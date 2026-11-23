// SamSpy — «План»: carousel content plan (server only)
//
//   create:  sources (dossiers) + accounts + days × per day → plan + one empty item per slot.
//            Each slot gets a target rubric × hook, drawn from what wins at the sources
//            (weighted, no rubric twice a day per account, ~20 % exploration), the number of
//            questions (q_min…q_max) and a universal CTA text (rotated).
//   step:    writes the next batch of empty slots (Claude), lock per plan; the open tab keeps
//            calling it until every slot is written.
//   edit / regenerate one carousel, status draft → in_slides → done.
//
// Version history:
//   v0.1.0 (2026-11-22) — initial.
//   v0.2.0 (2026-11-23) — universal CTA texts with a keyword (MORE / LIST / SEND) rotated
//                         across posts; caption checked for the same keyword.

import type { SupabaseClient } from '@supabase/supabase-js';
import { buildBrief, questionsFor, writeItems, type WriteSlot } from './generate';
import { DEFAULT_CTAS, keywordOf, type ContentPlan, type ItemStatus, type PlanCard, type PlanItem, type PlanSettings } from './types';

const BATCH = 8;
const LOCK_MS = 310_000; // > maxDuration of the step route (300 s)
const PLAN_COLS = 'id,title,accounts,days,per_day,start_date,sources,settings,status,error,locked_until,created_at,updated_at';
const ITEM_COLS = 'id,plan_id,account,day,slot,rubric,hook,title,slides,cta_variant,caption,status,created_at,updated_at';

const nowIso = () => new Date().toISOString();
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));


export interface CreatePlanInput {
  title?: string;
  accounts: string[];
  days?: number;
  per_day?: number;
  start_date?: string;
  sources: string[];
  language?: string;
  q_min?: number;
  q_max?: number;
  cta_variants?: string[];
  notes?: string;
}

function pickWeighted<T extends { weight: number }>(list: T[]): T | null {
  const total = list.reduce((a, x) => a + x.weight, 0);
  if (!list.length || total <= 0) return null;
  let r = Math.random() * total;
  for (const x of list) {
    r -= x.weight;
    if (r <= 0) return x;
  }
  return list[list.length - 1];
}

export async function createPlan(sb: SupabaseClient, input: CreatePlanInput): Promise<ContentPlan> {
  const accounts = Array.from(new Set(input.accounts.map((a) => a.trim()).filter(Boolean))).slice(0, 10);
  if (!accounts.length) throw new Error('Укажи хотя бы один аккаунт.');
  const days = Math.max(1, Math.min(60, Math.round(input.days ?? 30)));
  const perDay = Math.max(1, Math.min(6, Math.round(input.per_day ?? 3)));
  const qMin = Math.max(1, Math.min(12, Math.round(input.q_min ?? 4)));
  const qMax = Math.max(qMin, Math.min(12, Math.round(input.q_max ?? 6)));
  const ctas = (input.cta_variants ?? DEFAULT_CTAS).map((c) => c.trim()).filter(Boolean);
  const start = input.start_date && /^\d{4}-\d{2}-\d{2}$/.test(input.start_date)
    ? input.start_date
    : new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

  const { brief, combos } = await buildBrief(sb, input.sources);
  const settings: PlanSettings = {
    language: input.language?.trim() || 'English',
    q_min: qMin,
    q_max: qMax,
    cta_variants: ctas.length ? ctas : DEFAULT_CTAS,
    notes: (input.notes ?? '').trim(),
    brief,
    combos,
  };

  const { data: plan, error } = await sb
    .from('content_plans')
    .insert({
      title: input.title?.trim() || `План с ${start}`,
      accounts,
      days,
      per_day: perDay,
      start_date: start,
      sources: input.sources,
      settings,
      status: 'generating',
    })
    .select(PLAN_COLS)
    .single<ContentPlan>();
  if (error || !plan) throw new Error(error?.message ?? 'Не удалось создать план.');

  // slots: target rubric × hook (no rubric twice a day per account), CTA rotation
  const rows: Partial<PlanItem>[] = [];
  accounts.forEach((account, ai) => {
    for (let day = 1; day <= days; day++) {
      const usedToday = new Set<string>();
      for (let slot = 1; slot <= perDay; slot++) {
        let combo: (typeof combos)[number] | null = null;
        if (combos.length) {
          const fresh = combos.filter((c) => !usedToday.has(c.rubric));
          const pool = fresh.length ? fresh : combos;
          // ~20 % exploration: flat weights instead of the winners' weights
          combo = Math.random() < 0.2 ? pool[Math.floor(Math.random() * pool.length)] : pickWeighted(pool);
          if (combo) usedToday.add(combo.rubric);
        }
        const idx = (day - 1) * perDay + (slot - 1) + ai;
        rows.push({
          plan_id: plan.id,
          account,
          day,
          slot,
          rubric: combo?.rubric ?? null,
          hook: combo?.hook ?? null,
          cta_variant: idx % settings.cta_variants.length,
        });
      }
    }
  });
  for (let i = 0; i < rows.length; i += 500) {
    const { error: e } = await sb.from('content_plan_items').insert(rows.slice(i, i + 500));
    if (e) throw new Error(e.message);
  }
  return plan;
}

