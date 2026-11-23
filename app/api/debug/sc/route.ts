// SamSpy — TEMPORARY probe of ScrapeCreators (remove after the migration decision)
//   GET /api/debug/sc?handle=21questions.couples
//   -> shape of the answers (keys + short sample values) of: profile, user posts (page 1 + 2),
//      one post, its comments. Spends ~5 credits. Protected by the app password (middleware).
//
// Version history:
//   v0.1.0 (2026-11-23) — initial.

import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const API = 'https://api.scrapecreators.com';

/** Keys with short sample values; arrays → length + first element; depth-limited. */
function shape(v: unknown, depth = 0): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v === 'string') return v.length > 80 ? `${v.slice(0, 80)}…` : v;
  if (typeof v !== 'object') return v;
  if (depth > 5) return '…';
  if (Array.isArray(v)) return v.length ? { __len: v.length, first: shape(v[0], depth + 1) } : [];
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = shape(val, depth + 1);
  return out;
}

async function call(path: string, params: Record<string, string>) {
  const key = process.env.SCRAPECREATORS_API_KEY;
  if (!key) return { error: 'SCRAPECREATORS_API_KEY не задан (проверь, что он отмечен и для Preview).' };
  const url = `${API}${path}?${new URLSearchParams(params)}`;
  const t = Date.now();
  const res = await fetch(url, { headers: { 'x-api-key': key }, cache: 'no-store' });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    if (/credit|remaining|cache/i.test(k)) headers[k] = v;
  });
  return { path, status: res.status, ms: Date.now() - t, headers, body: json ? shape(json) : text.slice(0, 300), raw: json };
}

// find the first value of a key anywhere in an object
function find(v: unknown, keys: string[]): unknown {
  if (!v || typeof v !== 'object') return undefined;
  if (Array.isArray(v)) {
    for (const x of v) {
      const r = find(x, keys);
      if (r !== undefined) return r;
    }
    return undefined;
  }
  for (const k of keys) if (k in (v as Record<string, unknown>)) return (v as Record<string, unknown>)[k];
  for (const val of Object.values(v as Record<string, unknown>)) {
    const r = find(val, keys);
    if (r !== undefined) return r;
  }
  return undefined;
}

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const handle = sp.get('handle') || '21questions.couples';
  const forced = sp.get('post');
  const strip = (r: Awaited<ReturnType<typeof call>> | null) => (r ? { ...r, raw: undefined } : null);

  // ?post=<url> — test only the single-post and comments endpoints (1–3 credits)
  if (forced) {
    const post = await call('/v1/instagram/post', { url: forced });
    const postReel =
      post.status === 404 && forced.includes('/p/')
        ? await call('/v1/instagram/post', { url: forced.replace('/p/', '/reel/') })
        : null;
    const comments = await call('/v2/instagram/post/comments', { url: forced });
    return NextResponse.json({ post_url: forced, post: strip(post), post_reel_retry: strip(postReel), comments: strip(comments) });
  }

  const profile = await call('/v1/instagram/profile', { handle, trim: 'true' });
  const posts1 = await call('/v2/instagram/user/posts', { handle });
  const cursor = find(posts1.raw, ['next_max_id', 'cursor', 'next_cursor', 'end_cursor']);
  const posts2 = cursor ? await call('/v2/instagram/user/posts', { handle, next_max_id: String(cursor), cursor: String(cursor) }) : null;

  const code = find(posts1.raw, ['code', 'shortcode']);
  const postUrl = code ? `https://www.instagram.com/p/${code}/` : null;
  const post = postUrl ? await call('/v1/instagram/post', { url: postUrl }) : null;
  const comments = postUrl ? await call('/v2/instagram/post/comments', { url: postUrl }) : null;

  return NextResponse.json({
    handle,
    cursor_found: cursor ?? null,
    post_url: postUrl,
    profile: strip(profile),
    posts_page1: strip(posts1),
    posts_page2: strip(posts2),
    post: strip(post),
    comments: strip(comments),
  });
}
