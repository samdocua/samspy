// SamSpy — «Слайды», mode «Вписать в картинку»: draws a slide text INTO a template photo
//
// One font everywhere — Playfair Display 600; the size is the largest that fits the surface.
// Lines are balanced (no lonely last word): for the number of lines that fits, the split with the
// narrowest widest line wins. Forced line breaks (answer options «A) …») are kept.
//   quad — text laid out in a flat rectangle, then warped onto the surface (mesh of triangles,
//          each an affine map = a close approximation of the perspective)
//   mask — lines take the shape's width at their height (shape eroded by the margin), all on
//          one axis; the shape is levelled by its tilt first, the text turned back after
//   cyl  — text wrapped around a cylinder: letters narrow towards the label's sides and fade a
//          little, lines dip in the middle like the label's edges
// Dark text is multiplied into the surface (its texture shows through), light text is drawn over.
// Ported from the Python renderer the 29 templates were checked with (2026-11-28).
//
// Version history:
//   v0.1.0 (2026-11-28) — initial.

import { loadImage } from './render';
import { templateById, templateSrc, type Pt, type TemplateGeom } from './templates';

export const TEMPLATE_FONT = 'Playfair Display';
const WEIGHT = 600;
const OPACITY = 0.93;

let fontReady: Promise<unknown> | null = null;
export function ensureTemplateFont() {
  if (!fontReady) fontReady = document.fonts.load(`${WEIGHT} 48px "${TEMPLATE_FONT}"`, 'AaЖж').catch(() => undefined);
  return fontReady;
}

const font = (px: number) => `${WEIGHT} ${px}px "${TEMPLATE_FONT}", Georgia, serif`;

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

// --- line breaking ---------------------------------------------------------------------------
type Measure = (s: string) => number;

/** Words with forced breaks: paragraphs of words. */
const paragraphs = (text: string) =>
  text
    .split(/\n+/)
    .map((p) => p.trim().split(/\s+/).filter(Boolean))
    .filter((p) => p.length);

/** Greedy wrap of one paragraph. */
function greedy(words: string[], m: Measure, maxW: number): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (!cur || m(t) <= maxW) cur = t;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Exactly n lines of one paragraph, each ≤ maxW: narrowest widest line, then longest shortest. */
function balance(words: string[], n: number, m: Measure, maxW: number): string[] | null {
  const N = words.length;
  if (n <= 1 || n > N) return null;
  const memo = new Map<string, { key: [number, number]; parts: number[] } | null>();
  const f = (i: number, k: number): { key: [number, number]; parts: number[] } | null => {
    if (i === N) return k === 0 ? { key: [0, -Infinity], parts: [] } : null;
    if (k === 0) return null;
    const id = `${i}|${k}`;
    if (memo.has(id)) return memo.get(id)!;
    let best: { key: [number, number]; parts: number[] } | null = null;
    for (let j = i + 1; j <= N - k + 1; j++) {
      const w = m(words.slice(i, j).join(' '));
      if (w > maxW) break;
      const sub = f(j, k - 1);
      if (!sub) continue;
      const mx = Math.max(w, sub.key[0]);
      const mn = k > 1 ? Math.min(w, -sub.key[1]) : w;
      const key: [number, number] = [Math.round(mx), -Math.round(mn)];
      if (!best || key[0] < best.key[0] || (key[0] === best.key[0] && key[1] < best.key[1])) {
        best = { key, parts: [j, ...sub.parts] };
      }
    }
    memo.set(id, best);
    return best;
  };
  const r = f(0, n);
  if (!r) return null;
  const out: string[] = [];
  let i = 0;
  for (const j of r.parts) {
    out.push(words.slice(i, j).join(' '));
    i = j;
  }
  return out;
}

/** Lines for a box of width maxW: greedy count per paragraph, then balanced. */
function wrapBalanced(text: string, m: Measure, maxW: number): string[] {
  const out: string[] = [];
  for (const words of paragraphs(text)) {
    const g = greedy(words, m, maxW);
    out.push(...(balance(words, g.length, m, maxW) ?? g));
  }
  return out;
}

/** Text in a W×H box: the largest size that fits, centred, balanced lines. */
function boxLayer(text: string, W: number, H: number, color: string, maxSize: number, gap: number) {
  const c = canvas(W, H);
  const ctx = c.getContext('2d')!;
  let size = maxSize;
  let lines: string[] = [];
  for (; size > 10; size -= 4) {
    ctx.font = font(size);
    const m: Measure = (s) => ctx.measureText(s).width;
    lines = wrapBalanced(text, m, W);
    if (size * gap * lines.length <= H && lines.every((l) => m(l) <= W)) break;
  }
  ctx.font = font(size);
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const lh = size * gap;
  let y = (H - lh * lines.length) / 2;
  for (const l of lines) {
    ctx.fillText(l, W / 2, y + size * 0.08);
    y += lh;
  }
  return c;
}

