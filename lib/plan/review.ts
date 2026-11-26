// SamSpy — «План»: checks of the new carousels Claude wrote (server only)
//
//   codeIssues()   rules a program can check: cover / question length, number of questions,
//                  repeats inside the plan, near-copies of competitor covers / questions
//   reviewItems()  a second model (GPT, not Claude — other blind spots) reads each new carousel with
//                  the playbook and either approves it or returns a fixed version + a note in Russian
//
// Limits (from the 199 strongest carousels of @21questions.couples): cover 5–8 words, at most 10;
// a «task» hook («Send this to your boyfriend, they have to answer one…») at most 12; a question
// at most 16 words, answer options on their own short lines do not count.
//
// Version history:
//   v0.1.0 (2026-11-26) — initial.

import { normSlide } from './copy';
import type { PlanExample, PlanReview, PlanSettings } from './types';

export const REVIEW_MODEL = process.env.PLAN_REVIEW_MODEL || 'gpt-6.2-astra';

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

/** Problems a program can see. Empty = passes. */
export function codeIssues(d: Draft, questions: number, used: Set<string>, competitors: string[]): string[] {
  const issues: string[] = [];
  const coverMax = isTaskHook(d.cover) ? COVER_TASK_MAX : COVER_MAX;
  if (words(d.cover) > coverMax) issues.push(`обложка ${words(d.cover)} слов, нужно не больше ${coverMax}`);
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
    let res: Response | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: REVIEW_MODEL, messages: [{ role: 'user', content: prompt }] }),
        cache: 'no-store',
      });
      if (res.status !== 429 && res.status < 500) break;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
    if (!res?.ok) return skip(`не проверено: OpenAI HTTP ${res?.status}: ${(await res?.text())?.slice(0, 120)}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const answers = new Map(parseReview(data.choices?.[0]?.message?.content ?? '').map((a) => [a.key, a]));
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
