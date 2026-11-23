// SamSpy — «План»: one plan
//   GET    /api/plans/:id                    -> { plan, items }
//   POST   /api/plans/:id {action:'resume'}  -> continue after a failure
//   DELETE /api/plans/:id                    -> removes the plan and its carousels
//
// Version history:
//   v0.1.0 (2026-11-22) — initial.

import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';
import { deletePlan, getPlan, resumePlan } from '@/lib/plan/pipeline';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const data = await getPlan(createServiceClient(), params.id);
  if (!data) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  return NextResponse.json(data);
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const body = (await req.json().catch(() => ({}))) as { action?: string };
  if (body.action !== 'resume') return NextResponse.json({ error: 'Unknown action.' }, { status: 400 });
  await resumePlan(createServiceClient(), params.id);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  await deletePlan(createServiceClient(), params.id);
  return NextResponse.json({ ok: true });
}
