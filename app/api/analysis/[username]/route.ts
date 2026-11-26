// SamSpy — «Анализ»: one account
//   GET    /api/analysis/:username -> { dossier } latest finished dossier (404 if none yet)
//   POST   /api/analysis/:username {action:'slides'} -> «Распознать слайды» on the dossier → { card }
//   DELETE /api/analysis/:username -> removes the account, its dossiers, posts and images
//
// Version history:
//   v0.1.0 (2026-11-22) — initial.
//   v0.2.0 (2026-11-26) — POST action 'slides'.

import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';
import { deleteAccount, getCard, getDossier, startSlidesOcr } from '@/lib/analysis/pipeline';

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

export async function POST(req: Request, { params }: { params: { username: string } }) {
  const username = params.username.toLowerCase();
  try {
    const body = (await req.json().catch(() => ({}))) as { action?: string };
    if (body.action !== 'slides') return NextResponse.json({ error: 'Неизвестное действие.' }, { status: 400 });
    const sb = createServiceClient();
    await startSlidesOcr(sb, username);
    return NextResponse.json({ card: await getCard(sb, username) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
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
