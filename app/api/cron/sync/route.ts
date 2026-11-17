// SamSpy — GET /api/cron/sync  (daily catalog refresh)
//
// Pulls fresh posts for every active competitor from Virlo and upserts them
// into the reels catalog. Called by Vercel Cron once a day.
//
// Version history:
//   v0.1.0 (2026-11-17) — Loop active competitors -> syncCompetitor().
//   v0.1.1 (2026-11-17) — Also refresh the Top Reels digest once per run
//                         ($0.25/day). Skip it with ?skipTop=1.
//
// Auth: requires `?secret=SAMSPY_SECRET` or an `Authorization: Bearer` header.
// Vercel Cron sends the Authorization header automatically when configured
// with a secret; we also accept the query param for manual runs.

import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';
import { syncCompetitor, type SyncResult } from '@/lib/sync';
import { refreshTopReels } from '@/lib/top';
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

  // Sync only accounts Virlo is actively tracking.
  const { data: competitors, error } = await supabase
    .from('competitors')
    .select('*')
    .in('virlo_status', ['active', 'pending'])
    .returns<Competitor[]>();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

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

  // Refresh the Top Reels digest once per run ($0.25). Pass ?skipTop=1 to skip
  // (e.g. a manual mid-day sync where you don't want to pay for the digest).
  let top: { fetched: number; cached: number } | null = null;
  if (url.searchParams.get('skipTop') !== '1') {
    try {
      const r = await refreshTopReels(supabase, 60);
      top = { fetched: r.fetched, cached: r.cached };
    } catch (err) {
      errors.push({
        username: '(top digest)',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Refresh each saved-search block (~$0.10 each). Pass ?skipSearch=1 to skip.
  let searches = 0;
  if (url.searchParams.get('skipSearch') !== '1') {
    const { data: blocks } = await supabase
      .from('saved_searches')
      .select('*')
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
    synced: results.length,
    reels: results.reduce((n, r) => n + r.reelsUpserted, 0),
    top,
    searches,
    results,
    errors,
    ranAt: new Date().toISOString(),
  });
}
