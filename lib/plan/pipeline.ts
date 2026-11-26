// SamSpy — «План»: carousel content plan (server only)
//
//   create:  sources (dossiers) + accounts + days × per day → plan + one empty item per slot.
//            CTA kinds alternate post by post: 'comment' (keyword) / 'follow' (follow for more),
//            each rotating through its own list.
//            mode 'write': each slot gets a target rubric × hook drawn from what wins at the
//            sources (weighted, no rubric twice a day per account, ~20 % exploration) and the
//            number of questions; Claude writes the carousels.
//            mode 'copy': a pool of the sources' winning carousels (not used in any plan yet);
//            each slot takes the next one and copies its slide texts 1:1.
//   step:    fills the next batch of empty slots, lock per plan; the open tab and the
//            background worker keep calling it until every slot is filled.
//   edit / regenerate (copy: «другой пост») one carousel, status draft → in_slides → done.
//
// Version history:
//   v0.1.0 (2026-11-22) — initial.
//   v0.2.0 (2026-11-23) — universal CTA texts with a keyword (MORE / LIST / SEND) rotated
//                         across posts; caption checked for the same keyword.
//   v0.3.0 (2026-11-26) — mode 'copy' (slide texts 1:1 from winning carousels, source link on
//                         the item, near-duplicates skipped); CTA kinds 'comment' / 'follow'
//                         alternate post by post.

import type { SupabaseClient } from '@supabase/supabase-js';
import { buildPool, normSlide, textsOf } from './copy';
import { buildBrief, questionsFor, writeItems, type WriteSlot } from './generate';
import {
  CAPTION_BAITS,
  ctaTextOf,
  DEFAULT_CTAS,
  DEFAULT_FOLLOW_CTAS,
  keywordOf,
  type ContentPlan,
  type CopySource,
  type CtaKind,
  type ItemStatus,
  type PlanCard,
  type PlanItem,
  type PlanMode,
  type PlanSettings,
} from './types';

const BATCH = 8; // mode 'write': carousels per Claude call
const COPY_BATCH = 6; // mode 'copy': carousels per step (OCR of a carousel takes ~10–20 s)
const COPY_CONCURRENCY = 3;
const COPY_TRIES = 6; // pool entries tried for one slot (unreadable / near-duplicate ones skipped)
const COPY_BUDGET_MS = 200_000; // no new carousel is started after this (route max 300 s)
const DUP_SHARE = 0.5; // a carousel whose slides are ≥ 50 % already in the plan is a near-duplicate
const LOCK_MS = 310_000; // > maxDuration of the step route (300 s)
const PLAN_COLS = 'id,title,accounts,days,per_day,start_date,sources,settings,status,error,locked_until,created_at,updated_at';
const ITEM_COLS =
  'id,plan_id,account,day,slot,rubric,hook,title,slides,cta_kind,cta_variant,caption,source_username,source_shortcode,source_url,status,created_at,updated_at';

const nowIso = () => new Date().toISOString();
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const modeOf = (s: PlanSettings): PlanMode => s.mode ?? 'write';

