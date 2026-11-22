// SamSpy — «Анализ»: dossier job pipeline (server only)
//
//   create: username → job + two Apify runs (profile, posts of the last year)
//   step (≈40 s per call, the open tab keeps calling it, lock per job):
//     apify  → wait for both runs
//     save   → profile → analysis_accounts (+ avatar), posts → analysis_posts
//     thumbs → post previews → storage bucket 'analysis' (webp, 320 px)
//     stats  → numbers (lib/analysis/stats) → job.stats + account card summary
//     done
//   Stage 2 will add comments → transcripts → AI dossier before «done».
//
//   mode 'full'   — every post of the last year.
//   mode 'update' — only posts newer than the latest post of the previous dossier minus
//                   UPDATE_OVERLAP_DAYS (fresh posts still gain views, their numbers are
//                   refreshed); older posts of the previous dossier are carried over with
//                   their previews; posts older than a year drop out.
//
// Version history:
//   v0.1.0 (2026-11-22) — initial (stage 1: collection + numbers).
//   v0.2.0 (2026-11-22) — quick update (mode 'update', base_job_id).

import type { SupabaseClient } from '@supabase/supabase-js';
import sharp from 'sharp';
import {
  getDataset,
  getRun,
  parseUsername,
  RUN_FAILED,
  startPosts,
  startProfile,
  type PostItem,
  type ProfileItem,
} from './apify';
import { cardSummary, computeStats, hasCta, ratioOf } from './stats';
import type {
  AccountCard,
  AnalysisAccount,
  AnalysisJob,
  AnalysisPost,
  AnalysisStatus,
  Dossier,
  JobMode,
  PostKind,
  PostRow,
} from './types';

export const BUCKET = 'analysis';
const STEP_BUDGET_MS = 40_000;
const LOCK_MS = 58_000;
const THUMB_BATCH = 24;
const THUMB_CONCURRENCY = 6;
const THUMB_W = 320;
const DAY = 86_400_000;
const YEAR = 365 * DAY;
export const UPDATE_OVERLAP_DAYS = 14;

const JOB_COLS =
  'id,username,status,mode,base_job_id,period_from,profile_run_id,profile_dataset_id,posts_run_id,posts_dataset_id,stats,error,locked_until,created_at,updated_at';
const POST_COLS =
  'id,job_id,shortcode,url,kind,posted_at,caption,likes,comments,views,duration,slides,is_pinned,coauthors,owner,has_cta,display_url,video_url,thumb_path,thumb_done';

const nowIso = () => new Date().toISOString();
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const ACTIVE: AnalysisStatus[] = ['apify', 'save', 'thumbs', 'stats'];

function publicUrl(sb: SupabaseClient, path: string | null, v?: string): string | null {
  if (!path) return null;
  const u = sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
  return v ? `${u}?v=${encodeURIComponent(v)}` : u;
}

async function setJob(sb: SupabaseClient, id: string, patch: Partial<AnalysisJob>) {
  await sb.from('analysis_jobs').update({ ...patch, updated_at: nowIso() }).eq('id', id);
}

async function failJob(sb: SupabaseClient, id: string, error: string) {
  await setJob(sb, id, { status: 'failed', error });
}

// --- create -----------------------------------------------------------------------

