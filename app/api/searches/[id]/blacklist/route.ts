// SamSpy — per-search-block blacklist
//   GET    /api/searches/:id/blacklist          -> list blocked @usernames
//   POST   /api/searches/:id/blacklist          -> add a @username (+ purge)
//   DELETE /api/searches/:id/blacklist?id=...    -> remove one entry
//
// Version history:
//   v0.2.0 (2026-11-17) — per-block blacklist by @username.

import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

function normHandle(s: string): string {
  return s.trim().replace(/^@/, '').toLowerCase();
}

export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('blacklist')
    .select('*')
    .eq('scope', 'search')
    .eq('saved_search_id', params.id)
    .order('created_at', { ascending: false });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ blacklist: data ?? [] });
}

export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  let body: { username?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }
  const username = normHandle(body.username ?? '');
  if (!username) {
    return NextResponse.json({ error: 'Укажите @аккаунт.' }, { status: 400 });
  }

  const supabase = createServiceClient();

  // Add the entry (ignore duplicates).
  const { data: existing } = await supabase
    .from('blacklist')
    .select('id')
    .eq('scope', 'search')
    .eq('saved_search_id', params.id)
    .eq('username', username)
    .maybeSingle();

  if (!existing) {
    await supabase.from('blacklist').insert({
      scope: 'search',
      saved_search_id: params.id,
      username,
      label: `@${username}`,
    });
  }

  // Purge this author's already-cached reels in this block.
  await supabase
    .from('reels')
    .delete()
    .eq('saved_search_id', params.id)
    .ilike('author_username', username);

  return NextResponse.json({ ok: true });
}

export async function DELETE(
  req: Request,
  { params }: { params: { id: string } }
) {
  const entryId = new URL(req.url).searchParams.get('id');
  if (!entryId) {
    return NextResponse.json({ error: 'Missing entry id.' }, { status: 400 });
  }
  const supabase = createServiceClient();
  const { error } = await supabase
    .from('blacklist')
    .delete()
    .eq('id', entryId)
    .eq('scope', 'search')
    .eq('saved_search_id', params.id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
