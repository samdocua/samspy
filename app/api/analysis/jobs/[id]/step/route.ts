// SamSpy — POST /api/analysis/jobs/:id/step
// Advances a dossier job for ~40 s (Apify wait → save → previews → numbers → done).
// Called repeatedly by the open «Анализ» tab until the job is done.
// Returns { card, busy } — busy = another tab is processing this job right now.
//
// Version history:
//   v0.1.0 (2026-11-22) — initial.

import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';
import { getCard, stepAnalysis } from '@/lib/analysis/pipeline';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const sb = createServiceClient();
  try {
    const worked = await stepAnalysis(sb, params.id);
    const { data: job } = await sb.from('analysis_jobs').select('username,status').eq('id', params.id).maybeSingle();
    if (!job) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
    const card = await getCard(sb, job.username);
    return NextResponse.json({ card, busy: !worked && job.status !== 'done' && job.status !== 'failed' });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
