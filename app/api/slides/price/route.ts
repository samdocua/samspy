// SamSpy — rough price of one image generation (for the «Размножение» batch estimate)
//   GET /api/slides/price?modelId=…  -> { costUsd: number | null, kind: 'avg' | 'list' | null }
//
//   fal models: average historical price per call (fal Platform API, cached 1 h).
//   Gemini: list price × typical image output tokens (estimate).
// Protected by the app password via middleware.ts.
//
// Version history:
//   v0.1.0 (2026-11-20) — initial.

import { NextResponse } from 'next/server';
import { findModel } from '@/lib/slides/config';
import { falAvgCost } from '@/lib/slides/providers';
import { GEMINI_IMAGE_OUT_TOKENS } from '@/lib/multiply/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get('modelId') ?? '';
  const model = findModel(id);
  if (!model) return NextResponse.json({ costUsd: null, kind: null });
  if (model.provider === 'fal') {
    return NextResponse.json({ costUsd: await falAvgCost(model.id), kind: 'avg' });
  }
  const p = model.price;
  const costUsd = p ? (GEMINI_IMAGE_OUT_TOKENS * p.imageOut + 600 * p.imageIn + 300 * p.textIn) / 1_000_000 : null;
  return NextResponse.json({ costUsd, kind: 'list' });
}
