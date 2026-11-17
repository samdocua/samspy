// SamSpy — one saved-search block
//   GET    /api/searches/:id          -> that block's reels (free)
//   POST   /api/searches/:id/refresh  -> handled here via ?action=refresh ($0.10)
//   DELETE /api/searches/:id          -> delete the block + its reels
//
// Version history:
//   v0.1.0 (2026-11-17) — read reels, manual refresh, delete.

import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';
import { refreshSavedSearch } from '@/lib/search';
import { VirloError } from '@/lib/virlo';
import type { SavedSearch } from '@/lib/types/db';

export const dynamic = 'force-dynamic';

// --- GET: reels for this block (free). ?refresh=1 does a paid refresh first.
export async function GET(
  req: Request,
  { params }: { params: { id: string } }
) {
  const supabase = createServiceClient();
  const doRefresh = new URL(req.url).searchParams.get('refresh') === '1';

  if (doRefresh) {
    const { data: saved } = await supabase
      .from('saved_searches')
      .select('*')
      .eq('id', params.id)
      .maybeSingle();
    if (saved) {
      try {
        await refreshSavedSearch(supabase, saved as SavedSearch);
      } catch (err) {
        const ve = err as VirloError;
        return NextResponse.json(
          { error: ve?.message ?? 'Обновление не удалось.' },
          { status: ve?.status ?? 502 }
        );
      }
    }
  }

  const { data, error } = await supabase
    .from('reels')
    .select('*')
    .eq('saved_search_id', params.id)
    .order('views', { ascending: false })
    .limit(120);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ reels: data ?? [] });
}

// --- DELETE: remove the block and its cached reels -------------------------
export async function DELETE(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const supabase = createServiceClient();

  // Remove the block's reels first (they reference it), then the block.
  await supabase.from('reels').delete().eq('saved_search_id', params.id);
  const { error } = await supabase
    .from('saved_searches')
    .delete()
    .eq('id', params.id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
