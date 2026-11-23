// SamSpy — «Анализ»: dossier job pipeline (server only)
//
//   create: username → job + two Apify runs (profile, posts of the last year)
//   step (≈40 s per call, the open tab keeps calling it, lock per job):
//     apify  → wait for both runs
//     save   → profile → analysis_accounts (+ avatar), posts → analysis_posts
//     thumbs → post previews → storage bucket 'analysis' (webp, 320 px)
//     stats     → numbers (lib/analysis/stats) → job.stats + account card summary; from here
//                 the dossier opens with numbers, the AI part fills in while the job goes on
//     comments  → comments of the top posts (Apify comment scraper) + latestComments of posts
//     texts     → speech of the top reels (OpenAI), slide text of the top carousels (Claude)
//     tag       → rubric vocabulary of the account, then per post: title, rubric, hook, format,
//                 broad / narrow, first phrase (Claude)
//     breakdown → top posts: structure, pay-off, CTA, why it worked, text in Russian (Claude)
//     synth     → dossier texts (Claude) from the numbers and groups computed in code
//     done
//   An AI step that fails does not fail the dossier: the error goes to job.ai_error and the
//   job moves on (the numbers stay).
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
//   v0.3.0 (2026-11-22) — stage 2: comments, transcripts / slide texts, AI tags, breakdowns,
//                         dossier texts; quick update carries AI results + comments over.
//   v0.3.1 (2026-11-22) — tag: batches of 25, a failed batch is retried in halves, then
//                         skipped (never stops the step); texts: reels without speech → text
//                         from the cover frame, carousels without slide links → cover text.
//   v0.3.2 (2026-11-22) — dossier groups per content type (all / reels / carousels / photos);
//                         dossier texts get rubric stats per format too; × figures rounded.
//   v0.4.0 (2026-11-23) — ScrapeCreators instead of Apify (when its key is set, SCRAPER=apify
//                         switches back): 'apify' step pages the feed itself (12 posts a page,
//                         saved as they come, cursor in job.scrape); comments 2 pages per top
//                         post. «To finish» list: a call is retried 3× at once, then the post /
//                         page goes back in line and is retried later (20–60 s apart, up to 3
//                         rounds for comments, 6 for the feed). A feed that still fails stops
//                         the job; «Повторить» resumes from the saved cursor.
//   v0.5.0 (2026-11-23) — a full collection estimates posts a year from the first feed page;
//                         above CONFIRM_ABOVE the job waits in 'confirm' until a limit is chosen
//                         (confirmCollection / cancelCollection). Jobs are also advanced in the
//                         background by the worker (app/api/cron/step), no open tab needed.

import type { SupabaseClient } from '@supabase/supabase-js';
import sharp from 'sharp';
import {
  getDataset,
  getRun,
  MAX_POSTS,
  parseUsername,
  RUN_FAILED,
  startComments,
  startPosts,
  startProfile,
  type CommentItem,
  type PostItem,
  type ProfileItem,
} from './apify';
import {
  breakdownPosts,
  discoverVocab,
  ocrCarousel,
  synthesize,
  tagPosts,
  transcribe,
  type PostForAI,
} from './ai';
import { scCommentsPage, scEnabled, ScFatal, ScNotFound, scPostsPage, scProfile } from '@/lib/scrape/sc';
import { cardSummary, computeStats, groupStats, hasCta, metricOf, ratioOf } from './stats';
import type {
  AccountCard,
  AnalysisAccount,
  AnalysisJob,
  AnalysisPost,
  AnalysisStatus,
  Dossier,
  FetchState,
  JobMode,
  PostsEstimate,
  KindTab,
  PostKind,
  PostRow,
} from './types';

export const BUCKET = 'analysis';
const STEP_BUDGET_MS = 40_000;
const LOCK_MS = 310_000; // > maxDuration of the step route (300 s): one AI call can be slow
const THUMB_BATCH = 24;
const THUMB_CONCURRENCY = 6;
const THUMB_W = 320;
const DAY = 86_400_000;
const YEAR = 365 * DAY;
export const UPDATE_OVERLAP_DAYS = 14;
const STEP_HARD_MS = 40_000; // do not start a new AI batch after this

// stage 2 sizes (env overrides)
const envNum = (k: string, d: number, min: number, max: number) =>
  Math.max(min, Math.min(max, Number(process.env[k]) || d));
const COMMENT_POSTS = envNum('ANALYSIS_COMMENT_POSTS', 15, 0, 50);
const COMMENTS_PER_POST = envNum('ANALYSIS_COMMENTS_PER_POST', 24, 5, 100);
// ScrapeCreators «to finish» rounds
const FEED_ROUNDS = 6; // feed page / profile: rounds of 3 tries before the job stops
const COMMENT_ROUNDS = 3; // comments of one post: rounds of 3 tries before it is skipped
const RETRY_GAP_MS = 20_000; // pause before the next round grows with each failure
const SC_COMMENT_PAGE = 12;
const SC_CONCURRENCY = 3;
// big accounts: ask before a full collection
export const CONFIRM_ABOVE = 500; // posts a year
export const LIMIT_ALL = envNum('ANALYSIS_MAX_ALL', 10_000, 500, 20_000); // «весь год» cap
const TRANSCRIBE_TOP = envNum('ANALYSIS_TRANSCRIBE_TOP', 30, 0, 100);
const OCR_TOP = envNum('ANALYSIS_OCR_TOP', 10, 0, 40);
const BREAKDOWN_REELS = envNum('ANALYSIS_BREAKDOWN_REELS', 15, 0, 40);
const BREAKDOWN_CAROUSELS = envNum('ANALYSIS_BREAKDOWN_CAROUSELS', 5, 0, 20);
const TAG_BATCH = 25;
const TEXT_CONCURRENCY = 4;
const AI_STEPS: AnalysisStatus[] = ['comments', 'texts', 'tag', 'breakdown', 'synth'];

