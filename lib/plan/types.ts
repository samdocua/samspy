// SamSpy — «План»: types (mirror supabase/migration-009.sql)
//
// Version history:
//   v0.1.0 (2026-11-22) — plans, items, settings.
//   v0.2.0 (2026-11-23) — CTA = keyword (cta_words): «comment WORD — I'll DM you more
//                         questions»; the model writes the last slide around the word.

/** Default comment keywords (universal — fit any post), rotated across posts. */
export const DEFAULT_CTA_WORDS = ['MORE', 'NEXT', 'LIST', 'YES', 'SEND'];

/** Last slide when the model's text does not contain the keyword. */
export const ctaFallback = (word: string) => `Comment ${word} and I'll send you more questions like these 👇`;

export type PlanStatus = 'generating' | 'done' | 'failed';
export type ItemStatus = 'draft' | 'in_slides' | 'done';

export interface PlanSettings {
  language: string; // 'English'
  q_min: number; // questions per carousel
  q_max: number;
  cta_words?: string[]; // comment keywords, rotated across posts (cta_variant = index)
  cta_variants?: string[]; // v0.1 plans: fixed last-slide texts
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
  cta_variant: number | null; // index in settings.cta_words (v0.1: in cta_variants)
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
