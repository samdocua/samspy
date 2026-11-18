// SamSpy — carousel text collector: row types (mirror supabase/migration-004.sql)
//
// Version history:
//   v0.4.0 (2026-11-18) — jobs, posts, job↔post links, slides.

export type CarouselJobStatus = 'apify' | 'ocr' | 'check' | 'escalate' | 'done' | 'failed';

export interface CarouselJob {
  id: string;
  status: CarouselJobStatus;
  urls: string[];
  apify_run_id: string | null;
  apify_dataset_id: string | null;
  error: string | null;
  locked_until: string | null;
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
}
