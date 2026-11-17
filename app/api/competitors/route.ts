// SamSpy — POST /api/competitors  (add a competitor to track)
// GET  /api/competitors?platform=instagram|tiktok  (list tracked competitors)
//
// Version history:
//   v0.1.0 (2026-11-17) — add account: Virlo tracking ($0.25) then insert.
//   v0.3.0 (2026-11-17) — platform-aware (Instagram + TikTok); explicit
//                         columns on list (plain select('*') dropped rows).

import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';
import { trackCreator, VirloError } from '@/lib/virlo';
import type { VirloCadence, VirloPlatform } from '@/lib/types/virlo';
import type { Competitor } from '@/lib/types/db';

const COLS =
  'id,platform,niche_id,username,display_name,avatar_url,bio,is_verified,' +
  'virlo_creator_id,virlo_status,scrape_cadence,latest_followers,' +
  'median_views,last_synced_at,created_at,updated_at';

/** Pull a bare username from @handle, an instagram/tiktok URL, or plain text. */
function normalizeUsername(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  const urlMatch = s.match(/(?:instagram|tiktok)\.com\/@?([A-Za-z0-9._]+)/i);
  if (urlMatch) {
    const seg = urlMatch[1].toLowerCase();
    if (['reel', 'reels', 'p', 'explore', 'stories', 'video'].includes(seg))
      return null;
    return seg;
  }
  const handle = s.replace(/^@/, '').toLowerCase();
  return /^[a-z0-9._]+$/.test(handle) ? handle : null;
}

export async function POST(req: Request) {
  let body: {
    username?: string;
    platform?: VirloPlatform;
    niche_id?: string;
    cadence?: VirloCadence;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const platform: VirloPlatform =
    body.platform === 'tiktok' ? 'tiktok' : 'instagram';
  const username = normalizeUsername(body.username ?? '');
  if (!username) {
    return NextResponse.json(
      { error: 'Укажите корректный @username или ссылку на профиль.' },
      { status: 400 }
    );
  }

  const supabase = createServiceClient();

  // Idempotent per platform.
  const { data: existing } = await supabase
    .from('competitors')
    .select(COLS)
    .eq('platform', platform)
    .eq('username', username)
    .limit(1)
    .returns<Competitor[]>();
  if (existing && existing.length > 0) {
    return NextResponse.json(
      { competitor: existing[0], message: 'Уже отслеживается.' },
      { status: 200 }
    );
  }

  const { data: inserted, error: insertErr } = await supabase
    .from('competitors')
    .insert({
      platform,
      username,
      niche_id: body.niche_id ?? null,
      scrape_cadence: body.cadence ?? 'daily',
      virlo_status: 'pending',
    })
    .select(COLS)
    .single<Competitor>();

  if (insertErr || !inserted) {
    return NextResponse.json(
      { error: insertErr?.message ?? 'Не удалось добавить аккаунт.' },
      { status: 500 }
    );
  }

  try {
    const tracked = await trackCreator({
      handle: username,
      platform,
      cadence: body.cadence ?? 'daily',
    });

    const { data: updated } = await supabase
      .from('competitors')
      .update({ virlo_creator_id: tracked.id, virlo_status: 'active' })
      .eq('id', inserted.id)
      .select(COLS)
      .single<Competitor>();

    return NextResponse.json(
      { competitor: updated ?? inserted, message: 'Трекинг запущен.' },
      { status: 201 }
    );
  } catch (err) {
    const ve = err as VirloError;
    await supabase
      .from('competitors')
      .update({ virlo_status: 'failed' })
      .eq('id', inserted.id);

    return NextResponse.json(
      {
        competitor: inserted,
        error: ve?.message ?? 'Трекинг не удался. Аккаунт сохранён, попробуй позже.',
        code: ve?.code,
      },
      { status: ve?.status ?? 502 }
    );
  }
}

export async function GET(req: Request) {
  const platform = new URL(req.url).searchParams.get('platform') ?? 'instagram';
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('competitors')
    .select(COLS)
    .eq('platform', platform)
    .order('created_at', { ascending: false })
    .returns<Competitor[]>();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ competitors: data ?? [] });
}
