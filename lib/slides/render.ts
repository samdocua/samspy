// SamSpy — Slides: canvas rendering (browser only)
//
// Draws the generated photo (cover-fit) at the export size and lays the slide
// text on top. Each text style is a row in STYLE_SPECS (font, weight, effect).
// The same code renders the live preview and the downloaded JPEG.
//
// Text layout: the part before the first blank line is the title; everything
// after it is a subtitle drawn at `subtitlePct` % of the title size. The whole
// block can be rotated by `rotateDeg` around its centre.
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
//   v0.4.0 (2026-11-19) — IG Literature (Cormorant serif), IG Strong (Oswald caps
//                         on a white plate), Reels captions (bold + glow);
//                         subtitle after a blank line (smaller); block rotation.
//   v0.4.1 (2026-11-19) — stripJpegMetadata(): canvasToBlob output has every APPn
//                         (EXIF/XMP/IPTC/ICC) and COM segment removed, only JFIF kept.
//   v0.4.2 (2026-11-19) — JFIF (APP0) removed too: the file has no metadata at all.
//   v0.5.0 (2026-11-19) — layoutText() split out of drawText (used by slide checks).
//   v0.5.1 (2026-11-19) — ensureFonts() exported (checks must measure with real fonts).
//   v0.5.2 (2026-11-26) — the text block never leaves the frame: kept ≥ 3 % from the top and
//                         bottom (centre / bottom + a big upward offset pushed long texts out).

import type { TextPosition, TextStyleId } from './config';

export interface TextOptions {
  text: string;
  sizePct: number; // title font size, % of width
  position: TextPosition;
  style: TextStyleId;
  offsetPct: number; // % of height, + = down
  maxWidthPct: number; // wrap width, % of width
  subtitlePct: number; // subtitle size, % of the title size (100 = same)
  rotateDeg: number; // block rotation, degrees (+ = clockwise)
}

export type Effect = 'outline' | 'shadow' | 'plateWhite' | 'plateBlack';

interface StyleSpec {
  family: string; // web font family (loaded via @fontsource in SlidesView)
  weight: number;
  lineHeight: number; // × font size
  tracking: number; // letter spacing, × font size
  effect: Effect;
  outline?: number; // outline width, × font size (effect 'outline')
  glow?: number; // shadow strength multiplier (effect 'shadow'), default 1
  uppercase?: boolean;
  platePad?: number; // plate side padding, × font size (plate effects)
  plateRadius?: number; // plate corner radius, × font size (plate effects)
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
  igLiterature: { family: 'Cormorant', weight: 700, lineHeight: 1.08, tracking: 0, effect: 'shadow', glow: 0.8 },
  igStrong: {
    family: 'Oswald', weight: 600, lineHeight: 1.25, tracking: 0, effect: 'plateWhite',
    uppercase: true, platePad: 0.3, plateRadius: 0.16,
  },
  reelsBold: { family: 'Instrument Sans', weight: 700, lineHeight: 1.15, tracking: -0.01, effect: 'shadow', glow: 1.6 },
};

