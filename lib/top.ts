// SamSpy — Top Reels refresh logic (shared)
//
// Pulls the Instagram 48h top-reels digest from Virlo ($0.25) and caches it
// into `reels` with source='top'. Used by both the manual "Refresh" button
// (POST /api/top) and the daily cron.
//
// Version history:
//   v0.1.0 (2026-11-17) — extracted so cron + button share one implementation.

import type { SupabaseClient } from '@supabase/supabase-js';
import { instagramDigest } from './virlo';

export interface TopRefreshResult {
  fetched: number;
  cached: number;
  refreshedAt: string;
}

/**
 * Fetch a fresh Instagram top-reels digest and upsert into `reels`.
 * Costs $0.25 per call (one Virlo request). Returns counts.
 */
export async function refreshTopReels(
  supabase: SupabaseClient,
  limit = 60
): Promise<TopRefreshResult> {
  const items = await instagramDigest(limit);
  const now = new Date().toISOString();

  if (!items || items.length === 0) {
    return { fetched: 0, cached: 0, refreshedAt: now };
  }

  const rows = items.map((it) => ({
    source: 'top' as const,
    url: it.url,
    external_id: it.external_id ?? null,
    thumbnail_url: it.thumbnail_url ?? null,
    caption: it.description ?? null,
    author_username: null, // digest gives author_id, not a handle
    views: it.views ?? 0,
    likes: it.number_of_likes ?? 0,
    comments: it.number_of_comments ?? 0,
    hashtags: it.hashtags ?? [],
    outlier_ratio: null,
    is_outlier: false,
    published_at: it.publish_date ?? null,
    last_synced_at: now,
  }));

  const { data: upserted, error } = await supabase
    .from('reels')
    .upsert(rows, { onConflict: 'url' })
    .select('id');

  if (error) throw error;

  return {
    fetched: items.length,
    cached: upserted?.length ?? 0,
    refreshedAt: now,
  };
}