// --- geometry --------------------------------------------------------------------------------
/** Homography that maps the unit square (0,0)(1,0)(1,1)(0,1) to the quad. */
function homography(q: Pt[]) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2;
  const sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
  const den = dx1 * dy2 - dx2 * dy1;
  const g = (sx * dy2 - dx2 * sy) / den;
  const h = (dx1 * sy - sx * dy1) / den;
  const a = x1 - x0 + g * x1, b = x3 - x0 + h * x3, c = x0;
  const d = y1 - y0 + g * y1, e = y3 - y0 + h * y3, f = y0;
  return (u: number, v: number): Pt => {
    const w = g * u + h * v + 1;
    return [(a * u + b * v + c) / w, (d * u + e * v + f) / w];
  };
}

/**
 * Draws `src` (layer W×H) onto ctx through map(u, v) → (x, y), with an n×n mesh of triangles.
 * alphaAt(u, v) — optional fading per cell.
 */
function meshWarp(
  ctx: CanvasRenderingContext2D,
  src: HTMLCanvasElement,
  map: (u: number, v: number) => Pt,
  n = 32,
  alphaAt?: (u: number, v: number) => number
) {
  const W = src.width, H = src.height;
  const tri = (s: Pt[], d: Pt[]) => {
    // affine transform taking s → d
    const [[sx0, sy0], [sx1, sy1], [sx2, sy2]] = s;
    const [[dx0, dy0], [dx1, dy1], [dx2, dy2]] = d;
    const den = sx0 * (sy2 - sy1) - sx1 * sy2 + sx2 * sy1 + (sx1 - sx2) * sy0;
    if (!den) return;
    const a = -(sy0 * (dx2 - dx1) - sy1 * dx2 + sy2 * dx1 + (sy1 - sy2) * dx0) / den;
    const b = (sy1 * dy2 + sy0 * (dy1 - dy2) - sy2 * dy1 + (sy2 - sy1) * dy0) / den;
    const c = (sx0 * (dx2 - dx1) - sx1 * dx2 + sx2 * dx1 + (sx1 - sx2) * dx0) / den;
    const dd = -(sx1 * dy2 + sx0 * (dy1 - dy2) - sx2 * dy1 + (sx2 - sx1) * dy0) / den;
    const e = (sx0 * (sy2 * dx1 - sy1 * dx2) + sy0 * (sx1 * dx2 - sx2 * dx1) + (sx2 * sy1 - sx1 * sy2) * dx0) / den;
    const f = (sx0 * (sy2 * dy1 - sy1 * dy2) + sy0 * (sx1 * dy2 - sx2 * dy1) + (sx2 * sy1 - sx1 * sy2) * dy0) / den;
    // clip to the destination triangle, grown by ~0.6 px against hairline seams
    const cx = (dx0 + dx1 + dx2) / 3, cy = (dy0 + dy1 + dy2) / 3;
    const grow = (p: Pt): Pt => {
      const vx = p[0] - cx, vy = p[1] - cy;
      const l = Math.hypot(vx, vy) || 1;
      return [p[0] + (vx / l) * 0.6, p[1] + (vy / l) * 0.6];
    };
    const g0 = grow(d[0]), g1 = grow(d[1]), g2 = grow(d[2]);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(g0[0], g0[1]);
    ctx.lineTo(g1[0], g1[1]);
    ctx.lineTo(g2[0], g2[1]);
    ctx.closePath();
    ctx.clip();
    ctx.transform(a, b, c, dd, e, f);
    ctx.drawImage(src, 0, 0);
    ctx.restore();
  };
  const base = ctx.globalAlpha;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const u0 = (i / n) * W, u1 = ((i + 1) / n) * W, v0 = (j / n) * H, v1 = ((j + 1) / n) * H;
      const p00 = map(u0, v0), p10 = map(u1, v0), p11 = map(u1, v1), p01 = map(u0, v1);
      if (alphaAt) ctx.globalAlpha = base * alphaAt((u0 + u1) / 2, (v0 + v1) / 2);
      tri([[u0, v0], [u1, v0], [u1, v1]], [p00, p10, p11]);
      tri([[u0, v0], [u1, v1], [u0, v1]], [p00, p11, p01]);
    }
  }
  ctx.globalAlpha = base;
}

/** Chalk: patchy strokes + a slight blur. */
function chalky(src: HTMLCanvasElement) {
  const ctx = src.getContext('2d')!;
  const img = ctx.getImageData(0, 0, src.width, src.height);
  const d = img.data;
  for (let i = 3; i < d.length; i += 4) {
    if (d[i]) d[i] = Math.round(d[i] * (Math.random() > 0.25 ? 1 : 0.55));
  }
  ctx.putImageData(img, 0, 0);
  const out = canvas(src.width, src.height);
  const o = out.getContext('2d')!;
  o.filter = 'blur(2.2px)';
  o.drawImage(src, 0, 0);
  return out;
}