export async function createAnalysis(
  sb: SupabaseClient,
  input: string,
  wanted: JobMode = 'update'
): Promise<AnalysisJob> {
  const username = parseUsername(input);
  if (!username) throw new Error('Не понял аккаунт. Вставь ссылку instagram.com/имя или @имя.');

  // already running for this account → return that job
  const { data: running } = await sb
    .from('analysis_jobs')
    .select(JOB_COLS)
    .eq('username', username)
    .in('status', ACTIVE)
    .order('created_at', { ascending: false })
    .limit(1)
    .returns<AnalysisJob[]>();
  if (running?.[0]) return running[0];

  const from = new Date(Date.now() - YEAR);
  const fromDay = from.toISOString().slice(0, 10);

  // quick update needs a finished dossier to build on; otherwise — full year
  let mode: JobMode = 'full';
  let baseJobId: string | null = null;
  let scrapeFrom = fromDay;
  if (wanted === 'update') {
    const { data: acc } = await sb
      .from('analysis_accounts')
      .select('last_job_id')
      .eq('username', username)
      .maybeSingle<{ last_job_id: string | null }>();
    if (acc?.last_job_id) {
      const { data: newest } = await sb
        .from('analysis_posts')
        .select('posted_at')
        .eq('job_id', acc.last_job_id)
        .eq('is_pinned', false)
        .not('posted_at', 'is', null)
        .order('posted_at', { ascending: false })
        .limit(1)
        .returns<{ posted_at: string }[]>();
      if (newest?.[0]) {
        const since = Math.max(new Date(newest[0].posted_at).getTime() - UPDATE_OVERLAP_DAYS * DAY, from.getTime());
        mode = 'update';
        baseJobId = acc.last_job_id;
        scrapeFrom = new Date(since).toISOString().slice(0, 10);
      }
    }
  }

  const [profile, posts] = await Promise.all([startProfile(username), startPosts(username, scrapeFrom)]);

  const { data, error } = await sb
    .from('analysis_jobs')
    .insert({
      username,
      status: 'apify',
      mode,
      base_job_id: baseJobId,
      period_from: `${fromDay}T00:00:00.000Z`,
      profile_run_id: profile.id,
      profile_dataset_id: profile.defaultDatasetId,
      posts_run_id: posts.id,
      posts_dataset_id: posts.defaultDatasetId,
    })
    .select(JOB_COLS)
    .single<AnalysisJob>();
  if (error || !data) throw new Error(error?.message ?? 'Не удалось создать задание.');

  // account row exists from the start, so the card shows up right away
  await sb
    .from('analysis_accounts')
    .upsert({ username, updated_at: nowIso() }, { onConflict: 'username', ignoreDuplicates: true });
  return data;
}

// --- step -------------------------------------------------------------------------------

/** Advances a job for ~40 s. Returns false if another tab holds the lock / nothing to do. */
export async function stepAnalysis(sb: SupabaseClient, jobId: string): Promise<boolean> {
  const { data: cur } = await sb.from('analysis_jobs').select(JOB_COLS).eq('id', jobId).maybeSingle<AnalysisJob>();
  if (!cur || !ACTIVE.includes(cur.status)) return false;
  if (cur.locked_until && new Date(cur.locked_until).getTime() > Date.now()) return false;

  // lock = compare-and-swap on locked_until
  let q = sb
    .from('analysis_jobs')
    .update({ locked_until: new Date(Date.now() + LOCK_MS).toISOString() })
    .eq('id', jobId);
  q = cur.locked_until ? q.eq('locked_until', cur.locked_until) : q.is('locked_until', null);
  const { data: locked } = await q.select(JOB_COLS).returns<AnalysisJob[]>();
  const job = locked?.[0];
  if (!job) return false;

  const deadline = Date.now() + STEP_BUDGET_MS;
  let status = job.status;
  try {
    while (Date.now() < deadline && ACTIVE.includes(status)) {
      let next: AnalysisStatus = status;
      if (status === 'apify') next = await stepApify(sb, job);
      else if (status === 'save') next = await stepSave(sb, job);
      else if (status === 'thumbs') next = (await stepThumbs(sb, job)) ? 'thumbs' : 'stats';
      else if (status === 'stats') next = await stepStats(sb, job);

      if (next !== status) {
        await setJob(sb, jobId, { status: next });
        job.status = next;
        status = next;
      } else if (status === 'apify') {
        break; // runs still going on Apify's side
      }
    }
  } catch (e) {
    await failJob(sb, jobId, errMsg(e));
  } finally {
    await sb.from('analysis_jobs').update({ locked_until: null }).eq('id', jobId);
  }
  return true;
}

async function stepApify(sb: SupabaseClient, job: AnalysisJob): Promise<AnalysisStatus> {
  if (!job.profile_run_id || !job.posts_run_id) {
    await failJob(sb, job.id, 'Apify не запустился.');
    return 'failed';
  }
  const [profile, posts] = await Promise.all([getRun(job.profile_run_id), getRun(job.posts_run_id)]);
  for (const [name, run] of [
    ['профиль', profile],
    ['посты', posts],
  ] as const) {
    if (RUN_FAILED.includes(run.status)) {
      await failJob(sb, job.id, `Apify (${name}) завершился со статусом ${run.status}.`);
      return 'failed';
    }
  }
  return profile.status === 'SUCCEEDED' && posts.status === 'SUCCEEDED' ? 'save' : 'apify';
}