export interface CreatePlanInput {
  title?: string;
  mode?: PlanMode;
  accounts: string[];
  days?: number;
  per_day?: number;
  start_date?: string;
  sources: string[];
  language?: string;
  q_min?: number;
  q_max?: number;
  cta_variants?: string[];
  follow_variants?: string[];
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

const cleanList = (l: string[] | undefined, fallback: string[]) => {
  const out = (l ?? []).map((c) => c.trim()).filter(Boolean);
  return out.length ? out : fallback;
};

export async function createPlan(sb: SupabaseClient, input: CreatePlanInput): Promise<ContentPlan> {
  const accounts = Array.from(new Set(input.accounts.map((a) => a.trim()).filter(Boolean))).slice(0, 10);
  if (!accounts.length) throw new Error('Укажи хотя бы один аккаунт.');
  if (!input.sources?.length) throw new Error('Выбери хотя бы одно досье.');
  const mode: PlanMode = input.mode === 'copy' ? 'copy' : 'write';
  const days = Math.max(1, Math.min(60, Math.round(input.days ?? 30)));
  const perDay = Math.max(1, Math.min(6, Math.round(input.per_day ?? 3)));
  const qMin = Math.max(1, Math.min(12, Math.round(input.q_min ?? 4)));
  const qMax = Math.max(qMin, Math.min(12, Math.round(input.q_max ?? 6)));
  const start =
    input.start_date && /^\d{4}-\d{2}-\d{2}$/.test(input.start_date)
      ? input.start_date
      : new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const slots = accounts.length * days * perDay;

  let brief = '';
  let combos: PlanSettings['combos'] = [];
  let pool: CopySource[] = [];
  if (mode === 'copy') {
    pool = await buildPool(sb, input.sources, slots);
    if (!pool.length) throw new Error('У выбранных досье нет каруселей, которые ещё не взяты в планы.');
    // spare for unreadable / near-duplicate carousels
    pool = pool.slice(0, Math.max(slots * 2, slots + 60));
  } else {
    ({ brief, combos } = await buildBrief(sb, input.sources));
  }

  const settings: PlanSettings = {
    mode,
    language: input.language?.trim() || 'English',
    q_min: qMin,
    q_max: qMax,
    cta_variants: cleanList(input.cta_variants, DEFAULT_CTAS),
    follow_variants: cleanList(input.follow_variants, DEFAULT_FOLLOW_CTAS),
    notes: (input.notes ?? '').trim(),
    brief,
    combos,
    copy_pool: mode === 'copy' ? pool : undefined,
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

  // slots: CTA kind alternates post by post (accounts start on different kinds);
  // mode 'write' also gets a target rubric × hook (no rubric twice a day per account)
  const rows: Partial<PlanItem>[] = [];
  accounts.forEach((account, ai) => {
    for (let day = 1; day <= days; day++) {
      const usedToday = new Set<string>();
      for (let slot = 1; slot <= perDay; slot++) {
        let combo: (typeof combos)[number] | null = null;
        if (mode === 'write' && combos.length) {
          const fresh = combos.filter((c) => !usedToday.has(c.rubric));
          const pool2 = fresh.length ? fresh : combos;
          // ~20 % exploration: flat weights instead of the winners' weights
          combo = Math.random() < 0.2 ? pool2[Math.floor(Math.random() * pool2.length)] : pickWeighted(pool2);
          if (combo) usedToday.add(combo.rubric);
        }
        const k = (day - 1) * perDay + (slot - 1);
        const kind: CtaKind = (k + ai) % 2 === 0 ? 'comment' : 'follow';
        rows.push({
          plan_id: plan.id,
          account,
          day,
          slot,
          rubric: combo?.rubric ?? null,
          hook: combo?.hook ?? null,
          cta_kind: kind,
          cta_variant: Math.floor(k / 2) + ai,
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

/** Caption of a copied carousel: comment posts repeat the CTA (keyword), follow posts invite a comment. */
function copyCaption(it: Pick<PlanItem, 'cta_kind' | 'cta_variant'>, cta: string): string {
  if (it.cta_kind === 'follow') return CAPTION_BAITS[(it.cta_variant ?? 0) % CAPTION_BAITS.length];
  return cta;
}

function slotOf(s: PlanSettings, it: PlanItem): WriteSlot {
  const cta = ctaTextOf(s, it);
  return {
    key: it.id,
    account: it.account,
    rubric: it.rubric,
    hook: it.hook,
    questions: questionsFor(s, it.day, it.slot, it.account),
    cta,
    word: it.cta_kind === 'follow' ? null : keywordOf(cta),
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
    const cta = ctaTextOf(s, it);
    const word = it.cta_kind === 'follow' ? null : keywordOf(cta);
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

// --- mode 'copy' -----------------------------------------------------------------------------------

/** Normalized slide texts already in the plan — to skip near-duplicate carousels. */
function seenSlides(items: PlanItem[], except?: string): Set<string> {
  const seen = new Set<string>();
  for (const i of items) if (i.id !== except) for (const s of i.slides.slice(1, -1)) seen.add(normSlide(s));
  return seen;
}

/**
 * Fills one slot from the pool: next carousel that can be read and is not a near-duplicate.
 * Mutates `pool` (taken entries leave it) and `seen`. False when the pool ran out.
 */
async function fillFromPool(
  sb: SupabaseClient,
  s: PlanSettings,
  it: PlanItem,
  pool: CopySource[],
  seen: Set<string>,
  deadline = Date.now() + COPY_BUDGET_MS
): Promise<boolean> {
  for (let t = 0; t < COPY_TRIES && Date.now() < deadline; t++) {
    const src = pool.shift();
    if (!src) return false;
    const got = await textsOf(sb, src).catch(() => null);
    if (!got || got.slides.length < 2) continue;
    const body = got.slides.slice(1).map(normSlide);
    const dup = body.filter((x) => seen.has(x)).length;
    if (body.length && dup / body.length >= DUP_SHARE) continue;
    for (const x of body) seen.add(x);
    const cta = ctaTextOf(s, it);
    const cover = got.slides[0];
    await sb
      .from('content_plan_items')
      .update({
        title: got.title || cover.split('\n')[0].slice(0, 80),
        slides: [...got.slides, cta],
        caption: copyCaption(it, cta),
        source_username: src.username,
        source_shortcode: src.shortcode,
        source_url: src.url,
        updated_at: nowIso(),
      })
      .eq('id', it.id);
    Object.assign(it, { source_shortcode: src.shortcode, slides: [...got.slides, cta] });
    return true;
  }
  return true; // tried enough for this slot this time; it stays empty and comes back next step
}

async function stepCopy(sb: SupabaseClient, plan: ContentPlan, items: PlanItem[]): Promise<void> {
  const s = plan.settings;
  const pool = [...(s.copy_pool ?? [])];
  const seen = seenSlides(items);
  const empty = items.filter((i) => !i.slides.length).slice(0, COPY_BATCH);
  const deadline = Date.now() + COPY_BUDGET_MS;
  let ranOut = false;
  let next = 0;
  const worker = async () => {
    while (next < empty.length && !ranOut && Date.now() < deadline) {
      const it = empty[next++];
      if (!(await fillFromPool(sb, s, it, pool, seen, deadline))) ranOut = true;
    }
  };
  await Promise.all(Array.from({ length: COPY_CONCURRENCY }, worker));
  await sb
    .from('content_plans')
    .update({ settings: { ...s, copy_pool: pool }, updated_at: nowIso() })
    .eq('id', plan.id);
  if (ranOut) throw new Error('Залетевшие карусели выбранных досье закончились — добавь досье и нажми «Продолжить».');
}

// --- step / edit ----------------------------------------------------------------------------------

/** Fills one batch of empty slots. Returns false when another caller holds the lock / nothing to do. */
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
    if (modeOf(plan.settings) === 'copy') {
      await stepCopy(sb, plan, items);
      if (!items.some((i) => !i.slides.length)) {
        await sb.from('content_plans').update({ status: 'done', error: null, updated_at: nowIso() }).eq('id', planId);
      }
    } else {
      const batch = empty.slice(0, BATCH);
      const written = await writeItems(plan.settings, batch.map((i) => slotOf(plan.settings, i)), usedList(items));
      const n = await saveWritten(sb, plan.settings, batch, written);
      if (!n) throw new Error('Модель не вернула ни одной карусели — нажми «Продолжить».');
      if (empty.length <= n) {
        await sb.from('content_plans').update({ status: 'done', error: null, updated_at: nowIso() }).eq('id', planId);
      }
    }
  } catch (e) {
    await sb.from('content_plans').update({ status: 'failed', error: errMsg(e), updated_at: nowIso() }).eq('id', planId);
  } finally {
    await sb.from('content_plans').update({ locked_until: null }).eq('id', planId);
  }
  return true;
}

/** «Продолжить» after a failure: back to generating (filled items stay). Copy plans top up their pool. */
export async function resumePlan(sb: SupabaseClient, planId: string) {
  const { data: plan } = await sb.from('content_plans').select(PLAN_COLS).eq('id', planId).maybeSingle<ContentPlan>();
  const patch: Record<string, unknown> = { status: 'generating', error: null, locked_until: null, updated_at: nowIso() };
  if (plan && modeOf(plan.settings) === 'copy' && !(plan.settings.copy_pool ?? []).length) {
    const left = (await allItems(sb, planId)).filter((i) => !i.slides.length).length;
    patch.settings = { ...plan.settings, copy_pool: await buildPool(sb, plan.sources, left + 30) };
  }
  await sb.from('content_plans').update(patch).eq('id', planId);
}

/** Write mode: Claude rewrites the carousel. Copy mode: the next carousel from the pool. */
export async function regenerateItem(sb: SupabaseClient, itemId: string): Promise<PlanItem> {
  const { data: it } = await sb.from('content_plan_items').select(ITEM_COLS).eq('id', itemId).maybeSingle<PlanItem>();
  if (!it) throw new Error('Карусель не найдена.');
  const { data: plan } = await sb.from('content_plans').select(PLAN_COLS).eq('id', it.plan_id).maybeSingle<ContentPlan>();
  if (!plan) throw new Error('План не найден.');
  const items = await allItems(sb, plan.id);

  if (modeOf(plan.settings) === 'copy') {
    let pool = [...(plan.settings.copy_pool ?? [])];
    if (!pool.length) pool = await buildPool(sb, plan.sources, 30);
    const seen = seenSlides(items, it.id);
    const before = it.source_shortcode;
    const ok = await fillFromPool(sb, plan.settings, it, pool, seen);
    await sb
      .from('content_plans')
      .update({ settings: { ...plan.settings, copy_pool: pool } })
      .eq('id', plan.id);
    if (!ok || it.source_shortcode === before) throw new Error('Не нашлось другой залетевшей карусели — добавь досье.');
  } else {
    const written = await writeItems(plan.settings, [slotOf(plan.settings, it)], usedList(items, it.id));
    if (!(await saveWritten(sb, plan.settings, [it], written))) throw new Error('Модель не вернула карусель, попробуй ещё раз.');
  }
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
    .select('id,title,accounts,days,per_day,start_date,sources,mode:settings->>mode,status,error,created_at')
    .order('created_at', { ascending: false })
    .returns<(Omit<PlanCard, 'total' | 'written' | 'done' | 'mode'> & { mode: string | null })[]>();
  return Promise.all(
    (plans ?? []).map(async (p) => {
      const { data: items } = await sb.from('content_plan_items').select('slides,status').eq('plan_id', p.id).limit(5000);
      const list = (items ?? []) as { slides: string[]; status: string }[];
      return {
        ...p,
        mode: (p.mode === 'copy' ? 'copy' : 'write') as PlanMode,
        total: list.length,
        written: list.filter((i) => i.slides.length).length,
        done: list.filter((i) => i.status === 'done').length,
      };
    })
  );
}

export async function getPlan(sb: SupabaseClient, id: string): Promise<{ plan: ContentPlan; items: PlanItem[] } | null> {
  const { data: plan } = await sb.from('content_plans').select(PLAN_COLS).eq('id', id).maybeSingle<ContentPlan>();
  if (!plan) return null;
  // the brief and the pool are big and only needed on the server
  const settings = { ...plan.settings, brief: '', copy_pool: undefined };
  return { plan: { ...plan, settings }, items: await allItems(sb, id) };
}

export async function deletePlan(sb: SupabaseClient, id: string) {
  await sb.from('content_plans').delete().eq('id', id); // items cascade
}
