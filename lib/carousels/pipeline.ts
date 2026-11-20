// SamSpy — carousel text collector: job pipeline (step machine)
//
// Vercel Hobby functions stop at 60s, while a batch of carousels takes minutes. So a job is
// advanced in small steps: the open "Карусели" tab calls POST /api/carousels/jobs/:id/step
// every few seconds, and each call does ~40s of work, then saves progress in Supabase.
//
//   apify    → wait for the Apify run, then store posts + slide image URLs
//   ocr      → ~8 slides per batch: download image → Supabase Storage → OCR (cheap model)
//   check    → one text-only call per post: flag odd slides + split the last slide (content/cta)
//   escalate → re-OCR flagged slides with the expensive model (+ re-split if it was the last
//              slide), then finalize posts (roles, watermarks → brand, repeat check by text)
//   stats    → outlier: author's median likes from their recent posts (one Apify run for
//              all authors not cached in the last 7 days) → likes ÷ median → done
//
// A row lock (locked_until) keeps two open tabs from processing the same job at once.
// Posts are shared between jobs by shortcode: an already collected post is reused for free.
//
// Version history:
//   v0.4.0 (2026-11-18) — initial pipeline.
//   v0.7.0 (2026-11-20) — posts base without repeats: createJob reports new / already in base;
//                         finalize stores normalized text + hash and marks repeats
//                         (duplicate_of = same text, similar_to = ≥ 90% alike); 'stats' step
//                         computes outlier_ratio; listBasePosts() for «База постов».
//   v0.7.1 (2026-11-20) — createStatsJob(): outlier for posts collected earlier (a job that
//                         starts right at 'stats'); listBasePosts() also returns noOutlier.

import { createHash } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  startRun, startProfileRun, getRun, getItems, extractSlides, itemShortcode, parseLinks, RUN_FAILED,
} from './apify';
import { ocrSlide, checkPost, splitLastSlide, OCR_MODEL, ESCALATE_MODEL } from './claude';
import { postProcess } from './postprocess';
import type {
  CarouselJob, CarouselJobCard, CarouselPost, CarouselPostFull, CarouselSlide, CreateJobInfo,
  LastSplit,
} from './types';

export const BUCKET = 'carousels';
const STEP_BUDGET_MS = 40_000; // stop starting new batches after this (maxDuration is 60s)
const LOCK_MS = 58_000;
const OCR_BATCH = 8;
const CHECK_BATCH = 6;
const ESCALATE_BATCH = 4;
const FINALIZE_BATCH = 10;
const CONCURRENCY = 4;
const AUTHOR_TTL_MS = 7 * 24 * 3600 * 1000; // median likes cache
const STATS_WAIT_MS = 10 * 60 * 1000;       // give up on the authors run after this
const SIMILAR_MIN = 0.9;                    // Jaccard of 3-word shingles
const MIN_NORM_LEN = 30;                    // shorter texts are not compared

const JOB_COLS =
  'id,status,urls,apify_run_id,apify_dataset_id,error,locked_until,stats_run_id,stats_dataset_id,stats_started_at,created_at,updated_at';
const POST_COLS =
  'id,shortcode,url,author,posted_at,likes,comments,caption,brand,status,checked,last_split,error,' +
  'text_hash,duplicate_of,similar_to,similarity,outlier_ratio,stats_done,created_at,updated_at';
const SLIDE_COLS =
  'id,post_id,idx,source_url,image_path,is_video,ocr_done,raw_text,text,cta_text,role,model,check_status,issue,error';

// --- helpers -----------------------------------------------------------------

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
}

const nowIso = () => new Date().toISOString();
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

async function downloadImage(url: string): Promise<{ buf: Buffer; mime: string; ext: string }> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('png')) return { buf, mime: 'image/png', ext: 'png' };
  if (ct.includes('webp')) return { buf, mime: 'image/webp', ext: 'webp' };
  if (ct.includes('gif')) return { buf, mime: 'image/gif', ext: 'gif' };
  return { buf, mime: 'image/jpeg', ext: 'jpg' };
}

function mimeFromPath(path: string): string {
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.webp')) return 'image/webp';
  if (path.endsWith('.gif')) return 'image/gif';
  return 'image/jpeg';
}

async function jobPostIds(sb: SupabaseClient, jobId: string): Promise<string[]> {
  const { data } = await sb
    .from('carousel_job_posts')
    .select('post_id,position')
    .eq('job_id', jobId)
    .order('position');
  return (data ?? []).map((r: { post_id: string }) => r.post_id);
}