function kindOf(it: PostItem): PostKind {
  if (it.type === 'Sidecar' || (Array.isArray(it.childPosts) && it.childPosts.length > 1)) return 'carousel';
  if (it.type === 'Video' || it.productType === 'clips' || it.videoUrl) return 'reel';
  return 'photo';
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

async function downloadImage(url: string, width: number): Promise<Buffer> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return sharp(buf).resize({ width, withoutEnlargement: true }).webp({ quality: 72 }).toBuffer();
}

async function stepSave(sb: SupabaseClient, job: AnalysisJob): Promise<AnalysisStatus> {
  // profile
  const [profile] = await getDataset<ProfileItem>(job.profile_dataset_id!);
  if (!profile || profile.error || !profile.username) {
    await failJob(sb, job.id, `Профиль не найден или закрыт${profile?.error ? `: ${profile.error}` : ''}.`);
    return 'failed';
  }
  let avatarPath: string | null = null;
  const pic = profile.profilePicUrlHD || profile.profilePicUrl;
  if (pic) {
    try {
      const path = `avatars/${job.username}.webp`;
      const up = await sb.storage
        .from(BUCKET)
        .upload(path, await downloadImage(pic, 320), { contentType: 'image/webp', upsert: true });
      if (!up.error) avatarPath = path;
    } catch {
      /* no avatar — fine */
    }
  }
  await sb.from('analysis_accounts').upsert(
    {
      username: job.username,
      full_name: profile.fullName ?? null,
      biography: profile.biography ?? null,
      external_url: profile.externalUrl ?? profile.externalUrls?.[0]?.url ?? null,
      followers: num(profile.followersCount),
      follows: num(profile.followsCount),
      posts_count: num(profile.postsCount),
      verified: !!profile.verified,
      category: profile.businessCategoryName ?? null,
      ...(avatarPath ? { avatar_path: avatarPath } : {}),
      updated_at: nowIso(),
    },
    { onConflict: 'username' }
  );

  // posts
  const items = (await getDataset<PostItem>(job.posts_dataset_id!)).filter((it) => it.shortCode && !it.error);
  if (!items.length && job.mode !== 'update') {
    await failJob(sb, job.id, 'Apify не вернул ни одного поста (аккаунт закрыт или пуст за год).');
    return 'failed';
  }
  const seen = new Set<string>();
  const rows = items
    .filter((it) => !seen.has(it.shortCode!) && seen.add(it.shortCode!))
    .map((it) => {
      const kind = kindOf(it);
      const plays = num(it.videoPlayCount) ?? num(it.videoViewCount);
      return {
        job_id: job.id,
        shortcode: it.shortCode!,
        url: it.url || `https://www.instagram.com/p/${it.shortCode}/`,
        kind,
        posted_at: it.timestamp ?? null,
        caption: it.caption ?? null,
        likes: num(it.likesCount),
        comments: num(it.commentsCount),
        views: kind === 'reel' ? plays : null,
        duration: kind === 'reel' ? num(it.videoDuration) : null,
        slides:
          kind === 'carousel'
            ? Array.isArray(it.childPosts)
              ? it.childPosts.length
              : Array.isArray(it.images)
                ? it.images.length
                : null
            : null,
        is_pinned: !!it.isPinned,
        coauthors: (it.coauthorProducers ?? [])
          .map((c) => (c.username ?? '').toLowerCase())
          .filter((u) => u && u !== job.username),
        owner: it.ownerUsername?.toLowerCase() ?? null,
        has_cta: hasCta(it.caption),
        display_url: it.displayUrl ?? it.images?.[0] ?? null,
        video_url: it.videoUrl ?? null,
      };
    });
  for (let i = 0; i < rows.length; i += 300) {
    const { error } = await sb
      .from('analysis_posts')
      .upsert(rows.slice(i, i + 300), { onConflict: 'job_id,shortcode', ignoreDuplicates: true });
    if (error) throw new Error(`Сохранение постов: ${error.message}`);
  }
  if (job.mode === 'update' && job.base_job_id) await carryOver(sb, job, seen);
  return 'thumbs';
}

