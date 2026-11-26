// SamSpy — POST /api/shares {title, count} -> { token, uploads: [{path, url}], expires_at }
// «На телефон» in «Слайды»: a new share link; the browser PUTs each JPEG to its signed URL.
// Behind the password (only the phone page /s/<token> is public).
//
// Version history:
//   v0.1.0 (2026-11-26) — initial.

import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';
import { createShare } from '@/lib/shares';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { title?: string; count?: number };
    if (!body.count || body.count < 1) return NextResponse.json({ error: 'Нет слайдов.' }, { status: 400 });
    return NextResponse.json(await createShare(createServiceClient(), body.title ?? null, body.count));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
