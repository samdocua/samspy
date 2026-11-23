// SamSpy — PATCH /api/plans/items/:itemId {slides?, caption?, title?, status?} -> { item }
//
// Version history:
//   v0.1.0 (2026-11-22) — initial.

import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';
import { updateItem } from '@/lib/plan/pipeline';

export const dynamic = 'force-dynamic';

export async function PATCH(req: Request, { params }: { params: { itemId: string } }) {
  try {
    const body = await req.json();
    return NextResponse.json({ item: await updateItem(createServiceClient(), params.itemId, body) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
