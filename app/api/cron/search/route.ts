// SamSpy — GET /api/cron/search  (daily saved-search refresh)
//
// Refreshes every saved-search block on its own platform from Virlo's library
// (~$0.10 per block: 2 pages × $0.05). This is the paid part of the daily
// refresh.
//
// Split out of the old combined /api/cron/sync so it runs as its own Vercel
// Cron with its own 60s budget, independent of the slower (free) competitor
// sync — so paid search refreshes always complete.
//
// Top Reels is NOT refreshed by any cron — the 48h digest ($0.25/platform)
// updates only via the manual "Обновить" button (POST /api/top).
//
// Version history:
//   v0.2.0 (2026-11-19) — split from /api/cron/sync into a dedicated endpoint.
//
// Auth: requires `?secret=SAMSPY_SECRET` or an `Authorization: Bearer` header.

import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';
import { refreshSavedSearch } from '@/lib/search';
import type { SavedSearch } from '@/lib/types/db';

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
  const errors: { query: string; error: string }[] = [];

  const { data: blocks, error } = await supabase
    .from('saved_searches')
    .select('id,platform,query,label,min_views,last_run_at,created_at')
    .returns<SavedSearch[]>();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  let searches = 0;
  for (const b of blocks ?? []) {
    try {
      await refreshSavedSearch(supabase, b);
      searches++;
    } catch (err) {
      errors.push({
        query: b.query,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return NextResponse.json({
    ok: true,
    blocksFound: blocks?.length ?? 0,
    searches,
    errors,
    ranAt: new Date().toISOString(),
  });
}