const JOB_COLS =
  'id,username,status,mode,base_job_id,period_from,profile_run_id,profile_dataset_id,posts_run_id,posts_dataset_id,stats,error,locked_until,comments_run_id,comments_dataset_id,ai,ai_meta,ai_error,scrape,created_at,updated_at';
const POST_COLS =
  'id,job_id,shortcode,url,kind,posted_at,caption,likes,comments,views,duration,slides,is_pinned,coauthors,owner,has_cta,display_url,video_url,thumb_path,thumb_done,slide_urls,title_ru,rubric,hook,format,breadth,first_line,tagged,transcript,ocr_text,text_done,breakdown';
// AI results of a post — carried over on a quick update
const AI_FIELDS = ['title_ru', 'rubric', 'hook', 'format', 'breadth', 'first_line', 'tagged', 'transcript', 'ocr_text', 'text_done', 'breakdown'] as const;

const nowIso = () => new Date().toISOString();
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const ACTIVE: AnalysisStatus[] = ['apify', 'save', 'thumbs', 'stats', 'comments', 'texts', 'tag', 'breakdown', 'synth'];

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
    .in('status', [...ACTIVE, 'confirm'])
    .order('created_at', { ascending: false })
    .limit(1)
    .returns<AnalysisJob[]>();
  if (running?.[0]) return running[0];

  // «Повторить» after the feed stopped mid-way → continue from the saved cursor
  if (scEnabled()) {
    const { data: last } = await sb
      .from('analysis_jobs')
      .select(JOB_COLS)
      .eq('username', username)
      .order('created_at', { ascending: false })
      .limit(1)
      .returns<AnalysisJob[]>();
    const j = last?.[0];
    if (j && j.status === 'failed' && j.scrape?.provider === 'sc' && !j.scrape.done && j.scrape.profile) {
      const scrape: FetchState = { ...j.scrape, fails: 0, retry_at: undefined };
      // a big account whose limit was never chosen (cancelled) → ask again
      const status = scrape.limit == null && (scrape.estimate?.year ?? 0) > CONFIRM_ABOVE ? 'confirm' : 'apify';
      await setJob(sb, j.id, { status, error: null, scrape });
      return { ...j, status, error: null, scrape };
    }
  }

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

  let runs: Record<string, unknown>;
  if (scEnabled()) {
    // ScrapeCreators: nothing to start, the step pages the feed itself
    const scrape: FetchState = { provider: 'sc', since: `${scrapeFrom}T00:00:00.000Z`, pages: 0, posts: 0, fails: 0 };
    runs = { scrape };
  } else {
    const [profile, posts] = await Promise.all([startProfile(username), startPosts(username, scrapeFrom)]);
    runs = {
      profile_run_id: profile.id,
      profile_dataset_id: profile.defaultDatasetId,
      posts_run_id: posts.id,
      posts_dataset_id: posts.defaultDatasetId,
    };
  }

  const { data, error } = await sb
    .from('analysis_jobs')
    .insert({
      username,
      status: 'apify',
      mode,
      base_job_id: baseJobId,
      period_from: `${fromDay}T00:00:00.000Z`,
      ...runs,
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
      try {
        if (status === 'apify') next = job.scrape ? await stepFetch(sb, job, deadline) : await stepApify(sb, job);
        else if (status === 'save') next = await stepSave(sb, job);
        else if (status === 'thumbs') next = (await stepThumbs(sb, job)) ? 'thumbs' : 'stats';
        else if (status === 'stats') next = await stepStats(sb, job);
        else if (status === 'comments')
          next = job.scrape ? await stepCommentsSc(sb, job, deadline) : await stepComments(sb, job);
        else if (status === 'texts') next = (await stepTexts(sb, job, deadline)) ? 'texts' : 'tag';
        else if (status === 'tag') next = (await stepTag(sb, job, deadline)) ? 'tag' : 'breakdown';
        else if (status === 'breakdown') next = (await stepBreakdown(sb, job, deadline)) ? 'breakdown' : 'synth';
        else if (status === 'synth') next = await stepSynth(sb, job);
      } catch (e) {
        if (!AI_STEPS.includes(status)) throw e;
        // AI part failed: keep the numbers, note the error, go on to the next AI step
        const msg = `${status}: ${errMsg(e)}`;
        job.ai_error = job.ai_error ? `${job.ai_error} · ${msg}` : msg;
        await setJob(sb, jobId, { ai_error: job.ai_error });
        next = AI_STEPS[AI_STEPS.indexOf(status) + 1] ?? 'done';
      }

      if (next !== status) {
        await setJob(sb, jobId, { status: next });
        job.status = next;
        status = next;
      } else if (status === 'apify' || status === 'comments') {
        break; // runs still going on Apify's side / ScrapeCreators: out of time or waiting to retry
      }
    }
  } catch (e) {
    await failJob(sb, jobId, errMsg(e));
  } finally {
    await sb.from('analysis_jobs').update({ locked_until: null }).eq('id', jobId);
  }
  return true;
}

// --- ScrapeCreators collection ------------------------------------------------------------

async function saveFetch(sb: SupabaseClient, job: AnalysisJob) {
  await setJob(sb, job.id, { scrape: job.scrape });
}

const retryWait = (fails: number) => Math.min(60_000, RETRY_GAP_MS * fails);

