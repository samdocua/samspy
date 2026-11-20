// SamSpy — Slides: instant in-browser checks of a finished slide
//
//   overflow     — text block (after rotation) goes past the frame edge
//   readability  — white text without outline/plate on a bright background
//   text         — empty text, @handles, links, odd symbols, repeated chars, double spaces
//
// Version history:
//   v0.1.0 (2026-11-19) — initial checks.
//   v0.1.1 (2026-11-19) — fonts loaded before measuring (fallback font wrapped into more
//                         lines → false «за край кадра»); fail only when the text is
//                         really cut by the frame, «близко к краю» is a warning.

import { drawCover, ensureFonts, layoutText, loadImage, type TextOptions } from './render';

export type CheckSeverity = 'warn' | 'fail';

export interface CheckIssue {
  type: 'overflow' | 'readability' | 'covers_subject' | 'text' | 'photo_artifact' | 'other';
  severity: CheckSeverity;
  message: string;
}

const MARGIN = 0.02; // closer than 2% of the frame to an edge → warning

/** Text-only rules (no image needed). */
export function textIssues(text: string): CheckIssue[] {
  const out: CheckIssue[] = [];
  const t = text.trim();
  if (!t) {
    out.push({ type: 'text', severity: 'warn', message: 'На слайде нет текста.' });
    return out;
  }
  if (/(^|\s)@[\w.]{2,}/.test(t)) {
    out.push({ type: 'text', severity: 'warn', message: 'В тексте есть @упоминание — похоже на мусор из оригинала.' });
  }
  if (/https?:\/\/|www\.|\.(com|net|org|io)\b/i.test(t)) {
    out.push({ type: 'text', severity: 'warn', message: 'В тексте есть ссылка.' });
  }
  if (/[^\p{L}\p{N}\p{P}\p{Zs}\p{Extended_Pictographic}‍️\n+=$%&*#<>|~^°№€£₴]/u.test(t)) {
    out.push({ type: 'text', severity: 'warn', message: 'В тексте есть странные символы.' });
  }
  if (/(.)\1{4,}/u.test(t.replace(/[.!?…\-–—_]/g, ''))) {
    out.push({ type: 'text', severity: 'warn', message: 'Повтор одного символа 5+ раз подряд.' });
  }
  if (/[^\S\n]{2,}/.test(t)) {
    out.push({ type: 'text', severity: 'warn', message: 'Двойные пробелы в тексте.' });
  }
  return out;
}

/** Relative luminance (0…1) of an sRGB pixel. */
function lum(r: number, g: number, b: number): number {
  const c = (v: number) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
}

/** Geometry + background checks. `src` = generated photo (without text). */
export async function placementIssues(
  src: string,
  w: number,
  h: number,
  o: TextOptions
): Promise<CheckIssue[]> {
  const out: CheckIssue[] = [];
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return out;
  const [img] = await Promise.all([loadImage(src), ensureFonts()]);
  drawCover(ctx, img, w, h);

  const L = layoutText(ctx, w, h, o);
  if (!L) return out;

  // --- overflow: rotate every line box around the block centre, test the corners
  const cy = L.top + L.blockH / 2;
  const a = ((o.rotateDeg || 0) * Math.PI) / 180;
  const rot = (x: number, y: number) => [
    L.cx + (x - L.cx) * Math.cos(a) - (y - cy) * Math.sin(a),
    cy + (x - L.cx) * Math.sin(a) + (y - cy) * Math.cos(a),
  ];
  const mx = w * MARGIN;
  const my = h * MARGIN;
  let cut = false; // a corner is outside the frame
  let near = false; // inside, but within the safe margin
  for (const l of L.lines) {
    const pad = L.effect === 'plateWhite' || L.effect === 'plateBlack' ? l.fs * 0.35 : 0;
    const x0 = L.cx - l.width / 2 - pad;
    const x1 = L.cx + l.width / 2 + pad;
    const y0 = L.top + l.top;
    const y1 = y0 + l.lh;
    for (const [px, py] of [rot(x0, y0), rot(x1, y0), rot(x0, y1), rot(x1, y1)]) {
      if (px < 0 || px > w || py < 0 || py > h) cut = true;
      else if (px < mx || px > w - mx || py < my || py > h - my) near = true;
    }
  }
  if (cut) {
    out.push({
      type: 'overflow',
      severity: 'fail',
      message: 'Текст обрезан краем кадра — уменьши размер, сдвиг или наклон.',
    });
  } else if (near) {
    out.push({
      type: 'overflow',
      severity: 'warn',
      message: 'Текст почти касается края кадра — сдвинь его чуть от края.',
    });
  }

  // --- readability: only white text without outline/plate depends on the background
  if (L.effect === 'shadow') {
    let n = 0;
    let bright = 0;
    let sum = 0;
    for (const l of L.lines) {
      const x0 = Math.max(0, Math.round(L.cx - l.width / 2));
      const y0 = Math.max(0, Math.round(L.top + l.top));
      const bw = Math.min(w - x0, Math.round(l.width));
      const bh = Math.min(h - y0, Math.round(l.lh));
      if (bw <= 0 || bh <= 0) continue;
      const data = ctx.getImageData(x0, y0, bw, bh).data;
      const step = Math.max(4, Math.floor((bw * bh) / 400)) * 4; // ~400 samples per line
      for (let i = 0; i < data.length; i += step) {
        const L2 = lum(data[i], data[i + 1], data[i + 2]);
        sum += L2;
        if (L2 > 0.6) bright++;
        n++;
      }
    }
    if (n) {
      const mean = sum / n;
      const share = bright / n;
      if (mean > 0.55 || share > 0.45) {
        out.push({
          type: 'readability',
          severity: mean > 0.7 ? 'fail' : 'warn',
          message: 'Белый текст без обводки на светлом фоне читается плохо — возьми стиль с обводкой или плашкой.',
        });
      }
    }
  }
  return out;
}
