// SamSpy — database row types (mirror supabase/schema.sql)
//
// Version history:
//   v0.1.0 (2026-11-17) — niches, competitors, reels, reel_snapshots.

export interface Niche {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  sort_order: number;
  created_at: string;
}

export type VirloStatus = 'pending' | 'active' | 'paused' | 'failed' | 'deleted';

export type Platform = 'instagram' | 'tiktok';

export interface Competitor {
  id: string;
  platform: Platform;
  niche_id: string | null;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  bio: string | null;
  is_verified: boolean;
  virlo_creator_id: string | null;
  virlo_status: VirloStatus;
  scrape_cadence: string;
  latest_followers: number | null;
  median_views: number | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export type ReelSource = 'competitor' | 'search' | 'top';

export interface Reel {
  id: string;
  platform: Platform;
  source: ReelSource;
  competitor_id: string | null;
  saved_search_id: string | null;
  url: string;
  external_id: string | null;
  thumbnail_url: string | null;
  caption: string | null;
  author_username: string | null;
  author_external_id: string | null;
  views: number;
  likes: number;
  comments: number;
  hashtags: string[];
  outlier_ratio: number | null;
  outlier_weighted_score: number | null;
  is_outlier: boolean;
  published_at: string | null;
  first_seen_at: string;
  last_synced_at: string;
  created_at: string;
}

/** A reel joined with its competitor, for the catalog grid. */
export interface ReelWithCompetitor extends Reel {
  competitor: Pick<
    Competitor,
    'id' | 'username' | 'display_name' | 'avatar_url' | 'niche_id'
  > | null;
}

/** A saved search "block" (tab 2). */
export interface SavedSearch {
  id: string;
  platform: Platform;
  query: string;        // the raw topic string (may contain `|` synonyms)
  label: string | null; // display name for the block
  min_views: number;    // per-block minimum-views display filter
  last_run_at: string | null;
  created_at: string;
}

/** A blacklist entry (per search block, or Top Reels). */
export interface BlacklistEntry {
  id: string;
  scope: 'search' | 'top';
  platform: Platform;
  saved_search_id: string | null;
  username: string | null;
  author_external_id: string | null;
  label: string | null;
  created_at: string;
}

/** A saved-search block decorated with a reel count and a cover thumbnail. */
export interface SavedSearchCard extends SavedSearch {
  reel_count: number;
  cover_url: string | null;
}
