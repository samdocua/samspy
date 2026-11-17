// SamSpy — Top Reels (tab 3)
//   GET  /api/top          -> read cached top reels from DB (free)
//   POST /api/top          -> fetch a fresh digest from Virlo ($0.25),
//                             cache it (source='top'), return it
//
// Version history:
//   v0.1.0 (2026-11-17) — Instagram 48h top-reels digest, cached in `reels`.
//
// Cost control: the paid Virlo call happens ONLY on POST (the "Refresh"
// button). GET just reads what was cached, so opening the tab is free.

import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';
import { refreshTopReels } from '@/lib/top';
import { VirloError } from '@/lib/virlo';

export const dynamic = 'force-dynamic';

// --- GET: cached top reels (free) ------------------------------------------
export async function GET() {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('reels')
    .select('*')
    .eq('source', 'top')
    .order('views', { ascending: false })
    .limit(60);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ reels: data ?? [] });
}

// --- POST: refresh from Virlo ($0.25) --------------------------------------
export async function POST() {
  const supabase = createServiceClient();

  let refreshedAt: string;
  try {
    ({ refreshedAt } = await refreshTopReels(supabase, 60));
  } catch (err) {
    const ve = err as VirloError;
    return NextResponse.json(
      { error: ve?.message ?? 'Virlo digest failed.', code: ve?.code },
      { status: ve?.status ?? 502 }
    );
  }

  // Return the freshly-cached list, ranked by views.
  const { data, error } = await supabase
    .from('reels')
    .select('*')
    .eq('source', 'top')
    .order('views', { ascending: false })
    .limit(60);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ reels: data ?? [], refreshedAt });
}
