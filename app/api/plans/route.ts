// SamSpy — «План» (carousel content plans)
//   GET  /api/plans        -> { plans } all plans with progress
//   POST /api/plans {…}    -> new plan (slots laid out; generation goes on via /step)
//
// Version history:
//   v0.1.0 (2026-11-22) — initial.

import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';
import { createPlan, listPlans, type CreatePlanInput } from '@/lib/plan/pipeline';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET() {
  try {
    return NextResponse.json({ plans: await listPlans(createServiceClient()) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  let body: CreatePlanInput;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Bad JSON.' }, { status: 400 });
  }
  try {
    const plan = await createPlan(createServiceClient(), body);
    return NextResponse.json({ id: plan.id });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
