// SamSpy — Slides: canvas rendering (browser only)
//
// Draws the generated photo (cover-fit) at the export size and lays the slide
// text on top in a TikTok-like style. The same code renders the live preview
// and the downloaded JPEG, so what you see is what you get.
//
// Version history:
//   v0.1.0 (2026-11-18) — cover-fit, word wrap, 3 TikTok styles (outline,
//                         white plates, black plates), source downscaling.

import type { TextPosition, TextStyleId } from './config';

export interface TextOptions {
  text: string;
  sizePct: number; // font size, % of width
  position: TextPosition;
  style: TextStyleId;
  offsetPct: number; // % of height, + = down
  maxWidthPct: number; // wrap width, % of width
}

const FONT_FAMILY = '"Helvetica Neue", Helvetica, Arial, sans-serif';

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
  if (!o.text.trim()) return; // empty = no plates

  const fs = Math.max(8, (w * o.sizePct) / 100);
  ctx.font = `700 ${fs}px ${FONT_FAMILY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const lines = wrapText(ctx, o.text, (w * o.maxWidthPct) / 100);
  if (!lines.length) return;

  const lh = fs * 1.3;
  const blockH = lines.length * lh;
  let top =
    o.position === 'top' ? h * 0.1 : o.position === 'bottom' ? h * 0.9 - blockH : (h - blockH) / 2;
  top += (h * o.offsetPct) / 100;
  const cx = w / 2;

  if (o.style === 'tiktok1') {
    // White text, thick black outline.
    ctx.lineJoin = 'round';
    ctx.lineWidth = fs * 0.14;
    ctx.strokeStyle = '#000000';
    ctx.fillStyle = '#ffffff';
    lines.forEach((l, i) => {
      const y = top + i * lh + lh / 2;
      ctx.strokeText(l, cx, y);
      ctx.fillText(l, cx, y);
    });
    return;
  }

  // Per-line plates, filled as one path so overlaps don't leave seams.
  const plate = o.style === 'tiktok2' ? '#ffffff' : 'rgba(0, 0, 0, 0.8)';
  const ink = o.style === 'tiktok2' ? '#000000' : '#ffffff';
  const padX = fs * 0.35;
  const radius = fs * 0.24;

  ctx.beginPath();
  lines.forEach((l, i) => {
    const tw = ctx.measureText(l).width;
    addRoundRect(ctx, cx - tw / 2 - padX, top + i * lh, tw + padX * 2, lh + 1, radius);
  });
  ctx.fillStyle = plate;
  ctx.fill('nonzero');

  ctx.fillStyle = ink;
  lines.forEach((l, i) => ctx.fillText(l, cx, top + i * lh + lh / 2));
}

/** Render photo + text into `canvas` at w×h. */
export async function renderSlide(
  canvas: HTMLCanvasElement,
  src: string,
  w: number,
  h: number,
  text: TextOptions | null
): Promise<void> {
  const img = await loadImage(src);
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
