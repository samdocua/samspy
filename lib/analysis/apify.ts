// SamSpy — «Анализ»: Apify runs for one Instagram account
//
//   profile: apify~instagram-profile-scraper — bio, followers, posts count, avatar.
//   posts:   apify~instagram-scraper (resultsType 'posts') — every post of the profile grid
//            newer than the period start (reels, carousels, photos) with likes, comments,
//            plays, duration, caption, coauthors.
// Both runs start together; the job step polls them.
//
// Version history:
//   v0.1.0 (2026-11-22) — initial.

import { getRun, RUN_FAILED, type ApifyRun } from '@/lib/carousels/apify';

export { getRun, RUN_FAILED };

const API = 'https://api.apify.com/v2';

/** Hard cap of posts per dossier (a very active account can post 1000+ a year). */
export const MAX_POSTS = Math.max(50, Math.min(3000, Number(process.env.ANALYSIS_MAX_POSTS) || 1500));

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

async function start(actor: string, input: unknown): Promise<ApifyRun> {
  const data = await fetchJson<{ data: ApifyRun }>(`${API}/acts/${actor}/runs?token=${token()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return data.data;
}

export function startProfile(username: string): Promise<ApifyRun> {
  return start('apify~instagram-profile-scraper', { usernames: [username] });
}

/** All grid posts newer than `from` (YYYY-MM-DD), up to MAX_POSTS. */
export function startPosts(username: string, from: string): Promise<ApifyRun> {
  return start('apify~instagram-scraper', {
    directUrls: [`https://www.instagram.com/${username}/`],
    resultsType: 'posts',
    resultsLimit: MAX_POSTS,
    onlyPostsNewerThan: from,
    addParentData: false,
  });
}

export async function getDataset<T>(datasetId: string): Promise<T[]> {
  return fetchJson<T[]>(`${API}/datasets/${datasetId}/items?clean=true&format=json&token=${token()}`);
}

// Loose shapes of dataset items (fields we use).
export interface ProfileItem {
  username?: string;
  fullName?: string;
  biography?: string;
  externalUrl?: string | null;
  externalUrls?: { url?: string }[];
  followersCount?: number;
  followsCount?: number;
  postsCount?: number;
  verified?: boolean;
  businessCategoryName?: string | null;
  profilePicUrlHD?: string;
  profilePicUrl?: string;
  error?: string;
}

export interface PostItem {
  type?: string; // Image | Video | Sidecar
  productType?: string; // clips | feed | carousel_container | igtv
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
  images?: string[];
  childPosts?: unknown[];
  isPinned?: boolean;
  ownerUsername?: string;
  coauthorProducers?: { username?: string }[];
  error?: string;
}

/** «instagram.com/name/…», «@name», «name» → «name» (lower case), or '' when invalid. */
export function parseUsername(input: string): string {
  const s = input.trim();
  const m = s.match(/instagram\.com\/([A-Za-z0-9._]+)/i);
  const raw = (m ? m[1] : s.replace(/^@/, '')).toLowerCase();
  if (['p', 'reel', 'reels', 'tv', 'stories', 'explore'].includes(raw)) return '';
  return /^[a-z0-9._]{1,30}$/.test(raw) ? raw : '';
}
