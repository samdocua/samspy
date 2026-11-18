// SamSpy — carousel text collector: Apify client
// Runs an Instagram post scraper actor on a list of post URLs (async run + polling).
// Both supported actors return the same output shape (type, caption, images,
// childPosts, ownerUsername…); only the input differs.
//
// Version history:
//   v0.4.0 (2026-11-18) — start run / get run / get items, slide extraction, link parsing.

const API = 'https://api.apify.com/v2';

const ACTORS = {
  // $0.18 / 1k posts, default
  dami: {
    id: 'dami_studio~instagram-post-scraper',
    input: (urls: string[]) => ({ postUrls: urls, maxItems: urls.length }),
  },
  // official, $1.50 / 1k posts — fallback via APIFY_ACTOR=official
  official: {
    id: 'apify~instagram-scraper',
    input: (urls: string[]) => ({
      directUrls: urls,
      resultsType: 'posts',
      resultsLimit: 1,
      addParentData: false,
    }),
  },
} as const;

function actor() {
  const key = (process.env.APIFY_ACTOR || 'dami').toLowerCase();
  return key === 'official' ? ACTORS.official : ACTORS.dami;
}

function token(): string {
  const t = process.env.APIFY_TOKEN;
  if (!t) throw new Error('APIFY_TOKEN is not set.');
  return t;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, cache: 'no-store' });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    throw new Error(`Apify HTTP ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

export interface ApifyRun {
  id: string;
  status: string; // READY | RUNNING | SUCCEEDED | FAILED | ABORTED | TIMED-OUT …
  defaultDatasetId: string;
}

export async function startRun(urls: string[]): Promise<ApifyRun> {
  const a = actor();
  const data = await fetchJson<{ data: ApifyRun }>(
    `${API}/acts/${a.id}/runs?token=${token()}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(a.input(urls)),
    }
  );
  return data.data;
}

export async function getRun(runId: string): Promise<ApifyRun> {
  const data = await fetchJson<{ data: ApifyRun }>(
    `${API}/actor-runs/${runId}?token=${token()}`
  );
  return data.data;
}

export const RUN_FAILED = ['FAILED', 'ABORTED', 'TIMED-OUT'];

// Loose shape of one dataset item (fields we use).
export interface ApifyItem {
  ok?: boolean;
  inputUrl?: string;
  url?: string;
  shortCode?: string;
  type?: string;
  caption?: string;
  ownerUsername?: string;
  likesCount?: number | null;
  commentsCount?: number | null;
  timestamp?: string;
  displayUrl?: string;
  images?: string[];
  childPosts?: { displayUrl?: string; type?: string; videoUrl?: string }[];
}

export async function getItems(datasetId: string): Promise<ApifyItem[]> {
  return fetchJson<ApifyItem[]>(
    `${API}/datasets/${datasetId}/items?clean=true&format=json&token=${token()}`
  );
}

/** Slide image URLs of one post, in order. */
export function extractSlides(it: ApifyItem): { url: string; isVideo: boolean }[] {
  let list: { url?: string; isVideo: boolean }[] = [];
  if (Array.isArray(it.childPosts) && it.childPosts.length) {
    list = it.childPosts.map((c) => ({
      url: c.displayUrl,
      isVideo: c.type === 'Video' || !!c.videoUrl,
    }));
  } else if (Array.isArray(it.images) && it.images.length) {
    list = it.images.map((u) => ({ url: u, isVideo: false }));
  } else if (it.displayUrl) {
    list = [{ url: it.displayUrl, isVideo: it.type === 'Video' }];
  }
  return list.filter((s): s is { url: string; isVideo: boolean } => !!s.url);
}

export function itemShortcode(it: ApifyItem): string {
  return (
    shortcodeFromUrl(it.inputUrl || '') || it.shortCode || shortcodeFromUrl(it.url || '')
  );
}

export function shortcodeFromUrl(url: string): string {
  const m = url.match(/instagram\.com\/(?:[^/]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i);
  return m ? m[1] : '';
}

/** Pulls unique Instagram post links out of free text. Returns canonical /p/ URLs. */
export function parseLinks(text: string): { url: string; shortcode: string }[] {
  const seen = new Set<string>();
  const out: { url: string; shortcode: string }[] = [];
  for (const m of text.matchAll(/https?:\/\/(?:www\.)?instagram\.com\/[^\s"'<>]+/gi)) {
    const code = shortcodeFromUrl(m[0]);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push({ url: `https://www.instagram.com/p/${code}/`, shortcode: code });
  }
  return out;
}
