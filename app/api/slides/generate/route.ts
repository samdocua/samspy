// SamSpy — Slides: regenerate a reference photo with AI
//   POST /api/slides/generate
//     body: { image: dataURL, prompt, modelId, aspect, size, quality }
//     -> { image: dataURL (jpeg), ms, usage, costUsd, model }
//
// The browser sends an already-downscaled JPEG (≤1600px) so the request stays
// under Vercel's ~4.5 MB body limit. The result is re-encoded to JPEG with
// sharp so 2K PNGs from Gemini also fit in the response.
// Protected by the app password via middleware.ts (all /api/* except auth/cron).
//
// Version history:
//   v0.1.0 (2026-11-18) — Gemini + OpenAI, JPEG re-encode, cost estimate.
//   v0.2.0 (2026-11-18) — GPT Image via fal.ai; costUsd may be null (no usage
//                         from fal); maxDuration 300 for slow high-quality runs.
//   v0.3.0 (2026-11-18) — fal cost = average price per call (Platform API);
//                         response adds costKind: 'tokens' | 'avg'.

import { NextResponse } from 'next/server';
import sharp from 'sharp';
import {
  ASPECT_RATIOS,
  IMAGE_SIZES,
  GPT_QUALITIES,
  estimateCost,
  findModel,
  type AspectRatio,
  type ImageSize,
  type GptQuality,
} from '@/lib/slides/config';
import { SlideGenError, falAvgCost, generateImage } from '@/lib/slides/providers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300; // seconds — high-quality 2K runs can be slow

const DATA_URL_RE = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/;

export async function POST(req: Request) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Некорректный JSON.' }, { status: 400 });
  }

  const match = typeof body?.image === 'string' ? DATA_URL_RE.exec(body.image) : null;
  if (!match) {
    return NextResponse.json(
      { error: 'Нужна картинка-пример (JPEG, PNG или WebP).' },
      { status: 400 }
    );
  }

  const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) return NextResponse.json({ error: 'Пустой промпт.' }, { status: 400 });

  const model = findModel(String(body?.modelId ?? ''));
  if (!model) return NextResponse.json({ error: 'Неизвестная модель.' }, { status: 400 });

  const aspect: AspectRatio = ASPECT_RATIOS.includes(body?.aspect) ? body.aspect : '3:4';
  const size: ImageSize = IMAGE_SIZES.includes(body?.size) ? body.size : '1K';
  const quality: GptQuality = GPT_QUALITIES.some((q) => q.id === body?.quality)
    ? body.quality
    : 'medium';

  const t0 = Date.now();
  try {
    const out = await generateImage({
      model,
      imageBase64: match[2],
      mime: match[1],
      prompt,
      aspect,
      size,
      quality,
    });

    const jpeg = await sharp(out.data).jpeg({ quality: 92, mozjpeg: true }).toBuffer();
    const isFal = model.provider === 'fal';
    const costUsd = isFal ? await falAvgCost(model.id) : estimateCost(model, out.usage);

    return NextResponse.json({
      image: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
      ms: Date.now() - t0,
      usage: out.usage,
      costUsd,
      costKind: isFal ? 'avg' : 'tokens',
      model: model.id,
    });
  } catch (err) {
    if (err instanceof SlideGenError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json(
      { error: `Ошибка генерации: ${(err as Error)?.message ?? 'неизвестно'}` },
      { status: 500 }
    );
  }
}