/** Profile + feed pages until the period start. Posts are saved page by page. */
async function stepFetch(sb: SupabaseClient, job: AnalysisJob, deadline: number): Promise<AnalysisStatus> {
  const f = job.scrape!;
  if (f.retry_at && Date.now() < f.retry_at) return 'apify';
  const until = deadline - 3_000;
  try {
    if (!f.profile) {
      const profile = await scProfile(job.username, { until });
      if (profile.isPrivate) {
        await failJob(sb, job.id, 'Аккаунт закрытый — посты не видны.');
        return 'failed';
      }
      f.profile = profile;
      await saveFetch(sb, job);
    }
    const sinceMs = new Date(f.since).getTime();
    while (!f.done && Date.now() < deadline - 6_000) {
      const page = await scPostsPage(job.username, f.cursor, { until });
      const keep = page.items.filter(
        (it) => it.isPinned || !it.timestamp || new Date(it.timestamp).getTime() >= sinceMs
      );
      if (keep.length) await upsertPosts(sb, postRows(job, keep));
      if (!f.newest) f.newest = page.items.find((it) => !it.isPinned && it.timestamp)?.timestamp ?? null;
      f.pages += 1;
      f.posts += keep.length;
      f.cursor = page.next;
      f.fails = 0;
      f.retry_at = undefined;
      f.last_error = undefined;
      // pinned posts sit on top of the first page, so the last item tells where the page ends
      const last = page.items[page.items.length - 1];
      const pastPeriod = !!last?.timestamp && new Date(last.timestamp).getTime() < sinceMs && !last.isPinned;
      if (!page.next || !page.items.length || pastPeriod || f.posts >= (f.limit ?? MAX_POSTS)) f.done = true;
      // full collection: estimate the year from the first page, ask when it is big
      if (job.mode === 'full' && f.pages === 1 && f.limit == null) {
        f.estimate = estimateYear(page.items, sinceMs, f.profile?.postsCount ?? null);
        if (!f.done && f.estimate.year > CONFIRM_ABOVE) {
          await saveFetch(sb, job);
          return 'confirm';
        }
      }
      await saveFetch(sb, job);
    }
  } catch (e) {
    if (e instanceof ScFatal) {
      await failJob(sb, job.id, e.message);
      return 'failed';
    }
    if (e instanceof ScNotFound && !f.profile) {
      await failJob(sb, job.id, 'Профиль не найден.');
      return 'failed';
    }
    f.fails += 1;
    f.last_error = errMsg(e);
    if (f.fails >= FEED_ROUNDS) {
      f.fails = 0;
      f.retry_at = undefined;
      await saveFetch(sb, job);
      await failJob(
        sb,
        job.id,
        `ScrapeCreators не отдаёт ${f.profile ? 'ленту' : 'профиль'} (${f.last_error}). Собрано постов: ${f.posts}. ` +
          'Нажми «Повторить» — сбор продолжится с этого места.'
      );
      return 'failed';
    }
    f.retry_at = Date.now() + retryWait(f.fails);
    await saveFetch(sb, job);
    return 'apify';
  }
  return f.done ? 'save' : 'apify';
}

/** Posts a year from the first feed page (12 newest): rate since the 12th post × 365. */
function estimateYear(items: PostItem[], sinceMs: number, total: number | null): PostsEstimate {
  const times = items
    .filter((it) => !it.isPinned && it.timestamp)
    .map((it) => new Date(it.timestamp!).getTime())
    .sort((a, b) => b - a);
  if (!times.length) return { year: 0, per_day: 0, total, exact: true };
  const inYear = times.filter((t) => t >= sinceMs).length;
  if (inYear < times.length) return { year: inYear, per_day: +(inYear / 365).toFixed(2), total, exact: true };
  const days = Math.max(1, (Date.now() - times[times.length - 1]) / DAY);
  const perDay = times.length / days;
  const year = Math.round(Math.min(total ?? Infinity, perDay * 365));
  return { year, per_day: +perDay.toFixed(1), total, exact: false };
}

/** Big account: start the collection with the chosen limit (number of newest posts or 'all'). */
export async function confirmCollection(sb: SupabaseClient, jobId: string, limit: number | 'all') {
  const { data: job } = await sb.from('analysis_jobs').select(JOB_COLS).eq('id', jobId).maybeSingle<AnalysisJob>();
  if (!job || job.status !== 'confirm' || !job.scrape) throw new Error('Сбор уже не ждёт выбора.');
  const n = limit === 'all' ? LIMIT_ALL : Math.max(12, Math.min(LIMIT_ALL, Math.round(limit)));
  const scrape: FetchState = { ...job.scrape, limit: n };
  // the limit is already reached by the first page (tiny limit) → nothing more to page
  if (scrape.posts >= n) scrape.done = true;
  await setJob(sb, jobId, { status: 'apify', scrape });
}

export async function cancelCollection(sb: SupabaseClient, jobId: string) {
  const { data: job } = await sb.from('analysis_jobs').select('status').eq('id', jobId).maybeSingle();
  if (job?.status !== 'confirm') return;
  await setJob(sb, jobId, { status: 'failed', error: 'Сбор отменён.' });
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

function postRows(job: AnalysisJob, items: PostItem[]) {
  return items.map((it) => {
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
      slide_urls:
        kind === 'carousel'
          ? (it.childPosts?.map((c) => c.displayUrl).filter((u): u is string => !!u) ?? it.images ?? []).slice(0, 20)
          : [],
    };
  });
}

async function upsertPosts(sb: SupabaseClient, rows: ReturnType<typeof postRows>) {
  for (let i = 0; i < rows.length; i += 300) {
    const { error } = await sb
      .from('analysis_posts')
      .upsert(rows.slice(i, i + 300), { onConflict: 'job_id,shortcode', ignoreDuplicates: true });
    if (error) throw new Error(`Сохранение постов: ${error.message}`);
  }
}

