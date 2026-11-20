// SamSpy — One post of the carousel base
//   DELETE /api/carousels/posts/:id -> remove the post (slides + images) from the base
//
// Version history:
//   v0.7.0 (2026-11-20) — initial.

import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';
import { deletePost } from '@/lib/carousels/pipeline';

export const dynamic = 'force-dynamic';

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  try {
    await deletePost(createServiceClient(), params.id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
