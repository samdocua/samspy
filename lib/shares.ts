// SamSpy — «На телефон»: slides shared by a link (server only)
//
//   createShare()  new token + signed upload URLs (the browser uploads the JPEGs straight to the
//                  public bucket 'shares' — no 4.5 MB Vercel body limit); expired shares are
//                  cleaned up on the way
//   getShare()     the share of a token with public image URLs (null if missing / expired)
//   deleteShare()  removes the files and the row («Удалить» on the phone page)
//
// The page /s/<token> needs no password — the long random token is the key.
//
// Version history:
//   v0.1.0 (2026-11-26) — initial.
//   v0.2.0 (2026-11-27) — caption of the post (copied on the phone page).

import { randomBytes } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

const BUCKET = 'shares';
export const SHARE_DAYS = 7;
const MAX_FILES = 20;

export interface ShareRow {
  id: string;
  token: string;
  title: string | null;
  caption: string | null;
  files: string[];
  created_at: string;
  expires_at: string;
}

export interface SharePublic {
  token: string;
  title: string | null;
  caption: string | null;
  images: { name: string; url: string }[];
  expires_at: string;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

async function removeFiles(sb: SupabaseClient, rows: Pick<ShareRow, 'files'>[]) {
  const paths = rows.flatMap((r) => r.files);
  for (let i = 0; i < paths.length; i += 100) await sb.storage.from(BUCKET).remove(paths.slice(i, i + 100));
}

/** Deletes expired shares with their files. */
export async function cleanupShares(sb: SupabaseClient) {
  const { data } = await sb
    .from('slide_shares')
    .select('id,files')
    .lt('expires_at', new Date().toISOString())
    .limit(200)
    .returns<Pick<ShareRow, 'id' | 'files'>[]>();
  if (!data?.length) return;
  await removeFiles(sb, data);
  await sb.from('slide_shares').delete().in('id', data.map((r) => r.id));
}

export async function createShare(
  sb: SupabaseClient,
  title: string | null,
  count: number,
  caption: string | null = null
): Promise<{ token: string; uploads: { path: string; url: string }[]; expires_at: string }> {
  const n = Math.max(1, Math.min(MAX_FILES, Math.round(count)));
  await cleanupShares(sb).catch(() => {});
  const token = randomBytes(18).toString('base64url');
  const files = Array.from({ length: n }, (_, i) => `${token}/slide-${pad2(i + 1)}.jpg`);
  const uploads: { path: string; url: string }[] = [];
  for (const path of files) {
    const { data, error } = await sb.storage.from(BUCKET).createSignedUploadUrl(path);
    if (error || !data) throw new Error(`Хранилище: ${error?.message ?? 'нет ссылки для загрузки'}`);
    uploads.push({ path, url: data.signedUrl });
  }
  const expires_at = new Date(Date.now() + SHARE_DAYS * 86_400_000).toISOString();
  const { error } = await sb.from('slide_shares').insert({
    token,
    title: title?.slice(0, 120) || null,
    caption: caption?.trim().slice(0, 2200) || null, // Instagram's caption limit
    files,
    expires_at,
  });
  if (error) throw new Error(error.message);
  return { token, uploads, expires_at };
}

export async function getShare(sb: SupabaseClient, token: string): Promise<SharePublic | null> {
  if (!/^[\w-]{16,64}$/.test(token)) return null;
  const { data } = await sb.from('slide_shares').select('*').eq('token', token).maybeSingle<ShareRow>();
  if (!data) return null;
  if (new Date(data.expires_at).getTime() < Date.now()) {
    await removeFiles(sb, [data]);
    await sb.from('slide_shares').delete().eq('id', data.id);
    return null;
  }
  return {
    token: data.token,
    title: data.title,
    caption: data.caption ?? null,
    expires_at: data.expires_at,
    images: data.files.map((path) => ({
      name: path.split('/').pop() ?? path,
      url: sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl,
    })),
  };
}

export async function deleteShare(sb: SupabaseClient, token: string): Promise<boolean> {
  if (!/^[\w-]{16,64}$/.test(token)) return false;
  const { data } = await sb.from('slide_shares').select('id,files').eq('token', token).maybeSingle<Pick<ShareRow, 'id' | 'files'>>();
  if (!data) return false;
  await removeFiles(sb, [data]);
  await sb.from('slide_shares').delete().eq('id', data.id);
  return true;
}
