// SamSpy — POST /api/cron/step?kind=analysis|carousels|plan&id=…
// Background worker entry: Supabase (pg_cron → public.samspy_tick() → pg_net) calls it every
// 20 s for each unfinished job, so jobs finish without an open tab. One call = one ~40 s step of
// that job (same functions the tabs call). Auth: x-worker-secret header (see lib/worker.ts);
// /api/cron/* is let through by the password middleware.
//
// Version history:
//   v0.1.0 (2026-11-23) — initial.

import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';
import { workerAuthorized } from '@/lib/worker';
import { stepAnalysis } from '@/lib/analysis/pipeline';
import { stepJob } from '@/lib/carousels/pipeline';
import { stepPlan } from '@/lib/plan/pipeline';

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // AI steps of «Анализ» / «План» can be slow

const STEPS = {
  analysis: stepAnalysis,
  carousels: stepJob,
  plan: stepPlan,
} as const;

export async function POST(req: Request) {
  const sb = createServiceClient();
  if (!(await workerAuthorized(sb, req))) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }
  const url = new URL(req.url);
  const kind = url.searchParams.get('kind') as keyof typeof STEPS | null;
  const id = url.searchParams.get('id');
  if (!kind || !(kind in STEPS) || !id) {
    return NextResponse.json({ error: 'kind и id обязательны.' }, { status: 400 });
  }
  try {
    const worked = await STEPS[kind](sb, id);
    return NextResponse.json({ ok: true, worked });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
