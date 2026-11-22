// SamSpy — «План»: types (mirror supabase/migration-009.sql)
//
// Version history:
//   v0.1.0 (2026-11-22) — plans, items, settings.

/** Default last slides (comment bait), rotated across posts. */
export const DEFAULT_CTAS = [
  'Comment «I WANT MORE QUESTIONS» and I’ll drop part 2 👇',
  'Want more? Comment «MORE» and I’ll send you the next set',
  'Which one did he answer? Tell me in the comments 👇',
];

export type PlanStatus = 'generating' | 'done' | 'failed';
export type ItemStatus = 'draft' | 'in_slides' | 'done';

export interface PlanSettings {
  language: string; // 'English'
  q_min: number; // questions per carousel
  q_max: number;
  cta_variants: string[]; // last slide texts (comment bait), rotated across posts
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
  cta_variant: number | null;
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