async function pendingPosts(sb: SupabaseClient, jobId: string): Promise<CarouselPost[]> {
  const ids = await jobPostIds(sb, jobId);
  if (!ids.length) return [];
  const { data } = await sb
    .from('carousel_posts')
    .select(POST_COLS)
    .in('id', ids)
    .eq('status', 'pending')
    .returns<CarouselPost[]>();
  return data ?? [];
}

async function setJob(sb: SupabaseClient, jobId: string, patch: Partial<CarouselJob>) {
  await sb.from('carousel_jobs').update({ ...patch, updated_at: nowIso() }).eq('id', jobId);
}

// --- create ------------------------------------------------------------------

export async function createJob(
  sb: SupabaseClient,
  text: string
): Promise<{ job: CarouselJob; info: CreateJobInfo }> {
  const links = parseLinks(text);
  if (!links.length) throw new Error('Не нашёл ссылок на посты Instagram.');
  const codes = links.map((l) => l.shortcode);

  // Reuse posts already collected; drop unfinished leftovers so they are collected again.
  const { data: existing } = await sb
    .from('carousel_posts')
    .select('id,shortcode,status')
    .in('shortcode', codes);
  const ready = new Map<string, string>();
  const stale: string[] = [];
  for (const p of existing ?? []) {
    if (p.status === 'ready') ready.set(p.shortcode, p.id);
    else stale.push(p.id);
  }
  if (stale.length) await sb.from('carousel_posts').delete().in('id', stale);

  const fresh = links.filter((l) => !ready.has(l.shortcode));

  const { data: job, error: jobErr } = await sb
    .from('carousel_jobs')
    .insert({ status: fresh.length ? 'apify' : 'done', urls: links.map((l) => l.url) })
    .select(JOB_COLS)
    .single<CarouselJob>();
  if (jobErr || !job) throw new Error(jobErr?.message ?? 'Не удалось создать задачу.');

  const ids = new Map(ready);
  if (fresh.length) {
    const { data: inserted, error } = await sb
      .from('carousel_posts')
      .insert(fresh.map((l) => ({ shortcode: l.shortcode, url: l.url, status: 'pending' })))
      .select('id,shortcode');
    if (error) throw new Error(error.message);
    for (const p of inserted ?? []) ids.set(p.shortcode, p.id);
  }

  await sb.from('carousel_job_posts').insert(
    links.map((l, i) => ({ job_id: job.id, post_id: ids.get(l.shortcode), position: i }))
  );

  if (fresh.length) {
    try {
      const run = await startRun(fresh.map((l) => l.url));
      await setJob(sb, job.id, { apify_run_id: run.id, apify_dataset_id: run.defaultDatasetId });
      job.apify_run_id = run.id;
      job.apify_dataset_id = run.defaultDatasetId;
    } catch (e) {
      await failJob(sb, job.id, `Apify: ${errMsg(e)}`);
      job.status = 'failed';
      job.error = `Apify: ${errMsg(e)}`;
    }
  }
  // Nothing new → the job still goes through 'stats' for posts without an outlier yet.
  if (!fresh.length) {
    await setJob(sb, job.id, { status: 'stats' });
    job.status = 'stats';
  }
  return { job, info: { total: links.length, fresh: fresh.length, existing: ready.size } };
}

async function failJob(sb: SupabaseClient, jobId: string, error: string) {
  const pending = await pendingPosts(sb, jobId);
  if (pending.length) {
    await sb
      .from('carousel_posts')
      .update({ status: 'failed', error, updated_at: nowIso() })
      .in('id', pending.map((p) => p.id));
  }
  await setJob(sb, jobId, { status: 'failed', error });
}

// --- step --------------------------------------------------------------------

