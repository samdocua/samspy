// SamSpy — «План»: types (mirror supabase/migration-009.sql)
//
// Version history:
//   v0.1.0 (2026-11-22) — plans, items, settings.
//   v0.2.0 (2026-11-23) — CTA = fixed universal texts with a comment keyword (MORE / LIST /
//                         SEND), rotated across posts; keywordOf() finds the word.

/** Default last slides: universal (fit any post), each with a comment keyword. Rotated. */
export const DEFAULT_CTAS = [
  'Comment MORE and I’ll send you more questions 👇',
  'Want more? Comment LIST and I’ll send them',
  'Comment SEND and I’ll DM you the full list',
  'Want the rest? Comment MORE and I’ll send them 👇',
  'Need more questions? Comment LIST 👇',
  'Comment SEND and they’re yours',
];

/** The comment keyword of a CTA text: the first word in capitals (3+ letters). */
export function keywordOf(cta: string): string | null {
  return cta.match(/\b[A-Z]{3,}\b/)?.[0] ?? null;
}

export type PlanStatus = 'generating' | 'done' | 'failed';
export type ItemStatus = 'draft' | 'in_slides' | 'done';

export interface PlanSettings {
  language: string; // 'English'
  q_min: number; // questions per carousel
  q_max: number;
  cta_variants: string[]; // last slide texts with a comment keyword, rotated across posts
  notes: string; // free wishes for the writer
  brief: string; // snapshot of the source dossiers (built at creation)
  combos: { rubric: string; hook: string; weight: number }[]; // what wins at the sources
}

export interface ContentPlan {
  id: string;
  title: string;
  accounts: string[];
  days: number;
  per_day: number;
  start_date: string; // YYYY-MM-DD
  sources: string[];
  settings: PlanSettings;
  status: PlanStatus;
  error: string | null;
  locked_until: string | null;
  created_at: string;
  updated_at: string;
}

export interface PlanItem {
  id: string;
  plan_id: string;
  account: string;
  day: number;
  slot: number;
  rubric: string | null;
  hook: string | null;
  title: string | null;
  slides: string[];
  cta_variant: number | null; // index in settings.cta_variants
  caption: string | null;
  status: ItemStatus;
  created_at: string;
  updated_at: string;
}

export interface PlanCard {
  id: string;
  title: string;
  accounts: string[];
  days: number;
  per_day: number;
  start_date: string;
  sources: string[];
  status: PlanStatus;
  error: string | null;
  total: number;
  written: number;
  done: number;
  created_at: string;
}
