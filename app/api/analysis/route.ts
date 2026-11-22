// SamSpy — «Анализ» (Instagram account dossiers)
//   GET  /api/analysis          -> { cards } all analysed accounts (+ latest job status)
//   POST /api/analysis {input}  -> link / @username → new dossier job (or the running one)
//
// Version history:
//   v0.1.0 (2026-11-22) — initial.

import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';
import { createAnalysis, getCard, listCards } from '@/lib/analysis/pipeline';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET() {
  try {
    return NextResponse.json({ cards: await listCards(createServiceClient()) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  let body: { input?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Bad JSON.' }, { status: 400 });
  }
  if (!body.input?.trim()) return NextResponse.json({ error: 'Вставь ссылку на аккаунт.' }, { status: 400 });

  const sb = createServiceClient();
  try {
    const job = await createAnalysis(sb, body.input);
    return NextResponse.json({ card: await getCard(sb, job.username) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
