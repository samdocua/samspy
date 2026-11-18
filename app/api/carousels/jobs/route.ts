// SamSpy — Carousel jobs (tab «Карусели»)
//   GET  /api/carousels/jobs   -> recent jobs with progress counters
//   POST /api/carousels/jobs   -> { text } with Instagram post links → create a job + start Apify
//
// Version history:
//   v0.4.0 (2026-11-18) — list + create.

import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';
import { createJob, getJobCard, listJobs } from '@/lib/carousels/pipeline';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET() {
  const supabase = createServiceClient();
  try {
    return NextResponse.json({ jobs: await listJobs(supabase) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  let body: { text?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Bad JSON.' }, { status: 400 });
  }
  if (!body.text?.trim()) {
    return NextResponse.json({ error: 'Вставь ссылки на посты.' }, { status: 400 });
  }

  const supabase = createServiceClient();
  try {
    const job = await createJob(supabase, body.text);
    return NextResponse.json({ job: await getJobCard(supabase, job.id) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 }
    );
  }
}
