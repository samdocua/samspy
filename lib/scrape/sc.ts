// SamSpy — ScrapeCreators client (Instagram), server only
//
// Replaces the Apify actors for «Анализ» and «Карусели». Every call is synchronous (2–6 s)
// and costs 1 credit; failed calls are not charged. About 1 call in 10 fails on their side
// (often a temporary «not found»), so:
//   • each call is retried up to 3 times with a pause (retryable: network, timeout, 404,
//     429, 5xx, success:false);
//   • callers keep a «to finish» list for what still failed and come back to it later
//     (see lib/analysis/pipeline.ts and lib/carousels/pipeline.ts).
//
// Results are mapped to the same loose shape the Apify datasets had (shortCode, type,
// likesCount, childPosts…), so the rest of the pipelines did not change.
//
// Version history:
//   v0.1.0 (2026-11-23) — initial: profile, user posts (paged), single post, comments (paged).
//   v0.1.1 (2026-11-23) — pinned posts: the feed does not always flag them, so on the first page
//                         a post among the first 3 that is older than a post below it is pinned.

const API = 'https://api.scrapecreators.com';
const TRY_DELAYS = [0, 1500, 4000];
const CALL_TIMEOUT_MS = 15_000;

/** ScrapeCreators is used when its key is set, unless SCRAPER=apify. */
export function scEnabled(): boolean {
  if ((process.env.SCRAPER || '').toLowerCase() === 'apify') return false;
  return !!process.env.SCRAPECREATORS_API_KEY;
}

/** The key is wrong or credits ran out — retrying will not help. */
export class ScFatal extends Error {}
/** The API said «not found» on every try. */
export class ScNotFound extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface CallOpts {
  /** do not start a new try after this time (ms since epoch) */
  until?: number;
}

