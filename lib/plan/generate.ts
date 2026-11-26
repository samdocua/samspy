// SamSpy — «План»: what Claude learns from + the writer (server only)
//
//   buildCombos()    rubric × hook combos of the sources' strongest carousels (strength =
//                    likes / median of ±15 days, lib/analysis/winners.ts), weighted — each new
//                    post gets one as its target angle
//   loadExamples()   up to 200 strongest carousels per source whose slides are read in full
//                    («Распознать слайды»): slide texts (brand / promo lines removed), caption,
//                    strength
//   buildPlaybook()  one Claude pass over all examples → the plan's playbook: hook types that win
//                    (with real examples), question types, structure, what sets winners apart
//   writeItems()     Claude writes new carousels for given slots: playbook (cached prompt part)
//                    + ~30 examples (the 10 strongest + 20 rotating per batch, so batches differ)
//                    + everything already in the plan (no repeats) + the slots
//   buildBrief()     older dossier snapshot (12 best carousels) — fallback when too few carousels
//                    have their slides read
//
// Version history:
//   v0.1.0 (2026-11-22) — initial.
//   v0.2.0 (2026-11-23) — CTA = universal text with a keyword (not written per post); the
//                         caption must repeat the same keyword.
//   v0.3.0 (2026-11-26) — «follow» last slides: the caption invites a comment, no keyword.
//   v0.4.0 (2026-11-26) — learning from up to 200 strongest carousels per source: playbook +
//                         rotating examples (prompt caching on the shared part); combos from
//                         strength «относительно своего времени».
//   v0.5.0 (2026-11-26) — settings.slang: current American slang, moderately (only here — copies
//                         never pass through the writer).

import type { SupabaseClient } from '@supabase/supabase-js';
import type { AnalysisAccount, AnalysisJob, AnalysisPost } from '@/lib/analysis/types';
import { rankCarousels, topWinners } from '@/lib/analysis/winners';
import { joinSoftBreaks } from '@/lib/carousels/postprocess';
import { slidesFromOcr } from './copy';
import type { PlanExample, PlanSettings } from './types';

export const PLAN_MODEL = process.env.PLAN_MODEL || process.env.ANALYSIS_MODEL || 'claude-sonnet-5-5';

export const MIN_EXAMPLES = 15; // fewer read carousels → the older 12-example brief
const EXAMPLES_PER_SOURCE = 200;
const EXAMPLE_CHARS = 900;
const EXAMPLES_PER_BATCH = 30; // 10 strongest + 20 rotating

const clip = (s: string | null | undefined, n: number) => {
  const t = (s ?? '').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
const fmtX = (x: number) => (x < 10 ? x.toFixed(1) : String(Math.round(x)));

async function lastJob(sb: SupabaseClient, username: string) {
  const { data: acc } = await sb
    .from('analysis_accounts')
    .select('last_job_id')
    .eq('username', username)
    .maybeSingle<Pick<AnalysisAccount, 'last_job_id'>>();
  if (!acc?.last_job_id) return null;
  const { data: job } = await sb
    .from('analysis_jobs')
    .select('id,stats,ai,period_from')
    .eq('id', acc.last_job_id)
    .maybeSingle<Pick<AnalysisJob, 'id' | 'stats' | 'ai' | 'period_from'>>();
  return job?.stats ? job : null;
}

async function postsByIds<T>(sb: SupabaseClient, ids: string[], cols: string): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await sb.from('analysis_posts').select(cols).in('id', ids.slice(i, i + 200)).returns<T[]>();
    out.push(...(data ?? []));
  }
  return out;
}

/** Rubric × hook combos of the strongest carousels of the sources, weighted by strength. */
export async function buildCombos(sb: SupabaseClient, sources: string[]): Promise<PlanSettings['combos']> {
  const comboW = new Map<string, number>();
  for (const username of sources) {
    const job = await lastJob(sb, username);
    if (!job) continue;
    const ranked = await rankCarousels(sb, job.id, job.period_from);
    const winners = ranked.filter((w) => w.strength >= 2);
    const pick = (winners.length >= 10 ? winners : ranked.slice(0, 30)).slice(0, 400);
    const tags = await postsByIds<{ id: string; rubric: string | null; hook: string | null }>(
      sb,
      pick.map((w) => w.id),
      'id,rubric,hook'
    );
    const byId = new Map(tags.map((t) => [t.id, t]));
    for (const w of pick) {
      const t = byId.get(w.id);
      if (!t?.rubric || !t.hook) continue;
      const k = `${t.rubric}|${t.hook}`;
      comboW.set(k, (comboW.get(k) ?? 0) + Math.min(10, Math.max(1, Math.log2(w.strength + 1))));
    }
  }
  return Array.from(comboW.entries())
    .map(([k, weight]) => {
      const [rubric, hook] = k.split('|');
      return { rubric, hook, weight: Math.round(weight * 10) / 10 };
    })
    .sort((x, y) => y.weight - x.weight)
    .slice(0, 20);
}

