// SamSpy — POST /api/competitors/:id/sync
// Sync one competitor on demand (used by the "collect now" poll right after
// an account is added, so its reels appear without waiting for the cron).
//
// Version history:
//   v0.2.0 (2026-11-17) — per-competitor sync endpoint.

import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';
import { syncCompetitor } from '@/lib/sync';
import type { Competitor } from '@/lib/types/db';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Explicit columns (plain select('*') was observed to drop rows on this project).
const COLS =
  'id,niche_id,username,display_name,avatar_url,bio,is_verified,' +
  'virlo_creator_id,virlo_status,scrape_cadence,latest_followers,' +
  'median_views,last_synced_at,created_at,updated_at';

export async function POST(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const supabase = createServiceClient();

  const { data: rows } = await supabase
    .from('competitors')
    .select(COLS)
    .eq('id', params.id)
    .limit(1)
    .returns<Competitor[]>();

  const competitor = rows?.[0];
  if (!competitor) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }

  try {
    const result = await syncCompetitor(supabase, competitor);
    return NextResponse.json({ result });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
