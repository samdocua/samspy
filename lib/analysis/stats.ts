// SamSpy — «Анализ»: numbers of a dossier, computed in code (no model)
//
//   Reels are measured by plays (views); carousels / photos by likes (Instagram shows
//   no views for them). «Залёт» = ≥ 2× the account median of the same kind.
//   Weekday / hour buckets use Europe/Kyiv time.
//
// Version history:
//   v0.1.0 (2026-11-22) — initial: per-kind stats, trend, CTA / collab share,
//                         weekday / hour / monthly buckets, card summary, post ratio.

import type {
  AccountStats,
  AnalysisPost,
  BucketStat,
  CardSummary,
  KindStats,
  MonthStat,
  PostKind,
} from './types';

const DAY = 86_400_000;
const TZ = 'Europe/Kyiv';
export const OUTLIER_X = 2;

export function median(values: (number | null | undefined)[]): number | null {
  const v = values.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

const round = (x: number, d = 1) => Math.round(x * 10 ** d) / 10 ** d;

/** Main metric of a post for its kind: plays for reels, likes for the rest. */
export function metricOf(p: Pick<AnalysisPost, 'kind' | 'views' | 'likes'>): number | null {
  const v = p.kind === 'reel' ? p.views : p.likes;
  return typeof v === 'number' && v >= 0 ? v : null;
}

// Calls to action in a caption (EN + RU).
const CTA_RE =
  /(link in (my )?bio|in my bio|ссылк\p{L}* в (шапке|профиле|био)|comment\s+["“'«]?[A-Za-zА-Яа-я0-9]{2,}["”'»]?\s+(below|and|to|for|ниже|и|чтобы)|коммент\p{L}*\s+["«“]?[A-ZА-Я0-9]{2,}|напиши\s+(в\s+)?(коммент|директ|«|")|\bdm\s+(me|us)\b|send me a (dm|message)|в директ|\bfollow (me|for|@)|подпи(ш|сыв)\p{L}*|save (this|it|for later)|сохрани\p{L}*|share (this|with)|поделись|get (your|my) free|free (guide|roadmap|checklist|course|ebook|template)|бесплатн\p{L}+ (гайд|урок|чек-?лист|курс|вебинар)|join (my|our|the)|sign up|register|запиш\p{L}+|купи\p{L}*|buy now|shop now|order now|use code|промокод)/iu;

export function hasCta(caption: string | null | undefined): boolean {
  return !!caption && CTA_RE.test(caption);
}

function kyivParts(iso: string): { weekday: number; hour: number; month: string } | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    weekday: 'short',
    hour: '2-digit',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const wd = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(get('weekday'));
  return { weekday: wd < 0 ? 0 : wd, hour: Number(get('hour')) % 24, month: `${get('year')}-${get('month')}` };
}

function kindStats(list: AnalysisPost[], kind: PostKind, weeks: number, toMs: number): KindStats {
  const posts = list.filter((p) => p.kind === kind);
  const values = posts.map(metricOf);
  const med = median(values);
  const outliers = med ? posts.filter((p) => (metricOf(p) ?? -1) >= OUTLIER_X * med) : [];

  let best: KindStats['best'] = null;
  for (const p of posts) {
    const v = metricOf(p);
    if (v != null && (!best || v > best.value)) best = { shortcode: p.shortcode, value: v };
  }

  // trend: median of the last 30 days ÷ median of the earlier part of the period
  const cut = toMs - 30 * DAY;
  const recent = posts.filter((p) => p.posted_at && new Date(p.posted_at).getTime() >= cut);
  const earlier = posts.filter((p) => p.posted_at && new Date(p.posted_at).getTime() < cut);
  const mr = median(recent.map(metricOf));
  const me = median(earlier.map(metricOf));
  const trend = mr != null && me ? round(mr / me, 2) : null;

  let likesPct: number | null = null;
  let commentsPer1000: number | null = null;
  if (kind === 'reel') {
    const withViews = posts.filter((p) => (p.views ?? 0) > 0);
    const views = withViews.reduce((a, p) => a + (p.views ?? 0), 0);
    const likes = withViews.filter((p) => (p.likes ?? -1) >= 0).reduce((a, p) => a + (p.likes ?? 0), 0);
    const comments = withViews.reduce((a, p) => a + Math.max(0, p.comments ?? 0), 0);
    if (views > 0) {
      likesPct = round((100 * likes) / views, 2);
      commentsPer1000 = round((1000 * comments) / views, 2);
    }
  } else {
    const withLikes = posts.filter((p) => (p.likes ?? -1) > 0);
    const likes = withLikes.reduce((a, p) => a + (p.likes ?? 0), 0);
    const comments = withLikes.reduce((a, p) => a + Math.max(0, p.comments ?? 0), 0);
    if (likes > 0) commentsPer1000 = round((1000 * comments) / likes, 1);
  }

  return {
    count: posts.length,
    median: med,
    outliers: outliers.length,
    best,
    per_week: round(posts.length / weeks, 1),
    trend,
    likes_pct: likesPct,
    comments_per_1000: commentsPer1000,
    median_duration: kind === 'reel' ? median(posts.map((p) => p.duration)) : null,
    outliers_median_duration: kind === 'reel' ? median(outliers.map((p) => p.duration)) : null,
    median_slides: kind === 'carousel' ? median(posts.map((p) => p.slides)) : null,
  };
}

/** Post's result relative to the account median of its kind (reels vs reels, posts vs posts). */
export function ratioOf(p: Pick<AnalysisPost, 'kind' | 'views' | 'likes'>, s: AccountStats): number | null {
  const v = metricOf(p);
  const med = p.kind === 'reel' ? s.reels.median : p.kind === 'carousel' ? s.carousels.median : s.photos.median;
  return v != null && med ? round(v / med, 2) : null;
}

export function computeStats(
  all: AnalysisPost[],
  followers: number | null,
  fromIso: string,
  toIso: string
): AccountStats {
  const fromMs = new Date(fromIso).getTime();
  const toMs = new Date(toIso).getTime();
  const days = Math.max(1, Math.round((toMs - fromMs) / DAY));
  const weeks = days / 7;
  // pinned posts can be older than the period — they stay listed but are not counted
  const posts = all.filter((p) => !p.posted_at || new Date(p.posted_at).getTime() >= fromMs);

  const reels = kindStats(posts, 'reel', weeks, toMs);
  const carousels = kindStats(posts, 'carousel', weeks, toMs);
  const photos = kindStats(posts, 'photo', weeks, toMs);
  const partial: AccountStats = {
    period: { from: fromIso, to: toIso, days },
    total: posts.length,
    reels,
    carousels,
    photos,
    per_week: round(posts.length / weeks, 1),
    cta_pct: posts.length ? Math.round((100 * posts.filter((p) => p.has_cta).length) / posts.length) : 0,
    collab_pct: posts.length
      ? Math.round((100 * posts.filter((p) => p.coauthors.length > 0).length) / posts.length)
      : 0,
    pinned: all.filter((p) => p.is_pinned).length,
    hidden_likes: posts.filter((p) => p.likes == null).length,
    engagement_pct:
      followers && followers > 0
        ? (() => {
            const m = median(
              posts.filter((p) => p.likes != null).map((p) => (p.likes ?? 0) + Math.max(0, p.comments ?? 0))
            );
            return m == null ? null : round((100 * m) / followers, 2);
          })()
        : null,
    by_weekday: [],
    by_hour: [],
    monthly: [],
  };

  // buckets by weekday / hour: count + median ratio to the median of the post's kind
  const wd: number[][] = Array.from({ length: 7 }, () => []);
  const hr: number[][] = Array.from({ length: 24 }, () => []);
  const wdCount = new Array(7).fill(0);
  const hrCount = new Array(24).fill(0);
  const months = new Map<string, AnalysisPost[]>();
  for (const p of posts) {
    if (!p.posted_at) continue;
    const k = kyivParts(p.posted_at);
    if (!k) continue;
    wdCount[k.weekday]++;
    hrCount[k.hour]++;
    const r = ratioOf(p, partial);
    if (r != null) {
      wd[k.weekday].push(r);
      hr[k.hour].push(r);
    }
    const list = months.get(k.month);
    if (list) list.push(p);
    else months.set(k.month, [p]);
  }
  const bucket = (vals: number[][], counts: number[]): BucketStat[] =>
    vals.map((v, i) => ({ count: counts[i], median_ratio: median(v) }));
  partial.by_weekday = bucket(wd, wdCount);
  partial.by_hour = bucket(hr, hrCount);
  partial.monthly = Array.from(months.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([month, list]): MonthStat => ({
        month,
        posts: list.length,
        reels: list.filter((p) => p.kind === 'reel').length,
        reels_median_views: median(list.filter((p) => p.kind === 'reel').map(metricOf)),
        posts_median_likes: median(list.filter((p) => p.kind !== 'reel').map(metricOf)),
      })
    );
  return partial;
}

/** Card numbers: reels if the account posts reels, else carousels + photos. */
export function cardSummary(s: AccountStats): CardSummary {
  const main = s.reels.count >= Math.max(1, s.carousels.count + s.photos.count) / 3 ? s.reels : s.carousels;
  return {
    median_views: s.reels.median,
    outliers_pct: main.count ? Math.round((100 * main.outliers) / main.count) : null,
    per_week: s.per_week,
    trend: main.trend,
    posts: s.total,
  };
}
