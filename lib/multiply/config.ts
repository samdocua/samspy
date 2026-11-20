// SamSpy — «Размножение»: settings + per-copy variations (client, no secrets)
//
// One reference photo → N slightly different copies. Every copy is a separate
// /api/slides/generate call with the base prompt (same as «Слайды») plus its own
// small camera / moment change, so the copies differ but stay the same scene.
//
// Version history:
//   v0.1.0 (2026-11-20) — settings (prompt/model/format/size/quality/count/strength),
//                         first-run defaults from the «Слайды» settings, variation
//                         lists (min / medium), unique variations per batch.
//   v0.2.0 (2026-11-20) — autoFix setting; photo check types + fixPrompt for the
//                         check → fix pipeline.
//   v0.2.1 (2026-11-20) — PhotoCheck.by (who checked) + note (second opinion skipped / failed).

import {
  ASPECT_RATIOS,
  DEFAULT_SETTINGS as SLIDES_DEFAULTS,
  GPT_QUALITIES,
  IMAGE_MODELS,
  IMAGE_SIZES,
  sanitizeSettings,
  type AspectRatio,
  type GptQuality,
  type ImageSize,
} from '@/lib/slides/config';

export const MULTIPLY_STORAGE_KEY = 'samspy.multiply.settings.v1';
export const SLIDES_STORAGE_KEY = 'samspy.slides.settings.v1'; // same key as SlidesView

export const MIN_COUNT = 1;
export const MAX_COUNT = 20;

export type Strength = 'min' | 'medium';
export const STRENGTHS: { id: Strength; label: string }[] = [
  { id: 'min', label: 'Минимальная' },
  { id: 'medium', label: 'Средняя' },
];

export interface MultiplySettings {
  prompt: string;
  modelId: string;
  aspect: AspectRatio;
  size: ImageSize;
  quality: GptQuality;
  count: number;
  strength: Strength;
  autoFix: boolean; // after generation: check the copy and auto-fix serious artifacts
}

function pick<T extends string>(v: unknown, allowed: readonly T[], d: T): T {
  return allowed.includes(v as T) ? (v as T) : d;
}

/** Defaults = current «Слайды» settings (prompt, model, format…) if saved, else the slides defaults. */
export function defaultsFromSlides(): MultiplySettings {
  let s = SLIDES_DEFAULTS;
  try {
    const raw = localStorage.getItem(SLIDES_STORAGE_KEY);
    if (raw) s = sanitizeSettings(JSON.parse(raw));
  } catch {
    /* no storage / broken JSON — slides defaults */
  }
  return {
    prompt: s.prompt,
    modelId: s.modelId,
    aspect: s.aspect,
    size: s.size,
    quality: s.quality,
    count: 5,
    strength: 'min',
    autoFix: true,
  };
}

/** Prompt currently set in «Слайды» (for the «Взять из Слайдов» button). */
export function slidesPrompt(): string {
  return defaultsFromSlides().prompt;
}

export function sanitizeMultiply(raw: unknown, d: MultiplySettings): MultiplySettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const n = Number(r.count);
  return {
    prompt: typeof r.prompt === 'string' && r.prompt.trim() ? r.prompt : d.prompt,
    modelId: pick(r.modelId, IMAGE_MODELS.map((m) => m.id), d.modelId),
    aspect: pick(r.aspect, ASPECT_RATIOS, d.aspect),
    size: pick(r.size, IMAGE_SIZES, d.size),
    quality: pick(r.quality, GPT_QUALITIES.map((q) => q.id), d.quality),
    count: Number.isFinite(n) ? Math.min(MAX_COUNT, Math.max(MIN_COUNT, Math.round(n))) : d.count,
    strength: pick(r.strength, STRENGTHS.map((x) => x.id), d.strength),
    autoFix: typeof r.autoFix === 'boolean' ? r.autoFix : d.autoFix,
  };
}