/** Advances a job for ~40s. Returns false if another tab holds the lock. */
export async function stepJob(sb: SupabaseClient, jobId: string): Promise<boolean> {
  // Lock = compare-and-swap on locked_until (PostgREST rejects or() filters on UPDATE).
  const { data: cur } = await sb
    .from('carousel_jobs')
    .select(JOB_COLS)
    .eq('id', jobId)
    .maybeSingle<CarouselJob>();
  if (!cur || cur.status === 'done' || cur.status === 'failed') return false;
  if (cur.locked_until && new Date(cur.locked_until).getTime() > Date.now()) return false;

  let q = sb
    .from('carousel_jobs')
    .update({ locked_until: new Date(Date.now() + LOCK_MS).toISOString() })
    .eq('id', jobId);
  q = cur.locked_until ? q.eq('locked_until', cur.locked_until) : q.is('locked_until', null);
  const { data: locked } = await q.select(JOB_COLS).returns<CarouselJob[]>();
  const job = locked?.[0];
  if (!job) return false; // another tab took the lock first

  const deadline = Date.now() + STEP_BUDGET_MS;
  let status = job.status;
  try {
    while (Date.now() < deadline && status !== 'done' && status !== 'failed') {
      if (status === 'apify') {
        const next = await stepApify(sb, job);
        if (next === status) break; // still running on Apify's side
        status = next;
      } else if (status === 'ocr') {
        if (!(await stepOcr(sb, jobId))) status = 'check';
      } else if (status === 'check') {
        if (!(await stepCheck(sb, jobId))) status = 'escalate';
      } else if (status === 'escalate') {
        if (!(await stepEscalate(sb, jobId)) && !(await stepFinalize(sb, jobId))) status = 'stats';
      } else if (status === 'stats') {
        const next = await stepStats(sb, job);
        if (next === status) break; // authors run still going on Apify's side
        status = next;
      }
      if (status !== job.status) {
        await setJob(sb, jobId, { status });
        job.status = status;
      }
    }
  } catch (e) {
    await failJob(sb, jobId, errMsg(e));
  } finally {
    await sb.from('carousel_jobs').update({ locked_until: null }).eq('id', jobId);
  }
  return true;
}

// apify: returns the next status ('apify' = still running)
async function stepApify(sb: SupabaseClient, job: CarouselJob): Promise<CarouselJob['status']> {
  if (!job.apify_run_id || !job.apify_dataset_id) {
    await failJob(sb, job.id, 'Apify run was not started.');
    return 'failed';
  }
  const run = await getRun(job.apify_run_id);
  if (RUN_FAILED.includes(run.status)) {
    await failJob(sb, job.id, `Apify run ended with status ${run.status}`);
    return 'failed';
  }
  if (run.status !== 'SUCCEEDED') return 'apify';

  const items = await getItems(job.apify_dataset_id);
  const byCode = new Map<string, (typeof items)[number]>();
  for (const it of items) {
    if (it.ok === false) continue; // dami: error row for a link it could not read
    const code = itemShortcode(it);
    if (code) byCode.set(code, it);
  }

  for (const p of await pendingPosts(sb, job.id)) {
    const it = byCode.get(p.shortcode);
    if (!it) {
      await sb
        .from('carousel_posts')
        .update({ status: 'failed', error: 'not_returned (private, deleted or skipped by Apify)', updated_at: nowIso() })
        .eq('id', p.id);
      continue;
    }
    await sb
      .from('carousel_posts')
      .update({
        author: it.ownerUsername ?? null,
        posted_at: it.timestamp ?? null,
        likes: it.likesCount ?? null,
        comments: it.commentsCount ?? null,
        caption: it.caption ?? null,
        updated_at: nowIso(),
      })
      .eq('id', p.id);
    const slides = extractSlides(it);
    if (slides.length) {
      await sb.from('carousel_slides').insert(
        slides.map((s, i) => ({ post_id: p.id, idx: i + 1, source_url: s.url, is_video: s.isVideo }))
      );
    }
  }
  return 'ocr';
}

// ocr: returns true if it processed something
async function stepOcr(sb: SupabaseClient, jobId: string): Promise<boolean> {
  const posts = await pendingPosts(sb, jobId);
  if (!posts.length) return false;
  const codeOf = new Map(posts.map((p) => [p.id, p.shortcode]));

  const { data: slides } = await sb
    .from('carousel_slides')
    .select(SLIDE_COLS)
    .in('post_id', posts.map((p) => p.id))
    .eq('ocr_done', false)
    .order('idx')
    .limit(OCR_BATCH)
    .returns<CarouselSlide[]>();
  if (!slides?.length) return false;

  await pool(slides, CONCURRENCY, async (s) => {
    const patch: Partial<CarouselSlide> = { ocr_done: true };
    try {
      const img = await downloadImage(s.source_url);
      const path = `${codeOf.get(s.post_id)}/${String(s.idx).padStart(2, '0')}.${img.ext}`;
      const up = await sb.storage
        .from(BUCKET)
        .upload(path, img.buf, { contentType: img.mime, upsert: true });
      if (!up.error) patch.image_path = path;
      patch.raw_text = await ocrSlide({ base64: img.buf.toString('base64'), mime: img.mime }, OCR_MODEL);
      patch.model = OCR_MODEL;
    } catch (e) {
      patch.error = errMsg(e);
    }
    await sb.from('carousel_slides').update(patch).eq('id', s.id);
  });
  return true;
}

