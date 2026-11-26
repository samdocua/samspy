// SamSpy — «План», mode 'copy': slide texts 1:1 from competitors' winning carousels (server only)
//
//   buildPool()      winners of the source dossiers (carousels, best ratio first, sources
//                    interleaved), minus carousels already used in any plan
//   textsOf()        slide texts of one carousel: the dossier's OCR if there is one, else OCR now
//                    (fresh slide links from ScrapeCreators when the old ones expired); saved back
//                    to the dossier post
//   cleaning         Haiku (cleanCarouselSlides) keeps every question / answer option verbatim and
//                    removes brand names, taglines, app promos and the closing CTA — even when they
//                    sit in the middle of a slide; slidesFromOcr() is the rule-based fallback
//                    (brand lines repeated on most slides, @handles, promo slides, CTA at the end)
//
// Version history:
//   v0.1.0 (2026-11-26) — initial.
//   v0.1.1 (2026-11-26) — a dossier OCR of the cover only (older fallback) is redone from all
//                         slides; before, such carousels were skipped (a whole source dropped out).
//   v0.1.2 (2026-11-26) — line wraps of the original layout glued (joinSoftBreaks): they made
//                         one-word lines on my slides.

import type { SupabaseClient } from '@supabase/supabase-js';
import { cleanCarouselSlides, ocrCarousel } from '@/lib/analysis/ai';
import { joinSoftBreaks } from '@/lib/carousels/postprocess';
import { ratioOf } from '@/lib/analysis/stats';
import type { AnalysisAccount, AnalysisJob, AnalysisPost } from '@/lib/analysis/types';
import { scEnabled, scPost } from '@/lib/scrape/sc';
import type { CopySource } from './types';

const PER_SOURCE = 800; // best carousels looked at per source account
const MIN_RATIO = 2; // a «winner»: ≥ ×2 the account's carousel median

/** Winners of the sources, best first, sources interleaved, without carousels used before. */
export async function buildPool(sb: SupabaseClient, sources: string[], need: number): Promise<CopySource[]> {
  const { data: usedRows } = await sb
    .from('content_plan_items')
    .select('source_shortcode')
    .not('source_shortcode', 'is', null)
    .limit(20000);
  const used = new Set((usedRows ?? []).map((r) => r.source_shortcode as string));

  const lists: CopySource[][] = [];
  for (const username of sources) {
    const { data: acc } = await sb
      .from('analysis_accounts')
      .select('username,last_job_id')
      .eq('username', username)
      .maybeSingle<Pick<AnalysisAccount, 'username' | 'last_job_id'>>();
    if (!acc?.last_job_id) continue;
    const { data: job } = await sb
      .from('analysis_jobs')
      .select('id,stats')
      .eq('id', acc.last_job_id)
      .maybeSingle<Pick<AnalysisJob, 'id' | 'stats'>>();
    if (!job?.stats) continue;
    // carousel ratio = likes / median likes → the most liked are the best
    const { data: posts } = await sb
      .from('analysis_posts')
      .select('shortcode,url,kind,likes,views,slides,is_pinned')
      .eq('job_id', job.id)
      .eq('kind', 'carousel')
      .not('likes', 'is', null)
      .order('likes', { ascending: false })
      .limit(PER_SOURCE)
      .returns<Pick<AnalysisPost, 'shortcode' | 'url' | 'kind' | 'likes' | 'views' | 'slides' | 'is_pinned'>[]>();
    const list = (posts ?? [])
      .filter((p) => !used.has(p.shortcode) && (p.slides ?? 2) >= 2)
      .map((p) => ({ username, job_id: job.id, shortcode: p.shortcode, url: p.url, ratio: ratioOf(p, job.stats!) }));
    // winners; if a source has few, its next best fill in
    const winners = list.filter((p) => (p.ratio ?? 0) >= MIN_RATIO);
    lists.push(winners.length >= Math.ceil(need / Math.max(1, sources.length)) ? winners : list);
  }

  // interleave: best of each source in turn
  const out: CopySource[] = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) {
    for (const l of lists) if (i < l.length) out.push(l[i]);
  }
  return out;
}

