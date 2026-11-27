// SamSpy — «План»: checks of the new carousels Claude wrote (server only)
//
//   codeIssues()   rules a program can check: cover / question length, number of questions,
//                  repeats inside the plan, near-copies of competitor covers / questions
//   reviewItems()  a second model (GPT, not Claude — other blind spots) reads each new carousel with
//                  the playbook and either approves it or returns a fixed version + a note in Russian
//   proofreadCopies()  copies (competitor slide texts 1:1) get a proofreading only: OCR typos, words
//                  cut at the image edge (from the caption / the same hook on their other carousels),
//                  a missing full stop between two sentences — wording never changes
//
// Limits (from the 199 strongest carousels of @21questions.couples): cover 5–8 words, at most 10;
// a «task» hook («Send this to your boyfriend, they have to answer one…») at most 12; a question
// at most 16 words, answer options on their own short lines do not count.
//
// Version history:
//   v0.1.0 (2026-11-26) — initial.
//   v0.2.0 (2026-11-26) — proofreadCopies(); the winning task hook keeps its key words verbatim
//                         («Send this to your boyfriend … has to answer one»), checked by the script
//                         and by the reviewer; only the ending may vary.
//   v0.3.0 (2026-11-27) — cheaper: the review thinks at low effort (it was the biggest cost of a
//                         plan), the proofreading of copies runs on GPT-6.2 Sol (4× cheaper);
//                         tokens of every call go to ai_usage (lib/usage.ts).

import { addOpenAIUsage, usageStep } from '@/lib/usage';
import { normSlide } from './copy';
import type { PlanExample, PlanReview, PlanSettings } from './types';

export const REVIEW_MODEL = process.env.PLAN_REVIEW_MODEL || 'gpt-6.2-astra';
export const REVIEW_EFFORT = process.env.PLAN_REVIEW_EFFORT || 'low'; // reasoning effort of the review
export const PROOF_MODEL = process.env.PLAN_PROOF_MODEL || 'gpt-6.2-sol'; // copies: proofreading only

export const COVER_MAX = 10;
export const COVER_TASK_MAX = 12;
export const QUESTION_MAX = 16;

export interface Draft {
  key: string;
  title: string;
  cover: string;
  questions: string[];
  caption: string;
}

const words = (s: string) => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
const isTaskHook = (cover: string) => /\b(send|tag|share|ask|make)\b.*\b(answer|has to|have to|must)\b/i.test(cover);
/** The question itself: lines that are not answer options («A) …», «B. …», «• …»). */
const questionPart = (q: string) =>
  q
    .split('\n')
    .filter((l) => !/^\s*([A-Da-d][).:]|[-•·])\s+/.test(l))
    .join(' ');

function similar(a: string, b: string): boolean {
  if (a === b) return true;
  const A = new Set(a.split(' ').filter((w) => w.length > 2));
  const B = new Set(b.split(' ').filter((w) => w.length > 2));
  if (A.size < 3 || B.size < 3) return false;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / Math.min(A.size, B.size) >= 0.8;
}

/** Normalized covers / questions of the competitor carousels the plan learns from. */
export function competitorLines(examples: PlanExample[] | undefined): string[] {
  const out: string[] = [];
  for (const e of examples ?? []) {
    for (const line of e.slides.split('\n')) {
      const t = normSlide(line.replace(/^\d+\)\s*/, '').replace(/ \/ /g, ' '));
      if (t.split(' ').length >= 4) out.push(t);
    }
  }
  return out;
}

/** A «send this to…» task hook that lost the key words of the winning template. */
function brokenTaskHook(cover: string): string | null {
  if (!/\bsend (this|him|her|it)\b/i.test(cover)) return null;
  const to = /\bsend this to your (boyfriend|girlfriend|partner|bf|gf)\b/i.test(cover);
  const answer = /\b(has|have) to answer one\b/i.test(cover);
  if (to && answer) return null;
  return 'хук-задание без ключевых слов шаблона («Send this to your boyfriend… has to answer one»)';
}