async function stepSave(sb: SupabaseClient, job: AnalysisJob): Promise<AnalysisStatus> {
  // profile
  const [profile] = job.scrape
    ? [job.scrape.profile as ProfileItem | undefined]
    : await getDataset<ProfileItem>(job.profile_dataset_id!);
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

  // posts — ScrapeCreators: already saved page by page
  if (job.scrape) {
    const { data: saved } = await sb.from('analysis_posts').select('shortcode').eq('job_id', job.id).limit(10000);
    const fresh = new Set((saved ?? []).map((r) => r.shortcode as string));
    if (!fresh.size && job.mode !== 'update') {
      const newest = job.scrape.newest
        ? ` Самый свежий пост в сетке — ${new Date(job.scrape.newest).toLocaleDateString('ru-RU')}` +
          ' (рилсы, которых нет в сетке, сборщик не видит).'
        : ' Лента профиля пустая.';
      await failJob(sb, job.id, `За последний год постов нет.${newest}`);
      return 'failed';
    }
    if (job.mode === 'update' && job.base_job_id) await carryOver(sb, job, fresh);
    return 'thumbs';
  }
  const items = (await getDataset<PostItem>(job.posts_dataset_id!)).filter((it) => it.shortCode && !it.error);
  if (!items.length && job.mode !== 'update') {
    await failJob(sb, job.id, 'Apify не вернул ни одного поста (аккаунт закрыт или пуст за год).');
    return 'failed';
  }
  const seen = new Set<string>();
  const unique = items.filter((it) => !seen.has(it.shortCode!) && seen.add(it.shortCode!));
  await upsertPosts(sb, postRows(job, unique));
  // comments that came with the posts (free) — the audience block uses them
  const comments = items.flatMap((it) =>
    (it.latestComments ?? []).map((c) => commentRow(job.id, it.shortCode!, c))
  );
  await insertComments(sb, comments);

  if (job.mode === 'update' && job.base_job_id) await carryOver(sb, job, seen);
  return 'thumbs';
}

function commentRow(jobId: string, shortcode: string, c: CommentItem) {
  return {
    job_id: jobId,
    shortcode,
    text: (c.text ?? '').slice(0, 1000),
    likes: num(c.likesCount),
    owner: c.ownerUsername?.toLowerCase() ?? null,
    posted_at: c.timestamp ?? null,
  };
}

async function insertComments(sb: SupabaseClient, rows: ReturnType<typeof commentRow>[]) {
  const clean = rows.filter((r) => r.text.trim());
  for (let i = 0; i < clean.length; i += 500) {
    const { error } = await sb.from('analysis_comments').insert(clean.slice(i, i + 500));
    if (error) throw new Error(`Сохранение комментариев: ${error.message}`);
  }
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

  // re-collected posts keep the AI results of the previous dossier (numbers are fresh)
  for (const p of old.filter((x) => fresh.has(x.shortcode) && (x.tagged || x.text_done || x.breakdown))) {
    const patch: Record<string, unknown> = {};
    for (const k of AI_FIELDS) patch[k] = p[k];
    await sb.from('analysis_posts').update(patch).eq('job_id', job.id).eq('shortcode', p.shortcode);
  }

  // comments of the previous dossier (fresh ones of the same posts were added above)
  const { data: oldComments } = await sb
    .from('analysis_comments')
    .select('shortcode,text,likes,owner,posted_at')
    .eq('job_id', job.base_job_id!)
    .limit(5000);
  const have = new Set(
    ((await sb.from('analysis_comments').select('shortcode,text').eq('job_id', job.id).limit(5000)).data ?? []).map(
      (c) => `${c.shortcode}|${c.text}`
    )
  );
  await insertComments(
    sb,
    (oldComments ?? [])
      .filter((c) => !have.has(`${c.shortcode}|${c.text}`))
      .map((c) => ({ ...c, job_id: job.id }))
  );
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
  job.stats = stats;
  return 'comments';
}

// --- stage 2: AI ---------------------------------------------------------------------------

/** Posts of the job with their ratio, best first (pinned posts older than the period skipped). */
async function rankedPosts(sb: SupabaseClient, job: AnalysisJob): Promise<(AnalysisPost & { ratio: number | null })[]> {
  const fromMs = new Date(job.period_from).getTime();
  const posts = await loadPosts(sb, job.id);
  return posts
    .filter((p) => !p.posted_at || new Date(p.posted_at).getTime() >= fromMs)
    .map((p) => ({ ...p, ratio: job.stats ? ratioOf(p, job.stats) : null }))
    .sort((a, b) => (b.ratio ?? -1) - (a.ratio ?? -1));
}

const textOf = (p: AnalysisPost) => p.transcript || p.ocr_text || null;

function forAI(p: AnalysisPost & { ratio: number | null }): PostForAI {
  return { sc: p.shortcode, kind: p.kind, caption: p.caption, text: textOf(p), metric: metricOf(p), ratio: p.ratio };
}

