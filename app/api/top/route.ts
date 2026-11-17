// SamSpy — Top Reels (tab 3), per platform
//   GET  /api/top?platform=instagram|tiktok  -> cached top (free)
//   POST /api/top  {platform}                -> fresh digest ($0.25), cached
//
// Version history:
//   v0.1.0 (2026-11-17) — Instagram 48h digest.
//   v0.3.0 (2026-11-17) — platform-aware (Instagram + TikTok).

import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';
import { refreshTopReels } from '@/lib/top';
import { VirloError } from '@/lib/virlo';
import type { Platform } from '@/lib/types/db';

export const dynamic = 'force-dynamic';

function readPlatform(v: string | null | undefined): Platform {
  return v === 'tiktok' ? 'tiktok' : 'instagram';
}

// --- GET: cached top reels (free) ------------------------------------------
export async function GET(req: Request) {
  const platform = readPlatform(new URL(req.url).searchParams.get('platform'));
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('reels')
    .select('*')
    .eq('source', 'top')
    .eq('platform', platform)
    .order('views', { ascending: false })
    .limit(60);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ reels: data ?? [] });
}

// --- POST: refresh from Virlo ($0.25) --------------------------------------
export async function POST(req: Request) {
  let platform: Platform = 'instagram';
  try {
    platform = readPlatform((await req.json())?.platform);
  } catch {
    /* default instagram */
  }

  const supabase = createServiceClient();

  let refreshedAt: string;
  try {
    ({ refreshedAt } = await refreshTopReels(supabase, platform, 60));
  } catch (err) {
    const ve = err as VirloError;
    return NextResponse.json(
      { error: ve?.message ?? 'Virlo digest failed.', code: ve?.code },
      { status: ve?.status ?? 502 }
    );
  }

  const { data, error } = await supabase
    .from('reels')
    .select('*')
    .eq('source', 'top')
    .eq('platform', platform)
    .order('views', { ascending: false })
    .limit(60);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ reels: data ?? [], refreshedAt });
}
