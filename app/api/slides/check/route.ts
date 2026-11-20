// SamSpy — Slides: AI check of a finished slide (photo + overlaid text)
//   POST /api/slides/check   body: { image: dataURL (jpeg), text: string, provider? }
//     -> { status: 'ok'|'warn'|'fail', issues: [{type, severity, message}], model }
//
//   mode 'photo' («Размножение»): body { mode: 'photo', image, reference?, provider? }
//     Only the photo is checked (no caption). With `reference` (the original photo)
//     the model also compares the copy with it: invented / removed / broken structures.
//
//   provider: 'claude' (default) | 'openai' — the OpenAI call is the «second opinion».
//     Without OPENAI_API_KEY it answers { skipped: true, issues: [] }.
//
//   GET /api/slides/check -> { claude: bool, openai: bool, claudeModel, openaiModel }
//     which keys are set (open it in the browser while logged in to verify env).
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
//   v0.3.0 (2026-11-20) — provider 'openai' actually calls OpenAI (OPENAI_CHECK_MODEL,
//                         default gpt-5.4-mini) — before, the «GPT» second opinion went
//                         to Claude again; skipped without OPENAI_API_KEY. GET = env status.
//   v0.3.1 (2026-11-20) — busy photos (Times Square: dozens of garbled signs) cut the JSON
//                         at max_tokens → «Не удалось разобрать ответ». Now: max 6 grouped
//                         issues in the prompt, 1500 output tokens, and a truncated answer
//                         is salvaged (complete issue objects are kept).
//   v0.4.0 (2026-11-20) — slide mode checks the TEXT overlay only (photos are checked in
//                         «Размножение»): no photo_artifact item in the slide prompt.

import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const CLAUDE_MODEL =
  process.env.SLIDES_CHECK_MODEL || process.env.CAROUSEL_OCR_MODEL || 'claude-haiku-5-5';
const OPENAI_MODEL = process.env.OPENAI_CHECK_MODEL || 'gpt-5.4-mini';

const DATA_URL_RE = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/;

const PROMPT = (text: string) => `You are reviewing one slide of an Instagram/TikTok carousel: a photo with a caption overlaid on it. The photo itself was already checked — review ONLY the caption and how it sits on the photo.

Intended caption text (exactly what the author typed):
<<<
${text || '(no caption)'}
>>>

Check the slide image and report problems:
1. overflow / readability — is every word of the caption fully visible inside the frame and easy to read against the background (contrast, busy background behind the letters)?
2. covers_subject — does the caption cover a face or the main subject of the photo?
3. text — does the caption contain garbage: stray symbols, @handles, links, watermarks, leftover OCR noise, broken or misspelled words, wrong line breaks inside a phrase? Compare with the intended text.
Do NOT report anything about the photo itself (AI artifacts, signs, people, architecture).

List at most 6 issues, most noticeable first; group similar problems into one.

Severity: "fail" only for serious problems (caption unreadable, cut off, or covering a face). Minor things are "warn". Do not invent problems — if the slide is fine, return no issues.

Answer with ONLY this JSON, no other text. Write every "message" in Russian, short (max 20 words), with a concrete hint when possible (e.g. «сдвинь текст выше», «уменьши размер»):
{"status":"ok"|"warn"|"fail","issues":[{"type":"overflow|readability|covers_subject|text|other","severity":"warn|fail","message":"..."}]}`;

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

List at most 6 issues, most noticeable first; group similar problems into one (e.g. «много вывесок с бессмысленным текстом слева»).

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

// Provider-neutral message: text parts and images (data URL match) in order.
type Part = { kind: 'text'; text: string } | { kind: 'image'; m: RegExpExecArray };

class CheckError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

async function askClaude(parts: Part[]): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new CheckError('ANTHROPIC_API_KEY не задан в env.', 500);
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1500,
      messages: [
        {
          role: 'user',
          content: parts.map((p) =>
            p.kind === 'text'
              ? { type: 'text', text: p.text }
              : { type: 'image', source: { type: 'base64', media_type: p.m[1], data: p.m[2] } }
          ),
        },
      ],
    }),
    cache: 'no-store',
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    throw new CheckError(`Claude HTTP ${res.status}: ${detail}`, res.status === 429 ? 429 : 502);
  }
  const data = (await res.json()) as { content?: { type: string; text?: string }[] };
  return (data.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
}