async function allItems(sb: SupabaseClient, planId: string): Promise<PlanItem[]> {
  const { data, error } = await sb
    .from('content_plan_items')
    .select(ITEM_COLS)
    .eq('plan_id', planId)
    .order('day')
    .order('slot')
    .order('account')
    .limit(5000)
    .returns<PlanItem[]>();
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** Compact list of what is already written — the writer must not repeat it. */
function usedList(items: PlanItem[], except?: string): string[] {
  return items
    .filter((i) => i.slides.length && i.id !== except)
    .map((i) => `${i.title ?? ''}: ${i.slides.slice(1, -1).join(' | ')}`);
}

function ctaOf(s: PlanSettings, it: Pick<PlanItem, 'cta_variant'>): string {
  const list = s.cta_variants?.length ? s.cta_variants : DEFAULT_CTAS;
  return list[(it.cta_variant ?? 0) % list.length];
}

function slotOf(s: PlanSettings, it: PlanItem): WriteSlot {
  const cta = ctaOf(s, it);
  return {
    key: it.id,
    account: it.account,
    rubric: it.rubric,
    hook: it.hook,
    questions: questionsFor(s, it.day, it.slot, it.account),
    cta,
    word: keywordOf(cta),
  };
}

async function saveWritten(
  sb: SupabaseClient,
  s: PlanSettings,
  items: PlanItem[],
  written: Awaited<ReturnType<typeof writeItems>>
): Promise<number> {
  const byKey = new Map(written.map((w) => [w.key, w]));
  let n = 0;
  for (const it of items) {
    const w = byKey.get(it.id);
    if (!w || !w.questions.length) continue;
    const cta = ctaOf(s, it);
    const word = keywordOf(cta);
    // the caption must ask for the same keyword the automation listens for
    const caption = !word || new RegExp(`\\b${word}\\b`).test(w.caption) ? w.caption : cta;
    await sb
      .from('content_plan_items')
      .update({
        title: w.title,
        slides: [w.cover, ...w.questions, cta],
        caption,
        updated_at: nowIso(),
      })
      .eq('id', it.id);
    n++;
  }
  return n;
}

/** Writes one batch of empty slots. Returns false when another tab holds the lock / nothing to do. */
export async function stepPlan(sb: SupabaseClient, planId: string): Promise<boolean> {
  const { data: cur } = await sb.from('content_plans').select(PLAN_COLS).eq('id', planId).maybeSingle<ContentPlan>();
  if (!cur || cur.status !== 'generating') return false;
  if (cur.locked_until && new Date(cur.locked_until).getTime() > Date.now()) return false;
  let q = sb.from('content_plans').update({ locked_until: new Date(Date.now() + LOCK_MS).toISOString() }).eq('id', planId);
  q = cur.locked_until ? q.eq('locked_until', cur.locked_until) : q.is('locked_until', null);
  const { data: locked } = await q.select(PLAN_COLS).returns<ContentPlan[]>();
  const plan = locked?.[0];
  if (!plan) return false;

  try {
    const items = await allItems(sb, planId);
    const empty = items.filter((i) => !i.slides.length);
    if (!empty.length) {
      await sb.from('content_plans').update({ status: 'done', error: null, updated_at: nowIso() }).eq('id', planId);
      return true;
    }
    const batch = empty.slice(0, BATCH);
    const written = await writeItems(plan.settings, batch.map((i) => slotOf(plan.settings, i)), usedList(items));
    const n = await saveWritten(sb, plan.settings, batch, written);
    if (!n) throw new Error('Модель не вернула ни одной карусели — нажми «Продолжить».');
    if (empty.length <= n) {
      await sb.from('content_plans').update({ status: 'done', error: null, updated_at: nowIso() }).eq('id', planId);
    }
  } catch (e) {
    await sb.from('content_plans').update({ status: 'failed', error: errMsg(e), updated_at: nowIso() }).eq('id', planId);
  } finally {
    await sb.from('content_plans').update({ locked_until: null }).eq('id', planId);
  }
  return true;
}

/** «Продолжить» after a failure: back to generating (written items stay). */
export async function resumePlan(sb: SupabaseClient, planId: string) {
  await sb
    .from('content_plans')
    .update({ status: 'generating', error: null, locked_until: null, updated_at: nowIso() })
    .eq('id', planId);
}

export async function regenerateItem(sb: SupabaseClient, itemId: string): Promise<PlanItem> {
  const { data: it } = await sb.from('content_plan_items').select(ITEM_COLS).eq('id', itemId).maybeSingle<PlanItem>();
  if (!it) throw new Error('Карусель не найдена.');
  const { data: plan } = await sb.from('content_plans').select(PLAN_COLS).eq('id', it.plan_id).maybeSingle<ContentPlan>();
  if (!plan) throw new Error('План не найден.');
  const items = await allItems(sb, plan.id);
  const written = await writeItems(plan.settings, [slotOf(plan.settings, it)], usedList(items, it.id));
  if (!(await saveWritten(sb, plan.settings, [it], written))) throw new Error('Модель не вернула карусель, попробуй ещё раз.');
  await sb.from('content_plan_items').update({ status: 'draft' }).eq('id', it.id);
  const { data: fresh } = await sb.from('content_plan_items').select(ITEM_COLS).eq('id', it.id).single<PlanItem>();
  return fresh!;
}

export async function updateItem(
  sb: SupabaseClient,
  itemId: string,
  patch: { slides?: string[]; caption?: string; status?: ItemStatus; title?: string }
): Promise<PlanItem> {
  const clean: Record<string, unknown> = { updated_at: nowIso() };
  if (Array.isArray(patch.slides)) clean.slides = patch.slides.map((s) => String(s)).filter((s) => s.trim());
  if (typeof patch.caption === 'string') clean.caption = patch.caption;
  if (typeof patch.title === 'string') clean.title = patch.title;
  if (patch.status && ['draft', 'in_slides', 'done'].includes(patch.status)) clean.status = patch.status;
  const { data, error } = await sb.from('content_plan_items').update(clean).eq('id', itemId).select(ITEM_COLS).single<PlanItem>();
  if (error || !data) throw new Error(error?.message ?? 'Не удалось сохранить.');
  return data;
}

export async function listPlans(sb: SupabaseClient): Promise<PlanCard[]> {
  const { data: plans } = await sb
    .from('content_plans')
    .select(PLAN_COLS)
    .order('created_at', { ascending: false })
    .returns<ContentPlan[]>();
  return Promise.all(
    (plans ?? []).map(async (p) => {
      const { data: items } = await sb.from('content_plan_items').select('slides,status').eq('plan_id', p.id).limit(5000);
      const list = (items ?? []) as { slides: string[]; status: string }[];
      return {
        id: p.id,
        title: p.title,
        accounts: p.accounts,
        days: p.days,
        per_day: p.per_day,
        start_date: p.start_date,
        sources: p.sources,
        status: p.status,
        error: p.error,
        total: list.length,
        written: list.filter((i) => i.slides.length).length,
        done: list.filter((i) => i.status === 'done').length,
        created_at: p.created_at,
      };
    })
  );
}

export async function getPlan(sb: SupabaseClient, id: string): Promise<{ plan: ContentPlan; items: PlanItem[] } | null> {
  const { data: plan } = await sb.from('content_plans').select(PLAN_COLS).eq('id', id).maybeSingle<ContentPlan>();
  if (!plan) return null;
  // the brief is big and only needed by the writer
  const settings = { ...plan.settings, brief: '' };
  return { plan: { ...plan, settings }, items: await allItems(sb, id) };
}

export async function deletePlan(sb: SupabaseClient, id: string) {
  await sb.from('content_plans').delete().eq('id', id); // items cascade
}