// check: returns true if it processed something
async function stepCheck(sb: SupabaseClient, jobId: string): Promise<boolean> {
  const posts = (await pendingPosts(sb, jobId)).filter((p) => !p.checked).slice(0, CHECK_BATCH);
  if (!posts.length) return false;

  await pool(posts, CONCURRENCY, async (p) => {
    const { data: slides } = await sb
      .from('carousel_slides')
      .select('id,idx,raw_text,error')
      .eq('post_id', p.id)
      .order('idx');
    const all = slides ?? [];
    const ok = all.filter((s) => !s.error && s.raw_text);
    let lastSplit: LastSplit | null = null;
    try {
      const { flags, last } = await checkPost(ok.map((s) => ({ slide: s.idx, text: s.raw_text })));
      const lastIdx = all.length;
      if (last && all.length >= 2 && ok.some((s) => s.idx === lastIdx)) lastSplit = last;
      for (const s of all.filter((x) => !x.error)) {
        const f = flags.find((x) => x.slide === s.idx);
        await sb
          .from('carousel_slides')
          .update(f ? { check_status: 'flagged', issue: f.issue } : { check_status: 'ok' })
          .eq('id', s.id);
      }
    } catch (e) {
      const ids = all.filter((x) => !x.error).map((x) => x.id);
      if (ids.length) {
        await sb
          .from('carousel_slides')
          .update({ check_status: 'check_failed', issue: errMsg(e) })
          .in('id', ids);
      }
    }
    await sb
      .from('carousel_posts')
      .update({ checked: true, last_split: lastSplit, updated_at: nowIso() })
      .eq('id', p.id);
  });
  return true;
}

// escalate: re-OCR flagged slides with the expensive model. Returns true if it processed something.
async function stepEscalate(sb: SupabaseClient, jobId: string): Promise<boolean> {
  const posts = await pendingPosts(sb, jobId);
  if (!posts.length) return false;

  const { data: slides } = await sb
    .from('carousel_slides')
    .select(SLIDE_COLS)
    .in('post_id', posts.map((p) => p.id))
    .eq('check_status', 'flagged')
    .limit(ESCALATE_BATCH)
    .returns<CarouselSlide[]>();
  if (!slides?.length) return false;

  await pool(slides, CONCURRENCY, async (s) => {
    try {
      let img: { base64: string; mime: string };
      if (s.image_path) {
        const { data, error } = await sb.storage.from(BUCKET).download(s.image_path);
        if (error || !data) throw new Error(`storage: ${error?.message ?? 'no data'}`);
        img = {
          base64: Buffer.from(await data.arrayBuffer()).toString('base64'),
          mime: mimeFromPath(s.image_path),
        };
      } else {
        const d = await downloadImage(s.source_url);
        img = { base64: d.buf.toString('base64'), mime: d.mime };
      }
      const text = await ocrSlide(img, ESCALATE_MODEL, s.issue ?? '');
      await sb
        .from('carousel_slides')
        .update({ raw_text: text, model: ESCALATE_MODEL, check_status: 'escalated' })
        .eq('id', s.id);

      // The last slide changed → its split from the check call is stale.
      const { count } = await sb
        .from('carousel_slides')
        .select('id', { count: 'exact', head: true })
        .eq('post_id', s.post_id);
      if ((count ?? 0) >= 2 && s.idx === count) {
        let split: LastSplit | null = null;
        try {
          split = text ? await splitLastSlide(text) : null;
        } catch {
          split = null; // fallback to keyword detection
        }
        await sb.from('carousel_posts').update({ last_split: split }).eq('id', s.post_id);
      }
    } catch (e) {
      await sb
        .from('carousel_slides')
        .update({ check_status: 'escalate_failed', issue: `${s.issue ?? ''} | escalation failed: ${errMsg(e)}` })
        .eq('id', s.id);
    }
  });
  return true;
}

