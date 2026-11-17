// SamSpy — DELETE /api/competitors/:id
// Stop tracking a competitor: stop Virlo tracking (to stop billing) and remove
// the account. Its reels are removed via the competitor_id ON DELETE CASCADE.
//
// Version history:
//   v0.2.0 (2026-11-17) — delete tracked competitor.

import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';
import { stopTrackingCreator } from '@/lib/virlo';

export const dynamic = 'force-dynamic';

export async function DELETE(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const supabase = createServiceClient();

  // Look up the Virlo creator id so we can stop tracking (and stop billing).
  const { data: rows } = await supabase
    .from('competitors')
    .select('virlo_creator_id')
    .eq('id', params.id)
    .limit(1);
  const virloId = rows?.[0]?.virlo_creator_id as string | undefined;

  // Best-effort: stop Virlo tracking. Ignore failures (account may be gone).
  if (virloId) {
    try {
      await stopTrackingCreator(virloId);
    } catch {
      /* ignore */
    }
  }

  // Delete the competitor; reels cascade via the FK.
  const { error } = await supabase
    .from('competitors')
    .delete()
    .eq('id', params.id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