/**
 * Quick update: posts of the previous dossier that were not collected again (older than the
 * overlap window) move into this job with their previews; posts older than the period drop
 * out (pinned ones stay, like in a full collection).
 */
async function carryOver(sb: SupabaseClient, job: AnalysisJob, fresh: Set<string>) {
  const fromMs = new Date(job.period_from).getTime();
  const old = await loadPosts(sb, job.base_job_id!);
  const rows = old
    .filter((p) => !fresh.has(p.shortcode))
    .filter((p) => p.is_pinned || !p.posted_at || new Date(p.posted_at).getTime() >= fromMs)
    .map(({ id: _id, job_id: _job, ...rest }) => ({ ...rest, job_id: job.id, thumb_done: true }));
  for (let i = 0; i < rows.length; i += 300) {
    const { error } = await sb
      .from('analysis_posts')
      .upsert(rows.slice(i, i + 300), { onConflict: 'job_id,shortcode', ignoreDuplicates: true });
    if (error) throw new Error(`Перенос старых постов: ${error.message}`);
  }
}

/** One batch of previews. Returns true while there is more to do. */
async function stepThumbs(sb: SupabaseClient, job: AnalysisJob): Promise<boolean> {
  const { data } = await sb
    .from('analysis_posts')
    .select('id,shortcode,display_url')
    .eq('job_id', job.id)
    .eq('thumb_done', false)
    .limit(THUMB_BATCH)
    .returns<Pick<AnalysisPost, 'id' | 'shortcode' | 'display_url'>[]>();
  const list = data ?? [];
  if (!list.length) return false;

  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const p = list[next++];
      let thumb_path: string | null = null;
      if (p.display_url) {
        try {
          const path = `${job.id}/${p.shortcode}.webp`;
          const up = await sb.storage
            .from(BUCKET)
            .upload(path, await downloadImage(p.display_url, THUMB_W), { contentType: 'image/webp', upsert: true });
          if (!up.error) thumb_path = path;
        } catch {
          /* expired / blocked — the post stays without a preview */
        }
      }
      await sb.from('analysis_posts').update({ thumb_done: true, thumb_path }).eq('id', p.id);
    }
  };
  await Promise.all(Array.from({ length: THUMB_CONCURRENCY }, worker));
  return true;
}

