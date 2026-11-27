// SamSpy — POST /api/shares {title, count, caption?} -> { token, uploads: [{path, url}], expires_at }
// «На телефон» in «Слайды»: a new share link; the browser PUTs each JPEG to its signed URL.
// Behind the password (only the phone page /s/<token> is public).
//
// Version history:
//   v0.1.0 (2026-11-26) — initial.
//   v0.2.0 (2026-11-27) — caption of the post.

import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';
import { createShare } from '@/lib/shares';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { title?: string; count?: number; caption?: string };
    if (!body.count || body.count < 1) return NextResponse.json({ error: 'Нет слайдов.' }, { status: 400 });
    return NextResponse.json(await createShare(createServiceClient(), body.title ?? null, body.count, body.caption ?? null));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