// --- repeat check by text -----------------------------------------------------

/** Lowercase letters/digits only, single spaces — so OCR punctuation / case don't matter. */
export function normalizeText(t: string): string {
  return t
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Post text for the repeat check: all slides except a pure CTA slide. */
function postNormText(slides: { role: string | null; text: string | null }[]): string {
  return normalizeText(
    slides
      .filter((s) => s.role !== 'cta')
      .map((s) => s.text ?? '')
      .join(' ')
  );
}

const sha1 = (t: string) => createHash('sha1').update(t).digest('hex');

function shingles(t: string): Set<string> {
  const w = t.split(' ').filter(Boolean);
  const out = new Set<string>();
  if (w.length < 3) {
    w.forEach((x) => out.add(x));
    return out;
  }
  for (let i = 0; i + 2 < w.length; i++) out.add(`${w[i]} ${w[i + 1]} ${w[i + 2]}`);
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  a.forEach((x) => {
    if (b.has(x)) inter++;
  });
  return inter / (a.size + b.size - inter);
}

interface Candidate {
  id: string;
  hash: string;
  sh: Set<string>;
  len: number;
}

/** Posts already in the base (ready, not a duplicate) with their normalized text. */
async function loadCandidates(sb: SupabaseClient, exclude: Set<string>): Promise<Candidate[]> {
  await backfillNorm(sb);
  const out: Candidate[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from('carousel_posts')
      .select('id,text_hash,norm_text')
      .eq('status', 'ready')
      .is('duplicate_of', null)
      .not('text_hash', 'is', null)
      .order('created_at')
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) {
      if (exclude.has(r.id) || !r.norm_text) continue;
      out.push({ id: r.id, hash: r.text_hash, sh: shingles(r.norm_text), len: r.norm_text.length });
    }
    if (!data || data.length < 1000) break;
  }
  return out;
}

/** Posts collected before migration-005 get their normalized text once (no marking). */
async function backfillNorm(sb: SupabaseClient) {
  const { data: old } = await sb
    .from('carousel_posts')
    .select('id')
    .eq('status', 'ready')
    .is('norm_text', null)
    .limit(200);
  if (!old?.length) return;
  const ids = old.map((p) => p.id);
  const { data: slides } = await sb
    .from('carousel_slides')
    .select('post_id,idx,role,text')
    .in('post_id', ids)
    .order('idx');
  for (const id of ids) {
    const norm = postNormText((slides ?? []).filter((s) => s.post_id === id));
    // '' marks "checked, too short" so the post is not picked up again
    await sb
      .from('carousel_posts')
      .update({ norm_text: norm, text_hash: norm.length >= MIN_NORM_LEN ? sha1(norm) : null })
      .eq('id', id);
  }
}

/** Finds an earlier post with the same / very similar text. */
function findRepeat(norm: string, cands: Candidate[]) {
  if (norm.length < MIN_NORM_LEN) return { hash: null as string | null };
  const hash = sha1(norm);
  const same = cands.find((c) => c.hash === hash);
  if (same) return { hash, duplicateOf: same.id };
  const sh = shingles(norm);
  let best: { id: string; sim: number } | null = null;
  for (const c of cands) {
    // Jaccard ≥ 0.9 is impossible when lengths differ a lot — skip cheaply
    if (Math.min(c.len, norm.length) / Math.max(c.len, norm.length) < 0.7) continue;
    const sim = jaccard(sh, c.sh);
    if (sim >= SIMILAR_MIN && (!best || sim > best.sim)) best = { id: c.id, sim };
  }
  return best ? { hash, similarTo: best.id, similarity: Number(best.sim.toFixed(3)) } : { hash };
}

