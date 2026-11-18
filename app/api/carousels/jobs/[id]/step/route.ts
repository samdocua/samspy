// SamSpy — POST /api/carousels/jobs/:id/step
// Advances a carousel job for ~40s (Apify wait → OCR → check → escalate → done).
// Called repeatedly by the open «Карусели» tab until the job is done.
// Returns { job, busy } — busy = another tab is processing this job right now.
//
// Version history:
//   v0.4.0 (2026-11-18) — step endpoint.

import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';
import { getJobCard, stepJob } from '@/lib/carousels/pipeline';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const supabase = createServiceClient();
  try {
    const worked = await stepJob(supabase, params.id);
    const job = await getJobCard(supabase, params.id);
    if (!job) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
    return NextResponse.json({ job, busy: !worked && job.status !== 'done' && job.status !== 'failed' });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
