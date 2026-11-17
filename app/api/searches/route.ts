// SamSpy — Saved searches (tab 2 blocks)
//   GET  /api/searches   -> list blocks with reel_count + cover (free)
//   POST /api/searches   -> create a block and run the first search ($0.10)
//
// Version history:
//   v0.1.0 (2026-11-17) — list + create saved-search blocks.

import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';
import { refreshSavedSearch } from '@/lib/search';
import { VirloError } from '@/lib/virlo';
import type { SavedSearch, SavedSearchCard } from '@/lib/types/db';

export const dynamic = 'force-dynamic';

// --- GET: list blocks with counts + covers ---------------------------------
export async function GET(req: Request) {
  const platform = new URL(req.url).searchParams.get('platform') ?? 'instagram';
  const supabase = createServiceClient();

  const { data: searches, error } = await supabase
    .from('saved_searches')
    .select('id,platform,query,label,min_views,last_run_at,created_at')
    .eq('platform', platform)
    .order('created_at', { ascending: false })
    .returns<SavedSearch[]>();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Decorate each block with a reel count and a cover thumbnail.
  const cards: SavedSearchCard[] = [];
  for (const s of searches ?? []) {
    const { count } = await supabase
      .from('reels')
      .select('id', { count: 'exact', head: true })
      .eq('saved_search_id', s.id);

    const { data: cover } = await supabase
      .from('reels')
      .select('thumbnail_url')
      .eq('saved_search_id', s.id)
      .order('views', { ascending: false })
      .limit(1)
      .maybeSingle();

    cards.push({
      ...s,
      reel_count: count ?? 0,
      cover_url: cover?.thumbnail_url ?? null,
    });
  }

  return NextResponse.json({ searches: cards });
}

// --- POST: create a block + first search -----------------------------------
export async function POST(req: Request) {
  let body: { query?: string; label?: string; platform?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const query = (body.query ?? '').trim();
  if (!query) {
    return NextResponse.json(
      { error: 'Введите поисковый запрос.' },
      { status: 400 }
    );
  }

  const platform = body.platform === 'tiktok' ? 'tiktok' : 'instagram';
  const supabase = createServiceClient();

  // Create the block.
  const { data: saved, error: insErr } = await supabase
    .from('saved_searches')
    .insert({ query, label: (body.label ?? query).trim(), platform })
    .select('id,platform,query,label,min_views,last_run_at,created_at')
    .single();

  if (insErr || !saved) {
    return NextResponse.json(
      { error: insErr?.message ?? 'Не удалось создать блок.' },
      { status: 500 }
    );
  }

  // Run the first search ($0.10). On failure keep the (empty) block.
  try {
    const result = await refreshSavedSearch(supabase, saved as SavedSearch);
    return NextResponse.json({ search: saved, result }, { status: 201 });
  } catch (err) {
    const ve = err as VirloError;
    return NextResponse.json(
      {
        search: saved,
        error: ve?.message ?? 'Поиск не удался. Блок создан, попробуй обновить.',
      },
      { status: ve?.status ?? 502 }
    );
  }
}
