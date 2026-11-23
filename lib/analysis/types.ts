// SamSpy — «Анализ»: row + stats types (mirror supabase/migration-006.sql)
//
// Version history:
//   v0.1.0 (2026-11-22) — accounts, jobs, posts, computed stats, card summary.
//   v0.2.0 (2026-11-22) — job mode ('full' | 'update') + base_job_id (migration-007).
//   v0.3.0 (2026-11-22) — stage 2 (migration-008): AI tags / texts / breakdown per post,
//                         comments, dossier texts, rubric + hook stats.
//   v0.3.2 (2026-11-22) — rubric / hook stats per content type (KindTab).
//   v0.4.0 (2026-11-23) — job.scrape: ScrapeCreators collection state (migration-010, column scrape);
//                         status 'apify' now means «collecting» for both scrapers.
//   v0.5.0 (2026-11-23) — status 'confirm': a full collection waits for the post limit when the
//                         year looks big (scrape.estimate / scrape.limit); card.job.estimate.

export type AnalysisStatus =
  | 'confirm'
  | 'apify'
  | 'save'
  | 'thumbs'
  | 'stats'
  | 'comments'
  | 'texts'
  | 'tag'
  | 'breakdown'
  | 'synth'
  | 'done'
  | 'failed';
export type PostKind = 'reel' | 'carousel' | 'photo';

/** One retry record of the «to finish» list: tries so far + time of the last one. */
export interface RetryMark {
  n: number;
  at: number;
  err?: string;
}

export interface PostsEstimate {
  year: number; // posts in the last year (estimate)
  per_day: number;
  total: number | null; // posts of the profile, all time
  exact: boolean; // the first page already reached a year back
}

/** ScrapeCreators collection state (job.scrape); null on Apify jobs. */
export interface FetchState {
  provider: 'sc';
  since: string; // posts older than this are not collected (pinned ones are)
  profile?: import('@/lib/scrape/sc').IgProfile | null;
  cursor?: string | null;
  pages: number;
  posts: number;
  newest?: string | null; // newest non-pinned post seen in the feed (for the «empty» message)
  /** posts a year, estimated from the first feed page (full collection only) */
  estimate?: PostsEstimate;
  /** chosen post limit (full collection of a big account) */
  limit?: number;
  done?: boolean;
  /** failed rounds of the current feed request in a row */
  fails: number;
  retry_at?: number;
  last_error?: string;
  comments?: {
    targets: string[];
    done: string[];
    fails: Record<string, RetryMark>;
  };
}
export type JobMode = 'full' | 'update';
export type KindTab = 'all' | PostKind;

export interface AnalysisJob {
  id: string;
  username: string;
  status: AnalysisStatus;
  mode: JobMode;
  base_job_id: string | null;
  period_from: string;
  profile_run_id: string | null;
  profile_dataset_id: string | null;
  posts_run_id: string | null;
  posts_dataset_id: string | null;
  stats: AccountStats | null;
  error: string | null;
  locked_until: string | null;
  comments_run_id: string | null;
  comments_dataset_id: string | null;
  ai: DossierAI | null;
  ai_meta: Vocab | null;
  ai_error: string | null;
  scrape: FetchState | null;
  created_at: string;
  updated_at: string;
}

export interface Vocab {
  rubrics: { name: string; hint: string }[];
  formats: string[];
}

export interface DossierAI {
  one_liner: string;
  niche_tags: string[];
  about: string;
  audience: string;
  delivery: string;
  sells: { type: string; name: string; visibility: string; note: string }[];
  formula: string;
  works: { title: string; text: string; examples: string[] }[];
  fails: { title: string; text: string; examples: string[] }[];
  model: string;
}

export interface Breakdown {
  structure: string;
  payoff: string;
  cta: string;
  why: string;
  text_ru: string;
}

export interface AnalysisAccount {
  username: string;
  full_name: string | null;
  biography: string | null;
  external_url: string | null;
  followers: number | null;
  follows: number | null;
  posts_count: number | null;
  verified: boolean;
  category: string | null;
  avatar_path: string | null;
  last_job_id: string | null;
  summary: CardSummary | null;
  created_at: string;
  updated_at: string;
}

