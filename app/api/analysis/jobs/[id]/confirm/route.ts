// SamSpy — POST /api/analysis/jobs/:id/confirm   { limit: number | 'all' } | { cancel: true }
// A full collection of a big account waits in status 'confirm' until the user picks how many
// of the newest posts to collect (or cancels). Returns { card }.
//
// Version history:
//   v0.1.0 (2026-11-23) — initial.

import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';
import { cancelCollection, confirmCollection, getCard } from '@/lib/analysis/pipeline';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const sb = createServiceClient();
  try {
    const body = (await req.json().catch(() => ({}))) as { limit?: number | 'all'; cancel?: boolean };
    if (body.cancel) await cancelCollection(sb, params.id);
    else if (body.limit === 'all' || typeof body.limit === 'number') await confirmCollection(sb, params.id, body.limit);
    else return NextResponse.json({ error: 'Нужен limit или cancel.' }, { status: 400 });

    const { data: job } = await sb.from('analysis_jobs').select('username').eq('id', params.id).maybeSingle();
    if (!job) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
    return NextResponse.json({ card: await getCard(sb, job.username) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
