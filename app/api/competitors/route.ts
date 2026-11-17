// SamSpy — POST /api/competitors  (add a competitor to track)
// GET  /api/competitors  (list tracked competitors)
//
// Version history:
//   v0.1.0 (2026-11-17) — Add account: start Virlo tracking ($0.25) then
//                         insert into DB. Idempotent on username.
//
// Flow:
//   1. normalize @handle / instagram URL -> bare username
//   2. insert competitor row (status pending)
//   3. Virlo trackCreator -> store virlo_creator_id (status active)
//   4. first sync happens on the next cron run (creator needs ~1-2 min to enrich)

import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';
import { trackCreator, VirloError } from '@/lib/virlo';
import type { VirloCadence } from '@/lib/types/virlo';

/** Pull a bare Instagram username from @handle, a URL, or a plain string. */
function normalizeUsername(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  // instagram.com/<username>/... or /reel/... — take the first path segment
  const urlMatch = s.match(/instagram\.com\/([A-Za-z0-9._]+)/i);
  if (urlMatch) {
    const seg = urlMatch[1].toLowerCase();
    if (['reel', 'reels', 'p', 'explore', 'stories'].includes(seg)) return null;
    return seg;
  }
  // @handle or plain handle
  const handle = s.replace(/^@/, '').toLowerCase();
  return /^[a-z0-9._]+$/.test(handle) ? handle : null;
}

export async function POST(req: Request) {
  let body: { username?: string; niche_id?: string; cadence?: VirloCadence };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const username = normalizeUsername(body.username ?? '');
  if (!username) {
    return NextResponse.json(
      { error: 'Provide a valid Instagram @username or profile URL.' },
      { status: 400 }
    );
  }

  const supabase = createServiceClient();

  // If we already track this username, return it (idempotent).
  const { data: existing } = await supabase
    .from('competitors')
    .select('*')
    .eq('username', username)
    .maybeSingle();
  if (existing) {
    return NextResponse.json(
      { competitor: existing, message: 'Already tracked.' },
      { status: 200 }
    );
  }

  // Insert a pending row first so the UI can show it immediately.
  const { data: inserted, error: insertErr } = await supabase
    .from('competitors')
    .insert({
      username,
      niche_id: body.niche_id ?? null,
      scrape_cadence: body.cadence ?? 'daily',
      virlo_status: 'pending',
    })
    .select('*')
    .single();

  if (insertErr || !inserted) {
    return NextResponse.json(
      { error: insertErr?.message ?? 'Failed to insert competitor.' },
      { status: 500 }
    );
  }

  // Start Virlo tracking ($0.25). On failure, mark the row failed but keep it.
  try {
    const tracked = await trackCreator({
      handle: username,
      cadence: body.cadence ?? 'daily',
    });

    const { data: updated } = await supabase
      .from('competitors')
      .update({ virlo_creator_id: tracked.id, virlo_status: 'active' })
      .eq('id', inserted.id)
      .select('*')
      .single();

    return NextResponse.json(
      {
        competitor: updated ?? inserted,
        message:
          'Tracking started. First reels appear after the account enriches (~1–2 min), on the next sync.',
      },
      { status: 201 }
    );
  } catch (err) {
    const ve = err as VirloError;
    // 409 already tracked on the Virlo side — treat as active if we got an id.
    await supabase
      .from('competitors')
      .update({ virlo_status: 'failed' })
      .eq('id', inserted.id);

    return NextResponse.json(
      {
        competitor: inserted,
        error:
          ve?.message ??
          'Virlo tracking failed. The account row was kept; retry later.',
        code: ve?.code,
      },
      { status: ve?.status ?? 502 }
    );
  }
}

export async function GET() {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('competitors')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ competitors: data ?? [] });
}
