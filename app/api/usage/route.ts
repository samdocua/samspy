// SamSpy — GET /api/usage?ref=<analysis job id | plan id> -> UsageTotals
// What a dossier / plan cost in API calls (Claude, OpenAI, ScrapeCreators), from table ai_usage.
//
// Version history:
//   v0.1.0 (2026-11-27) — initial.

import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';
import { usageOf } from '@/lib/usage';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const ref = new URL(req.url).searchParams.get('ref') ?? '';
  if (!/^[0-9a-f-]{36}$/i.test(ref)) return NextResponse.json({ error: 'ref обязателен.' }, { status: 400 });
  try {
    return NextResponse.json(await usageOf(createServiceClient(), ref));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
