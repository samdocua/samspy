// SamSpy — Slides: AI check of a finished slide (photo + overlaid text)
//   POST /api/slides/check   body: { image: dataURL (jpeg), text: string }
//     -> { status: 'ok'|'warn'|'fail', issues: [{type, severity, message}], model }
//
//   mode 'photo' («Размножение»): body { mode: 'photo', image, reference? }
//     Only the photo is checked (no caption). With `reference` (the original photo)
//     Claude also compares the copy with it: invented / removed / broken structures.
//
// Claude looks at the rendered slide and reports: unreadable / cut text, text over
// faces or the main subject, garbage or typos in the text, AI artifacts in the photo
// (garbled signs, distorted people, broken architecture). Messages are in Russian.
// Protected by the app password via middleware.ts.
//
// Version history:
//   v0.1.0 (2026-11-19) — initial check (Haiku by default, SLIDES_CHECK_MODEL override).
//   v0.2.0 (2026-11-20) — mode 'photo' for «Размножение»: photo-only AI-artifact check,
//                         optional reference photo for comparison (type 'scene_change').

import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MODEL =
  process.env.SLIDES_CHECK_MODEL || process.env.CAROUSEL_OCR_MODEL || 'claude-haiku-5-5';

const DATA_URL_RE = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/;

const PROMPT = (text: string) => `You are reviewing one slide of an Instagram/TikTok carousel: a photo with a caption overlaid on it.

Intended caption text (exactly what the author typed):
<<<
${text || '(no caption)'}
>>>

Check the slide image and report problems:
1. overflow / readability — is every word of the caption fully visible inside the frame and easy to read against the background?
2. covers_subject — does the caption cover a face or the main subject of the photo?
3. text — does the caption contain garbage: stray symbols, @handles, links, watermarks, leftover OCR noise, broken or misspelled words, wrong line breaks inside a phrase? Compare with the intended text.
4. photo_artifact — AI-generation artifacts in the PHOTO itself: garbled or fake lettering on signs, distorted faces/hands/people, broken or impossible architecture, melted or duplicated objects, anything that makes it look fake rather than a real phone photo.

Severity: "fail" only for serious problems (caption unreadable or cut off, obvious artifacts a viewer would notice). Minor things are "warn". Do not invent problems — if the slide is fine, return no issues.

Answer with ONLY this JSON, no other text. Write every "message" in Russian, short (max 20 words), with a concrete hint when possible:
{"status":"ok"|"warn"|"fail","issues":[{"type":"overflow|readability|covers_subject|text|photo_artifact|other","severity":"warn|fail","message":"..."}]}`;

const PHOTO_PROMPT = (withReference: boolean) => `${
  withReference
    ? 'Image 1 is the ORIGINAL photo. Image 2 is an AI-generated copy of it: it should look like a new real phone shot of the same place, with a small camera change (a step left/right, slight zoom, slightly different moment).'
    : 'The image is an AI-generated photo that should look like a real phone shot.'
}

Check ${withReference ? 'Image 2 (the copy) ONLY' : 'the image'} for anything that makes it look AI-generated rather than a real photo:
1. photo_artifact — garbled, fake or misspelled lettering on signs, screens, plates and labels; distorted faces, hands, fingers or bodies; melted, merged or duplicated objects; impossible geometry, broken lines, warped perspective; plastic / over-smoothed textures; obvious seams.${
  withReference
    ? `
2. scene_change — compared with the original: a building, bridge, landmark or major object that is broken, redrawn with different geometry, invented or missing. Text on signs that is readable in the original but garbled in the copy.
Do NOT report the intended small differences: camera position, zoom, crop, light, and moving things (people, cars, water, clouds) may differ.`
    : ''
}

Severity: "fail" only for problems an ordinary viewer would notice on a phone screen and think «this is AI». Small things visible only when zoomed in are "warn". Do not invent problems — if the photo looks real, return no issues.

Answer with ONLY this JSON, no other text. Write every "message" in Russian, short (max 20 words), say WHERE in the frame the problem is:
{"status":"ok"|"warn"|"fail","issues":[{"type":"photo_artifact|scene_change|other","severity":"warn|fail","message":"..."}]}`;

const TYPES = new Set([
  'overflow',
  'readability',
  'covers_subject',
  'text',
  'photo_artifact',
  'scene_change',
  'other',
]);

type ImagePart = { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };
const imagePart = (m: RegExpExecArray): ImagePart => ({
  type: 'image',
  source: { type: 'base64', media_type: m[1], data: m[2] },
});

export async function POST(req: Request) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return NextResponse.json({ error: 'ANTHROPIC_API_KEY не задан в env.' }, { status: 500 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Некорректный JSON.' }, { status: 400 });
  }
  const m = typeof body?.image === 'string' ? DATA_URL_RE.exec(body.image) : null;
  if (!m) return NextResponse.json({ error: 'Нужна картинка слайда.' }, { status: 400 });

  // Build the message: slide mode (default) or photo-only mode.
  let content: (ImagePart | { type: 'text'; text: string })[];
  if (body?.mode === 'photo') {
    const ref = typeof body?.reference === 'string' ? DATA_URL_RE.exec(body.reference) : null;
    content = ref
      ? [
          { type: 'text', text: 'Image 1 — original:' },
          imagePart(ref),
          { type: 'text', text: 'Image 2 — AI copy to check:' },
          imagePart(m),
          { type: 'text', text: PHOTO_PROMPT(true) },
        ]
      : [imagePart(m), { type: 'text', text: PHOTO_PROMPT(false) }];
  } else {
    const text = typeof body?.text === 'string' ? body.text : '';
    content = [imagePart(m), { type: 'text', text: PROMPT(text) }];
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 600,
      messages: [{ role: 'user', content }],
    }),
    cache: 'no-store',
  });

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    return NextResponse.json(
      { error: `Claude HTTP ${res.status}: ${detail}` },
      { status: res.status === 429 ? 429 : 502 }
    );
  }

  const data = (await res.json()) as { content?: { type: string; text?: string }[] };
  const raw = (data.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
  const jsonText = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);

  try {
    const parsed = JSON.parse(jsonText) as {
      issues?: { type?: string; severity?: string; message?: string }[];
    };
    const issues = (parsed.issues ?? [])
      .filter((i) => i && typeof i.message === 'string' && i.message.trim())
      .map((i) => ({
        type: TYPES.has(String(i.type)) ? String(i.type) : 'other',
        severity: i.severity === 'fail' ? 'fail' : 'warn',
        message: String(i.message).trim(),
      }));
    const status = issues.some((i) => i.severity === 'fail') ? 'fail' : issues.length ? 'warn' : 'ok';
    return NextResponse.json({ status, issues, model: MODEL });
  } catch {
    return NextResponse.json({ error: 'Не удалось разобрать ответ модели.' }, { status: 502 });
  }
}