/** Problems a program can see. Empty = passes. */
export function codeIssues(d: Draft, questions: number, used: Set<string>, competitors: string[]): string[] {
  const issues: string[] = [];
  const coverMax = isTaskHook(d.cover) ? COVER_TASK_MAX : COVER_MAX;
  if (words(d.cover) > coverMax) issues.push(`обложка ${words(d.cover)} слов, нужно не больше ${coverMax}`);
  const hook = brokenTaskHook(d.cover);
  if (hook) issues.push(hook);
  if (d.questions.length !== questions) issues.push(`вопросов ${d.questions.length}, нужно ${questions}`);
  d.questions.forEach((q, i) => {
    const n = words(questionPart(q));
    if (n > QUESTION_MAX) issues.push(`вопрос ${i + 1}: ${n} слов, нужно не больше ${QUESTION_MAX}`);
  });
  const seen = new Set<string>();
  for (const [i, text] of [d.cover, ...d.questions].entries()) {
    const t = normSlide(text);
    const what = i === 0 ? 'обложка' : `вопрос ${i}`;
    if (used.has(t) || seen.has(t)) issues.push(`${what} повторяет уже бывший в плане`);
    seen.add(t);
    if (competitors.some((c) => similar(t, c))) issues.push(`${what} почти дословно как у конкурента`);
  }
  return issues;
}

interface ReviewAnswer {
  key: string;
  verdict: 'ok' | 'fixed';
  note?: string;
  cover?: string;
  questions?: string[];
  caption?: string;
}

function parseReview(text: string): ReviewAnswer[] {
  try {
    const a = text.indexOf('{');
    const b = text.lastIndexOf('}');
    const j = JSON.parse(text.slice(a, b + 1)) as { items?: ReviewAnswer[] };
    return (j.items ?? []).filter((x) => x?.key);
  } catch {
    return [];
  }
}

/**
 * Second opinion on new carousels. Returns the drafts (fixed where the reviewer fixed them) and a
 * review per key. Never throws: if the reviewer is unavailable the drafts pass with «не проверено».
 */
