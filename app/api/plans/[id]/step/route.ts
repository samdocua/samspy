// SamSpy — POST /api/plans/:id/step
// Writes the next batch of carousels (Claude). Called repeatedly by the open «План» tab.
// Returns { busy } — another tab is writing this plan right now.
//
// Version history:
//   v0.1.0 (2026-11-22) — initial.

import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';
import { stepPlan } from '@/lib/plan/pipeline';

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // one batch of 4 new carousels: Claude writes, GPT checks

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  try {
    const worked = await stepPlan(createServiceClient(), params.id);
    return NextResponse.json({ busy: !worked });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
