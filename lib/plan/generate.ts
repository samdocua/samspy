// SamSpy — «План»: source brief + Claude writer (server only)
//
//   buildBrief()   snapshot of the chosen dossiers: formula, what works, carousel rubrics,
//                  texts of the best carousels — the style the plan copies
//   writeItems()   Claude writes carousels for given slots: cover hook + N questions +
//                  a comment-bait caption, in the plan language; the comment-bait LAST slide
//                  is not written by the model — it is the plan's CTA variant, added in code
//
// Version history:
//   v0.1.0 (2026-11-22) — initial.

import type { SupabaseClient } from '@supabase/supabase-js';
import { ratioOf } from '@/lib/analysis/stats';
import type { AnalysisAccount, AnalysisJob, AnalysisPost } from '@/lib/analysis/types';
import type { PlanSettings } from './types';

export const PLAN_MODEL = process.env.PLAN_MODEL || process.env.ANALYSIS_MODEL || 'claude-sonnet-5-5';

const clip = (s: string | null | undefined, n: number) => {
  const t = (s ?? '').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** Brief of the source dossiers + weighted rubric × hook combos of their winning carousels. */
export async function buildBrief(
  sb: SupabaseClient,
  sources: string[]
): Promise<{ brief: string; combos: PlanSettings['combos'] }> {
  const parts: string[] = [];
  const comboW = new Map<string, number>();

  for (const username of sources) {
    const { data: acc } = await sb.from('analysis_accounts').select('*').eq('username', username).maybeSingle<AnalysisAccount>();
    if (!acc?.last_job_id) continue;
    const { data: job } = await sb
      .from('analysis_jobs')
      .select('id,stats,ai')
      .eq('id', acc.last_job_id)
      .maybeSingle<Pick<AnalysisJob, 'id' | 'stats' | 'ai'>>();
    if (!job?.stats) continue;
    const { data: posts } = await sb
      .from('analysis_posts')
      .select('shortcode,kind,likes,views,caption,ocr_text,title_ru,rubric,hook,slides')
      .eq('job_id', job.id)
      .eq('kind', 'carousel')
      .limit(2000)
      .returns<AnalysisPost[]>();
    const car = (posts ?? [])
      .map((p) => ({ ...p, ratio: ratioOf(p, job.stats!) }))
      .sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0));
    if (!car.length) continue;

    // winning combos: outliers (≥ ×2), or the top 30 if there are few
    const winners = car.filter((p) => (p.ratio ?? 0) >= 2);
    for (const p of (winners.length >= 10 ? winners : car.slice(0, 30)).filter((p) => p.rubric && p.hook)) {
      const k = `${p.rubric}|${p.hook}`;
      comboW.set(k, (comboW.get(k) ?? 0) + Math.min(10, Math.max(1, Math.log2((p.ratio ?? 1) + 1))));
    }

    const a = job.ai;
    const examples = car
      .slice(0, 12)
      .filter((p) => p.ocr_text || p.caption)
      .map(
        (p, i) =>
          `Example ${i + 1} (${p.likes ?? '?'} likes, ×${(p.ratio ?? 0).toFixed(1)}, ${p.slides ?? '?'} slides, ${p.rubric ?? ''} / ${p.hook ?? ''}):\n` +
          `slides: ${clip(p.ocr_text, 900) || '(no slide text)'}\ncaption: ${clip(p.caption, 200)}`
      )
      .join('\n\n');
    parts.push(
      `=== SOURCE @${username} (${acc.followers ?? '?'} followers; carousels: median ${job.stats.carousels.median ?? '?'} likes, median ${job.stats.carousels.median_slides ?? '?'} slides; ${winners.length} carousels ≥ ×2) ===
${a?.one_liner ? `Who: ${a.one_liner}` : ''}
${a?.formula ? `What wins: ${a.formula}` : ''}
${(a?.works ?? []).map((w) => `+ ${w.title}: ${w.text}`).join('\n')}
${(a?.fails ?? []).map((w) => `- ${w.title}: ${w.text}`).join('\n')}

Best carousels (slide texts as on the images):
${examples}`
    );
  }

  const combos = Array.from(comboW.entries())
    .map(([k, weight]) => {
      const [rubric, hook] = k.split('|');
      return { rubric, hook, weight: Math.round(weight * 10) / 10 };
    })
    .sort((x, y) => y.weight - x.weight)
    .slice(0, 20);
  return { brief: parts.join('\n\n'), combos };
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
  cta: string; // last slide text (comment bait) — the caption must fit it
}

export interface Written {
  key: string;
  title: string;
  cover: string;
  questions: string[];
  caption: string;
}

async function claude(prompt: string, maxTokens: number, attempt = 1): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY не задан.');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: PLAN_MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
    cache: 'no-store',
  });
  if ((res.status === 429 || res.status >= 500) && attempt < 3) {
    await new Promise((r) => setTimeout(r, 2000 * attempt));
    return claude(prompt, maxTokens, attempt + 1);
  }
  if (!res.ok) throw new Error(`Claude HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { content?: { type: string; text?: string }[] };
  return (data.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
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

/** Writes carousels for the given slots. `used` = everything already in the plan (to avoid repeats). */
export async function writeItems(
  s: PlanSettings,
  slots: WriteSlot[],
  used: string[]
): Promise<Written[]> {
  const prompt = `You write Instagram carousel posts for my accounts about questions for couples. Each carousel = a cover slide with a hook + one question per slide + a last slide that asks for comments (the last slide is given, do not write it). The background photos already exist; your texts are overlaid on them, so keep every slide SHORT (cover ≤ 14 words, a question ≤ 22 words).

Write in ${s.language}. Natural, casual, like the best examples below — not corporate, no emojis on slides, no numbering inside the questions.

WHAT WORKS AT THE SOURCE ACCOUNTS (study the style, hooks and question types — do not copy questions word for word):
${s.brief || '(no source dossiers)'}
${s.notes ? `\nMY WISHES: ${s.notes}\n` : ''}
ALREADY IN THE PLAN — never repeat these topics or questions, not even reworded:
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
- cover: the hook text of slide 1, in ${s.language} (e.g. «SEND THIS TO YOUR BOYFRIEND — he has to answer one question»; vary the wording between carousels)
- questions: exactly the number asked, each a separate slide, in ${s.language}, all different and fresh
- caption: 1–2 short lines in ${s.language} that bait comments and match the last slide (no hashtags)
Inside text values never use the " character — use «» or ' instead.

Answer with ONLY this JSON:
{"items":[{"key":"...","title":"...","cover":"...","questions":["...","..."],"caption":"..."}]}`;
  const answer = await claude(prompt, Math.min(16000, 700 * slots.length + 800));
  return parseItems(answer);
}
