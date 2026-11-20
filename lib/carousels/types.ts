// SamSpy — carousel text collector: row types (mirror supabase/migration-004.sql)
//
// Version history:
//   v0.4.0 (2026-11-18) — jobs, posts, job↔post links, slides.
//   v0.7.0 (2026-11-20) — migration-005: repeat check fields, outlier, 'stats' job step,
//                         authors cache, posts base list types.

export type CarouselJobStatus =
  | 'apify' | 'ocr' | 'check' | 'escalate' | 'stats' | 'done' | 'failed';

export interface CarouselJob {
  id: string;
  status: CarouselJobStatus;
  urls: string[];
  apify_run_id: string | null;
  apify_dataset_id: string | null;
  error: string | null;
  locked_until: string | null;
  stats_run_id: string | null;
  stats_dataset_id: string | null;
  stats_started_at: string | null;
  created_at: string;
  updated_at: string;
}

export type CarouselPostStatus = 'pending' | 'ready' | 'failed';

export interface LastSplit {
  content: string;
  cta: string;
}

export interface CarouselPost {
  id: string;
  shortcode: string;
  url: string;
  author: string | null;
  posted_at: string | null;
  likes: number | null;
  comments: number | null;
  caption: string | null;
  brand: string | null;
  status: CarouselPostStatus;
  checked: boolean;
  last_split: LastSplit | null;
  error: string | null;
  text_hash: string | null;
  duplicate_of: string | null;   // same text as an earlier post → hidden from the base
  similar_to: string | null;     // ≥ 90% alike an earlier post → marked, stays in the base
  similarity: number | null;     // 0..1
  outlier_ratio: number | null;  // likes ÷ author's median likes
  stats_done: boolean;
  created_at: string;
  updated_at: string;
}

export type SlideRole = 'hook' | 'body' | 'body+cta' | 'cta';
export type SlideCheck = 'ok' | 'flagged' | 'escalated' | 'check_failed' | 'escalate_failed';

export interface CarouselSlide {
  id: string;
  post_id: string;
  idx: number;
  source_url: string;
  image_path: string | null;
  is_video: boolean;
  ocr_done: boolean;
  raw_text: string | null;
  text: string | null;
  cta_text: string | null;
  role: SlideRole | null;
  model: string | null;
  check_status: SlideCheck | null;
  issue: string | null;
  error: string | null;
}

/** Job card for the list (with progress counters). */
export interface CarouselJobCard extends CarouselJob {
  posts_total: number;
  posts_ready: number;
  slides_total: number;
  slides_ocr_done: number;
}

/** Post with its slides (detail view, CSV). image_url = public Storage URL. */
export interface CarouselPostFull extends CarouselPost {
  slides: (CarouselSlide & { image_url: string | null })[];
  /** For duplicate_of / similar_to: the earlier post (author + link). */
  ref?: { id: string; url: string; author: string | null } | null;
}

/** Result of creating a job: how many links were new vs already in the base. */
export interface CreateJobInfo {
  total: number;
  fresh: number;
  existing: number;
}