async function stepComments(sb: SupabaseClient, job: AnalysisJob): Promise<AnalysisStatus> {
  if (!job.comments_run_id) {
    if (!COMMENT_POSTS) return 'texts';
    const ranked = await rankedPosts(sb, job);
    const { data: have } = await sb.from('analysis_comments').select('shortcode').eq('job_id', job.id).limit(10000);
    const counts = new Map<string, number>();
    for (const c of have ?? []) counts.set(c.shortcode, (counts.get(c.shortcode) ?? 0) + 1);
    const targets = ranked
      .filter((p) => (p.comments ?? 0) > 0 && (counts.get(p.shortcode) ?? 0) < Math.min(10, COMMENTS_PER_POST))
      .slice(0, COMMENT_POSTS);
    if (!targets.length) return 'texts';
    const run = await startComments(
      targets.map((p) => p.url),
      COMMENTS_PER_POST
    );
    job.comments_run_id = run.id;
    job.comments_dataset_id = run.defaultDatasetId;
    await setJob(sb, job.id, { comments_run_id: run.id, comments_dataset_id: run.defaultDatasetId });
    return 'comments';
  }
  const run = await getRun(job.comments_run_id);
  if (RUN_FAILED.includes(run.status)) throw new Error(`Apify (комментарии): ${run.status}`);
  if (run.status !== 'SUCCEEDED') return 'comments';

  const items = await getDataset<CommentItem & { error?: string }>(job.comments_dataset_id!);
  const posts = await loadPosts(sb, job.id);
  const byCode = new Map(posts.map((p) => [p.shortcode, p.shortcode]));
  const scOf = (url?: string) => {
    const m = (url ?? '').match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
    return m ? byCode.get(m[1]) ?? null : null;
  };
  const { data: have } = await sb.from('analysis_comments').select('shortcode,text').eq('job_id', job.id).limit(10000);
  const seen = new Set((have ?? []).map((c) => `${c.shortcode}|${c.text}`));
  const rows = items
    .filter((c) => !c.error && c.text)
    .map((c) => ({ sc: scOf(c.postUrl), c }))
    .filter((x): x is { sc: string; c: CommentItem } => !!x.sc)
    .map((x) => commentRow(job.id, x.sc, x.c))
    .filter((r) => !seen.has(`${r.shortcode}|${r.text}`) && seen.add(`${r.shortcode}|${r.text}`));
  await insertComments(sb, rows);
  return 'texts';
}

/**
 * ScrapeCreators comments: up to COMMENTS_PER_POST (2 pages) for each top post. A post whose
 * comments did not come goes back in line and is retried after a pause (COMMENT_ROUNDS);
 * still failing → skipped and noted. Returns 'comments' while there is work or a wait.
 */
async function stepCommentsSc(sb: SupabaseClient, job: AnalysisJob, deadline: number): Promise<AnalysisStatus> {
  if (!COMMENT_POSTS) return 'texts';
  const f = job.scrape!;
  const posts = await loadPosts(sb, job.id);
  const urlOf = new Map(posts.map((p) => [p.shortcode, p.url]));
  const { data: have } = await sb.from('analysis_comments').select('shortcode,text').eq('job_id', job.id).limit(10000);
  const counts = new Map<string, number>();
  const seen = new Set<string>();
  for (const c of have ?? []) {
    counts.set(c.shortcode, (counts.get(c.shortcode) ?? 0) + 1);
    seen.add(`${c.shortcode}|${c.text}`);
  }

  if (!f.comments) {
    // fixed list on the first call, so posts that finish do not pull in new ones
    const ranked = await rankedPosts(sb, job);
    const targets = ranked
      .filter((p) => (p.comments ?? 0) > 0 && (counts.get(p.shortcode) ?? 0) < Math.min(10, COMMENTS_PER_POST))
      .slice(0, COMMENT_POSTS)
      .map((p) => p.shortcode);
    f.comments = { targets, done: [], fails: {} };
    await saveFetch(sb, job);
  }
  const c = f.comments;
  const left = c.targets.filter((sc) => !c.done.includes(sc) && (c.fails[sc]?.n ?? 0) < COMMENT_ROUNDS);
  if (!left.length) {
    const missed = c.targets.filter((sc) => !c.done.includes(sc));
    if (missed.length) {
      const msg = `комментарии не пришли у ${missed.length} из ${c.targets.length} топ-постов (ScrapeCreators не ответил)`;
      job.ai_error = job.ai_error ? `${job.ai_error} · ${msg}` : msg;
      await setJob(sb, job.id, { ai_error: job.ai_error });
    }
    return 'texts';
  }
  // first-try posts first, then the «to finish» ones whose pause is over
  const now = Date.now();
  const ready = left
    .filter((sc) => !c.fails[sc] || now - c.fails[sc].at >= retryWait(c.fails[sc].n))
    .sort((a, b) => (c.fails[a]?.n ?? 0) - (c.fails[b]?.n ?? 0));
  if (!ready.length) return 'comments';

  const pages = Math.max(1, Math.ceil(COMMENTS_PER_POST / SC_COMMENT_PAGE));
  const until = deadline - 3_000;
  let next = 0;
  const worker = async () => {
    while (next < ready.length && Date.now() < deadline - 8_000) {
      const sc = ready[next++];
      const url = urlOf.get(sc) ?? `https://www.instagram.com/p/${sc}/`;
      try {
        const got: CommentItem[] = [];
        let cursor: string | null = null;
        for (let i = 0; i < pages; i++) {
          const page = await scCommentsPage(url, cursor, { until });
          got.push(...page.items);
          cursor = page.next;
          if (!cursor) break;
        }
        const rows = got
          .map((it) => commentRow(job.id, sc, it))
          .filter((r) => !seen.has(`${r.shortcode}|${r.text}`) && seen.add(`${r.shortcode}|${r.text}`));
        await insertComments(sb, rows);
        c.done.push(sc);
        delete c.fails[sc];
      } catch (e) {
        if (e instanceof ScFatal) throw e;
        c.fails[sc] = { n: (c.fails[sc]?.n ?? 0) + 1, at: Date.now(), err: errMsg(e).slice(0, 200) };
      }
    }
  };
  await Promise.all(Array.from({ length: SC_CONCURRENCY }, worker));
  await saveFetch(sb, job);
  return 'comments';
}

