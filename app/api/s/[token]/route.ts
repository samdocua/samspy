// SamSpy — DELETE /api/s/:token -> { ok } «Удалить» on the phone page: the slides and the link go.
// Public (no password): the unguessable token is the key.
//
// Version history:
//   v0.1.0 (2026-11-26) — initial.

import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';
import { deleteShare } from '@/lib/shares';

export const dynamic = 'force-dynamic';

export async function DELETE(_req: Request, { params }: { params: { token: string } }) {
  try {
    return NextResponse.json({ ok: await deleteShare(createServiceClient(), params.token) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