// --- shapes (mask) -----------------------------------------------------------------------------
function drawShape(ctx: CanvasRenderingContext2D, shape: Extract<TemplateGeom, { kind: 'mask' }>['shape']) {
  ctx.beginPath();
  if ('rect' in shape) {
    const [x0, y0, x1, y1] = shape.rect;
    ctx.rect(x0, y0, x1 - x0, y1 - y0);
  } else if ('ellipse' in shape) {
    const [x, y, rx, ry] = shape.ellipse;
    ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  } else {
    shape.poly.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
  }
  ctx.fill();
}

/** Lines of `text` inside a shape (already levelled), drawn on a W×H layer. */
function maskLayer(
  text: string,
  W: number,
  H: number,
  g: Extract<TemplateGeom, { kind: 'mask' }>,
  maxSize = 170,
  gap = 1.15
) {
  // rasterize the levelled shape and read the span of every row
  const mc = canvas(W, H);
  const m = mc.getContext('2d')!;
  m.translate(W / 2, H / 2);
  m.rotate((-g.angle * Math.PI) / 180);
  m.translate(-W / 2, -H / 2);
  m.fillStyle = '#000';
  drawShape(m, g.shape);
  const data = m.getImageData(0, 0, W, H).data;
  const L = new Float32Array(H).fill(NaN), R = new Float32Array(H).fill(NaN);
  for (let y = 0; y < H; y++) {
    let l = -1, r = -1;
    for (let x = 0; x < W; x++) {
      if (data[(y * W + x) * 4 + 3] > 127) {
        if (l < 0) l = x;
        r = x;
      }
    }
    if (l >= 0) {
      L[y] = l;
      R[y] = r;
    }
  }
  // erode by the margin (a disc): every row looks at its neighbours within the margin
  const mg = g.margin;
  const EL = new Float32Array(H).fill(NaN), ER = new Float32Array(H).fill(NaN);
  for (let y = 0; y < H; y++) {
    let l = -Infinity, r = Infinity, ok = true;
    for (let dy = -mg; dy <= mg && ok; dy += mg > 8 ? 2 : 1) {
      const yy = y + dy;
      if (yy < 0 || yy >= H || Number.isNaN(L[yy])) {
        ok = false;
        break;
      }
      const dx = Math.sqrt(Math.max(0, mg * mg - dy * dy));
      l = Math.max(l, L[yy] + dx);
      r = Math.min(r, R[yy] - dx);
    }
    if (ok && r > l) {
      EL[y] = l;
      ER[y] = r;
    }
  }
  const rows: number[] = [];
  for (let y = 0; y < H; y++) if (!Number.isNaN(EL[y])) rows.push(y);
  if (!rows.length) return canvas(W, H);
  let y0 = rows[0], y1 = rows[rows.length - 1];
  const k0 = y0 + (y1 - y0) * g.keep[0], k1 = y0 + (y1 - y0) * g.keep[1];
  y0 = Math.ceil(k0);
  y1 = Math.floor(k1);
  const span = (y: number): [number, number] | null => {
    const yy = Math.round(y);
    if (yy < y0 || yy > y1 || Number.isNaN(EL[yy])) return null;
    return [EL[yy], ER[yy]];
  };
  const centres: number[] = [];
  for (let y = y0; y <= y1; y += 4) {
    const s = span(y);
    if (s) centres.push((s[0] + s[1]) / 2);
  }
  centres.sort((a, b) => a - b);
  const axis = centres[Math.floor(centres.length / 2)] ?? W / 2;

  const out = canvas(W, H);
  const ctx = out.getContext('2d')!;
  const words = paragraphs(text);
  const flat = words.flat();
  // lines for n_try rows at this size with the half width scaled by f (forced breaks respected)
  const layout = (size: number, n: number, f: number) => {
    const lh = size * gap;
    const top = (y0 + y1) / 2 - (lh * n) / 2;
    if (top < y0) return null;
    const m: Measure = (s) => ctx.measureText(s).width;
    const res: { t: string; y: number }[] = [];
    let p = 0, i = 0;
    for (let k = 0; k < n; k++) {
      if (p >= words.length) return null;
      const yc = top + lh * k + lh * 0.55;
      const a = span(yc - size * 0.35), b = span(yc + size * 0.35);
      if (!a || !b) return null;
      const half = Math.min(axis - Math.max(a[0], b[0]), Math.min(a[1], b[1]) - axis) * f;
      if (half <= 0) return null;
      let cur = '';
      while (i < words[p].length) {
        const t = cur ? `${cur} ${words[p][i]}` : words[p][i];
        if (m(t) <= half * 2) {
          cur = t;
          i++;
        } else break;
      }
      if (!cur) return null;
      res.push({ t: cur, y: top + lh * k });
      if (i >= words[p].length) {
        p++;
        i = 0;
      }
    }
    return p >= words.length ? res : null;
  };
  for (let size = maxSize; size > 12; size -= 3) {
    ctx.font = font(size);
    for (let n = 1; n <= Math.max(12, flat.length); n++) {
      let lines = layout(size, n, 1);
      if (!lines) continue;
      let lo = 0.4, hi = 1;
      for (let it = 0; it < 12; it++) {
        const mid = (lo + hi) / 2;
        if (layout(size, n, mid)) hi = mid;
        else lo = mid;
      }
      lines = layout(size, n, hi) ?? lines;
      ctx.fillStyle = g.color;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (const l of lines) ctx.fillText(l.t, axis, l.y + size * 0.08);
      return out;
    }
  }
  return out;
}

