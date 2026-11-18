// SamSpy — Slides: image providers (server only — reads API keys)
//
// One function per provider. Each takes the reference photo + prompt and
// returns the raw generated image bytes plus token usage for the estimate.
//
//   Gemini: POST generativelanguage.googleapis.com/v1beta/models/{id}:generateContent
//   fal:    POST fal.run/{model id}   (GPT Image edit endpoints, sync)
//
// Version history:
//   v0.1.0 (2026-11-18) — Gemini (inline image + imageConfig) and OpenAI
//                         edits (size from aspect, jpeg output).
//   v0.2.0 (2026-11-18) — OpenAI direct replaced by fal.ai (GPT Image without
//                         OpenAI org verification). Reference sent as a data
//                         URI, result returned inline via sync_mode.

import {
  gptImageSize,
  type AspectRatio,
  type GptQuality,
  type ImageModel,
  type ImageSize,
} from './config';

export class SlideGenError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

export interface GenInput {
  model: ImageModel;
  imageBase64: string; // reference photo, no data: prefix
  mime: string;
  prompt: string;
  aspect: AspectRatio;
  size: ImageSize;
  quality: GptQuality;
}

export interface Usage {
  textIn: number;
  imageIn: number;
  imageOut: number;
}

export interface GenOutput {
  data: Buffer;
  usage: Usage;
}

export async function generateImage(input: GenInput): Promise<GenOutput> {
  return input.model.provider === 'gemini' ? generateGemini(input) : generateFal(input);
}

// --- Gemini -------------------------------------------------------------------
interface GeminiPart {
  text?: string;
  inlineData?: { mimeType?: string; data?: string };
  inline_data?: { mime_type?: string; data?: string };
}

interface GeminiModalityCount {
  modality?: string;
  tokenCount?: number;
}

async function generateGemini(input: GenInput): Promise<GenOutput> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new SlideGenError('GEMINI_API_KEY не задан в env.', 500);

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${input.model.id}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              { text: input.prompt },
              { inlineData: { mimeType: input.mime, data: input.imageBase64 } },
            ],
          },
        ],
        generationConfig: {
          responseModalities: ['IMAGE'],
          imageConfig: { aspectRatio: input.aspect, imageSize: input.size },
        },
      }),
    }
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json: any = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = json?.error?.message ?? res.statusText;
    throw new SlideGenError(`Gemini: ${msg}`, res.status >= 500 ? 502 : res.status);
  }

  const cand = json?.candidates?.[0];
  const parts: GeminiPart[] = cand?.content?.parts ?? [];
  const img = parts.find((p) => p.inlineData?.data || p.inline_data?.data);
  const b64 = img?.inlineData?.data ?? img?.inline_data?.data;
  if (!b64) {
    const reason =
      json?.promptFeedback?.blockReason ?? cand?.finishReason ?? 'в ответе нет картинки';
    const text = parts.find((p) => p.text)?.text;
    throw new SlideGenError(
      `Gemini не вернул картинку (${reason})${text ? `: ${text.slice(0, 200)}` : ''}.`,
      502
    );
  }

  // Token usage, split by modality when Gemini reports it.
  const um = json?.usageMetadata ?? {};
  const promptDetails: GeminiModalityCount[] = um.promptTokensDetails ?? [];
  let textIn = 0;
  let imageIn = 0;
  for (const d of promptDetails) {
    if (d.modality === 'IMAGE') imageIn += d.tokenCount ?? 0;
    else textIn += d.tokenCount ?? 0;
  }
  if (!promptDetails.length) textIn = um.promptTokenCount ?? 0;

  const outDetails: GeminiModalityCount[] = um.candidatesTokensDetails ?? [];
  let imageOut = outDetails
    .filter((d) => d.modality === 'IMAGE')
    .reduce((s, d) => s + (d.tokenCount ?? 0), 0);
  if (!imageOut) imageOut = um.candidatesTokenCount ?? 0;

  return { data: Buffer.from(b64, 'base64'), usage: { textIn, imageIn, imageOut } };
}

// --- fal.ai (GPT Image edit) ------------------------------------------------------
function falErrorMessage(json: unknown, fallback: string): string {
  // fal returns { detail: string } or { detail: [{ msg, loc }] } (validation).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = (json as any)?.detail ?? (json as any)?.error ?? (json as any)?.message;
  if (typeof d === 'string') return d;
  if (Array.isArray(d)) {
    return d
      .map((e) => [e?.loc?.slice?.(-1)?.[0], e?.msg].filter(Boolean).join(': '))
      .join('; ');
  }
  return fallback;
}

async function generateFal(input: GenInput): Promise<GenOutput> {
  const key = process.env.FAL_KEY;
  if (!key) throw new SlideGenError('FAL_KEY не задан в env.', 500);

  const res = await fetch(`https://fal.run/${input.model.id}`, {
    method: 'POST',
    headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: input.prompt,
      image_urls: [`data:${input.mime};base64,${input.imageBase64}`],
      image_size: gptImageSize(input.aspect, input.size),
      quality: input.quality,
      num_images: 1,
      output_format: 'jpeg',
      sync_mode: true, // image comes back as a data URI, not kept in fal history
    }),
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json: any = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = falErrorMessage(json, res.statusText);
    throw new SlideGenError(`fal: ${msg}`, res.status >= 500 ? 502 : res.status);
  }

  const url: string | undefined = json?.images?.[0]?.url;
  if (!url) throw new SlideGenError('fal не вернул картинку.', 502);

  let data: Buffer;
  if (url.startsWith('data:')) {
    data = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
  } else {
    const img = await fetch(url);
    if (!img.ok) throw new SlideGenError('Не удалось скачать картинку с fal.', 502);
    data = Buffer.from(await img.arrayBuffer());
  }

  // fal doesn't report token usage — the cost is only in the fal billing.
  return { data, usage: { textIn: 0, imageIn: 0, imageOut: 0 } };
}