// Canvas won't wait for web fonts — load every family/weight we draw with first.
let fontsReady: Promise<void> | null = null;
export function ensureFonts(): Promise<void> {
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

export function drawCover(ctx: CanvasRenderingContext2D, img: HTMLImageElement, w: number, h: number) {
  const s = Math.max(w / img.naturalWidth, h / img.naturalHeight);
  const dw = img.naturalWidth * s;
  const dh = img.naturalHeight * s;
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

const EDGE_MARGIN = 0.03; // the text block keeps this share of the height from the top / bottom

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

interface LaidLine {
  text: string;
  fs: number; // font size of this line
  top: number; // offset from the block top
  lh: number; // line height
}

export interface TextLayout {
  lines: (LaidLine & { width: number })[];
  top: number; // block top, canvas px (before rotation)
  blockH: number;
  cx: number; // block centre x
  effect: Effect;
  setFont: (fs: number) => void;
}

/** Wraps and positions the text block (no drawing). Shared by drawText and the checks. */
export function layoutText(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  o: TextOptions
): TextLayout | null {
  if (!o.text.trim()) return null; // empty = no text

  const spec = STYLE_SPECS[o.style] ?? STYLE_SPECS.classic;
  const titleFs = Math.max(8, (w * o.sizePct) / 100);
  const subFs = Math.max(8, (titleFs * (o.subtitlePct || 100)) / 100);
  const maxW = (w * o.maxWidthPct) / 100;

  const setFont = (fs: number) => {
    ctx.font = `${spec.weight} ${fs}px "${spec.family}", ${FALLBACK}`;
    // Letter spacing (canvas letterSpacing: Chrome 99+, Safari 17+).
    const lsCtx = ctx as CanvasRenderingContext2D & { letterSpacing?: string };
    if ('letterSpacing' in lsCtx) lsCtx.letterSpacing = `${spec.tracking * fs}px`;
  };

  // Title = before the first blank line, subtitle = the rest.
  const text = spec.uppercase ? o.text.toUpperCase() : o.text;
  const [titlePart, ...rest] = text.split(/\n\s*\n/);
  const subPart = rest.join('\n');

  const lines: (LaidLine & { width: number })[] = [];
  let y = 0;
  const lay = (part: string, fs: number) => {
    setFont(fs);
    for (const t of wrapText(ctx, part, maxW)) {
      const lh = fs * spec.lineHeight;
      lines.push({ text: t, fs, top: y, lh, width: ctx.measureText(t).width });
      y += lh;
    }
  };
  lay(titlePart, titleFs);
  if (lines.length && subPart.trim()) y += titleFs * 0.15; // small gap before the subtitle
  lay(subPart, subFs);
  if (!lines.length) return null;

  const blockH = y;
  let top =
    o.position === 'top' ? h * 0.1 : o.position === 'bottom' ? h * 0.9 - blockH : (h - blockH) / 2;
  top += (h * o.offsetPct) / 100;
  // never past the frame: long texts stop at the edge margin instead of being cut
  const edge = h * EDGE_MARGIN;
  top = Math.max(edge, Math.min(top, h - edge - blockH));
  if (blockH > h - 2 * edge) top = (h - blockH) / 2; // taller than the frame: centred
  return { lines, top, blockH, cx: w / 2, effect: spec.effect, setFont };
}

export function drawText(ctx: CanvasRenderingContext2D, w: number, h: number, o: TextOptions) {
  const L = layoutText(ctx, w, h, o);
  if (!L) return;
  const spec = STYLE_SPECS[o.style] ?? STYLE_SPECS.classic;
  const { lines, top, blockH, cx, setFont } = L;
  const midY = (l: LaidLine) => top + l.top + l.lh / 2;

  ctx.save();
  if (o.rotateDeg) {
    const cy = top + blockH / 2;
    ctx.translate(cx, cy);
    ctx.rotate((o.rotateDeg * Math.PI) / 180);
    ctx.translate(-cx, -cy);
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  if (spec.effect === 'outline') {
    // White text, crisp dark outline (TikTok).
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.9)';
    ctx.fillStyle = '#ffffff';
    for (const l of lines) {
      setFont(l.fs);
      ctx.lineWidth = Math.max(2, l.fs * (spec.outline ?? 0.1));
      ctx.strokeText(l.text, cx, midY(l));
      ctx.fillText(l.text, cx, midY(l));
    }
  } else if (spec.effect === 'shadow') {
    // White text, soft drop shadow / glow, no outline (Instagram look).
    const k = spec.glow ?? 1;
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = `rgba(0, 0, 0, ${Math.min(0.85, 0.55 * k)})`;
    for (const l of lines) {
      setFont(l.fs);
      ctx.shadowBlur = l.fs * 0.18 * k;
      ctx.shadowOffsetY = l.fs * 0.04;
      ctx.fillText(l.text, cx, midY(l));
    }
  } else {
    // Per-line plates, filled as one path so overlaps don't leave seams.
    const white = spec.effect === 'plateWhite';
    ctx.beginPath();
    for (const l of lines) {
      setFont(l.fs);
      const tw = ctx.measureText(l.text).width;
      const padX = l.fs * (spec.platePad ?? 0.35);
      addRoundRect(ctx, cx - tw / 2 - padX, top + l.top, tw + padX * 2, l.lh + 1, l.fs * (spec.plateRadius ?? 0.24));
    }
    ctx.fillStyle = white ? '#ffffff' : 'rgba(0, 0, 0, 0.8)';
    ctx.fill('nonzero');
    ctx.fillStyle = white ? '#000000' : '#ffffff';
    for (const l of lines) {
      setFont(l.fs);
      ctx.fillText(l.text, cx, midY(l));
    }
  }
  ctx.restore();
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

/**
 * Removes all metadata from a JPEG: every APP0–APP15 segment (JFIF, EXIF, XMP,
 * ICC, Photoshop/IPTC…) and COM comments. Only the image data stays — JFIF is
 * optional, decoders read the file fine without it.
 * Browsers (Safari/WebKit) add a small EXIF block (ColorSpace, pixel size) on export.
 */
export async function stripJpegMetadata(blob: Blob): Promise<Blob> {
  const src = new Uint8Array(await blob.arrayBuffer());
  if (src[0] !== 0xff || src[1] !== 0xd8) return blob; // not a JPEG — leave as is
  const parts: Uint8Array[] = [src.subarray(0, 2)]; // SOI
  let i = 2;
  while (i + 4 <= src.length) {
    if (src[i] !== 0xff) return blob; // unexpected layout — don't risk breaking the file
    const marker = src[i + 1];
    if (marker === 0xda) {
      parts.push(src.subarray(i)); // SOS: compressed data until EOI, copy as is
      break;
    }
    const len = (src[i + 2] << 8) | src[i + 3];
    const seg = src.subarray(i, i + 2 + len);
    const isApp = marker >= 0xe0 && marker <= 0xef;
    if (!isApp && marker !== 0xfe) parts.push(seg);
    i += 2 + len;
  }
  return new Blob(parts as BlobPart[], { type: 'image/jpeg' });
}

export function canvasToBlob(canvas: HTMLCanvasElement, quality = 0.92): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Не удалось сохранить JPEG.'))),
      'image/jpeg',
      quality
    )
  ).then(stripJpegMetadata);
}