async function scGet<T>(path: string, params: Record<string, string>, opts: CallOpts = {}): Promise<T> {
  const key = process.env.SCRAPECREATORS_API_KEY;
  if (!key) throw new ScFatal('SCRAPECREATORS_API_KEY не задан.');
  const qs = new URLSearchParams(params).toString();
  let lastErr = '';
  let notFound = false;
  for (let i = 0; i < TRY_DELAYS.length; i++) {
    if (i > 0) {
      if (opts.until && Date.now() + TRY_DELAYS[i] > opts.until) break;
      await sleep(TRY_DELAYS[i]);
    }
    try {
      const res = await fetch(`${API}${path}?${qs}`, {
        headers: { 'x-api-key': key },
        cache: 'no-store',
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      const text = await res.text();
      let body: (T & { success?: boolean; message?: string; error?: string }) | null = null;
      try {
        body = JSON.parse(text);
      } catch {
        /* not JSON */
      }
      if (res.status === 401 || res.status === 402 || res.status === 403) {
        throw new ScFatal(
          `ScrapeCreators HTTP ${res.status}: ${body?.message || body?.error || text.slice(0, 200)} (ключ или кредиты)`
        );
      }
      if (res.ok && body && body.success !== false) return body;
      notFound = res.status === 404;
      lastErr = `HTTP ${res.status}: ${body?.message || body?.error || text.slice(0, 200)}`;
    } catch (e) {
      if (e instanceof ScFatal) throw e;
      notFound = false;
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  if (notFound) throw new ScNotFound(`ScrapeCreators ${path}: ${lastErr}`);
  throw new Error(`ScrapeCreators ${path}: ${lastErr}`);
}

// --- shapes (Apify-compatible) ------------------------------------------------------------

export interface IgProfile {
  username?: string;
  fullName?: string;
  biography?: string;
  externalUrl?: string | null;
  followersCount?: number;
  followsCount?: number;
  postsCount?: number;
  verified?: boolean;
  isPrivate?: boolean;
  businessCategoryName?: string | null;
  profilePicUrlHD?: string;
  profilePicUrl?: string;
}

export interface IgComment {
  postUrl?: string;
  text?: string;
  ownerUsername?: string;
  likesCount?: number | null;
  timestamp?: string;
}

export interface IgPost {
  type?: 'Image' | 'Video' | 'Sidecar';
  productType?: string;
  shortCode?: string;
  url?: string;
  caption?: string;
  timestamp?: string;
  likesCount?: number | null;
  commentsCount?: number | null;
  videoViewCount?: number | null;
  videoPlayCount?: number | null;
  videoDuration?: number | null;
  displayUrl?: string;
  videoUrl?: string;
  childPosts?: { displayUrl?: string; type?: string; videoUrl?: string }[];
  latestComments?: IgComment[];
  isPinned?: boolean;
  ownerUsername?: string;
  coauthorProducers?: { username?: string }[];
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const n = (v: any): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const iso = (sec: any): string | undefined => (typeof sec === 'number' ? new Date(sec * 1000).toISOString() : undefined);
const firstCandidate = (m: any): string | undefined => m?.image_versions2?.candidates?.[0]?.url;
const postUrl = (code: string) => `https://www.instagram.com/p/${code}/`;

/** One item of /v2/instagram/user/posts (private-API media shape). */
function fromFeed(m: any): IgPost {
  const type = m.media_type === 8 ? 'Sidecar' : m.media_type === 2 ? 'Video' : 'Image';
  const code: string = m.code;
  return {
    type,
    productType: m.product_type,
    shortCode: code,
    url: postUrl(code),
    caption: m.caption?.text ?? '',
    timestamp: iso(m.taken_at) ?? m.created_at,
    likesCount: n(m.like_count),
    commentsCount: n(m.comment_count),
    videoPlayCount: n(m.ig_play_count) ?? n(m.play_count),
    videoViewCount: n(m.view_count),
    videoDuration: n(m.video_duration),
    displayUrl: m.display_uri || firstCandidate(m),
    videoUrl: m.video_url || m.video_versions?.[0]?.url,
    childPosts: Array.isArray(m.carousel_media)
      ? m.carousel_media.map((c: any) => ({
          displayUrl: c.display_uri || firstCandidate(c),
          type: c.media_type === 2 ? 'Video' : 'Image',
          videoUrl: c.video_versions?.[0]?.url,
        }))
      : undefined,
    isPinned:
      (Array.isArray(m.timeline_pinned_user_ids) && m.timeline_pinned_user_ids.length > 0) || !!m.is_pinned,
    ownerUsername: m.user?.username ?? m.owner?.username,
    coauthorProducers: (m.coauthor_producers ?? []).map((u: any) => ({ username: u?.username })),
  };
}

/** /v1/instagram/post (web GraphQL shape: xdt_shortcode_media). */
function fromWeb(m: any): IgPost {
  const t: string = m.__typename ?? '';
  const type = t.includes('Sidecar') ? 'Sidecar' : t.includes('Video') || m.is_video ? 'Video' : 'Image';
  const code: string = m.shortcode;
  const comments = m.edge_media_to_parent_comment?.edges ?? m.edge_media_to_comment?.edges ?? [];
  return {
    type,
    productType: m.product_type ?? undefined,
    shortCode: code,
    url: postUrl(code),
    caption: m.edge_media_to_caption?.edges?.[0]?.node?.text ?? '',
    timestamp: iso(m.taken_at_timestamp) ?? m.created_at,
    likesCount: n(m.edge_media_preview_like?.count) ?? n(m.edge_liked_by?.count),
    commentsCount: n(m.comment_count) ?? n(m.edge_media_to_parent_comment?.count),
    videoPlayCount: n(m.video_play_count),
    videoViewCount: n(m.video_view_count),
    videoDuration: n(m.video_duration),
    displayUrl: m.display_url,
    videoUrl: m.video_url ?? undefined,
    childPosts: m.edge_sidecar_to_children?.edges?.map((e: any) => ({
      displayUrl: e.node?.display_url,
      type: e.node?.is_video ? 'Video' : 'Image',
      videoUrl: e.node?.video_url ?? undefined,
    })),
    latestComments: comments.map((e: any) => ({
      postUrl: postUrl(code),
      text: e.node?.text,
      ownerUsername: e.node?.owner?.username,
      likesCount: n(e.node?.edge_liked_by?.count),
      timestamp: iso(e.node?.created_at),
    })),
    ownerUsername: m.owner?.username,
    coauthorProducers: (m.coauthor_producers ?? []).map((u: any) => ({ username: u?.username })),
  };
}

// --- endpoints ----------------------------------------------------------------------------

export async function scProfile(handle: string, opts?: CallOpts): Promise<IgProfile> {
  const body = await scGet<any>('/v1/instagram/profile', { handle, trim: 'true' }, opts);
  const u = body?.data?.user;
  if (!u?.username) throw new ScNotFound('Профиль не найден.');
  return {
    username: u.username,
    fullName: u.full_name,
    biography: u.biography,
    externalUrl: u.external_url ?? u.bio_links?.[0]?.url ?? null,
    followersCount: n(u.edge_followed_by?.count) ?? undefined,
    followsCount: n(u.edge_follow?.count) ?? undefined,
    postsCount: n(u.edge_owner_to_timeline_media?.count) ?? undefined,
    verified: !!u.is_verified,
    isPrivate: !!u.is_private,
    businessCategoryName: u.category_name ?? null,
    profilePicUrlHD: u.profile_pic_url_hd,
    profilePicUrl: u.profile_pic_url,
  };
}

export interface PostsPage {
  items: IgPost[];
  next: string | null;
}

/** 12 newest posts per page; pass `next` back to get the following page. */
export async function scPostsPage(handle: string, cursor?: string | null, opts?: CallOpts): Promise<PostsPage> {
  const params: Record<string, string> = { handle };
  if (cursor) params.next_max_id = cursor;
  const body = await scGet<any>('/v2/instagram/user/posts', params, opts);
  const items: IgPost[] = (Array.isArray(body?.items) ? body.items : []).filter((m: any) => m?.code).map(fromFeed);
  if (!cursor) markPinned(items);
  const next = body?.more_available !== false && body?.next_max_id ? String(body.next_max_id) : null;
  return { items, next };
}

/**
 * Pinned posts (up to 3) sit on top of the first page, out of date order. The feed flag is not
 * always there, so: a post among the first 3 that is older than some post below it is pinned.
 */
function markPinned(items: IgPost[]) {
  const ms = items.map((it) => (it.timestamp ? new Date(it.timestamp).getTime() : NaN));
  for (let i = 0; i < Math.min(3, items.length); i++) {
    if (items[i].isPinned || Number.isNaN(ms[i])) continue;
    const newerBelow = ms.slice(i + 1).some((t) => !Number.isNaN(t) && t > ms[i]);
    if (newerBelow) items[i].isPinned = true;
  }
}

/** One post by link (with the first ~12 comments). */
export async function scPost(url: string, opts?: CallOpts): Promise<IgPost> {
  const body = await scGet<any>('/v1/instagram/post', { url }, opts);
  const m = body?.data?.xdt_shortcode_media;
  if (!m?.shortcode) throw new ScNotFound('Пост не найден.');
  return fromWeb(m);
}

export interface CommentsPage {
  items: IgComment[];
  next: string | null;
}

/** ~12 comments per page. */
export async function scCommentsPage(url: string, cursor?: string | null, opts?: CallOpts): Promise<CommentsPage> {
  const params: Record<string, string> = { url };
  if (cursor) params.cursor = cursor;
  const body = await scGet<any>('/v2/instagram/post/comments', params, opts);
  const items: IgComment[] = (Array.isArray(body?.comments) ? body.comments : []).map((c: any) => ({
    postUrl: url,
    text: c.text,
    ownerUsername: c.user?.username,
    likesCount: n(c.comment_like_count),
    timestamp: c.created_at,
  }));
  return { items, next: body?.cursor ? String(body.cursor) : null };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