// --- variations ------------------------------------------------------------------
// One small change per copy. A plain repeat of the same prompt often gives near
// identical images — an explicit, different change per copy guarantees variety.
const VARIATIONS: Record<Strength, string[]> = {
  min: [
    'move the camera one or two steps to the left',
    'move the camera one or two steps to the right',
    'zoom in very slightly (about 5%)',
    'zoom out very slightly (about 5%)',
    'hold the camera slightly higher, tilting a few degrees down',
    'hold the camera slightly lower, tilting a few degrees up',
    'turn the camera a few degrees to the left',
    'turn the camera a few degrees to the right',
    'a few seconds later: people, cars, water and clouds moved a little',
    'slightly different light, as if a cloud just moved',
    'tiny handheld tilt of the horizon (1–2 degrees)',
    'a slightly tighter crop around the main subject',
  ],
  medium: [
    'move the camera a few meters to the left, the main subject stays in frame',
    'move the camera a few meters to the right, the main subject stays in frame',
    'zoom in noticeably (about 15–20%) on the main subject',
    'zoom out noticeably (about 15–20%), showing a bit more around',
    'shoot from a noticeably higher point, looking down a little',
    'shoot from a low angle, closer to the ground',
    'turn the camera about 10 degrees to the left',
    'turn the camera about 10 degrees to the right',
    'a minute later: different people and cars, clouds moved',
    'the light shifted: a bit warmer or softer, like a little later in the day',
    'vertical phone framing with the subject slightly off-center',
    'step closer to the main subject, with some foreground in the frame',
  ],
};

function shuffle<T>(a: T[]): T[] {
  const r = [...a];
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

/**
 * `n` variations, none repeated within the batch and not already in `used`.
 * When single changes run out, pairs of two different changes are used.
 */
export function buildVariations(n: number, strength: Strength, used: string[] = []): string[] {
  const usedSet = new Set(used);
  const base = VARIATIONS[strength];
  const out: string[] = [];
  for (const v of shuffle(base)) {
    if (out.length >= n) break;
    if (!usedSet.has(v)) {
      out.push(v);
      usedSet.add(v);
    }
  }
  let guard = 0;
  while (out.length < n && guard++ < 1000) {
    const [a, b] = shuffle(base);
    const v = `${a}, and ${b}`;
    if (!usedSet.has(v)) {
      out.push(v);
      usedSet.add(v);
    }
  }
  while (out.length < n) out.push(shuffle(base)[0]); // practically unreachable
  return out;
}

/** Final prompt for one copy: base prompt + its own change. */
export function copyPrompt(base: string, variation: string, strength: Strength): string {
  const tail =
    strength === 'min'
      ? 'Keep the difference subtle: it must look like an almost identical shot of the same scene, taken seconds apart.'
      : 'The difference should be noticeable, but the place, main subject, style and mood stay the same.';
  return `${base.trim()}\n\nThis is one of several copies of the same photo. For this copy: ${variation}. ${tail}`;
}

// --- check / fix ----------------------------------------------------------------------
export interface PhotoIssue {
  type: 'photo_artifact' | 'scene_change' | 'other';
  severity: 'warn' | 'fail';
  message: string;
}

export interface PhotoCheck {
  status: 'ok' | 'warn' | 'fail';
  issues: PhotoIssue[];
  error: string | null; // main (Claude) check failed
  by: string[]; // checkers that answered: «Claude», «GPT»
  note: string | null; // second opinion skipped / failed — informational
}

/** Lower = better: fail = 3, warn = 1; unchecked / failed checks rank last. */
export function checkScore(c: PhotoCheck | null): number {
  if (!c || c.error) return 1e6;
  return c.issues.reduce((n, i) => n + (i.severity === 'fail' ? 3 : 1), 0);
}

/** Edit prompt for the CURRENT copy: fix only the reported problems, keep the rest. */
export function fixPrompt(problems: string[]): string {
  return (
    'Edit this photo. Keep everything else exactly the same — composition, camera angle, ' +
    'framing, colors, lighting, people, buildings and objects. Fix ONLY these problems ' +
    `(reported in Russian): ${problems.map((p) => `«${p}»`).join('; ')}. ` +
    'All signs, billboards and screens must show either real, correctly spelled text or be ' +
    'naturally out of focus — no garbled or fake letters. People must have natural anatomy ' +
    '(faces, hands, fingers). Architecture must keep correct, realistic geometry, the same as ' +
    'in a real photo of this place. Photorealistic, shot on a phone, no watermark.'
  );
}