/** Speech of the top reels + slide text of the top carousels. true = more to do. */
async function stepTexts(sb: SupabaseClient, job: AnalysisJob, deadline: number): Promise<boolean> {
  const ranked = await rankedPosts(sb, job);
  const reels = ranked.filter((p) => p.kind === 'reel').slice(0, TRANSCRIBE_TOP);
  const carousels = ranked.filter((p) => p.kind === 'carousel').slice(0, OCR_TOP);
  // to do: never tried, or tried but no text came out and the cover was not read yet
  const noSpeech = (p: AnalysisPost) => !p.transcript || p.transcript.length < 20;
  const todo = [...reels, ...carousels].filter(
    (p) => !p.text_done || (p.ocr_text == null && (p.kind === 'carousel' || noSpeech(p)) && !!p.display_url)
  );
  if (!todo.length) return false;

  let next = 0;
  const worker = async () => {
    while (next < todo.length && Date.now() < deadline) {
      const p = todo[next++];
      const patch: Partial<AnalysisPost> = { text_done: true };
      if (p.kind === 'reel' && p.video_url && !p.text_done) {
        try {
          const t = await transcribe(p.video_url);
          if (t != null) patch.transcript = t;
        } catch {
          /* expired link / too big */
        }
      }
      const speech = patch.transcript ?? p.transcript;
      // reels with no speech (music + text on screen) and carousels: read the images
      if (p.kind === 'carousel' || !speech || speech.length < 20) {
        const urls = p.kind === 'carousel' && p.slide_urls.length ? p.slide_urls : p.display_url ? [p.display_url] : [];
        try {
          patch.ocr_text = urls.length ? await ocrCarousel(urls) : '';
        } catch {
          patch.ocr_text = ''; // tried — do not loop on it
        }
      }
      await sb.from('analysis_posts').update(patch).eq('id', p.id);
    }
  };
  await Promise.all(Array.from({ length: TEXT_CONCURRENCY }, worker));
  return next < todo.length || todo.length > 0; // re-check on the next round
}

/** Rubric vocabulary (once per account line), then tags for untagged posts. true = more. */
async function stepTag(sb: SupabaseClient, job: AnalysisJob, deadline: number): Promise<boolean> {
  const ranked = await rankedPosts(sb, job);
  if (!job.ai_meta) {
    // a quick update keeps the rubrics of the previous dossier, so tags stay comparable
    let vocab = null;
    if (job.base_job_id) {
      const { data } = await sb.from('analysis_jobs').select('ai_meta').eq('id', job.base_job_id).maybeSingle();
      vocab = data?.ai_meta ?? null;
    }
    if (!vocab) {
      const { data: acc } = await sb.from('analysis_accounts').select('biography').eq('username', job.username).maybeSingle();
      const top = ranked.slice(0, 60);
      const rest = ranked.slice(60);
      const step = Math.max(1, Math.floor(rest.length / 90));
      const sample = [...top, ...rest.filter((_, i) => i % step === 0).slice(0, 90)];
      vocab = await discoverVocab(sample.map(forAI), acc?.biography ?? null);
    }
    job.ai_meta = vocab;
    await setJob(sb, job.id, { ai_meta: vocab });
  }
  const untagged = ranked.filter((p) => !p.tagged);
  if (!untagged.length) return false;

  const batches: (typeof untagged)[] = [];
  for (let i = 0; i < untagged.length; i += TAG_BATCH) batches.push(untagged.slice(i, i + TAG_BATCH));
  // 3 batches at a time while the step budget lasts; a failed batch is retried in halves,
  // posts that still fail are skipped (tagged without tags) so the step never stalls
  const save = async (batch: typeof untagged, tags: Awaited<ReturnType<typeof tagPosts>>) => {
    const byCode = new Map(tags.map((t) => [t.sc, t]));
    await Promise.all(
      batch.map((p) => {
        const t = byCode.get(p.shortcode);
        return sb
          .from('analysis_posts')
          .update(
            t
              ? { tagged: true, title_ru: t.title, rubric: t.rubric, hook: t.hook, format: t.format, breadth: t.breadth, first_line: t.first_line }
              : { tagged: true }
          )
          .eq('id', p.id);
      })
    );
  };
  const run = async (batch: typeof untagged, depth = 0): Promise<void> => {
    try {
      const tags = await tagPosts(batch.map(forAI), job.ai_meta!);
      const got = new Set(tags.map((t) => t.sc));
      const missing = batch.filter((p) => !got.has(p.shortcode));
      // posts the model skipped / broke get one more try on their own
      await save(depth < 2 ? batch.filter((p) => got.has(p.shortcode)) : batch, tags);
      if (missing.length && depth < 2) await run(missing, depth + 1);
    } catch (e) {
      if (depth < 2 && batch.length > 1) {
        const mid = Math.ceil(batch.length / 2);
        await run(batch.slice(0, mid), depth + 1);
        await run(batch.slice(mid), depth + 1);
      } else {
        await save(batch, []);
        const msg = `tag: ${batch.length} пост(ов) без разметки — ${errMsg(e).slice(0, 80)}`;
        job.ai_error = job.ai_error ? `${job.ai_error} · ${msg}` : msg;
        await setJob(sb, job.id, { ai_error: job.ai_error });
      }
    }
  };
  for (let i = 0; i < batches.length && Date.now() < deadline; i += 3) {
    await Promise.all(batches.slice(i, i + 3).map((b) => run(b)));
  }
  return true; // re-check: more batches may be left
}

/** ×4,4 under 10, ×24 / ×1435 above — how × figures appear in texts. */
const fmtR = (r: number | null) =>
  r == null ? '—' : r < 10 ? r.toFixed(1).replace('.', ',') : String(Math.round(r));

