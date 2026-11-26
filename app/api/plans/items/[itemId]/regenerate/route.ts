// SamSpy — POST /api/plans/items/:itemId/regenerate -> { item } rewritten by Claude / next copied carousel
//
// Version history:
//   v0.1.0 (2026-11-22) — initial.
//   v0.1.1 (2026-11-26) — maxDuration 300: copy mode may OCR a few carousels before one fits.

import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';
import { regenerateItem } from '@/lib/plan/pipeline';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(_req: Request, { params }: { params: { itemId: string } }) {
  try {
    return NextResponse.json({ item: await regenerateItem(createServiceClient(), params.itemId) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
