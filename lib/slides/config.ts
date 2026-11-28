// SamSpy — Slides: shared config (client + server, no secrets)
//
// Models, formats, sizes, token prices for the cost estimate, text-overlay
// styles and the default settings of the «Слайды» tab.
//
// Version history:
//   v0.1.0 (2026-11-18) — Gemini 3.1 Flash Image + OpenAI gpt-image-2;
//                         formats 3:4 / 4:5 / 9:16 / 1:1, sizes 1K / 2K,
//                         TikTok-style text presets, settings sanitizer.
//   v0.2.0 (2026-11-18) — GPT Image via fal.ai instead of OpenAI direct (no org
//                         verification): 2.6 / 2.5 Flare + Sunburst, 2 Edit.
//                         Price is optional (fal returns no usage → no estimate).
//   v0.3.0 (2026-11-18) — default model GPT Image 2.6 Flare (fal); new default
//                         prompt that keeps architecture intact.
//   v0.3.1 (2026-11-18) — default text: size 6, center, TikTok 1, offset -43.
//   v0.4.0 (2026-11-18) — «TikTok Classic» style (TikTok Sans 500, thin outline).
//   v0.4.1 (2026-11-18) — «TikTok Classic (тонкая)» copy with a thinner outline.
//   v0.4.2 (2026-11-18) — thin copy removed (regular Classic won); default text
//                         style TikTok Classic, size 4%.
//   v0.5.0 (2026-11-18) — Instagram A/B styles: IG Classic, IG Modern, Montserrat.
//   v0.6.0 (2026-11-19) — IG Literature, IG Strong, Reels captions styles;
//                         textRotate (°) and subtitleSize (% of title) settings.
//   v0.7.0 (2026-11-19) — autoFix: check every generated slide and auto-fix photo artifacts.
//   v0.7.1 (2026-11-19) — default text position «Верх» with offset −6 (multi-line text grows
//                         downward instead of creeping to the top edge); altModelFor().
//   v0.8.0 (2026-11-28) — placement: 'inside' (text written into a template photo, default) or
//                         'overlay' (the old way: text over a photo).

export type Provider = 'gemini' | 'fal';

export interface TokenPrice {
  textIn: number; // USD per 1M text input tokens
  imageIn: number; // USD per 1M image input tokens
  imageOut: number; // USD per 1M image output tokens
}

export interface ImageModel {
  id: string; // API model id
  label: string; // dropdown label
  provider: Provider;
  price: TokenPrice | null; // null = no estimate (see the provider's billing)
}

// Gemini: list prices per 1M tokens — the number under the button is an
// estimate. fal: no usage in the response, so the real cost is only in the
// fal billing. Add a model here and it shows up in the dropdown.
export const IMAGE_MODELS: ImageModel[] = [
  {
    id: 'gemini-3.1-flash-image',
    label: 'Gemini 3.1 Flash Image',
    provider: 'gemini',
    price: { textIn: 0.5, imageIn: 0.5, imageOut: 60 },
  },
  ...[
    ['openai/gpt-image-2.6/flare/edit', 'GPT Image 2.6 Flare (fal)'],
    ['openai/gpt-image-2.6/sunburst/edit', 'GPT Image 2.6 Sunburst (fal)'],
    ['openai/gpt-image-2.5/flare/edit', 'GPT Image 2.5 Flare (fal)'],
    ['openai/gpt-image-2.5/sunburst/edit', 'GPT Image 2.5 Sunburst (fal)'],
    ['openai/gpt-image-2/edit', 'GPT Image 2 (fal)'],
  ].map(([id, label]): ImageModel => ({ id, label, provider: 'fal', price: null })),
];

export function findModel(id: string): ImageModel | undefined {
  return IMAGE_MODELS.find((m) => m.id === id);
}

/** The «other» image model used when auto-fix with the main model keeps failing. */
export function altModelFor(modelId: string): ImageModel {
  const main = findModel(modelId);
  const altId = main?.provider === 'gemini' ? 'openai/gpt-image-2.6/flare/edit' : 'gemini-3.1-flash-image';
  return findModel(altId) ?? IMAGE_MODELS[0];
}

export function estimateCost(
  model: ImageModel,
  usage: { textIn: number; imageIn: number; imageOut: number }
): number | null {
  const p = model.price;
  if (!p) return null;
  return (
    (usage.textIn * p.textIn + usage.imageIn * p.imageIn + usage.imageOut * p.imageOut) /
    1_000_000
  );
}

// --- formats ----------------------------------------------------------------
export type AspectRatio = '3:4' | '4:5' | '9:16' | '1:1';
export const ASPECT_RATIOS: AspectRatio[] = ['3:4', '4:5', '9:16', '1:1'];

// Final JPEG size per format (1080 wide — Instagram / TikTok friendly).
export const EXPORT_SIZE: Record<AspectRatio, { w: number; h: number }> = {
  '3:4': { w: 1080, h: 1440 },
  '4:5': { w: 1080, h: 1350 },
  '9:16': { w: 1080, h: 1920 },
  '1:1': { w: 1080, h: 1080 },
};

export type ImageSize = '1K' | '2K';
export const IMAGE_SIZES: ImageSize[] = ['1K', '2K'];

export type GptQuality = 'low' | 'medium' | 'high';
export const GPT_QUALITIES: { id: GptQuality; label: string }[] = [
  { id: 'low', label: 'Низкое' },
  { id: 'medium', label: 'Среднее' },
  { id: 'high', label: 'Высокое' },
];

function ratioValue(r: AspectRatio): number {
  const [a, b] = r.split(':').map(Number);
  return a / b;
}