export interface AnalysisPost {
  id: string;
  job_id: string;
  shortcode: string;
  url: string;
  kind: PostKind;
  posted_at: string | null;
  caption: string | null;
  likes: number | null;
  comments: number | null;
  views: number | null;
  duration: number | null;
  slides: number | null;
  is_pinned: boolean;
  coauthors: string[];
  owner: string | null;
  has_cta: boolean;
  display_url: string | null;
  video_url: string | null;
  thumb_path: string | null;
  thumb_done: boolean;
  slide_urls: string[];
  title_ru: string | null;
  rubric: string | null;
  hook: string | null;
  format: string | null;
  breadth: string | null;
  first_line: string | null;
  tagged: boolean;
  transcript: string | null;
  ocr_text: string | null;
  text_done: boolean;
  breakdown: Breakdown | null;
}

/** Post as sent to the UI: thumbnail URL + ratio to the account median of its kind. */
export interface PostRow {
  shortcode: string;
  url: string;
  kind: PostKind;
  posted_at: string | null;
  caption: string | null;
  likes: number | null;
  comments: number | null;
  views: number | null;
  duration: number | null;
  slides: number | null;
  is_pinned: boolean;
  collab: boolean;
  coauthors: string[];
  has_cta: boolean;
  thumb: string | null;
  ratio: number | null; // reels: views ÷ median views; carousels / photos: likes ÷ median likes
  rank: number; // № by ratio across all posts (1 = best)
  title_ru: string | null;
  rubric: string | null;
  hook: string | null;
  format: string | null;
  breadth: string | null;
  first_line: string | null;
  has_text: boolean; // transcript / slide text exists
  breakdown: Breakdown | null;
}

/** Share of the feed + result of one group (rubric / hook / format). */
export interface GroupStat {
  name: string;
  count: number;
  share: number; // % of posts in the period
  median_metric: number | null; // main format: median views of its reels, else median likes
  metric_kind: 'views' | 'likes';
  metric_count: number; // posts the median is computed from
  median_ratio: number | null;
  top: string[]; // shortcodes of its best posts
}

export interface BestPost {
  shortcode: string;
  value: number;
}

export interface KindStats {
  count: number;
  median: number | null; // reels: views; carousels / photos: likes
  outliers: number; // ≥ 2× median
  best: BestPost | null;
  per_week: number;
  trend: number | null; // median of the last 30 days ÷ median of the rest of the period
  likes_pct: number | null; // reels: likes ÷ views, %
  comments_per_1000: number | null; // reels: per 1000 views; posts: per 1000 likes
  median_duration: number | null; // reels, s
  outliers_median_duration: number | null; // reels, s
  median_slides: number | null; // carousels
}

export interface BucketStat {
  count: number;
  median_ratio: number | null;
}

export interface MonthStat {
  month: string; // YYYY-MM
  posts: number;
  reels: number;
  reels_median_views: number | null;
  posts_median_likes: number | null;
}

export interface AccountStats {
  period: { from: string; to: string; days: number };
  total: number;
  reels: KindStats;
  carousels: KindStats;
  photos: KindStats;
  per_week: number;
  cta_pct: number;
  collab_pct: number;
  pinned: number;
  hidden_likes: number;
  engagement_pct: number | null; // median (likes + comments) ÷ followers, %
  by_weekday: BucketStat[]; // 0 = Monday … 6 = Sunday (Europe/Kyiv)
  by_hour: BucketStat[]; // 0…23 (Europe/Kyiv)
  monthly: MonthStat[];
}

/** Small set of numbers for the account card on the tab's home screen. */
export interface CardSummary {
  median_views: number | null;
  outliers_pct: number | null;
  per_week: number;
  trend: number | null;
  posts: number;
}

/** Card on the home screen: account + its latest job (running or done). */
export interface AccountCard {
  username: string;
  full_name: string | null;
  followers: number | null;
  verified: boolean;
  avatar: string | null;
  summary: CardSummary | null;
  last_job_id: string | null;
  job: {
    id: string;
    status: AnalysisStatus;
    mode: JobMode;
    error: string | null;
    progress: string | null;
    estimate: PostsEstimate | null; // status 'confirm': how many posts a year
    collected: number; // posts already collected (first page)
    created_at: string;
  } | null;
  updated_at: string;
}

export interface Dossier {
  account: AnalysisAccount & { avatar: string | null };
  job: AnalysisJob;
  stats: AccountStats;
  posts: PostRow[];
  ai: DossierAI | null;
  ai_running: boolean;
  ai_error: string | null;
  // groups per content type: 'all' = every post, then only reels / carousels / photos
  rubrics: Record<KindTab, GroupStat[]>; // all posts of the period
  hooks_top: Record<KindTab, GroupStat[]>; // among outliers (≥ ×2)
  rubrics_top: Record<KindTab, GroupStat[]>; // among outliers (≥ ×2)
  comments_count: number;
}
