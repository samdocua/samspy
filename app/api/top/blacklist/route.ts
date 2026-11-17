// SamSpy — Top Reels blacklist (by author id, since digest has no @username)
//   GET    /api/top/blacklist          -> list blocked authors
//   POST   /api/top/blacklist          -> add an author id (+ purge) {author_external_id, label}
//   DELETE /api/top/blacklist?id=...    -> remove one entry
//
// Version history:
//   v0.2.0 (2026-11-17) — Top Reels blacklist.

import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET() {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('blacklist')
    .select('*')
    .eq('scope', 'top')
    .order('created_at', { ascending: false });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ blacklist: data ?? [] });
}

export async function POST(req: Request) {
  let body: { author_external_id?: string; label?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }
  const authorId = (body.author_external_id ?? '').trim();
  if (!authorId) {
    return NextResponse.json({ error: 'Missing author id.' }, { status: 400 });
  }

  const supabase = createServiceClient();

  const { data: existing } = await supabase
    .from('blacklist')
    .select('id')
    .eq('scope', 'top')
    .eq('author_external_id', authorId)
    .maybeSingle();

  if (!existing) {
    await supabase.from('blacklist').insert({
      scope: 'top',
      author_external_id: authorId,
      label: body.label ?? authorId,
    });
  }

  // Purge this author's already-cached top reels.
  await supabase
    .from('reels')
    .delete()
    .eq('source', 'top')
    .eq('author_external_id', authorId);

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const entryId = new URL(req.url).searchParams.get('id');
  if (!entryId) {
    return NextResponse.json({ error: 'Missing entry id.' }, { status: 400 });
  }
  const supabase = createServiceClient();
  const { error } = await supabase
    .from('blacklist')
    .delete()
    .eq('id', entryId)
    .eq('scope', 'top');
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
