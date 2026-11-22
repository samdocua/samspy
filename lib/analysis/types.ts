// SamSpy — «Анализ»: row + stats types (mirror supabase/migration-006.sql)
//
// Version history:
//   v0.1.0 (2026-11-22) — accounts, jobs, posts, computed stats, card summary.
//   v0.2.0 (2026-11-22) — job mode ('full' | 'update') + base_job_id (migration-007).

export type AnalysisStatus = 'apify' | 'save' | 'thumbs' | 'stats' | 'done' | 'failed';
export type PostKind = 'reel' | 'carousel' | 'photo';
export type JobMode = 'full' | 'update';

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
  created_at: string;
  updated_at: string;
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
    created_at: string;
  } | null;
  updated_at: string;
}

export interface Dossier {
  account: AnalysisAccount & { avatar: string | null };
  job: AnalysisJob;
  stats: AccountStats;
  posts: PostRow[];
}
