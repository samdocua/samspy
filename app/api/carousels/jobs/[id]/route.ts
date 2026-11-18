// SamSpy — One carousel job
//   GET    /api/carousels/jobs/:id   -> job card + posts with slides (image_url = Storage URL)
//   DELETE /api/carousels/jobs/:id   -> delete the job (collected posts stay for reuse)
//
// Version history:
//   v0.4.0 (2026-11-18) — detail + delete.

import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';
import { getJobCard, getJobPosts } from '@/lib/carousels/pipeline';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const supabase = createServiceClient();
  const job = await getJobCard(supabase, params.id);
  if (!job) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  const posts = await getJobPosts(supabase, params.id);
  return NextResponse.json({ job, posts });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const supabase = createServiceClient();
  const { error } = await supabase.from('carousel_jobs').delete().eq('id', params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
