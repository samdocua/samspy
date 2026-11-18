// SamSpy — carousel text collector: cleanup (roles + watermarks)
//
// Roles: first slide = hook, middle = body. The last slide is split (by the check call) into
//   content → stays a body slide (its own slide_N column), cta → cta_text (cta column).
//   role "body+cta" = has both, "cta" = only CTA, "body" = no CTA.
// Watermark = a line that repeats on at least half of the post's slides (minimum 2), except quiz
// options like "A) Aww". It is removed from slide texts and moved to brand. CTA text is left
// untouched (there the brand name is part of the message: "feel closer with flamingo").
//
// Version history:
//   v0.4.0 (2026-11-18) — port of carousels.js v1.7 postProcess + dedupeLines.
//   v0.5.0 (2026-11-18) — joinSoftBreaks(): glue visual line wraps inside a phrase,
//                         keep breaks before list items / after sentence ends / blank lines.

import { CTA_PATTERNS } from './prompts';
import type { LastSplit, SlideRole } from './types';

const QUIZ_OPTION = /^\s*[A-Da-d][\).:]\s+\S/;

// A line that must stay on its own: quiz option, numbered/bulleted item.
const LIST_ITEM = /^\s*(?:[A-Da-d][\).:]|\d{1,2}[\).:]|[-–—•*·])\s+\S/;
// Previous line ends a sentence/clause → keep the break.
const HARD_END = /[.?!:;…)"»”]\s*$/;

/**
 * Glues line wraps that only come from the slide layout ("What's a little habit of mine /
 * you / secretly love?" → one line). Keeps: blank lines (paragraphs), breaks before list items
 * (A) B) 1. -), breaks after a list item, and breaks after sentence-ending punctuation.
 */
export function joinSoftBreaks(text: string): string {
  return String(text || '')
    .split(/\n\s*\n/)
    .map((para) => {
      const out: string[] = [];
      for (const raw of para.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        const prev = out[out.length - 1];
        const glue = prev !== undefined && !LIST_ITEM.test(line) && !LIST_ITEM.test(prev) && !HARD_END.test(prev);
        if (glue) out[out.length - 1] = `${prev} ${line}`;
        else out.push(line);
      }
      return out.join('\n');
    })
    .filter(Boolean)
    .join('\n\n');
}

/** Removes repeated lines (case-insensitive), keeps the first occurrence and blank-line spacing. */
export function dedupeLines(text: string): string {
  const seen = new Set<string>();
  return String(text || '')
    .split('\n')
    .filter((l) => {
      const k = l.trim().toLowerCase();
      if (!k) return true;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface PPSlide {
  idx: number;
  raw_text: string;
}

export interface PPResult {
  brand: string;
  slides: { idx: number; role: SlideRole; text: string; cta_text: string }[];
}

export function postProcess(slidesIn: PPSlide[], lastSplit: LastSplit | null): PPResult {
  const slides = [...slidesIn]
    .sort((a, b) => a.idx - b.idx)
    .map((s) => ({
      idx: s.idx,
      raw: s.raw_text || '',
      role: 'body' as SlideRole,
      text: s.raw_text || '',
      cta_text: '',
    }));
  const n = slides.length;
  if (!n) return { brand: '', slides: [] };

  // roles
  slides[0].role = 'hook';
  if (n >= 2) {
    const last = slides[n - 1];
    if (lastSplit) {
      const content = String(lastSplit.content || '').trim();
      const cta = String(lastSplit.cta || '').trim();
      last.text = content;
      last.cta_text = dedupeLines(cta);
      last.role = content && cta ? 'body+cta' : cta ? 'cta' : 'body';
    } else if (n >= 3 && CTA_PATTERNS.some((re) => re.test(last.raw))) {
      last.role = 'cta';
      last.text = '';
      last.cta_text = last.raw;
    }
  }

  // watermarks
  const norm = (l: string) => l.trim().toLowerCase().replace(/\s+/g, ' ');
  const counts = new Map<string, number>();
  for (const s of slides) {
    const uniq = new Set(
      s.raw
        .split('\n')
        .filter((l) => !QUIZ_OPTION.test(l))
        .map(norm)
        .filter(Boolean)
    );
    for (const l of uniq) counts.set(l, (counts.get(l) || 0) + 1);
  }
  const threshold = Math.max(2, Math.ceil(n / 2));
  const marks = new Set(
    Array.from(counts)
      .filter(([, c]) => c >= threshold)
      .map(([l]) => l)
  );

  let brand = '';
  if (marks.size) {
    const brandLines: string[] = [];
    for (const s of slides) {
      for (const l of s.raw.split('\n')) {
        if (marks.has(norm(l)) && !brandLines.some((b) => norm(b) === norm(l))) {
          brandLines.push(l.trim());
        }
      }
    }
    brand = brandLines.join(' | ');
    for (const s of slides) {
      s.text = s.text
        .split('\n')
        .filter((l) => !marks.has(norm(l)))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }
  }

  return {
    brand,
    slides: slides.map((s) => ({ idx: s.idx, role: s.role, text: s.text, cta_text: s.cta_text })),
  };
}
