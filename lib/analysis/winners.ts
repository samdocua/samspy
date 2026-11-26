// SamSpy — «залёт относительно своего времени»: the strongest carousels of a dossier (server only)
//
// A post's strength = its likes / the median likes of the account's carousels within ±15 days of
// it. An account that grew (or shrank) during the year is compared with itself at that time, so
// a ×10 spring hit is not pushed out by ordinary posts of a bigger autumn. Pinned posts are left
// out. At most PER_MONTH posts of one month are taken, so the pick covers the whole year.
//
// Used by «Распознать слайды» (which 200 carousels are read in full), «План» copies (which
// carousels are copied) and the «План» playbook (what Claude learns from).
//
// Version history:
//   v0.1.0 (2026-11-26) — initial.

import type { SupabaseClient } from '@supabase/supabase-js';

const WINDOW_DAYS = 15;
const DAY = 86_400_000;
const PAGE = 1000;

export interface Winner {
  id: string;
  shortcode: string;
  url: string;
  likes: number;
  posted_at: string;
  slides: number | null;
  strength: number; // likes / local median
}

interface Row {
  id: string;
  shortcode: string;
  url: string;
  likes: number | null;
  posted_at: string | null;
  slides: number | null;
  is_pinned: boolean | null;
}

/** All carousels of a job in the period (light columns, keyset pages on the date index). */
async function carousels(sb: SupabaseClient, jobId: string, fromIso: string): Promise<Row[]> {
  const out: Row[] = [];
  let after: Row | null = null;
  for (;;) {
    let q = sb
      .from('analysis_posts')
      .select('id,shortcode,url,likes,posted_at,slides,is_pinned,kind')
      .eq('job_id', jobId)
      .eq('kind', 'carousel')
      .gte('posted_at', fromIso);
    if (after) q = q.or(`posted_at.lt.${after.posted_at},and(posted_at.eq.${after.posted_at},id.lt.${after.id})`);
    const { data, error } = await q
      .order('posted_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(PAGE)
      .returns<Row[]>();
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
    after = data[data.length - 1];
  }
  return out;
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Every carousel of the period with its strength (pinned ones left out), strongest first. */
export async function rankCarousels(sb: SupabaseClient, jobId: string, fromIso: string): Promise<Winner[]> {
  const rows = (await carousels(sb, jobId, fromIso)).filter(
    (r) => !r.is_pinned && r.posted_at && typeof r.likes === 'number'
  );
  if (!rows.length) return [];
  // median per day of the ±15-day window around it (posts sorted by time, two pointers)
  const t = rows.map((r) => new Date(r.posted_at!).getTime());
  const order = rows.map((_, i) => i).sort((a, b) => t[a] - t[b]);
  const dayMedian = new Map<number, number>();
  let lo = 0;
  let hi = 0;
  for (const i of order) {
    const day = Math.floor(t[i] / DAY);
    if (dayMedian.has(day)) continue;
    while (lo < order.length && t[order[lo]] < (day - WINDOW_DAYS) * DAY) lo++;
    while (hi < order.length && t[order[hi]] < (day + WINDOW_DAYS + 1) * DAY) hi++;
    const m = median(order.slice(lo, hi).map((j) => rows[j].likes!));
    if (m) dayMedian.set(day, m);
  }
  return rows
    .map((r, i) => {
      const m = dayMedian.get(Math.floor(t[i] / DAY)) ?? 0;
      return {
        id: r.id,
        shortcode: r.shortcode,
        url: r.url,
        likes: r.likes!,
        posted_at: r.posted_at!,
        slides: r.slides,
        strength: m > 0 ? Math.round((r.likes! / m) * 100) / 100 : 0,
      };
    })
    .sort((a, b) => b.strength - a.strength);
}

/** The strongest `limit` carousels, at most `perMonth` of one calendar month. */
export async function topWinners(
  sb: SupabaseClient,
  jobId: string,
  fromIso: string,
  limit = 200,
  perMonth = 30
): Promise<Winner[]> {
  const ranked = await rankCarousels(sb, jobId, fromIso);
  const byMonth = new Map<string, number>();
  const out: Winner[] = [];
  for (const w of ranked) {
    const m = w.posted_at.slice(0, 7);
    if ((byMonth.get(m) ?? 0) >= perMonth) continue;
    byMonth.set(m, (byMonth.get(m) ?? 0) + 1);
    out.push(w);
    if (out.length >= limit) break;
  }
  return out;
}
