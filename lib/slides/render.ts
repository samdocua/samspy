// SamSpy — Slides: canvas rendering (browser only)
//
// Draws the generated photo (cover-fit) at the export size and lays the slide
// text on top. Each text style is a row in STYLE_SPECS (font, weight, effect).
// The same code renders the live preview and the downloaded JPEG.
//
// Version history:
//   v0.1.0 (2026-11-18) — cover-fit, word wrap, 3 TikTok styles (outline,
//                         white plates, black plates), source downscaling.
//   v0.2.0 (2026-11-18) — TikTok Sans font (loaded before drawing) + «Classic»
//                         style: medium weight, thin dark outline, soft shadow.
//   v0.2.1 (2026-11-18) — Classic closer to the app: semibold, tighter tracking,
//                         crisp thin outline instead of a blurred shadow.
//   v0.2.2 (2026-11-18) — «classicThin»: same as Classic, outline ~1/3 thinner.
//   v0.2.3 (2026-11-18) — «classicThin» removed; regular Classic kept.
//   v0.3.0 (2026-11-18) — style spec table; Instagram A/B styles: IG Classic
//                         (Instrument Sans), IG Modern (Gabarito), Montserrat —
//                         white text with a soft drop shadow, no outline.

import type { TextPosition, TextStyleId } from './config';

export interface TextOptions {
  text: string;
  sizePct: number; // font size, % of width
  position: TextPosition;
  style: TextStyleId;
  offsetPct: number; // % of height, + = down
  maxWidthPct: number; // wrap width, % of width
}

type Effect = 'outline' | 'shadow' | 'plateWhite' | 'plateBlack';

interface StyleSpec {
  family: string; // web font family (loaded via @fontsource in SlidesView)
  weight: number;
  lineHeight: number; // × font size
  tracking: number; // letter spacing, × font size
  effect: Effect;
  outline?: number; // outline width, × font size (effect 'outline')
}

const FALLBACK = '"Helvetica Neue", Helvetica, Arial, sans-serif';

const STYLE_SPECS: Record<TextStyleId, StyleSpec> = {
  tiktok1: { family: 'TikTok Sans', weight: 700, lineHeight: 1.3, tracking: 0, effect: 'outline', outline: 0.14 },
  tiktok2: { family: 'TikTok Sans', weight: 700, lineHeight: 1.3, tracking: 0, effect: 'plateWhite' },
  tiktok3: { family: 'TikTok Sans', weight: 700, lineHeight: 1.3, tracking: 0, effect: 'plateBlack' },
  classic: { family: 'TikTok Sans', weight: 600, lineHeight: 1.15, tracking: -0.02, effect: 'outline', outline: 0.1 },
  igClassic: { family: 'Instrument Sans', weight: 600, lineHeight: 1.2, tracking: -0.01, effect: 'shadow' },
  igModern: { family: 'Gabarito', weight: 600, lineHeight: 1.15, tracking: 0, effect: 'shadow' },
  montserrat: { family: 'Montserrat', weight: 700, lineHeight: 1.2, tracking: -0.01, effect: 'shadow' },
};

// Canvas won't wait for web fonts — load every family/weight we draw with first.
let fontsReady: Promise<void> | null = null;
function ensureFonts(): Promise<void> {
  if (!fontsReady) {
    const seen = new Set<string>();
    const loads: Promise<unknown>[] = [];
    for (const s of Object.values(STYLE_SPECS)) {
      const key = `${s.weight} 48px "${s.family}"`;
      if (seen.has(key)) continue;
      seen.add(key);
      loads.push(document.fonts.load(key, 'AaЖж').catch(() => undefined));
    }
    fontsReady = Promise.all(loads).then(() => undefined); // fallback font if any fails
  }
  return fontsReady;
}

// Small cache so the preview doesn't re-decode the same image on every keystroke.
const imageCache = new Map<string, Promise<HTMLImageElement>>();

export function loadImage(src: string): Promise<HTMLImageElement> {
  const hit = imageCache.get(src);
  if (hit) return hit;
  const p = new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Не удалось открыть картинку.'));
    img.src = src;
  });
  imageCache.set(src, p);
  p.catch(() => imageCache.delete(src));
  if (imageCache.size > 24) {
    const first = imageCache.keys().next().value;
    if (first !== undefined) imageCache.delete(first);
  }
  return p;
}