const fmtN = (n: number | null) =>
  n == null ? '—' : n >= 1e6 ? `${(n / 1e6).toFixed(2)} млн` : n >= 1e3 ? `${Math.round(n / 1e3)} тыс` : String(Math.round(n));

/** Top reels + carousels without a breakdown, 3 per call. true = more. */
async function stepBreakdown(sb: SupabaseClient, job: AnalysisJob, deadline: number): Promise<boolean> {
  const ranked = await rankedPosts(sb, job);
  const pick = [
    ...ranked.filter((p) => p.kind === 'reel').slice(0, BREAKDOWN_REELS),
    ...ranked.filter((p) => p.kind === 'carousel').slice(0, BREAKDOWN_CAROUSELS),
  ].filter((p) => !p.breakdown && (p.ratio ?? 0) > 0);
  if (!pick.length) return false;
  const s = job.stats!;
  const batch = pick.slice(0, 3);
  if (Date.now() > deadline) return true;
  const result = await breakdownPosts(
    batch.map((p) => ({
      ...forAI(p),
      title: p.title_ru,
      duration: p.duration,
      metric_label: `${p.kind === 'reel' ? `${fmtN(p.views)} просмотров` : `${fmtN(p.likes)} лайков`} (×${fmtR(p.ratio)})`,
      median_label: p.kind === 'reel' ? `${fmtN(s.reels.median)} просмотров` : `${fmtN(s.carousels.median)} лайков`,
    }))
  );
  await Promise.all(
    batch.map((p) =>
      sb
        .from('analysis_posts')
        // empty object = tried; keeps the step from looping on a post the model skipped
        .update({ breakdown: result[p.shortcode] ?? { structure: '', payoff: '', cta: '', why: '', text_ru: '' } })
        .eq('id', p.id)
    )
  );
  return pick.length > batch.length;
}

/** Dossier texts from the numbers / groups computed in code. */
async function stepSynth(sb: SupabaseClient, job: AnalysisJob): Promise<AnalysisStatus> {
  const ranked = await rankedPosts(sb, job);
  const s = job.stats!;
  const { data: acc } = await sb.from('analysis_accounts').select('*').eq('username', job.username).maybeSingle<AnalysisAccount>();
  const { data: comments } = await sb
    .from('analysis_comments')
    .select('text,likes')
    .eq('job_id', job.id)
    .order('likes', { ascending: false, nullsFirst: false })
    .limit(2000);
  const outliers = ranked.filter((p) => (p.ratio ?? 0) >= 2);
  const rubrics = groupStats(ranked, (p) => p.rubric, s);
  const hooksTop = groupStats(outliers, (p) => p.hook, s);
  const formats = groupStats(ranked, (p) => p.format, s);
  const breadthTop = groupStats(outliers, (p) => p.breadth, s);
  const g = (list: typeof rubrics) =>
    list
      .map((x) => `${x.name}: ${x.count} постов (${x.share}%), медиана ${fmtN(x.median_metric)} ${x.metric_kind === 'views' ? 'просм.' : 'лайков'}, ×${fmtR(x.median_ratio)} к медиане аккаунта`)
      .join('\n');
  const line = (p: (typeof ranked)[number]) =>
    `[${p.shortcode}] ${p.kind} ${p.posted_at?.slice(0, 10) ?? ''} · ${p.kind === 'reel' ? `${fmtN(p.views)} просм.` : `${fmtN(p.likes)} лайков`} · ×${fmtR(p.ratio)}` +
    `${p.duration ? ` · ${Math.round(p.duration)} с` : ''} · ${p.rubric ?? '—'} · заход: ${p.hook ?? '—'} · ${p.format ?? '—'} · ${p.breadth ?? '—'}` +
    `${p.coauthors.length ? ` · коллаб @${p.coauthors.join(', @')}` : ''}${p.has_cta ? ' · есть призыв' : ''}\n  «${p.title_ru ?? ''}» первая фраза: ${p.first_line ?? '—'}` +
    `\n  подпись: ${(p.caption ?? '').replace(/\s+/g, ' ').slice(0, 200)}` +
    (p.breakdown?.why ? `\n  почему залетел: ${p.breakdown.why}` : '');
  const cms = (comments ?? []).map((c) => c.text.replace(/\s+/g, ' ').slice(0, 160));

  const context = `PROFILE
@${job.username}${acc?.full_name ? ` (${acc.full_name})` : ''}, ${fmtN(acc?.followers ?? null)} подписчиков, ${acc?.posts_count ?? '—'} публикаций всего
категория: ${acc?.category ?? '—'}
био: ${acc?.biography ?? '—'}
ссылка: ${acc?.external_url ?? '—'}

NUMBERS (period ${s.period.from.slice(0, 10)} — ${s.period.to.slice(0, 10)}, ${s.total} posts)
Reels: ${s.reels.count}, медиана ${fmtN(s.reels.median)} просм., залётов (≥2×) ${s.reels.outliers}, ${s.reels.per_week} в неделю, тренд месяца ×${fmtR(s.reels.trend)}, лайков от просмотров ${s.reels.likes_pct ?? '—'}%, комментов на 1000 просмотров ${s.reels.comments_per_1000 ?? '—'}, медиана длины ${s.reels.median_duration ?? '—'} с (у залётов ${s.reels.outliers_median_duration ?? '—'} с)
Карусели: ${s.carousels.count}, медиана ${fmtN(s.carousels.median)} лайков, залётов ${s.carousels.outliers}, ${s.carousels.per_week} в неделю, медиана слайдов ${s.carousels.median_slides ?? '—'}
Фото: ${s.photos.count}
Постов в неделю всего: ${s.per_week}; с призывом в подписи: ${s.cta_pct}%; коллабы: ${s.collab_pct}%; ER: ${s.engagement_pct ?? '—'}%

RUBRICS (all posts)
${g(rubrics)}

RUBRICS — reels only (views)
${g(groupStats(ranked.filter((p) => p.kind === 'reel'), (p) => p.rubric, s)) || '—'}

RUBRICS — carousels only (likes)
${g(groupStats(ranked.filter((p) => p.kind === 'carousel'), (p) => p.rubric, s)) || '—'}

FORMATS (all posts)
${g(formats)}

AMONG OUTLIERS (≥ ×2, ${outliers.length} posts) — hooks:
${g(hooksTop)}
broad / narrow:
${g(breadthTop)}

TOP 30 POSTS
${ranked.slice(0, 30).map(line).join('\n')}

WEAKEST 25 POSTS
${ranked.filter((p) => p.ratio != null).slice(-25).map(line).join('\n')}

COMMENTS (${cms.length} collected, most liked first; sample)
${cms.slice(0, 220).map((c) => `- ${c}`).join('\n') || '(no comments)'}`;

  const ai = await synthesize(context);
  job.ai = ai;
  await setJob(sb, job.id, { ai });
  return 'done';
}

