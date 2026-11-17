// SamSpy — sync logic
//
// Pulls a tracked creator's posts from Virlo and upserts them into our
// `reels` catalog, recomputes the creator's median views, and writes a
// metric snapshot per reel. This is the heart of tab 1.
//
// Version history:
//   v0.1.0 (2026-11-17) — syncCompetitor(): posts -> reels upsert + snapshots
//                         + median recompute + competitor rollups.
//   v0.1.1 (2026-11-17) — Instagram often returns views=0 on the first check.
//                         Fall back to LIKES as the outlier basis so the
//                         catalog is usable before views populate. The metric
//                         used (views vs likes) is chosen per creator.

import type { SupabaseClient } from '@supabase/supabase-js';
import { getCreator, listCreatorPosts } from './virlo';
import type { VirloCreatorPost } from './types/virlo';
import type { Competitor } from './types/db';

const OUTLIER_THRESHOLD = Number(
  process.env.NEXT_PUBLIC_DEFAULT_OUTLIER_THRESHOLD ?? 3
);

/** Median of a numeric array (0 for empty). */
function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** Which metric drives the outlier ratio for a creator. */
type OutlierBasis = 'views' | 'likes';

/**
 * Map one Virlo post to a reels-table row.
 * We trust Virlo's outlier fields when present; otherwise we compute a ratio
 * from our own median. When views are missing (common on IG first checks),
 * `basis` is 'likes' and the ratio is computed from likes instead.
 */
function mapPostToReel(
  post: VirloCreatorPost,
  competitorId: string,
  fallbackMedian: number,
  basis: OutlierBasis,
  platform: string
) {
  // Prefer Virlo's own ratio; else compute from our median of the basis metric.
  let ratio = post.outlier_ratio;
  if (ratio == null && fallbackMedian > 0) {
    const value = basis === 'likes' ? (post.likes ?? 0) : (post.views ?? 0);
    ratio = Number((value / fallbackMedian).toFixed(2));
  }
  const isOutlier =
    post.is_outlier || (ratio != null && ratio >= OUTLIER_THRESHOLD);

  return {
    source: 'competitor' as const,
    competitor_id: competitorId,
    platform,
    url: post.url,
    external_id: post.platform_video_id ?? null,
    thumbnail_url: post.thumbnail_url ?? null,
    caption: post.description ?? post.title ?? null,
    views: post.views ?? 0,
    likes: post.likes ?? 0,
    comments: post.comments ?? 0,
    hashtags: post.hashtags ?? [],
    outlier_ratio: ratio ?? null,
    outlier_weighted_score: post.outlier_weighted_score ?? null,
    is_outlier: isOutlier,
    published_at: post.publish_date ?? null,
    last_synced_at: new Date().toISOString(),
  };
}

export interface SyncResult {
  competitorId: string;
  username: string;
  postsFetched: number;
  reelsUpserted: number;
  medianViews: number;
  skipped?: string; // reason if we skipped (e.g. not ready yet)
}

/**
 * Sync one competitor: fetch posts from Virlo, upsert reels, snapshot metrics,
 * recompute median and update competitor rollups.
 *
 * Requires the competitor to have a virlo_creator_id and an enriched creator
 * (enrichment_status === 'ready'); otherwise it's skipped.
 */
export async function syncCompetitor(
  supabase: SupabaseClient,
  competitor: Competitor
): Promise<SyncResult> {
  const base = {
    competitorId: competitor.id,
    username: competitor.username,
    postsFetched: 0,
    reelsUpserted: 0,
    medianViews: competitor.median_views ?? 0,
  };

  if (!competitor.virlo_creator_id) {
    return { ...base, skipped: 'no virlo_creator_id' };
  }

  // Make sure the first Virlo check is done before reading posts.
  const creator = await getCreator(competitor.virlo_creator_id);
  if (creator.enrichment_status !== 'ready') {
    // keep latest profile bits even while enriching
    await supabase
      .from('competitors')
      .update({
        virlo_status: creator.status,
        display_name: creator.display_name ?? competitor.display_name,
        avatar_url: creator.avatar_url ?? competitor.avatar_url,
        bio: creator.bio ?? competitor.bio,
        is_verified: creator.is_verified ?? competitor.is_verified,
        latest_followers: creator.latest_followers ?? competitor.latest_followers,
      })
      .eq('id', competitor.id);
    return { ...base, skipped: `enrichment_status=${creator.enrichment_status}` };
  }

  // Pull the creator's stored posts (Instagram: up to ~90 newest).
  const { data: posts } = await listCreatorPosts(competitor.virlo_creator_id, {
    sort: 'publish_date_desc',
    limit: 200,
  });

  if (!posts || posts.length === 0) {
    return { ...base, skipped: 'no posts' };
  }

  // Recompute our own median over the last 30 posts for outlier context.
  // Instagram's tracking often returns views=0 on early checks, which makes a
  // views-based median useless. If so, fall back to LIKES as the basis.
  const recent = posts.slice(0, 30);
  const medianViews = median(recent.map((p) => p.views ?? 0));
  const medianLikes = median(recent.map((p) => p.likes ?? 0));

  const basis: OutlierBasis = medianViews > 0 ? 'views' : 'likes';
  const fallbackMedian = basis === 'views' ? medianViews : medianLikes;

  // Map + upsert reels (conflict on url -> update metrics in place).
  const rows = posts.map((p) =>
    mapPostToReel(p, competitor.id, fallbackMedian, basis, competitor.platform)
  );

  const { data: upserted, error: upsertErr } = await supabase
    .from('reels')
    .upsert(rows, { onConflict: 'url' })
    .select('id, url, views, likes, comments');

  if (upsertErr) throw upsertErr;

  // Write a metric snapshot per reel (history for the "rising" view).
  if (upserted && upserted.length > 0) {
    const snapshots = upserted.map((r) => ({
      reel_id: r.id,
      views: r.views,
      likes: r.likes,
      comments: r.comments,
    }));
    await supabase.from('reel_snapshots').insert(snapshots);
  }

  // Update competitor rollups.
  await supabase
    .from('competitors')
    .update({
      virlo_status: creator.status,
      display_name: creator.display_name ?? competitor.display_name,
      avatar_url: creator.avatar_url ?? competitor.avatar_url,
      bio: creator.bio ?? competitor.bio,
      is_verified: creator.is_verified ?? competitor.is_verified,
      latest_followers: creator.latest_followers ?? competitor.latest_followers,
      median_views: medianViews,
      last_synced_at: new Date().toISOString(),
    })
    .eq('id', competitor.id);

  return {
    ...base,
    postsFetched: posts.length,
    reelsUpserted: upserted?.length ?? 0,
    medianViews,
  };
}