async function askOpenAI(parts: Part[], key: string): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      max_completion_tokens: 3000,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'user',
          content: parts.map((p) =>
            p.kind === 'text'
              ? { type: 'text', text: p.text }
              : { type: 'image_url', image_url: { url: p.m[0], detail: 'high' } }
          ),
        },
      ],
    }),
    cache: 'no-store',
  });
  if (!res.ok) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const j: any = await res.json().catch(() => null);
    const msg = j?.error?.message ?? res.statusText;
    throw new CheckError(`OpenAI HTTP ${res.status}: ${String(msg).slice(0, 200)}`, res.status === 429 ? 429 : 502);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = await res.json();
  return String(data?.choices?.[0]?.message?.content ?? '');
}

export async function GET() {
  return NextResponse.json({
    claude: !!process.env.ANTHROPIC_API_KEY,
    openai: !!process.env.OPENAI_API_KEY,
    claudeModel: CLAUDE_MODEL,
    openaiModel: OPENAI_MODEL,
  });
}

export async function POST(req: Request) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Некорректный JSON.' }, { status: 400 });
  }
  const m = typeof body?.image === 'string' ? DATA_URL_RE.exec(body.image) : null;
  if (!m) return NextResponse.json({ error: 'Нужна картинка слайда.' }, { status: 400 });

  const provider: 'claude' | 'openai' = body?.provider === 'openai' ? 'openai' : 'claude';
  const openaiKey = process.env.OPENAI_API_KEY;
  if (provider === 'openai' && !openaiKey) {
    return NextResponse.json({ skipped: true, reason: 'OPENAI_API_KEY не задан', issues: [] });
  }

  // Build the message: slide mode (default) or photo-only mode.
  let parts: Part[];
  if (body?.mode === 'photo') {
    const ref = typeof body?.reference === 'string' ? DATA_URL_RE.exec(body.reference) : null;
    parts = ref
      ? [
          { kind: 'text', text: 'Image 1 — original:' },
          { kind: 'image', m: ref },
          { kind: 'text', text: 'Image 2 — AI copy to check:' },
          { kind: 'image', m },
          { kind: 'text', text: PHOTO_PROMPT(true) },
        ]
      : [
          { kind: 'image', m },
          { kind: 'text', text: PHOTO_PROMPT(false) },
        ];
  } else {
    const text = typeof body?.text === 'string' ? body.text : '';
    parts = [
      { kind: 'image', m },
      { kind: 'text', text: PROMPT(text) },
    ];
  }

  let raw: string;
  try {
    raw = provider === 'openai' ? await askOpenAI(parts, openaiKey!) : await askClaude(parts);
  } catch (e) {
    const err = e as CheckError;
    return NextResponse.json({ error: err.message }, { status: err.status ?? 502 });
  }
  const model = provider === 'openai' ? OPENAI_MODEL : CLAUDE_MODEL;
  const issues = parseIssues(raw);
  if (!issues) {
    return NextResponse.json(
      { error: `Не удалось разобрать ответ модели (${model}): ${raw.slice(0, 120) || 'пустой ответ'}` },
      { status: 502 }
    );
  }
  const status = issues.some((i) => i.severity === 'fail') ? 'fail' : issues.length ? 'warn' : 'ok';
  return NextResponse.json({ status, issues, model, provider });
}

type Issue = { type: string; severity: 'warn' | 'fail'; message: string };

function clean(list: { type?: unknown; severity?: unknown; message?: unknown }[]): Issue[] {
  return list
    .filter((i) => i && typeof i.message === 'string' && i.message.trim())
    .slice(0, 8)
    .map((i) => ({
      type: TYPES.has(String(i.type)) ? String(i.type) : 'other',
      severity: i.severity === 'fail' ? 'fail' : 'warn',
      message: String(i.message).trim(),
    }));
}

/**
 * Issues from the model's answer. Normal case: the JSON object. If the answer was cut off
 * (output limit), every complete {"type","severity","message"} object found is kept.
 * Returns null when nothing usable is there.
 */
function parseIssues(raw: string): Issue[] | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1)) as { issues?: unknown };
      if (Array.isArray(parsed.issues)) return clean(parsed.issues);
    } catch {
      /* fall through to salvage */
    }
  }
  const found: { type?: unknown; severity?: unknown; message?: unknown }[] = [];
  for (const m of raw.matchAll(/\{[^{}]*"message"\s*:\s*"(?:[^"\\]|\\.)*"[^{}]*\}/g)) {
    try {
      found.push(JSON.parse(m[0]));
    } catch {
      /* skip a broken object */
    }
  }
  if (found.length) return clean(found);
  if (/"issues"\s*:\s*\[\s*\]/.test(raw)) return [];
  return null;
}
