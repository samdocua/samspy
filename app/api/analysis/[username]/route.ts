// SamSpy — «Анализ»: one account
//   GET    /api/analysis/:username -> { dossier } latest finished dossier (404 if none yet)
//   DELETE /api/analysis/:username -> removes the account, its dossiers, posts and images
//
// Version history:
//   v0.1.0 (2026-11-22) — initial.

import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';
import { deleteAccount, getDossier } from '@/lib/analysis/pipeline';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(_req: Request, { params }: { params: { username: string } }) {
  try {
    const dossier = await getDossier(createServiceClient(), params.username.toLowerCase());
    if (!dossier) return NextResponse.json({ error: 'Досье ещё не готово.' }, { status: 404 });
    return NextResponse.json({ dossier });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: { params: { username: string } }) {
  try {
    await deleteAccount(createServiceClient(), params.username.toLowerCase());
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
