// SamSpy — Top Reels refresh logic (shared)
//
// Pulls the Instagram 48h top-reels digest from Virlo ($0.25) and caches it
// into `reels` with source='top'. Used by both the manual "Refresh" button
// (POST /api/top) and the daily cron.
//
// Version history:
//   v0.1.0 (2026-11-17) — extracted so cron + button share one implementation.

import type { SupabaseClient } from '@supabase/supabase-js';
import { videoDigest } from './virlo';
import { topBlacklistAuthorIds } from './blacklist';
import type { Platform } from './types/db';

export interface TopRefreshResult {
  fetched: number;
  cached: number;
  refreshedAt: string;
}

/**
 * Fetch a fresh top-videos digest for a platform and upsert into `reels`.
 * Costs $0.25 per call (one Virlo request). Returns counts.
 */
export async function refreshTopReels(
  supabase: SupabaseClient,
  platform: Platform,
  limit = 60
): Promise<TopRefreshResult> {
  const items = await videoDigest(platform, limit);
  const now = new Date().toISOString();

  if (!items || items.length === 0) {
    return { fetched: 0, cached: 0, refreshedAt: now };
  }

  // Drop authors blacklisted for Top on this platform (matched by author id).
  const blocked = await topBlacklistAuthorIds(supabase, platform);
  const kept = blocked.size
    ? items.filter((it) => !it.author_id || !blocked.has(it.author_id))
    : items;

  if (kept.length === 0) {
    return { fetched: items.length, cached: 0, refreshedAt: now };
  }

  const rows = kept.map((it) => ({
    source: 'top' as const,
    platform,
    url: it.url,
    external_id: it.external_id ?? null,
    author_external_id: it.author_id ?? null,
    thumbnail_url: it.thumbnail_url ?? null,
    caption: it.description ?? null,
    // TikTok URLs embed the @handle (tiktok.com/@handle/video/..); Instagram
    // digests expose only author_id, so there it stays null.
    author_username:
      platform === 'tiktok'
        ? (it.url.match(/tiktok\.com\/@([A-Za-z0-9._]+)/)?.[1] ?? null)
        : null,
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
    fetched: kept.length,
    cached: upserted?.length ?? 0,
    refreshedAt: now,
  };
}