/** Up to 200 strongest carousels per source with their slides read in full, strongest first. */
export async function loadExamples(
  sb: SupabaseClient,
  sources: string[]
): Promise<{ examples: PlanExample[]; perSource: Record<string, number> }> {
  const examples: PlanExample[] = [];
  const perSource: Record<string, number> = {};
  for (const username of sources) {
    const job = await lastJob(sb, username);
    if (!job) continue;
    const top = await topWinners(sb, job.id, job.period_from, EXAMPLES_PER_SOURCE);
    const rows = await postsByIds<Pick<AnalysisPost, 'id' | 'ocr_text' | 'caption' | 'rubric' | 'hook'>>(
      sb,
      top.map((w) => w.id),
      'id,ocr_text,caption,rubric,hook'
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    let n = 0;
    for (const w of top) {
      const r = byId.get(w.id);
      const marks = (r?.ocr_text?.match(/^\s*-{2,}\s*\d+\s*-{2,}\s*$/gm) ?? []).length;
      if (!r?.ocr_text || marks < 2) continue; // only the cover read — not enough to learn from
      const slides = slidesFromOcr(r.ocr_text).map(joinSoftBreaks);
      if (slides.length < 2) continue;
      examples.push({
        src: username,
        strength: w.strength,
        likes: w.likes,
        rubric: r.rubric,
        hook: r.hook,
        slides: clip(slides.map((s, i) => `${i + 1}) ${s.replace(/\n/g, ' / ')}`).join('\n'), EXAMPLE_CHARS),
        caption: clip(r.caption, 160),
      });
      n++;
    }
    perSource[username] = n;
  }
  examples.sort((a, b) => b.strength - a.strength);
  return { examples, perSource };
}

const exampleText = (e: PlanExample, i: number) =>
  `#${i + 1} @${e.src} · ×${fmtX(e.strength)} to its time · ${e.likes} likes${e.hook ? ` · hook: ${e.hook}` : ''}${e.rubric ? ` · ${e.rubric}` : ''}\n${e.slides}${e.caption ? `\ncaption: ${e.caption}` : ''}`;

async function claude(content: { text: string; cache?: boolean }[], maxTokens: number, attempt = 1): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY не задан.');
  const wellFormed = (t: string) =>
    t.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: PLAN_MODEL,
      max_tokens: maxTokens,
      messages: [
        {
          role: 'user',
          content: content.map((c) => ({
            type: 'text',
            text: wellFormed(c.text),
            ...(c.cache ? { cache_control: { type: 'ephemeral' } } : {}),
          })),
        },
      ],
    }),
    cache: 'no-store',
  });
  if ((res.status === 429 || res.status >= 500) && attempt < 3) {
    await new Promise((r) => setTimeout(r, 2000 * attempt));
    return claude(content, maxTokens, attempt + 1);
  }
  if (!res.ok) throw new Error(`Claude HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { content?: { type: string; text?: string }[] };
  return (data.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
}

/** One pass over all examples → the playbook (Russian explanations, original-language examples). */
export async function buildPlaybook(examples: PlanExample[], language: string): Promise<string> {
  const answer = await claude(
    [
      {
        text: `Below are Instagram carousels of competitor accounts about questions for couples — their strongest posts of the year, strongest first. «×N to its time» = the post's likes divided by the median likes of the same account's carousels within ±15 days: how much it beat the ordinary posts of its time. Slides are numbered; slide 1 is the cover.

Study them to write a PLAYBOOK for creating new carousels that win the same way. Write it in Russian, quote examples in the original language (${language}) exactly. Sections:
1. Хуки обложек — the types of cover hooks that win, from the strongest; for each: how it works, why it hooks, 3–5 real covers from the list with their ×.
2. Вопросы — the kinds of questions in the winners (provocative, «would you…», with answer options A/B/C/D, about the partner, about the past, etc.): what makes a question catchy, typical length and tone, 5–8 real examples.
3. Структура — number of slides, how the carousel builds up, what the last slides do.
4. Что отличает самые сильные (×5 и выше) от остальных из списка — concrete, with examples.
5. Чего избегать — patterns that appear only in the weaker ones.
Be concrete and short; no general advice.

CAROUSELS:
${examples.map(exampleText).join('\n\n')}`,
      },
    ],
    6000
  );
  return answer.trim();
}

/** Older snapshot of the source dossiers (12 best carousels each) — used when few slides are read. */
export async function buildBrief(sb: SupabaseClient, sources: string[]): Promise<string> {
  const parts: string[] = [];
  for (const username of sources) {
    const { data: acc } = await sb.from('analysis_accounts').select('*').eq('username', username).maybeSingle<AnalysisAccount>();
    const job = await lastJob(sb, username);
    if (!acc || !job) continue;
    const ranked = (await rankCarousels(sb, job.id, job.period_from)).slice(0, 30);
    const rows = await postsByIds<Pick<AnalysisPost, 'id' | 'kind' | 'likes' | 'views' | 'caption' | 'ocr_text' | 'rubric' | 'hook' | 'slides'>>(
      sb,
      ranked.map((w) => w.id),
      'id,kind,likes,views,caption,ocr_text,rubric,hook,slides'
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    const a = job.ai;
    const examples = ranked
      .map((w) => ({ w, p: byId.get(w.id) }))
      .filter(({ p }) => p && (p.ocr_text || p.caption))
      .slice(0, 12)
      .map(
        ({ w, p }, i) =>
          `Example ${i + 1} (${p!.likes ?? '?'} likes, ×${fmtX(w.strength)} to its time, ${p!.slides ?? '?'} slides, ${p!.rubric ?? ''} / ${p!.hook ?? ''}):\n` +
          `slides: ${clip(p!.ocr_text, 900) || '(no slide text)'}\ncaption: ${clip(p!.caption, 200)}`
      )
      .join('\n\n');
    parts.push(
      `=== SOURCE @${username} (${acc.followers ?? '?'} followers; carousels: median ${job.stats!.carousels.median ?? '?'} likes, median ${job.stats!.carousels.median_slides ?? '?'} slides) ===
${a?.one_liner ? `Who: ${a.one_liner}` : ''}
${a?.formula ? `What wins: ${a.formula}` : ''}
${(a?.works ?? []).map((x) => `+ ${x.title}: ${x.text}`).join('\n')}
${(a?.fails ?? []).map((x) => `- ${x.title}: ${x.text}`).join('\n')}

Best carousels (slide texts as on the images):
${examples}`
    );
  }
  return parts.join('\n\n');
}

/** How many questions a slot gets — spread between q_min and q_max, stable per slot. */
export function questionsFor(s: PlanSettings, day: number, slot: number, account: string): number {
  const span = Math.max(0, s.q_max - s.q_min);
  if (!span) return s.q_min;
  const h = Array.from(`${account}-${day}-${slot}`).reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  return s.q_min + (h % (span + 1));
}

export interface WriteSlot {
  key: string; // item id
  account: string;
  rubric: string | null;
  hook: string | null;
  questions: number;
  cta: string; // last slide (given) — the caption repeats its keyword
  word: string | null; // keyword of the CTA
}

export interface Written {
  key: string;
  title: string;
  cover: string;
  questions: string[];
  caption: string;
}

function parseItems(answer: string): Written[] {
  const out: Written[] = [];
  const take = (it: Partial<Written>) => {
    if (it?.key && it.cover && Array.isArray(it.questions)) {
      out.push({
        key: String(it.key),
        title: clip(String(it.title ?? ''), 80),
        cover: String(it.cover).trim(),
        questions: it.questions.map((q) => String(q).trim()).filter(Boolean),
        caption: String(it.caption ?? '').trim(),
      });
    }
  };
  try {
    const a = answer.indexOf('{');
    const b = answer.lastIndexOf('}');
    const j = JSON.parse(answer.slice(a, b + 1)) as { items?: Partial<Written>[] };
    for (const it of j.items ?? []) take(it);
    if (out.length) return out;
  } catch {
    /* salvage below: objects with a "questions" array (no nested braces) */
  }
  for (const m of answer.matchAll(/\{[^{}]*"key"\s*:\s*"[^"]+"[^{}]*\}/g)) {
    try {
      take(JSON.parse(m[0]));
    } catch {
      /* skip */
    }
  }
  return out;
}

const SLANG_RULES = `SLANG — write like a real American in their 20s posts on TikTok / Instagram today (2025–2026), using CURRENT American slang:
- moderately: the cover always has a slang word or phrase; roughly half of the questions have one; the rest are plain casual English. Never more than one slang expression per slide; never forced — if it sounds cringe, leave it out
- only slang that is current right now, e.g. lowkey / highkey, the ick, situationship, red / green / beige flag, delulu, rizz, ngl, it's giving…, main character energy, soft launch / hard launch, your Roman Empire, the bare minimum, love bombing, breadcrumbing, yapping, the way…, be so for real, touch grass, aura, gatekeeping, core memory, unhinged, toxic trait, pick me, it's the … for me. Do not reuse the same expression in two carousels
- NEVER dated slang: YOLO, on fleek, bae, swag, lit, savage, squad goals, fam, Netflix and chill, I can't even, totes, adulting, turnt, basic, no cap, sus, slay
- every question must still be perfectly clear to any reader; the caption may use slang too; the given last slide stays exactly as given`;

/** Examples for one batch: the 10 strongest + 20 rotating through the rest. */
function examplesFor(all: PlanExample[], batch: number): PlanExample[] {
  if (all.length <= EXAMPLES_PER_BATCH) return all;
  const head = all.slice(0, 10);
  const rest = all.slice(10);
  const n = EXAMPLES_PER_BATCH - head.length;
  const start = (batch * n) % rest.length;
  const pick = [...rest.slice(start, start + n), ...rest.slice(0, Math.max(0, start + n - rest.length))];
  return [...head, ...pick];
}

/** Writes carousels for the given slots. `used` = everything already in the plan (to avoid repeats). */
export async function writeItems(
  s: PlanSettings,
  slots: WriteSlot[],
  used: string[],
  batch = 0
): Promise<Written[]> {
  const learned = s.playbook
    ? `PLAYBOOK — what wins at the competitor accounts (learned from their strongest carousels):
${s.playbook}`
    : `WHAT WORKS AT THE SOURCE ACCOUNTS:
${s.brief || '(no source dossiers)'}`;

  // shared part of every batch first (cached by the API), then what changes per batch
  const shared = `You write Instagram carousel posts for my accounts about questions for couples. Each carousel = a cover slide with a hook + one question per slide + a last slide that asks for a comment or a follow (the last slide is given, do not write it). The background photos already exist; your texts are overlaid on them, so keep every slide SHORT (cover ≤ 14 words, a question ≤ 22 words; answer options, if you use them, on separate lines like «A) …»).