// finalize: roles + watermarks for pending posts → ready, + repeat check.
// Returns true if it processed something.
async function stepFinalize(sb: SupabaseClient, jobId: string): Promise<boolean> {
  const posts = (await pendingPosts(sb, jobId)).slice(0, FINALIZE_BATCH);
  if (!posts.length) return false;
  const cands = await loadCandidates(sb, new Set(posts.map((p) => p.id)));

  for (const p of posts) {
    const { data: slides } = await sb
      .from('carousel_slides')
      .select(SLIDE_COLS)
      .eq('post_id', p.id)
      .order('idx')
      .returns<CarouselSlide[]>();
    const all = slides ?? [];
    const res = postProcess(
      all.map((s) => ({ idx: s.idx, raw_text: s.raw_text ?? '' })),
      p.last_split
    );
    if (all.length) {
      const rows = all.map((s) => {
        const r = res.slides.find((x) => x.idx === s.idx);
        return { ...s, role: r?.role ?? null, text: r?.text ?? '', cta_text: r?.cta_text ?? '' };
      });
      const { error } = await sb.from('carousel_slides').upsert(rows, { onConflict: 'id' });
      if (error) throw new Error(`finalize: ${error.message}`);
    }
    const norm = postNormText(
      all.map((s) => {
        const r = res.slides.find((x) => x.idx === s.idx);
        return { role: r?.role ?? null, text: r?.text ?? '' };
      })
    );
    const rep = findRepeat(norm, cands);
    await sb
      .from('carousel_posts')
      .update({
        brand: res.brand || null,
        status: 'ready',
        norm_text: norm,
        text_hash: rep.hash,
        duplicate_of: 'duplicateOf' in rep ? rep.duplicateOf : null,
        similar_to: 'similarTo' in rep ? rep.similarTo : null,
        similarity: 'similarity' in rep ? rep.similarity : null,
        updated_at: nowIso(),
      })
      .eq('id', p.id);
    // later posts of the same batch are compared with this one too
    if (rep.hash && !('duplicateOf' in rep)) {
      cands.push({ id: p.id, hash: rep.hash, sh: shingles(norm), len: norm.length });
    }
  }
  return true;
}

// --- stats: outlier ------------------------------------------------------------

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const a = [...nums].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
}

/** Returns the next status: 'stats' = waiting for the authors run, else 'done'. */
async function stepStats(sb: SupabaseClient, job: CarouselJob): Promise<CarouselJob['status']> {
  const ids = await jobPostIds(sb, job.id);
  const { data } = ids.length
    ? await sb
        .from('carousel_posts')
        .select('id,author,likes')
        .in('id', ids)
        .eq('status', 'ready')
        .eq('stats_done', false)
    : { data: [] as { id: string; author: string | null; likes: number | null }[] };
  const posts = data ?? [];
  if (!posts.length) return 'done';

  const authors = Array.from(
    new Set(posts.map((p) => p.author?.toLowerCase()).filter((a): a is string => !!a))
  );
  const { data: cached } = authors.length
    ? await sb.from('carousel_authors').select('username,median_likes,fetched_at').in('username', authors)
    : { data: [] as { username: string; median_likes: number | null; fetched_at: string }[] };
  const fresh = new Map<string, number | null>();
  for (const a of cached ?? []) {
    if (Date.now() - new Date(a.fetched_at).getTime() < AUTHOR_TTL_MS) fresh.set(a.username, a.median_likes);
  }
  const missing = authors.filter((a) => !fresh.has(a));

  if (missing.length) {
    if (!job.stats_run_id) {
      try {
        const run = await startProfileRun(missing);
        const patch = {
          stats_run_id: run.id,
          stats_dataset_id: run.defaultDatasetId,
          stats_started_at: nowIso(),
        };
        await setJob(sb, job.id, patch);
        Object.assign(job, patch);
        return 'stats';
      } catch (e) {
        await saveAuthors(sb, missing, new Map(), `Apify: ${errMsg(e)}`, fresh);
      }
    } else {
      const run = await getRun(job.stats_run_id);
      const started = job.stats_started_at ? new Date(job.stats_started_at).getTime() : 0;
      if (run.status === 'SUCCEEDED') {
        const items = await getItems(job.stats_dataset_id!);
        const likes = new Map<string, number[]>();
        for (const it of items) {
          const u = it.ownerUsername?.toLowerCase();
          if (!u || typeof it.likesCount !== 'number' || it.likesCount <= 0) continue; // hidden likes
          likes.set(u, [...(likes.get(u) ?? []), it.likesCount]);
        }
        await saveAuthors(sb, missing, likes, null, fresh);
      } else if (RUN_FAILED.includes(run.status) || Date.now() - started > STATS_WAIT_MS) {
        await saveAuthors(sb, missing, new Map(), `Apify run: ${run.status}`, fresh);
      } else {
        return 'stats'; // still running
      }
    }
  }

  for (const p of posts) {
    const m = p.author ? fresh.get(p.author.toLowerCase()) : null;
    const ratio = m && m > 0 && p.likes && p.likes > 0 ? Number((p.likes / m).toFixed(2)) : null;
    await sb.from('carousel_posts').update({ outlier_ratio: ratio, stats_done: true }).eq('id', p.id);
  }
  if (job.stats_run_id) {
    const patch = { stats_run_id: null, stats_dataset_id: null, stats_started_at: null };
    await setJob(sb, job.id, patch);
    Object.assign(job, patch);
  }
  return 'done';
}