export async function reviewItems(
  s: PlanSettings,
  drafts: (Draft & { questionsWanted: number; cta: string; issues: string[] })[]
): Promise<{ drafts: Draft[]; reviews: Map<string, PlanReview> }> {
  const reviews = new Map<string, PlanReview>();
  const key = process.env.OPENAI_API_KEY;
  const skip = (why: string) => {
    for (const d of drafts) reviews.set(d.key, { by: REVIEW_MODEL, verdict: 'skipped', note: why, issues: d.issues });
    return { drafts, reviews };
  };
  if (!key) return skip('не проверено: нет OPENAI_API_KEY');
  if (!drafts.length) return { drafts, reviews };

  const prompt = `You are the editor of an Instagram account that posts carousels with conversation questions for couples (a couples' question-card app; flirty and a bit spicy is the genre, never explicit). A writer drafted the carousels below. Check each one and either approve it or fix it.

What wins at the competitors (the writer's playbook, in Russian):
${(s.playbook || s.brief || '(none)').slice(0, 6000)}

RULES
- a «task» hook keeps the key words of the winning template verbatim: «Send this to your boyfriend» (or girlfriend / partner, never «your man» / «send him this») and «he has to answer one» (or «they have to answer one»); only a short ending may vary («…no excuses», «…honestly»)
- cover (slide 1) = the hook: 5–8 words is best, at most ${COVER_MAX}; a «task» hook like «Send this to your boyfriend, he has to answer one» at most ${COVER_TASK_MAX}. It must make someone stop scrolling, as strong as the playbook's best hooks
- each question: at most ${QUESTION_MAX} words (answer options on their own short lines «A) …» do not count); clear at first read, specific, makes people want to answer or send it to their partner; no dull or generic questions
- exactly the number of questions asked; all different
- language: ${s.language}${s.slang ? `; current American slang used moderately (cover always, about half of the questions, never more than one expression per slide). Dated slang (YOLO, on fleek, bae, swag, lit, savage, fam, no cap, sus, slay, Netflix and chill…) is not allowed; forced slang is worse than none` : '; no slang'}
- no explicit sexual content (Instagram-safe), no emojis on the cover and questions
- caption: 1–2 short lines, no hashtags; if the last slide asks to comment a KEYWORD, the caption repeats the same keyword

Fix only what breaks a rule or is clearly weak; keep the writer's idea and voice. Problems a script already found are listed per carousel — they must be fixed.

CAROUSELS
${drafts
  .map(
    (d) => `key=${d.key} · needs exactly ${d.questionsWanted} questions · last slide (fixed, do not change): «${d.cta}»
cover: ${d.cover}
${d.questions.map((q, i) => `q${i + 1}: ${q.replace(/\n/g, ' / ')}`).join('\n')}
caption: ${d.caption}${d.issues.length ? `\nscript found: ${d.issues.join('; ')}` : ''}`
  )
  .join('\n\n')}

Answer with ONLY this JSON (one entry per key). For «ok» give only key and verdict. For «fixed» give the whole fixed carousel and a short note in Russian about what you changed and why. Inside text values never use the " character — use «» or ' instead; answer options go into the question text separated by \\n.
{"items":[{"key":"...","verdict":"ok"},{"key":"...","verdict":"fixed","note":"...","cover":"...","questions":["..."],"caption":"..."}]}`;

  try {
    usageStep('review');
    let text = '';
    try {
      text = await openai(prompt, REVIEW_MODEL, REVIEW_EFFORT);
    } catch (e) {
      return skip(`не проверено: ${e instanceof Error ? e.message : String(e)}`.slice(0, 160));
    }
    const answers = new Map(parseReview(text).map((a) => [a.key, a]));
    const out: Draft[] = drafts.map((d) => {
      const a = answers.get(d.key);
      if (!a) {
        reviews.set(d.key, { by: REVIEW_MODEL, verdict: 'skipped', note: 'не проверено: проверяющий не ответил', issues: d.issues });
        return d;
      }
      if (a.verdict === 'fixed' && a.cover && Array.isArray(a.questions) && a.questions.length) {
        reviews.set(d.key, { by: REVIEW_MODEL, verdict: 'fixed', note: (a.note ?? '').trim(), issues: d.issues });
        return {
          ...d,
          cover: a.cover.trim(),
          questions: a.questions.map((q) => String(q).trim()).filter(Boolean),
          caption: (a.caption ?? d.caption).trim(),
        };
      }
      reviews.set(d.key, { by: REVIEW_MODEL, verdict: 'ok', issues: d.issues });
      return d;
    });
    return { drafts: out, reviews };
  } catch (e) {
    return skip(`не проверено: ${e instanceof Error ? e.message : String(e)}`.slice(0, 160));
  }
}

// --- copies: proofreading only -------------------------------------------------------------------

export interface CopyDraft {
  key: string;
  slides: string[]; // without our CTA
  caption: string; // the competitor's caption (context for cut words)
  siblings: string[]; // the same hook on their other carousels (context)
}

const wordSet = (t: string) => new Set(normSlide(t).split(' ').filter(Boolean));

/** A proofread slide is accepted only if it is still the same text (most words kept, not much longer). */
function sameText(before: string, after: string): boolean {
  const a = wordSet(before);
  const b = wordSet(after);
  if (!a.size) return false;
  let kept = 0;
  for (const w of a) if (b.has(w)) kept++;
  return kept / a.size >= 0.6 && b.size <= a.size + 6;
}

/** One OpenAI chat call (retries 429 / 5xx); `effort` = reasoning effort, dropped if the model rejects it. */
async function openai(prompt: string, model: string, effort?: string): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('нет OPENAI_API_KEY');
  let useEffort = !!effort;
  let res: Response | null = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        ...(useEffort ? { reasoning_effort: effort } : {}),
      }),
      cache: 'no-store',
    });
    if (res.status === 400 && useEffort) {
      const body = await res.clone().text();
      if (/reasoning/i.test(body)) {
        useEffort = false; // this model takes no reasoning effort — same call without it
        continue;
      }
    }
    if (res.status !== 429 && res.status < 500) break;
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
  if (!res?.ok) throw new Error(`OpenAI HTTP ${res?.status}: ${(await res?.text())?.slice(0, 120)}`);
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
  };
  addOpenAIUsage(model, data.usage);
  return data.choices?.[0]?.message?.content ?? '';
}

