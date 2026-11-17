// SamSpy — Virlo API client
//
// Thin wrapper around the Virlo REST API (https://api.virlo.ai/v1).
// Keeps every Virlo call in one place so the provider can be swapped later
// without touching the rest of the app.
//
// Version history:
//   v0.1.0 (2026-11-17) — Tracking (creators + posts + signals) and the
//                         Instagram top-reels digest. Tab 1 needs only
//                         trackCreator + getCreator + listCreatorPosts.
//
// Auth: Bearer token. Set VIRLO_API_KEY (format: virlo_tkn_...) in the env.
// Billing note: trackCreator costs $0.25 (first check). listCreatorPosts,
//               getCreator and signals are FREE. instagramDigest costs $0.25.

import type {
  VirloEnvelope,
  VirloListEnvelope,
  VirloCadence,
  VirloPlatform,
  VirloTrackCreatorResponse,
  VirloCreator,
  VirloCreatorPost,
  VirloSignal,
  VirloInstagramDigestItem,
  VirloSearchVideosResponse,
} from './types/virlo';

const VIRLO_BASE_URL = 'https://api.virlo.ai/v1';

/** Thrown for any non-2xx Virlo response, carrying status + parsed body. */
export class VirloError extends Error {
  status: number;
  code?: string;
  body: unknown;
  constructor(status: number, message: string, body: unknown, code?: string) {
    super(message);
    this.name = 'VirloError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

function getApiKey(): string {
  const key = process.env.VIRLO_API_KEY;
  if (!key) {
    throw new Error(
      'VIRLO_API_KEY is not set. Add it to your environment (format: virlo_tkn_...).'
    );
  }
  return key;
}

/** Core fetch wrapper: auth header, JSON parse, uniform error handling. */
async function virloFetch<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const res = await fetch(`${VIRLO_BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
    // Virlo data is our own cache source; never let the platform cache it.
    cache: 'no-store',
  });

  // 204 No Content (e.g. DELETE) — nothing to parse.
  if (res.status === 204) return undefined as T;

  let body: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!res.ok) {
    const b = body as { message?: string; code?: string; error?: string } | null;
    const message =
      b?.message ?? b?.error ?? `Virlo request failed (${res.status})`;
    throw new VirloError(res.status, message, body, b?.code);
  }

  return body as T;
}

// ---------------------------------------------------------------------------
// Tracking — creators
// ---------------------------------------------------------------------------

export interface TrackCreatorInput {
  /** Instagram username without @, e.g. "flamingoappreels". */
  handle: string;
  /** How often Virlo re-checks the account. Defaults to daily. */
  cadence?: VirloCadence;
}

/**
 * Start tracking an Instagram creator. Costs $0.25 (covers the first check).
 * Returns Virlo's creator id — store it as competitors.virlo_creator_id.
 *
 * Throws VirloError:
 *   409 — already tracked (body may include creator_id)
 *   400 — creator_not_found / creator_login_required (don't retry)
 *   402 — balance too low
 */
export async function trackCreator(
  input: TrackCreatorInput
): Promise<VirloTrackCreatorResponse> {
  const res = await virloFetch<VirloEnvelope<VirloTrackCreatorResponse>>(
    '/tracking/creators',
    {
      method: 'POST',
      body: JSON.stringify({
        platform: 'instagram',
        handle: input.handle,
        scrape_cadence: input.cadence ?? 'daily',
      }),
    }
  );
  return res.data;
}

/** Fetch one tracked creator (free). Poll this until enrichment_status is ready. */
export async function getCreator(virloCreatorId: string): Promise<VirloCreator> {
  const res = await virloFetch<VirloEnvelope<VirloCreator>>(
    `/tracking/creators/${virloCreatorId}`
  );
  return res.data;
}

/** Change cadence or pause/resume a tracked creator (free; resume costs $0.25). */
export async function updateCreator(
  virloCreatorId: string,
  patch: { status?: 'active' | 'paused'; cadence?: VirloCadence }
): Promise<VirloCreator> {
  const body: Record<string, unknown> = {};
  if (patch.status) body.status = patch.status;
  if (patch.cadence) body.scrape_cadence = patch.cadence;
  const res = await virloFetch<VirloEnvelope<VirloCreator>>(
    `/tracking/creators/${virloCreatorId}`,
    { method: 'PATCH', body: JSON.stringify(body) }
  );
  return res.data;
}

/** Stop tracking a creator (free). Returns nothing (204). */
export async function stopTrackingCreator(virloCreatorId: string): Promise<void> {
  await virloFetch<void>(`/tracking/creators/${virloCreatorId}`, {
    method: 'DELETE',
  });
}

export interface ListCreatorPostsOptions {
  sort?: 'publish_date_desc' | 'publish_date_asc' | 'views_desc';
  startDate?: string; // ISO 8601
  endDate?: string;
  page?: number;
  limit?: number;     // 1..200, default 50
}

/**
 * List a creator's stored posts with stats (free). This is our catalog source.
 * Each post carries is_outlier / outlier_ratio / outlier_weighted_score.
 */
export async function listCreatorPosts(
  virloCreatorId: string,
  opts: ListCreatorPostsOptions = {}
): Promise<VirloListEnvelope<VirloCreatorPost>> {
  const params = new URLSearchParams();
  if (opts.sort) params.set('sort', opts.sort);
  if (opts.startDate) params.set('start_date', opts.startDate);
  if (opts.endDate) params.set('end_date', opts.endDate);
  params.set('page', String(opts.page ?? 1));
  params.set('limit', String(opts.limit ?? 50));

  return virloFetch<VirloListEnvelope<VirloCreatorPost>>(
    `/tracking/creators/${virloCreatorId}/posts?${params.toString()}`
  );
}

/** Get a creator's outlier/follower alerts, newest first (free). */
export async function getCreatorSignals(
  virloCreatorId: string,
  limit = 50
): Promise<VirloSignal[]> {
  const res = await virloFetch<VirloEnvelope<VirloSignal[]>>(
    `/tracking/creators/${virloCreatorId}/signals?limit=${limit}`
  );
  return res.data;
}

// ---------------------------------------------------------------------------
// Instagram top-reels digest (tab 3) — most-viewed Reels of the last 48h.
// One request = $0.25 regardless of limit.
// ---------------------------------------------------------------------------

export async function instagramDigest(
  limit = 50
): Promise<VirloInstagramDigestItem[]> {
  const res = await virloFetch<VirloEnvelope<VirloInstagramDigestItem[]>>(
    `/instagram/videos/digest?limit=${Math.min(Math.max(limit, 1), 100)}`
  );
  return res.data;
}

// ---------------------------------------------------------------------------
// Keyword search (tab 2) — POST /v1/search/videos over Virlo's library.
// $0.05 per page of 25 results (empty page is free). Paginate via next_cursor.
// ---------------------------------------------------------------------------

export interface SearchVideosInput {
  /** Keyword topics; a block uses one topic with `|`-joined synonyms. */
  topics: string[];
  platforms?: VirloPlatform[]; // default ['instagram']
  postedAfter?: string; // 'YYYY-MM-DD'
  cursor?: string; // from a previous next_cursor (1h TTL)
}

/**
 * Run one page (25 results) of a library video search. Costs $0.05 if the
 * page has results. Returns the page plus next_cursor for the following page.
 */
export async function searchVideos(
  input: SearchVideosInput
): Promise<VirloSearchVideosResponse> {
  const body: Record<string, unknown> = {
    scope: 'virlo_library',
    topics: input.topics,
    platforms: input.platforms ?? ['instagram'],
  };
  if (input.postedAfter) body.posted_after = input.postedAfter;
  if (input.cursor) body.cursor = input.cursor;

  const res = await virloFetch<VirloEnvelope<VirloSearchVideosResponse>>(
    '/search/videos',
    { method: 'POST', body: JSON.stringify(body) }
  );
  return res.data;
}