Write in ${s.language}. Make the hooks and questions as catchy as the strongest examples: same kinds of hooks, same kinds of questions, same tone — but your own words; never copy a cover or a question, not even reworded closely. No emojis on the cover and questions, no numbering inside the questions.

${learned}
${s.slang ? `\n${SLANG_RULES}\n` : ''}${s.notes ? `\nMY WISHES: ${s.notes}\n` : ''}`;

  const ex = examplesFor(s.examples ?? [], batch);
  const perBatch = `${ex.length ? `STRONGEST CAROUSELS TO LEARN FROM (×N = how much it beat the account's ordinary posts of its time):\n${ex.map(exampleText).join('\n\n')}\n\n` : ''}ALREADY IN THE PLAN — never repeat these topics or questions, not even reworded:
${used.length ? used.map((u) => `- ${u}`).join('\n') : '(nothing yet)'}

WRITE THESE CAROUSELS (one per line; rubric / hook are the target angle — make it fit them):
${slots
  .map(
    (x) =>
      `key=${x.key} · account ${x.account} · rubric: ${x.rubric ?? 'any'} · hook: ${x.hook ?? 'any'} · exactly ${x.questions} questions · last slide (given): «${x.cta}»`
  )
  .join('\n')}

For every carousel:
- title: the topic in 3–8 words (for my calendar), in Russian
- cover: the hook text of slide 1, in ${s.language}; vary the wording between carousels
- questions: exactly the number asked, each a separate slide, in ${s.language}, all different and fresh
- caption: 1–2 short lines in ${s.language}, no hashtags, universal (do not address him / her; no «part 2»). If the last slide asks to comment a KEYWORD in capitals, repeat that request with the SAME keyword. If the last slide asks to follow / send / save, invite a comment instead (e.g. which question they would answer first) — no keyword
Inside text values never use the " character — use «» or ' instead.

Answer with ONLY this JSON:
{"items":[{"key":"...","title":"...","cover":"...","questions":["...","..."],"caption":"..."}]}`;

  const answer = await claude(
    [
      { text: shared, cache: true },
      { text: perBatch },
    ],
    Math.min(16000, 700 * slots.length + 800)
  );
  return parseItems(answer);
}