// --- one slide -------------------------------------------------------------------------------------
/** The text (only) of a template slide, on a transparent layer of the template's size. */
function textOverlay(W: number, H: number, g: TemplateGeom, text: string) {
  const out = canvas(W, H);
  const ctx = out.getContext('2d')!;
  if (g.kind === 'quad') {
    const H0 = homography(g.quad as Pt[]);
    const [l, t, r, b] = g.inset;
    const q: Pt[] = [H0(l, t), H0(1 - r, t), H0(1 - r, 1 - b), H0(l, 1 - b)];
    const w = Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]);
    const h = Math.hypot(q[3][0] - q[0][0], q[3][1] - q[0][1]);
    let layer = boxLayer(text, w * 2, h * 2, g.color, 200, 1.18);
    if (g.chalk) layer = chalky(layer);
    const Hq = homography(q);
    meshWarp(ctx, layer, (u, v) => Hq(u / layer.width, v / layer.height));
  } else if (g.kind === 'cyl') {
    const [cx, R, top, bottom, x0, x1, sagT, sagB] = g.cyl;
    const eA = Math.asin(Math.max(-1, Math.min(1, (x0 - cx) / R)));
    const eB = Math.asin(Math.max(-1, Math.min(1, (x1 - cx) / R)));
    const edge = Math.max(Math.abs(eA), Math.abs(eB));
    const phiA = eA * g.fill, phiB = eB * g.fill;
    const tA = 0.12, tB = 0.88;
    const layer = boxLayer(text, R * (phiB - phiA) * 2, (bottom - top) * 0.76 * 2, g.color, 200, 1.18);
    const ce = Math.cos(edge);
    const phiOf = (u: number) => phiA + (u / layer.width) * (phiB - phiA);
    meshWarp(
      ctx,
      layer,
      (u, v) => {
        const phi = phiOf(u);
        const k = (Math.cos(phi) - ce) / (1 - ce); // 0 at the label's sides, 1 in the middle
        const t = tA + (v / layer.height) * (tB - tA);
        return [cx + R * Math.sin(phi), top + sagT * k + t * (bottom - top + (sagB - sagT) * k)];
      },
      40,
      (u) => Math.pow(Math.max(0, Math.cos(phiOf(u))), 0.35)
    );
  } else {
    const layer = maskLayer(text, W, H, g);
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.rotate((g.angle * Math.PI) / 180);
    ctx.translate(-W / 2, -H / 2);
    ctx.drawImage(layer, 0, 0);
    ctx.restore();
  }
  return out;
}

const isDark = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return ((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114 < 128;
};

/** Template photo + text into `target` at w×h (the template is cropped to fill, like a cover). */
export async function renderTemplateSlide(
  target: HTMLCanvasElement,
  templateId: string,
  text: string,
  w: number,
  h: number
): Promise<void> {
  const tpl = templateById(templateId);
  if (!tpl) throw new Error(`Нет шаблона ${templateId}.`);
  const [img] = await Promise.all([loadImage(templateSrc(templateId)), ensureTemplateFont()]);
  const W = img.naturalWidth, H = img.naturalHeight;
  const work = canvas(W, H);
  const wc = work.getContext('2d')!;
  wc.drawImage(img, 0, 0);
  if (text.trim()) {
    const overlay = textOverlay(W, H, tpl.g, text.trim());
    wc.globalAlpha = OPACITY;
    wc.globalCompositeOperation = isDark(tpl.g.color) ? 'multiply' : 'source-over';
    wc.drawImage(overlay, 0, 0);
    wc.globalAlpha = 1;
    wc.globalCompositeOperation = 'source-over';
  }
  target.width = w;
  target.height = h;
  const ctx = target.getContext('2d')!;
  const s = Math.max(w / W, h / H);
  const dw = W * s, dh = H * s;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(work, (w - dw) / 2, (h - dh) / 2, dw, dh);
}
