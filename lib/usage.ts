// SamSpy — what the paid APIs cost (server only)
//
//   withUsage(ref, fn)  runs a dossier / plan step with a usage collector; every Claude / OpenAI /
//                       ScrapeCreators call inside it adds its tokens / credits, and at the end the
//                       totals go to table ai_usage in one insert (grouped by step + model)
//   addUsage()          called by the API wrappers (no-op outside withUsage)
//   usageOf(refId)      totals of one dossier job / plan for the UI: $ by provider and by step
//
// Prices are list prices per 1M tokens (USD, Nov 2026); thinking / reasoning is billed as output.
// ScrapeCreators: $47 for 25 000 credits, 1 credit per call.
//
// Version history:
//   v0.1.0 (2026-11-27) — initial.

import { AsyncLocalStorage } from 'node:async_hooks';
import type { SupabaseClient } from '@supabase/supabase-js';

export type UsageKind = 'analysis' | 'plan';

interface Row {
  step: string;
  provider: 'anthropic' | 'openai' | 'scrapecreators';
  model: string;
  calls: number;
  input_tokens: number;
  cached_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

interface Store {
  kind: UsageKind;
  refId: string;
  step: string;
  rows: Map<string, Row>;
}

const als = new AsyncLocalStorage<Store>();

// USD per 1M tokens: [input, cached input, output]
const PRICES: [RegExp, number, number, number][] = [
  [/haiku-5-5/, 0.1, 0.01, 0.5],
  [/haiku-4-5/, 1, 0.1, 5],
  [/sonnet-5/, 2, 0.1, 10],
  [/opus-5/, 4, 0.4, 20],
  [/gpt-6\.2-astra/, 8, 0.4, 40],
  [/gpt-6\.2-sol|gpt-6\.1-sol/, 2, 0.1, 10],
  [/gpt-4o-mini-transcribe/, 1.25, 1.25, 5],
];
const SC_CREDIT_USD = 47 / 25_000;

function priceOf(model: string): [number, number, number] {
  const m = model.toLowerCase();
  const p = PRICES.find(([re]) => re.test(m));
  return p ? [p[1], p[2], p[3]] : [0, 0, 0];
}

/** Runs fn with a usage collector and saves what it spent (never fails the step because of it). */
export async function withUsage<T>(
  sb: SupabaseClient,
  ref: { kind: UsageKind; refId: string; step?: string },
  fn: () => Promise<T>
): Promise<T> {
  const store: Store = { kind: ref.kind, refId: ref.refId, step: ref.step ?? '', rows: new Map() };
  try {
    return await als.run(store, fn);
  } finally {
    const rows = Array.from(store.rows.values()).filter((r) => r.calls);
    if (rows.length) {
      await sb
        .from('ai_usage')
        .insert(
          rows.map((r) => ({ kind: ref.kind, ref_id: ref.refId, ...r, cost_usd: Math.round(r.cost_usd * 1e6) / 1e6 }))
        )
        .then(
          () => null,
          () => null
        );
    }
  }
}

/** The step name for the calls that follow (e.g. 'tag', 'slides', 'write', 'review'). */
export function usageStep(step: string) {
  const s = als.getStore();
  if (s) s.step = step;
}

export function addUsage(
  provider: Row['provider'],
  model: string,
  u: { input?: number; cached?: number; output?: number; credits?: number }
) {
  const s = als.getStore();
  if (!s) return;
  const key = `${s.step}|${provider}|${model}`;
  const r =
    s.rows.get(key) ??
    ({ step: s.step, provider, model, calls: 0, input_tokens: 0, cached_tokens: 0, output_tokens: 0, cost_usd: 0 } as Row);
  r.calls += 1;
  if (provider === 'scrapecreators') {
    r.cost_usd += (u.credits ?? 1) * SC_CREDIT_USD;
  } else {
    const input = u.input ?? 0;
    const cached = u.cached ?? 0;
    const output = u.output ?? 0;
    const [pi, pc, po] = priceOf(model);
    r.input_tokens += input;
    r.cached_tokens += cached;
    r.output_tokens += output;
    r.cost_usd += (input * pi + cached * pc + output * po) / 1e6;
  }
  s.rows.set(key, r);
}

/** Anthropic `usage` block → addUsage (cache writes billed ×1.25 of input, kept simple as input). */
export function addAnthropicUsage(
  model: string,
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
) {
  if (!usage) return;
  addUsage('anthropic', model, {
    input: (usage.input_tokens ?? 0) + Math.round((usage.cache_creation_input_tokens ?? 0) * 1.25),
    cached: usage.cache_read_input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
  });
}

/** OpenAI chat `usage` block → addUsage (reasoning tokens are inside completion_tokens). */
export function addOpenAIUsage(
  model: string,
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }
) {
  if (!usage) return;
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  addUsage('openai', model, {
    input: Math.max(0, (usage.prompt_tokens ?? 0) - cached),
    cached,
    output: usage.completion_tokens ?? 0,
  });
}

export interface UsageTotals {
  total: number;
  byProvider: Record<string, number>;
  byStep: { step: string; provider: string; model: string; calls: number; cost: number }[];
}

export async function usageOf(sb: SupabaseClient, refId: string): Promise<UsageTotals> {
  const { data } = await sb
    .from('ai_usage')
    .select('step,provider,model,calls,cost_usd')
    .eq('ref_id', refId)
    .limit(5000)
    .returns<{ step: string; provider: string; model: string; calls: number; cost_usd: number }[]>();
  const byKey = new Map<string, UsageTotals['byStep'][number]>();
  const byProvider: Record<string, number> = {};
  let total = 0;
  for (const r of data ?? []) {
    const cost = Number(r.cost_usd) || 0;
    total += cost;
    byProvider[r.provider] = (byProvider[r.provider] ?? 0) + cost;
    const k = `${r.step}|${r.provider}|${r.model}`;
    const x = byKey.get(k) ?? { step: r.step, provider: r.provider, model: r.model, calls: 0, cost: 0 };
    x.calls += r.calls;
    x.cost += cost;
    byKey.set(k, x);
  }
  return { total, byProvider, byStep: Array.from(byKey.values()).sort((a, b) => b.cost - a.cost) };
}
