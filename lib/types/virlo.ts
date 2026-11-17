// SamSpy — Virlo API response types
//
// Version history:
//   v0.1.0 (2026-11-17) — Types for tracking (creators + posts) and the
//                         Instagram top-reels digest, matching dev.virlo.ai/docs
//                         as of 2026-11-17. Fields we don't use are omitted.

/** Virlo wraps every successful payload in { data: ... } (except /v1/webhooks). */
export interface VirloEnvelope<T> {
  data: T;
}

export interface VirloPagination {
  page: number;
  limit: number;
  total: number;
  total_pages: number;
  has_next_page: boolean;
  has_prev_page: boolean;
}

export interface VirloListEnvelope<T> {
  data: T[];
  pagination: VirloPagination;
}

/** Cadence values Virlo accepts for a tracked creator/video. */
export type VirloCadence =
  | 'six_hours'
  | 'twelve_hours'
  | 'daily'
  | 'every_other_day'
  | 'weekly'
  | 'bi_weekly'
  | 'monthly';

export type VirloPlatform = 'instagram' | 'tiktok' | 'youtube';

/** enrichment_status: report progress on the first/next check. */
export type VirloEnrichmentStatus = 'pending' | 'processing' | 'ready' | 'failed';

/** status: lifecycle of a tracked item. */
export type VirloTrackStatus = 'active' | 'paused' | 'deleted';

// ---------------------------------------------------------------------------
// POST /v1/tracking/creators  (start tracking)
// ---------------------------------------------------------------------------
export interface VirloTrackCreatorResponse {
  id: string;                       // Virlo's creator id (our virlo_creator_id)
  status: VirloTrackStatus;
  message: string;
  pending_jobs?: unknown[];
  finalized?: boolean;
}

// ---------------------------------------------------------------------------
// GET /v1/tracking/creators/:id  (full creator)
// ---------------------------------------------------------------------------
export interface VirloCreator {
  id: string;
  platform: VirloPlatform;
  platform_handle: string;
  profile_url?: string;
  display_name?: string;
  avatar_url?: string | null;
  bio?: string;
  is_verified?: boolean;
  status: VirloTrackStatus;
  scrape_cadence: VirloCadence;
  enrichment_status: VirloEnrichmentStatus;
  latest_followers?: number;
  last_scraped_at?: string;
  next_scrape_at?: string;
  created_at?: string;
}

// ---------------------------------------------------------------------------
// GET /v1/tracking/creators/:id/posts  (stored videos with stats)
//   This is our main source for the catalog.
// ---------------------------------------------------------------------------
export interface VirloCreatorPost {
  id: string;                       // Virlo's internal post id
  tracking_account_id: string;
  platform: VirloPlatform;
  platform_video_id: string;
  url: string;
  title?: string;
  description?: string;
  thumbnail_url?: string;
  publish_date?: string;
  views: number;
  likes: number;
  comments: number;
  shares?: number;                  // 0 on Instagram
  bookmarks?: number;               // 0 on Instagram
  duration_seconds?: number | null;
  hashtags?: string[];
  collected_at?: string;
  is_outlier: boolean;              // true when > 3x median on the storing check
  outlier_ratio: number | null;
  outlier_weighted_score: number | null;
}

// ---------------------------------------------------------------------------
// GET /v1/tracking/creators/:id/signals  (alerts; we use outlier_video)
// ---------------------------------------------------------------------------
export interface VirloSignal {
  id: string;
  type:
    | 'outlier_video'
    | 'follower_spike'
    | 'follower_decline'
    | 'new_subject'
    | 'creator_unreachable';
  severity?: string;
  title?: string;
  payload: {
    url?: string;
    title?: string;
    views?: number;
    platform?: VirloPlatform;
    median_views?: number;
    outlier_ratio?: number;
    weighted_score?: number;
    platform_handle?: string;
    platform_video_id?: string;
  };
  created_at: string;
  read: boolean;
}

// ---------------------------------------------------------------------------
// GET /v1/instagram/videos/digest  (tab 3 — top reels, last 48h)
// ---------------------------------------------------------------------------
export interface VirloInstagramDigestItem {
  id: string;
  url: string;
  platform: 'instagram';
  description?: string;
  publish_date?: string;
  views: number;
  number_of_likes?: number;
  number_of_comments?: number;
  hashtags?: string[];
  thumbnail_url?: string;
  external_id?: string;
  author_id?: string;
  niche?: string;
}
