// SamSpy — GET /api/cron/sync  (daily catalog refresh)
//
// Pulls fresh posts for every active competitor from Virlo and upserts them
// into the reels catalog. Called by Vercel Cron once a day.
//
// Version history:
//   v0.1.0 (2026-11-17) — Loop active competitors -> syncCompetitor().
//   v0.1.1 (2026-11-17) — Also refresh the Top Reels digest once per run
//                         ($0.25/day). Skip it with ?skipTop=1.
//   v0.2.0 (2026-11-19) — Top is NO LONGER refreshed by cron. The 48h digest
//                         costs $0.25/platform/call; it now updates only on the
//                         manual "Обновить" button (POST /api/top) to avoid the
//                         daily spend. Cron keeps syncing competitors (free) and
//                         saved searches.
//
// Auth: requires `?secret=SAMSPY_SECRET` or an `Authorization: Bearer` header.
// Vercel Cron sends the Authorization header automatically when configured
// with a secret; we also accept the query param for manual runs.

import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';
import { syncCompetitor, type SyncResult } from '@/lib/sync';
import { refreshSavedSearch } from '@/lib/search';
import type { Competitor, SavedSearch } from '@/lib/types/db';

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
  for (const c of competitors ?? []) {
    try {
      results.push(await syncCompetitor(supabase, c));
    } catch (err) {
      errors.push({
        username: c.username,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const url = new URL(req.url);

  // NOTE: Top Reels is intentionally NOT refreshed here — the 48h digest is a
  // paid Virlo call ($0.25/platform) and now updates only via the manual
  // "Обновить" button on the Top tab (POST /api/top). This keeps the daily
  // cron free of the top-digest spend.

  // Refresh each saved-search block on its own platform (~$0.10 each).
  // ?skipSearch=1 skips.
  let searches = 0;
  if (url.searchParams.get('skipSearch') !== '1') {
    const { data: blocks } = await supabase
      .from('saved_searches')
      .select('id,platform,query,label,min_views,last_run_at,created_at')
      .returns<SavedSearch[]>();
    for (const b of blocks ?? []) {
      try {
        await refreshSavedSearch(supabase, b);
        searches++;
      } catch (err) {
        errors.push({
          username: `(search: ${b.query})`,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return NextResponse.json({
    ok: true,
    competitorsFound: competitors.length,
    synced: results.length,
    reels: results.reduce((n, r) => n + r.reelsUpserted, 0),
    searches,
    results,
    errors,
    ranAt: new Date().toISOString(),
  });
}
