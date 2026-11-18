// SamSpy — carousel text collector: Claude calls
// OCR (vision), text-only check of a whole post (+ last-slide split), re-split.
//
// Version history:
//   v0.4.0 (2026-11-18) — port of carousels.js v1.7 Claude logic.

import { OCR_PROMPT, CHECK_PROMPT, SPLIT_PROMPT } from './prompts';
import type { LastSplit } from './types';

export const OCR_MODEL = process.env.CAROUSEL_OCR_MODEL || 'claude-haiku-5-5';
export const ESCALATE_MODEL = process.env.CAROUSEL_ESCALATE_MODEL || 'claude-sonnet-5-5';

type Content =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source: { type: 'base64'; media_type: string; data: string };
    };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function callClaude(
  model: string,
  content: Content[],
  maxTokens: number,
  attempt = 1
): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set.');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content }],
    }),
    cache: 'no-store',
  });

  if ((res.status === 429 || res.status >= 500) && attempt < 3) {
    await sleep(1500 * attempt);
    return callClaude(model, content, maxTokens, attempt + 1);
  }
  if (!res.ok) {
    throw new Error(`Claude HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as { content?: { type: string; text?: string }[] };
  return (data.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n')
    .trim();
}

function parseJson<T>(answer: string): T {
  const m = answer.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`no JSON in answer: ${answer.slice(0, 100)}`);
  return JSON.parse(m[0]) as T;
}

export async function ocrSlide(
  img: { base64: string; mime: string },
  model: string,
  previousIssue = ''
): Promise<string> {
  let prompt = OCR_PROMPT;
  if (previousIssue) {
    prompt += `\n\nNote: a previous transcription of this slide had a problem: "${previousIssue}". Read carefully.`;
  }
  const text = await callClaude(
    model,
    [
      { type: 'image', source: { type: 'base64', media_type: img.mime, data: img.base64 } },
      { type: 'text', text: prompt },
    ],
    2000
  );
  return text === '[NO TEXT]' ? '' : text;
}

/** Text-only check of all slides of one post + split of the last slide. */
export async function checkPost(
  slides: { slide: number; text: string }[]
): Promise<{ flags: { slide: number; issue: string }[]; last: LastSplit | null }> {
  if (!slides.length) return { flags: [], last: null };
  const answer = await callClaude(
    OCR_MODEL,
    [{ type: 'text', text: CHECK_PROMPT + JSON.stringify(slides, null, 1) }],
    1500
  );
  const obj = parseJson<{
    flags?: { slide?: number | string; issue?: string }[];
    last_slide?: { content?: string; cta?: string };
  }>(answer);
  const flags = (Array.isArray(obj.flags) ? obj.flags : [])
    .filter((f) => f && f.slide != null)
    .map((f) => ({ slide: Number(f.slide), issue: String(f.issue ?? '') }));
  const last =
    obj.last_slide && typeof obj.last_slide === 'object'
      ? { content: String(obj.last_slide.content ?? ''), cta: String(obj.last_slide.cta ?? '') }
      : null;
  return { flags, last };
}

export async function splitLastSlide(text: string): Promise<LastSplit> {
  const answer = await callClaude(OCR_MODEL, [{ type: 'text', text: SPLIT_PROMPT + text }], 800);
  const obj = parseJson<{ content?: string; cta?: string }>(answer);
  return { content: String(obj.content ?? ''), cta: String(obj.cta ?? '') };
}
