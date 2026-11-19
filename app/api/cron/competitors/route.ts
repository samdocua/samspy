// SamSpy — GET /api/cron/competitors  (daily competitor sync)
//
// Syncs every active/pending competitor's posts from Virlo into the reels
// catalog. This is FREE on Virlo (getCreator + listCreatorPosts cost nothing).
//
// Split out of the old combined /api/cron/sync so it runs as its own Vercel
// Cron with its own 60s budget — the slow, sequential competitor loop can no
// longer starve the paid search refresh, which now runs as a separate cron at
// a different time.
//
// Version history:
//   v0.2.0 (2026-11-19) — split from /api/cron/sync into a dedicated endpoint.
//
// Auth: requires `?secret=SAMSPY_SECRET` or an `Authorization: Bearer` header.
// Vercel Cron sends the Authorization header automatically when configured
// with a secret; we also accept the query param for manual runs.

import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';
import { syncCompetitor, type SyncResult } from '@/lib/sync';
import type { Competitor } from '@/lib/types/db';

export const maxDuration = 60; // seconds (Vercel hobby limit)
export const dynamic = 'force-dynamic';

function authorized(req: Request): boolean {
  const secret = process.env.SAMSPY_SECRET;
  if (!secret) return false;
  const url = new URL(req.url);
  if (url.searchParams.get('secret') === secret) return true;
  const auth = req.headers.get('authorization');
  return auth === `Bearer ${secret}`;
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const supabase = createServiceClient();

  // Fetch competitors with EXPLICIT columns (a plain `select('*')` was observed
  // to silently drop rows on this project's PostgREST), then filter in JS for
  // the ones Virlo is actively tracking. Robust against that quirk.
  const COLS =
    'id,platform,niche_id,username,display_name,avatar_url,bio,is_verified,' +
    'virlo_creator_id,virlo_status,scrape_cadence,latest_followers,' +
    'median_views,last_synced_at,created_at,updated_at';

  const { data: allRows, error } = await supabase
    .from('competitors')
    .select(COLS)
    .returns<Competitor[]>();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const competitors = (allRows ?? []).filter(
    (c) => c.virlo_status === 'active' || c.virlo_status === 'pending'
  );

  const results: SyncResult[] = [];
  const errors: { username: string; error: string }[] = [];

  // Sequential to stay well under rate limits and the 60s budget.
  for (const c of competitors) {
    try {
      results.push(await syncCompetitor(supabase, c));
    } catch (err) {
      errors.push({
        username: c.username,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return NextResponse.json({
    ok: true,
    competitorsFound: competitors.length,
    synced: results.length,
    reels: results.reduce((n, r) => n + r.reelsUpserted, 0),
    results,
    errors,
    ranAt: new Date().toISOString(),
  });
}