/** GPT Image output size: ~1MP (1K) or ~4MP (2K), both sides multiples of 16. */
export function gptImageSize(r: AspectRatio, s: ImageSize): { width: number; height: number } {
  const pixels = s === '2K' ? 2048 * 2048 : 1024 * 1024;
  const k = ratioValue(r);
  const width = Math.round(Math.sqrt(pixels * k) / 16) * 16;
  const height = Math.round(width / k / 16) * 16;
  return { width, height };
}

// --- text overlay -------------------------------------------------------------
export type TextPosition = 'top' | 'center' | 'bottom';
export const TEXT_POSITIONS: { id: TextPosition; label: string }[] = [
  { id: 'top', label: 'Верх' },
  { id: 'center', label: 'Центр' },
  { id: 'bottom', label: 'Низ' },
];

export type TextStyleId =
  | 'tiktok1'
  | 'tiktok2'
  | 'tiktok3'
  | 'classic'
  | 'igClassic'
  | 'igModern'
  | 'montserrat'
  | 'igLiterature'
  | 'igStrong'
  | 'reelsBold';
export const TEXT_STYLES: { id: TextStyleId; label: string }[] = [
  { id: 'tiktok1', label: 'TikTok 1 — обводка' },
  { id: 'tiktok2', label: 'TikTok 2 — белая плашка' },
  { id: 'tiktok3', label: 'TikTok 3 — чёрная плашка' },
  { id: 'classic', label: 'TikTok Classic — как в приложении' },
  { id: 'igClassic', label: 'Instagram Classic (Instrument Sans)' },
  { id: 'igModern', label: 'Instagram Modern (Gabarito)' },
  { id: 'montserrat', label: 'Montserrat (карусели в Canva)' },
  { id: 'igLiterature', label: 'Instagram Literature (с засечками)' },
  { id: 'igStrong', label: 'Instagram Strong (капс на плашке)' },
  { id: 'reelsBold', label: 'Субтитры Reels (жирный + свечение)' },
];

// --- settings ----------------------------------------------------------------
export type Placement = 'inside' | 'overlay';

export interface SlidesSettings {
  placement: Placement; // 'inside' = text written into a template photo; 'overlay' = over a photo
  prompt: string;
  modelId: string;
  aspect: AspectRatio;
  size: ImageSize;
  quality: GptQuality; // GPT Image (fal) only
  textSize: number; // font size, % of slide width
  textPosition: TextPosition;
  textStyle: TextStyleId;
  textOffset: number; // vertical shift, % of slide height (+ = down)
  textMaxWidth: number; // wrap width, % of slide width
  textRotate: number; // block rotation, degrees (+ = clockwise)
  subtitleSize: number; // text after a blank line, % of the title size
  autoFix: boolean; // after generation: check the slide and auto-fix photo artifacts
}

// v0.3.0: keep landmarks/architecture intact, change the camera only slightly —
// a bigger shift made models invent unseen geometry (broken Brooklyn Bridge).
export const DEFAULT_PROMPT =
  'Recreate this exact photo as a new phone shot of the same place, at the target aspect ratio. ' +
  'Keep every landmark and structure exactly as in the reference — same bridge geometry, towers, ' +
  'arches, cables and buildings. Only change the camera very slightly (a few steps left/right or a ' +
  'small zoom) and small natural details: people, cars, waves, clouds, lights. Do not invent or ' +
  'redraw architecture. Photorealistic, shot on a phone, no watermark.';

export const DEFAULT_SETTINGS: SlidesSettings = {
  placement: 'inside',
  prompt: DEFAULT_PROMPT,
  modelId: 'openai/gpt-image-2.6/flare/edit',
  aspect: '3:4',
  size: '1K',
  quality: 'medium',
  textSize: 4,
  textPosition: 'top',
  textStyle: 'classic',
  textOffset: -6,
  textMaxWidth: 72,
  textRotate: 0,
  subtitleSize: 60,
  autoFix: true,
};

function pick<T extends string>(v: unknown, allowed: readonly T[], d: T): T {
  return allowed.includes(v as T) ? (v as T) : d;
}

function num(v: unknown, min: number, max: number, d: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
}

/** Merge anything (localStorage, imported JSON) onto the defaults, validated. */
export function sanitizeSettings(raw: unknown): SlidesSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_SETTINGS;
  return {
    placement: r.placement === 'overlay' ? 'overlay' : 'inside',
    prompt: typeof r.prompt === 'string' && r.prompt.trim() ? r.prompt : d.prompt,
    modelId: pick(r.modelId, IMAGE_MODELS.map((m) => m.id), d.modelId),
    aspect: pick(r.aspect, ASPECT_RATIOS, d.aspect),
    size: pick(r.size, IMAGE_SIZES, d.size),
    quality: pick(r.quality, GPT_QUALITIES.map((q) => q.id), d.quality),
    textSize: num(r.textSize, 2, 20, d.textSize),
    textPosition: pick(r.textPosition, TEXT_POSITIONS.map((p) => p.id), d.textPosition),
    textStyle: pick(r.textStyle, TEXT_STYLES.map((s) => s.id), d.textStyle),
    textOffset: num(r.textOffset, -50, 50, d.textOffset),
    textMaxWidth: num(r.textMaxWidth, 20, 100, d.textMaxWidth),
    textRotate: num(r.textRotate, -45, 45, d.textRotate),
    subtitleSize: num(r.subtitleSize, 30, 100, d.subtitleSize),
    autoFix: typeof r.autoFix === 'boolean' ? r.autoFix : d.autoFix,
  };
}
