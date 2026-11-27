// SamSpy — carousel → «Слайды» hand-off
//
// Turns a collected carousel post into the list of slide texts for the «Слайды»
// tab: one original slide → one slide, in order. CTA is dropped for now: a
// CTA-only slide is skipped, a «content + CTA» last slide keeps only the content.
// Brand watermarks are already removed by postprocess. Line wraps are glued.
//
// Version history:
//   v0.1.0 (2026-11-19) — initial hand-off (no CTA).
//   v0.2.0 (2026-11-22) — optional planItemId: a carousel from «План» (marked done after ZIP).
//   v0.3.0 (2026-11-27) — optional caption (from «План»): goes with the slides to the phone page.

import { joinSoftBreaks } from './postprocess';
import type { CarouselPostFull } from './types';

/** Payload sent from «Карусели» to «Слайды». `id` makes every send unique. */
export interface SlidesImport {
  id: string;
  title: string; // e.g. "@flamingoappreels"
  texts: string[]; // one entry per slide, in order
  planItemId?: string; // sent from «План»: «Скачать все» in «Слайды» marks it done
  caption?: string; // post caption (from «План») — copied on the phone page
}

export function carouselToSlideTexts(post: CarouselPostFull): string[] {
  return [...post.slides]
    .sort((a, b) => a.idx - b.idx)
    .filter((s) => s.role !== 'cta') // CTA-only slide → skipped
    .map((s) => joinSoftBreaks(s.text ?? '')); // body+cta → `text` is the content part only
}

export function makeSlidesImport(post: CarouselPostFull): SlidesImport {
  return {
    id: `${post.id}-${Date.now()}`,
    title: post.author ? `@${post.author}` : post.url,
    texts: carouselToSlideTexts(post),
  };
}
