// SamSpy — saved-search refresh logic (tab 2)
//
// Runs a saved search against Virlo's library and caches the results into
// `reels` with source='search' + saved_search_id. Used by both the "create
// block" flow and the daily cron.
//
// Version history:
//   v0.1.0 (2026-11-17) — refreshSavedSearch(): N pages -> reels upsert.
//
// Cost: $0.05 per page of 25 results. Default 2 pages (50 reels) = $0.10.

import type { SupabaseClient } from '@supabase/supabase-js';
import { searchVideos } from './virlo';
import type { VirloSearchVideo } from './types/virlo';
import type { SavedSearch } from './types/db';

/** Default pages pulled per refresh (25 results each). 2 => ~$0.10. */
export const DEFAULT_SEARCH_PAGES = 2;

/** Map one search video to a reels row (source='search'). */
function mapSearchVideo(v: VirloSearchVideo, savedSearchId: string) {
  return {
    source: 'search' as const,
    saved_search_id: savedSearchId,
    competitor_id: null,
    url: v.url,
    external_id: v.id ?? null,
    thumbnail_url: v.thumbnail_url ?? null,
    caption: v.description ?? null,
    author_username: v.author?.username ?? null,
    views: v.views ?? 0,
    likes: v.likes ?? 0,
    comments: v.comments ?? 0,
    hashtags: v.hashtags ?? [],
    outlier_ratio: null, // cross-author; not an author-relative outlier
    outlier_weighted_score: v.virality_score ?? null,
    is_outlier: false,
    published_at: v.publish_date ?? null,
    last_synced_at: new Date().toISOString(),
  };
}

export interface SearchRefreshResult {
  savedSearchId: string;
  query: string;
  fetched: number;
  cached: number;
  pages: number;
}

/**
 * Refresh one saved search: pull up to `pages` pages from Virlo, upsert the
 * results into `reels`, and stamp the search's last_run_at.
 * The block's query string is sent as a single topic (so `|` acts as OR).
 */
export async function refreshSavedSearch(
  supabase: SupabaseClient,
  saved: SavedSearch,
  pages = DEFAULT_SEARCH_PAGES
): Promise<SearchRefreshResult> {
  const all: VirloSearchVideo[] = [];
  let cursor: string | undefined;

  for (let i = 0; i < pages; i++) {
    const page = await searchVideos({
      topics: [saved.query],
      platforms: ['instagram'],
      cursor,
    });
    all.push(...(page.videos ?? []));
    if (!page.has_more || !page.next_cursor) break;
    cursor = page.next_cursor;
  }

  let cached = 0;
  if (all.length > 0) {
    const rows = all.map((v) => mapSearchVideo(v, saved.id));
    const { data, error } = await supabase
      .from('reels')
      .upsert(rows, { onConflict: 'url' })
      .select('id');
    if (error) throw error;
    cached = data?.length ?? 0;
  }

  await supabase
    .from('saved_searches')
    .update({ last_run_at: new Date().toISOString() })
    .eq('id', saved.id);

  return {
    savedSearchId: saved.id,
    query: saved.query,
    fetched: all.length,
    cached,
    pages,
  };
}