// --- read ------------------------------------------------------------------------------------

async function progressOf(sb: SupabaseClient, job: AnalysisJob): Promise<string | null> {
  if (job.status === 'apify') {
    const f = job.scrape;
    if (!f) return job.mode === 'update' ? 'Apify собирает новые посты…' : 'Apify собирает профиль и посты за год…';
    const what = job.mode === 'update' ? 'новые посты' : 'посты за год';
    const retry = f.fails ? ` · не ответил, повтор ${f.fails} из ${FEED_ROUNDS - 1}…` : '';
    return f.profile ? `Собираю ${what}: ${f.posts}${retry}` : `Собираю профиль…${retry}`;
  }
  if (job.status === 'save') return 'Сохраняю посты…';
  if (job.status === 'stats') return 'Считаю цифры…';
  if (job.status === 'comments') {
    const c = job.scrape?.comments;
    if (!c) return 'AI-разбор: собираю комментарии…';
    const wait = Object.keys(c.fails).length;
    return `AI-разбор: комментарии ${c.done.length} из ${c.targets.length}${wait ? ` · доделываю ${wait}` : ''}…`;
  }
  if (job.status === 'texts') return 'AI-разбор: расшифровываю топовые ролики и карусели…';
  if (job.status === 'tag') {
    const [{ count: total }, { count: done }] = await Promise.all([
      sb.from('analysis_posts').select('id', { count: 'exact', head: true }).eq('job_id', job.id),
      sb.from('analysis_posts').select('id', { count: 'exact', head: true }).eq('job_id', job.id).eq('tagged', true),
    ]);
    return `AI-разбор: размечаю посты ${done ?? 0} из ${total ?? 0}…`;
  }
  if (job.status === 'breakdown') return 'AI-разбор: разбираю топовые посты…';
  if (job.status === 'synth') return 'AI-разбор: пишу досье…';
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
              estimate: j.status === 'confirm' ? j.scrape?.estimate ?? null : null,
              collected: j.scrape?.posts ?? 0,
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
  const stats = job.stats;
  const posts = await loadPosts(sb, job.id);
  const fromMs = new Date(stats.period.from).getTime();
  const inPeriod = posts.filter((p) => !p.posted_at || new Date(p.posted_at).getTime() >= fromMs);

  // № = place by ratio across all posts
  const ranked = posts
    .map((p) => ({ sc: p.shortcode, r: ratioOf(p, stats) }))
    .sort((a, b) => (b.r ?? -1) - (a.r ?? -1));
  const rankOf = new Map(ranked.map((x, i) => [x.sc, i + 1]));

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
    ratio: ratioOf(p, stats),
    rank: rankOf.get(p.shortcode) ?? 0,
    title_ru: p.title_ru,
    rubric: p.rubric,
    hook: p.hook,
    format: p.format,
    breadth: p.breadth,
    first_line: p.first_line,
    has_text: !!(p.transcript || p.ocr_text),
    breakdown: p.breakdown && (p.breakdown.structure || p.breakdown.text_ru) ? p.breakdown : null,
  }));

  const outliers = inPeriod.filter((p) => (ratioOf(p, stats) ?? 0) >= 2);
  const { count: commentsCount } = await sb
    .from('analysis_comments')
    .select('id', { count: 'exact', head: true })
    .eq('job_id', job.id);

  return {
    account: { ...account, avatar: publicUrl(sb, account.avatar_path, account.updated_at) },
    job,
    stats,
    posts: rows,
    ai: job.ai,
    ai_running: ACTIVE.includes(job.status),
    ai_error: job.ai_error,
    rubrics: byKind(inPeriod, (list) => groupStats(list, (p) => p.rubric, stats)),
    hooks_top: byKind(outliers, (list) => groupStats(list, (p) => p.hook, stats)),
    rubrics_top: byKind(outliers, (list) => groupStats(list, (p) => p.rubric, stats)),
    comments_count: commentsCount ?? 0,
  };
}

/** Same grouping for all posts and for each content type separately. */
function byKind<T>(posts: AnalysisPost[], fn: (list: AnalysisPost[]) => T): Record<KindTab, T> {
  return {
    all: fn(posts),
    reel: fn(posts.filter((p) => p.kind === 'reel')),
    carousel: fn(posts.filter((p) => p.kind === 'carousel')),
    photo: fn(posts.filter((p) => p.kind === 'photo')),
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