/** Downscale a picked/pasted file to a JPEG data URL (long side ≤ maxSide). */
export async function compressImage(file: Blob, maxSide = 1600, quality = 0.9): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Браузер не смог открыть файл (нужен JPEG, PNG или WebP).'));
      i.src = url;
    });
    const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * k);
    const h = Math.round(img.naturalHeight * k);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('Canvas недоступен.');
    ctx.drawImage(img, 0, 0, w, h);
    return c.toDataURL('image/jpeg', quality);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function drawCover(ctx: CanvasRenderingContext2D, img: HTMLImageElement, w: number, h: number) {
  const s = Math.max(w / img.naturalWidth, h / img.naturalHeight);
  const dw = img.naturalWidth * s;
  const dh = img.naturalHeight * s;
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

/** Split on Enter, then greedy word-wrap each line to maxWidth. */
export function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const words = raw.trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    let line = words[0];
    for (const word of words.slice(1)) {
      const test = `${line} ${word}`;
      if (ctx.measureText(test).width <= maxWidth) line = test;
      else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}

/** Adds a rounded-rect subpath (no beginPath — callers fill many at once). */
function addRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

export function drawText(ctx: CanvasRenderingContext2D, w: number, h: number, o: TextOptions) {
  if (!o.text.trim()) return; // empty = no text

  const spec = STYLE_SPECS[o.style] ?? STYLE_SPECS.classic;
  const fs = Math.max(8, (w * o.sizePct) / 100);
  ctx.font = `${spec.weight} ${fs}px "${spec.family}", ${FALLBACK}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Letter spacing (canvas letterSpacing: Chrome 99+, Safari 17+).
  const lsCtx = ctx as CanvasRenderingContext2D & { letterSpacing?: string };
  if ('letterSpacing' in lsCtx) lsCtx.letterSpacing = `${spec.tracking * fs}px`;

  const lines = wrapText(ctx, o.text, (w * o.maxWidthPct) / 100);
  if (!lines.length) return;

  const lh = fs * spec.lineHeight;
  const blockH = lines.length * lh;
  let top =
    o.position === 'top' ? h * 0.1 : o.position === 'bottom' ? h * 0.9 - blockH : (h - blockH) / 2;
  top += (h * o.offsetPct) / 100;
  const cx = w / 2;
  const lineY = (i: number) => top + i * lh + lh / 2;

  if (spec.effect === 'outline') {
    // White text, crisp dark outline (TikTok).
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(2, fs * (spec.outline ?? 0.1));
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.9)';
    ctx.fillStyle = '#ffffff';
    lines.forEach((l, i) => {
      ctx.strokeText(l, cx, lineY(i));
      ctx.fillText(l, cx, lineY(i));
    });
    return;
  }

  if (spec.effect === 'shadow') {
    // White text, soft drop shadow, no outline (Instagram Stories look).
    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
    ctx.shadowBlur = fs * 0.18;
    ctx.shadowOffsetY = fs * 0.04;
    lines.forEach((l, i) => ctx.fillText(l, cx, lineY(i)));
    ctx.restore();
    return;
  }

  // Per-line plates, filled as one path so overlaps don't leave seams.
  const white = spec.effect === 'plateWhite';
  const padX = fs * 0.35;
  const radius = fs * 0.24;
  ctx.beginPath();
  lines.forEach((l, i) => {
    const tw = ctx.measureText(l).width;
    addRoundRect(ctx, cx - tw / 2 - padX, top + i * lh, tw + padX * 2, lh + 1, radius);
  });
  ctx.fillStyle = white ? '#ffffff' : 'rgba(0, 0, 0, 0.8)';
  ctx.fill('nonzero');
  ctx.fillStyle = white ? '#000000' : '#ffffff';
  lines.forEach((l, i) => ctx.fillText(l, cx, lineY(i)));
}

/** Render photo + text into `canvas` at w×h. */
export async function renderSlide(
  canvas: HTMLCanvasElement,
  src: string,
  w: number,
  h: number,
  text: TextOptions | null
): Promise<void> {
  const [img] = await Promise.all([loadImage(src), ensureFonts()]);
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas недоступен.');
  ctx.clearRect(0, 0, w, h);
  drawCover(ctx, img, w, h);
  if (text) drawText(ctx, w, h, text);
}

export function canvasToBlob(canvas: HTMLCanvasElement, quality = 0.92): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Не удалось сохранить JPEG.'))),
      'image/jpeg',
      quality
    )
  );
}