/** Upserts the authors cache; also fills `fresh` with the new medians. */
async function saveAuthors(
  sb: SupabaseClient,
  usernames: string[],
  likes: Map<string, number[]>,
  error: string | null,
  fresh: Map<string, number | null>
) {
  const rows = usernames.map((u) => {
    const l = likes.get(u) ?? [];
    const med = l.length ? median(l) : null;
    fresh.set(u, med);
    return {
      username: u,
      median_likes: med,
      posts_count: l.length,
      error: error ?? (l.length ? null : 'нет постов с открытыми лайками'),
      fetched_at: nowIso(),
    };
  });
  if (rows.length) await sb.from('carousel_authors').upsert(rows, { onConflict: 'username' });
}

// --- read --------------------------------------------------------------------

export async function getJobPosts(sb: SupabaseClient, jobId: string): Promise<CarouselPostFull[]> {
  return loadPostsFull(sb, await jobPostIds(sb, jobId));
}

/** Posts (in the given order) with slides and, for repeats, the earlier post. */
async function loadPostsFull(sb: SupabaseClient, ids: string[]): Promise<CarouselPostFull[]> {
  if (!ids.length) return [];
  const { data: posts } = await sb
    .from('carousel_posts')
    .select(POST_COLS)
    .in('id', ids)
    .returns<CarouselPost[]>();
  const refIds = Array.from(
    new Set(
      (posts ?? [])
        .map((p) => p.duplicate_of ?? p.similar_to)
        .filter((x): x is string => !!x)
    )
  );
  const { data: refs } = refIds.length
    ? await sb.from('carousel_posts').select('id,url,author').in('id', refIds)
    : { data: [] as { id: string; url: string; author: string | null }[] };
  const refOf = new Map((refs ?? []).map((r) => [r.id, r]));
  // Supabase returns at most 1000 rows per request → page through slides.
  const slides: CarouselSlide[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from('carousel_slides')
      .select(SLIDE_COLS)
      .in('post_id', ids)
      .order('id')
      .range(from, from + 999)
      .returns<CarouselSlide[]>();
    if (error) throw new Error(error.message);
    slides.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  slides.sort((x, y) => x.idx - y.idx);

  const byId = new Map((posts ?? []).map((p) => [p.id, p]));
  return ids
    .map((id) => byId.get(id))
    .filter((p): p is CarouselPost => !!p)
    .map((p) => ({
      ...p,
      ref: refOf.get(p.duplicate_of ?? p.similar_to ?? '') ?? null,
      slides: slides
        .filter((s) => s.post_id === p.id)
        .map((s) => ({
          ...s,
          image_url: s.image_path
            ? sb.storage.from(BUCKET).getPublicUrl(s.image_path).data.publicUrl
            : null,
        })),
    }));
}

export async function getJobCard(sb: SupabaseClient, jobId: string): Promise<CarouselJobCard | null> {
  const { data: job } = await sb
    .from('carousel_jobs')
    .select(JOB_COLS)
    .eq('id', jobId)
    .maybeSingle<CarouselJob>();
  if (!job) return null;
  return (await decorate(sb, [job]))[0];
}

export async function listJobs(sb: SupabaseClient, limit = 20): Promise<CarouselJobCard[]> {
  const { data: jobs } = await sb
    .from('carousel_jobs')
    .select(JOB_COLS)
    .order('created_at', { ascending: false })
    .limit(limit)
    .returns<CarouselJob[]>();
  return decorate(sb, jobs ?? []);
}

async function decorate(sb: SupabaseClient, jobs: CarouselJob[]): Promise<CarouselJobCard[]> {
  if (!jobs.length) return [];
  const { data: links } = await sb
    .from('carousel_job_posts')
    .select('job_id,post_id')
    .in('job_id', jobs.map((j) => j.id));
  const postIds = Array.from(new Set((links ?? []).map((l) => l.post_id)));
  const { data: posts } = postIds.length
    ? await sb.from('carousel_posts').select('id,status').in('id', postIds)
    : { data: [] as { id: string; status: string }[] };
  const statusOf = new Map((posts ?? []).map((p) => [p.id, p.status]));

  const cards: CarouselJobCard[] = [];
  for (const j of jobs) {
    const ids = (links ?? []).filter((l) => l.job_id === j.id).map((l) => l.post_id);
    let slidesTotal = 0;
    let slidesDone = 0;
    const active = j.status !== 'done' && j.status !== 'failed';
    if (active && ids.length) {
      const t = await sb
        .from('carousel_slides')
        .select('id', { count: 'exact', head: true })
        .in('post_id', ids);
      const d = await sb
        .from('carousel_slides')
        .select('id', { count: 'exact', head: true })
        .in('post_id', ids)
        .eq('ocr_done', true);
      slidesTotal = t.count ?? 0;
      slidesDone = d.count ?? 0;
    }
    cards.push({
      ...j,
      posts_total: ids.length,
      posts_ready: ids.filter((id) => statusOf.get(id) === 'ready').length,
      slides_total: slidesTotal,
      slides_ocr_done: slidesDone,
    });
  }
  return cards;
}

// --- posts base («База постов») ------------------------------------------------

export type BaseSort = 'recent' | 'likes' | 'outlier';

export async function listBasePosts(
  sb: SupabaseClient,
  opts: { q?: string; sort?: BaseSort; minOutlier?: number; offset?: number; limit?: number }
): Promise<{ posts: CarouselPostFull[]; total: number; noOutlier: number }> {
  const limit = Math.min(100, Math.max(1, opts.limit ?? 50));
  const offset = Math.max(0, opts.offset ?? 0);
  let q = sb
    .from('carousel_posts')
    .select('id', { count: 'exact' })
    .eq('status', 'ready')
    .is('duplicate_of', null);
  const term = (opts.q ?? '').replace(/[,()%*"\\]/g, ' ').trim();
  if (term) {
    const norm = normalizeText(term);
    const parts = [`author.ilike."%${term.replace(/^@/, '')}%"`, `caption.ilike."%${term}%"`];
    if (norm) parts.push(`norm_text.ilike."%${norm}%"`);
    q = q.or(parts.join(','));
  }
  if (opts.minOutlier && opts.minOutlier > 0) q = q.gte('outlier_ratio', opts.minOutlier);
  if (opts.sort === 'likes') q = q.order('likes', { ascending: false, nullsFirst: false });
  else if (opts.sort === 'outlier') q = q.order('outlier_ratio', { ascending: false, nullsFirst: false });
  q = q.order('created_at', { ascending: false });
  const { data, count, error } = await q.range(offset, offset + limit - 1);
  if (error) throw new Error(error.message);
  const posts = await loadPostsFull(sb, (data ?? []).map((r) => r.id));
  const { count: noOutlier } = await sb
    .from('carousel_posts')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'ready')
    .is('duplicate_of', null)
    .eq('stats_done', false);
  return { posts, total: count ?? 0, noOutlier: noOutlier ?? 0 };
}

/** A job that only counts the outlier for base posts that don't have it yet. */
export async function createStatsJob(sb: SupabaseClient): Promise<CarouselJob | null> {
  const { data: posts } = await sb
    .from('carousel_posts')
    .select('id,url')
    .eq('status', 'ready')
    .eq('stats_done', false)
    .order('created_at')
    .limit(300);
  if (!posts?.length) return null;
  const { data: job, error } = await sb
    .from('carousel_jobs')
    .insert({ status: 'stats', urls: posts.map((p) => p.url) })
    .select(JOB_COLS)
    .single<CarouselJob>();
  if (error || !job) throw new Error(error?.message ?? 'Не удалось создать задачу.');
  await sb
    .from('carousel_job_posts')
    .insert(posts.map((p, i) => ({ job_id: job.id, post_id: p.id, position: i })));
  return job;
}

/** Deletes a post from the base (slides cascade; Storage images removed best-effort). */
export async function deletePost(sb: SupabaseClient, id: string) {
  const { data: slides } = await sb.from('carousel_slides').select('image_path').eq('post_id', id);
  const paths = (slides ?? []).map((s) => s.image_path).filter((x): x is string => !!x);
  if (paths.length) await sb.storage.from(BUCKET).remove(paths);
  const { error } = await sb.from('carousel_posts').delete().eq('id', id);
  if (error) throw new Error(error.message);
}