async function loadPosts(sb: SupabaseClient, jobId: string): Promise<AnalysisPost[]> {
  const out: AnalysisPost[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from('analysis_posts')
      .select(POST_COLS)
      .eq('job_id', jobId)
      .order('posted_at', { ascending: false })
      .range(from, from + 999)
      .returns<AnalysisPost[]>();
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function stepStats(sb: SupabaseClient, job: AnalysisJob): Promise<AnalysisStatus> {
  const posts = await loadPosts(sb, job.id);
  const { data: acc } = await sb
    .from('analysis_accounts')
    .select('followers')
    .eq('username', job.username)
    .maybeSingle<{ followers: number | null }>();
  const stats = computeStats(posts, acc?.followers ?? null, job.period_from, job.created_at);
  await setJob(sb, job.id, { stats });
  await sb
    .from('analysis_accounts')
    .update({ last_job_id: job.id, summary: cardSummary(stats), updated_at: nowIso() })
    .eq('username', job.username);
  return 'done';
}

// --- read ------------------------------------------------------------------------------------

async function progressOf(sb: SupabaseClient, job: AnalysisJob): Promise<string | null> {
  if (job.status === 'apify')
    return job.mode === 'update' ? 'Apify собирает новые посты…' : 'Apify собирает профиль и посты за год…';
  if (job.status === 'save') return 'Сохраняю посты…';
  if (job.status === 'stats') return 'Считаю цифры…';
  if (job.status === 'thumbs') {
    const [{ count: total }, { count: done }] = await Promise.all([
      sb.from('analysis_posts').select('id', { count: 'exact', head: true }).eq('job_id', job.id),
      sb.from('analysis_posts').select('id', { count: 'exact', head: true }).eq('job_id', job.id).eq('thumb_done', true),
    ]);
    return `Превью ${done ?? 0} из ${total ?? 0}…`;
  }
  return null;
}

export async function listCards(sb: SupabaseClient): Promise<AccountCard[]> {
  const { data: accounts } = await sb
    .from('analysis_accounts')
    .select('*')
    .order('updated_at', { ascending: false })
    .returns<AnalysisAccount[]>();
  if (!accounts?.length) return [];
  const { data: jobs } = await sb
    .from('analysis_jobs')
    .select(JOB_COLS)
    .in(
      'username',
      accounts.map((a) => a.username)
    )
    .order('created_at', { ascending: false })
    .returns<AnalysisJob[]>();
  const latest = new Map<string, AnalysisJob>();
  for (const j of jobs ?? []) if (!latest.has(j.username)) latest.set(j.username, j);

  return Promise.all(
    accounts.map(async (a): Promise<AccountCard> => {
      const j = latest.get(a.username) ?? null;
      return {
        username: a.username,
        full_name: a.full_name,
        followers: a.followers,
        verified: a.verified,
        avatar: publicUrl(sb, a.avatar_path, a.updated_at),
        summary: a.summary,
        last_job_id: a.last_job_id,
        job: j
          ? {
              id: j.id,
              status: j.status,
              mode: j.mode,
              error: j.error,
              progress: ACTIVE.includes(j.status) ? await progressOf(sb, j) : null,
              created_at: j.created_at,
            }
          : null,
        updated_at: a.updated_at,
      };
    })
  );
}

export async function getCard(sb: SupabaseClient, username: string): Promise<AccountCard | null> {
  return (await listCards(sb)).find((c) => c.username === username) ?? null;
}

export async function getDossier(sb: SupabaseClient, username: string): Promise<Dossier | null> {
  const { data: account } = await sb
    .from('analysis_accounts')
    .select('*')
    .eq('username', username)
    .maybeSingle<AnalysisAccount>();
  if (!account?.last_job_id) return null;
  const { data: job } = await sb
    .from('analysis_jobs')
    .select(JOB_COLS)
    .eq('id', account.last_job_id)
    .maybeSingle<AnalysisJob>();
  if (!job?.stats) return null;
  const posts = await loadPosts(sb, job.id);
  const rows: PostRow[] = posts.map((p) => ({
    shortcode: p.shortcode,
    url: p.url,
    kind: p.kind,
    posted_at: p.posted_at,
    caption: p.caption,
    likes: p.likes,
    comments: p.comments,
    views: p.views,
    duration: p.duration,
    slides: p.slides,
    is_pinned: p.is_pinned,
    collab: p.coauthors.length > 0 || (!!p.owner && p.owner !== username),
    coauthors: p.coauthors,
    has_cta: p.has_cta,
    thumb: publicUrl(sb, p.thumb_path),
    ratio: ratioOf(p, job.stats!),
  }));
  return {
    account: { ...account, avatar: publicUrl(sb, account.avatar_path, account.updated_at) },
    job,
    stats: job.stats,
    posts: rows,
  };
}

/** Removes the account with all its dossiers, posts and stored images. */
export async function deleteAccount(sb: SupabaseClient, username: string) {
  const { data: jobs } = await sb.from('analysis_jobs').select('id').eq('username', username);
  for (const j of jobs ?? []) {
    // storage.list pages by 1000; removing a page shifts the rest, so always read offset 0
    for (let guard = 0; guard < 20; guard++) {
      const { data: files } = await sb.storage.from(BUCKET).list(j.id, { limit: 1000 });
      if (!files?.length) break;
      await sb.storage.from(BUCKET).remove(files.map((f) => `${j.id}/${f.name}`));
      if (files.length < 1000) break;
    }
  }
  await sb.storage.from(BUCKET).remove([`avatars/${username}.webp`]);
  await sb.from('analysis_jobs').delete().eq('username', username); // posts cascade
  await sb.from('analysis_accounts').delete().eq('username', username);
}