/** Proofreads copied carousels. Never throws; every key gets a review (ok / fixed / skipped). */
export async function proofreadCopies(
  copies: CopyDraft[]
): Promise<Map<string, { slides: string[]; review: PlanReview }>> {
  const out = new Map<string, { slides: string[]; review: PlanReview }>();
  const skip = (why: string) => {
    for (const c of copies) out.set(c.key, { slides: c.slides, review: { by: PROOF_MODEL, verdict: 'skipped', note: why, issues: [] } });
    return out;
  };
  if (!copies.length) return out;
  const prompt = `These are slide texts of Instagram carousels, read by OCR from the images of a competitor account (questions for couples). We repost the texts 1:1, so you are a PROOFREADER, not an editor.

Fix ONLY:
- OCR mistakes: garbled or misspelled words («QUESHUR» → «QUESTION»)
- words cut off at the image edge or hidden behind something: complete them only when the caption or the same hook on their other carousels (given below) shows what the full words are
- two sentences glued without punctuation: add the full stop («…YOUR BOYFRIEND THEY HAVE…» → «…YOUR BOYFRIEND. THEY HAVE…»)
NEVER change the wording, order, tone, slang or letter case, never shorten, never improve. If a slide has no such mistakes, leave it exactly as it is. Keep line breaks. Keep the number of slides.

${copies
  .map(
    (c) => `### key=${c.key}
caption of the original post: ${c.caption.replace(/\s+/g, ' ').slice(0, 300) || '—'}
${c.siblings.length ? `the same hook on their other carousels: ${c.siblings.map((x) => `«${x}»`).join(' · ')}\n` : ''}${c.slides.map((t, i) => `slide ${i + 1}: ${t.replace(/\n/g, ' / ')}`).join('\n')}`
  )
  .join('\n\n')}

Answer with ONLY this JSON, one entry per key. «ok» = nothing to fix. For «fixed» give ALL slides (unchanged ones as they were; a line break as « / ») and a short note in Russian listing what you fixed. Inside text values never use the " character.
{"items":[{"key":"...","verdict":"ok"},{"key":"...","verdict":"fixed","note":"...","slides":["...","..."]}]}`;
  let answer = '';
  usageStep('proofread');
  try {
    answer = await openai(prompt, PROOF_MODEL);
  } catch (e) {
    return skip(`не проверено: ${e instanceof Error ? e.message : String(e)}`.slice(0, 160));
  }
  let items: { key?: string; verdict?: string; note?: string; slides?: string[] }[] = [];
  try {
    const a = answer.indexOf('{');
    const b = answer.lastIndexOf('}');
    items = (JSON.parse(answer.slice(a, b + 1)) as { items?: typeof items }).items ?? [];
  } catch {
    return skip('не проверено: ответ не разобран');
  }
  const byKey = new Map(items.filter((x) => x?.key).map((x) => [String(x.key), x]));
  for (const c of copies) {
    const a = byKey.get(c.key);
    if (!a) {
      out.set(c.key, { slides: c.slides, review: { by: PROOF_MODEL, verdict: 'skipped', note: 'не проверено: корректор не ответил', issues: [] } });
      continue;
    }
    if (a.verdict !== 'fixed' || !Array.isArray(a.slides) || a.slides.length !== c.slides.length) {
      out.set(c.key, { slides: c.slides, review: { by: PROOF_MODEL, verdict: 'ok', issues: [] } });
      continue;
    }
    // take a fixed slide only if it is still the same text; line breaks come back as « / »
    let changed = 0;
    const slides = c.slides.map((before, i) => {
      const after = String(a.slides![i] ?? '').replace(/\s+\/\s+/g, '\n').trim();
      if (!after || after === before || !sameText(before, after)) return before;
      changed++;
      return after;
    });
    out.set(c.key, {
      slides,
      review: changed
        ? { by: PROOF_MODEL, verdict: 'fixed', note: (a.note ?? '').trim(), issues: [] }
        : { by: PROOF_MODEL, verdict: 'ok', issues: [] },
    });
  }
  return out;
}