const PROMO_RE =
  /\b(download|app ?store|google play|link in (my )?bio|search .{0,30} (on|in) the app|available (on|in)|use code)\b/i;
const CTA_RE =
  /\b(comment|follow|save (this|it)|share (this|it|with)|tag (your|a|someone)|send (this|it) to|dm me|turn on notifications|like (this|if)|subscribe)\b/i;

/** OCR text («--- 1 ---\n…») → slide texts, cleaned of brand lines / promos / the source's CTA. */
export function slidesFromOcr(ocr: string): string[] {
  const raw = ocr
    .split(/^\s*-{2,}\s*\d+\s*-{2,}\s*$/m)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!raw.length) return [];
  const lines = raw.map((s) => s.split('\n').map((l) => l.trim()));

  // brand / watermark lines: the same line on most slides («flamingo app», «21 QUESTIONS»)
  const norm = (l: string) => l.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const count = new Map<string, number>();
  for (const ls of lines) for (const k of new Set(ls.map(norm).filter(Boolean))) count.set(k, (count.get(k) ?? 0) + 1);
  const brand = new Set(
    raw.length >= 3 ? Array.from(count.entries()).filter(([, n]) => n >= Math.ceil(raw.length * 0.5)).map(([k]) => k) : []
  );

  const slides = lines
    .map((ls) =>
      ls
        .filter((l) => l && !brand.has(norm(l)) && !/^@[\w.]+$/.test(l) && !/^\(?без текста\)?$/i.test(l))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    )
    .filter((s) => s && !PROMO_RE.test(s));

  // the source's own call to action at the end goes — ours replaces it
  while (slides.length > 1 && CTA_RE.test(slides[slides.length - 1]) && !/\?/.test(slides[slides.length - 1])) slides.pop();
  return slides;
}

/** Slide texts of one carousel (OCR from the dossier, or OCR now). Null if it cannot be read. */
export async function textsOf(sb: SupabaseClient, src: CopySource): Promise<{ slides: string[]; title: string | null } | null> {
  const { data: post } = await sb
    .from('analysis_posts')
    .select('id,url,ocr_text,slide_urls,title_ru,slides')
    .eq('job_id', src.job_id)
    .eq('shortcode', src.shortcode)
    .maybeSingle<Pick<AnalysisPost, 'id' | 'url' | 'ocr_text' | 'slide_urls' | 'title_ru' | 'slides'>>();
  if (!post) return null;

  // the dossier OCR counts only if it covers the slides (an older fallback read the cover only)
  const ocrSlides = (post.ocr_text?.match(/^\s*-{2,}\s*\d+\s*-{2,}\s*$/gm) ?? []).length;
  const covers = ocrSlides >= Math.min(2, post.slides ?? 2);
  let ocr = post.ocr_text && post.ocr_text.trim().length > 20 && covers ? post.ocr_text : null;
  if (!ocr) {
    let urls = post.slide_urls ?? [];
    try {
      if (!urls.length) throw new Error('no links');
      ocr = await ocrCarousel(urls);
    } catch {
      // Instagram image links expire — fresh ones from ScrapeCreators
      if (!scEnabled()) return null;
      try {
        const fresh = await scPost(post.url || src.url);
        urls = (fresh.childPosts ?? []).map((c) => c.displayUrl).filter((u): u is string => !!u);
        if (!urls.length) return null;
        ocr = await ocrCarousel(urls);
        await sb.from('analysis_posts').update({ slide_urls: urls }).eq('id', post.id);
      } catch {
        return null;
      }
    }
    await sb.from('analysis_posts').update({ ocr_text: ocr, text_done: true }).eq('id', post.id);
  }
  if (!ocr) return null;
  const clean = await cleanCarouselSlides(ocr, src.username).catch(() => null);
  const slides = (clean ?? slidesFromOcr(ocr)).map(joinSoftBreaks).filter(Boolean);
  return { slides, title: post.title_ru };
}

/** Lower-case letters / digits only — to compare slide texts. */
export const normSlide = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
