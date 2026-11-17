// SamSpy — GET /api/reels  (read the catalog for the grid)
//
// Version history:
//   v0.1.0 (2026-11-17) — Filters: source, niche_id, competitor_id,
//                         min_outlier, min_views, period (days), sort.
//
// Returns reels joined with their competitor, filtered and sorted for the grid.

import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const p = url.searchParams;

  const source = p.get('source') ?? 'competitor';
  const nicheId = p.get('niche_id');
  const competitorId = p.get('competitor_id');
  const minOutlier = Number(p.get('min_outlier') ?? 0);
  const minViews = Number(p.get('min_views') ?? 0);
  const periodDays = p.get('period') ? Number(p.get('period')) : null;
  const sort = p.get('sort') ?? 'outlier'; // outlier | views | recent
  const limit = Math.min(Number(p.get('limit') ?? 60), 200);

  const supabase = createServiceClient();

  let q = supabase
    .from('reels')
    .select(
      `*, competitor:competitors(id, username, display_name, avatar_url, niche_id)`
    )
    .eq('source', source);

  if (competitorId) q = q.eq('competitor_id', competitorId);
  if (minOutlier > 0) q = q.gte('outlier_ratio', minOutlier);
  if (minViews > 0) q = q.gte('views', minViews);
  if (periodDays) {
    const since = new Date(Date.now() - periodDays * 86400000).toISOString();
    q = q.gte('published_at', since);
  }

  // Sorting
  if (sort === 'views') q = q.order('views', { ascending: false });
  else if (sort === 'recent')
    q = q.order('published_at', { ascending: false, nullsFirst: false });
  else q = q.order('outlier_ratio', { ascending: false, nullsFirst: false });

  q = q.limit(limit);

  const { data, error } = await q;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Niche filter is applied after the join (competitor.niche_id).
  let reels = data ?? [];
  if (nicheId) {
    reels = reels.filter(
      (r: { competitor?: { niche_id?: string | null } | null }) =>
        r.competitor?.niche_id === nicheId
    );
  }

  return NextResponse.json({ reels });
}
