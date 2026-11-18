// SamSpy — carousel text collector: one-post-per-row table (same layout as posts.csv)
//   post_url | author | posted_at | likes | comments | slides_count | hook | slide_2 … slide_N |
//   cta | brand | caption | escalated | error
// Used by the UI table, the CSV download and the "copy" (TSV) button.
//
// Version history:
//   v0.4.0 (2026-11-18) — buildTable, toCsv, toTsv.

import type { CarouselPostFull } from './types';

const isBody = (s: { role: string | null; text: string | null }) =>
  (s.role === 'body' || s.role === 'body+cta') && !!s.text;

export interface PostsTable {
  /** slide numbers that get their own column (2…N) */
  slideCols: number[];
  header: string[];
  rows: string[][];
}

export function buildTable(posts: CarouselPostFull[]): PostsTable {
  let maxBody = 1;
  for (const p of posts) for (const s of p.slides) if (isBody(s)) maxBody = Math.max(maxBody, s.idx);
  const slideCols: number[] = [];
  for (let i = 2; i <= maxBody; i++) slideCols.push(i);

  const header = [
    'post_url', 'author', 'posted_at', 'likes', 'comments', 'slides_count',
    'hook', ...slideCols.map((i) => `slide_${i}`), 'cta', 'brand', 'caption', 'escalated', 'error',
  ];

  const rows = posts.map((p) => {
    const hook = p.slides.filter((s) => s.role === 'hook').map((s) => s.text ?? '').join('\n\n');
    const body = slideCols.map((i) => {
      const s = p.slides.find((x) => x.idx === i && isBody(x));
      return s?.text ?? '';
    });
    const cta = p.slides.filter((s) => s.cta_text).map((s) => s.cta_text as string).join('\n\n');
    const escalated = p.slides
      .filter((s) => s.check_status === 'escalated')
      .map((s) => s.idx)
      .join(', ');
    const errors = [p.error, ...p.slides.filter((s) => s.error).map((s) => `slide ${s.idx}: ${s.error}`)]
      .filter(Boolean)
      .join(' | ');
    return [
      p.url, p.author ?? '', p.posted_at ?? '', String(p.likes ?? ''), String(p.comments ?? ''),
      String(p.slides.length), hook, ...body, cta, p.brand ?? '', p.caption ?? '', escalated, errors,
    ];
  });

  return { slideCols, header, rows };
}

const quote = (v: string, re: RegExp) => (re.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** CSV with BOM (opens correctly in Excel / Numbers / Google Sheets). */
export function toCsv(t: PostsTable): string {
  const lines = [t.header, ...t.rows].map((r) => r.map((v) => quote(v ?? '', /[",\n\r;]/)).join(','));
  return '﻿' + lines.join('\r\n');
}

/** TSV for pasting into Google Sheets (multi-line cells are quoted). */
export function toTsv(t: PostsTable): string {
  return [t.header, ...t.rows]
    .map((r) => r.map((v) => quote(v ?? '', /["\t\n\r]/)).join('\t'))
    .join('\n');
}
