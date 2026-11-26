// SamSpy — «План»: types (mirror supabase/migration-009.sql, migration-014.sql)
//
// Version history:
//   v0.1.0 (2026-11-22) — plans, items, settings.
//   v0.2.0 (2026-11-23) — CTA = fixed universal texts with a comment keyword (MORE / LIST /
//                         SEND), rotated across posts; keywordOf() finds the word.
//   v0.3.0 (2026-11-26) — mode 'copy': slide texts 1:1 from competitors' winning carousels
//                         (settings.copy_pool, item.source_*); CTA kinds alternate post by post:
//                         'comment' (keyword) / 'follow' (follow for more) — DEFAULT_FOLLOW_CTAS;
//                         follow posts get a comment-bait caption (CAPTION_BAITS).
//   v0.3.1 (2026-11-26) — neutral last slides vary: send / save / tag / follow / try.
//   v0.4.0 (2026-11-26) — mode 'mix': half copies, half new (item.mode per post).
//   v0.5.0 (2026-11-26) — the writer learns from up to 200 strongest carousels per source:
//                         settings.playbook (Claude's notes) + settings.examples; mix plans go
//                         copy, new, copy, new… (the CTA kind changes every two posts there).

/** Last slides that ask to comment a keyword. Universal (fit any post). Rotated. */
export const DEFAULT_CTAS = [
  'Comment MORE and I’ll send you more questions 👇',
  'Want more? Comment LIST and I’ll send them',
  'Comment SEND and I’ll DM you the full list',
  'Want the rest? Comment MORE and I’ll send them 👇',
  'Need more questions? Comment LIST 👇',
  'Comment SEND and they’re yours',
];

/** Neutral last slides (no keyword): send / save / tag / follow / try. Universal. Rotated. */
export const DEFAULT_FOLLOW_CTAS = [
  'Send this to your partner',
  'Save this for your next date night',
  'Follow for more questions like these',
  'Tag the person you’d ask first',
  'Send this to someone you’d ask these',
  'Try these tonight',
  'Save these for your next deep talk',
  'Follow for new questions every day',
  'Send it to your person and compare answers',
];

/** Captions of «follow» posts in copy mode: invite a comment without a keyword. Rotated. */
export const CAPTION_BAITS = [
  'Which one would you answer first? 👇',
  'Be honest — which question was the hardest? 👇',
  'Answer one in the comments 👇',
  'Which one would you never answer? 👇',
  'Send this to your partner and compare answers',
];

/** The comment keyword of a CTA text: the first word in capitals (3+ letters). */
export function keywordOf(cta: string): string | null {
  return cta.match(/\b[A-Z]{3,}\b/)?.[0] ?? null;
}

export type PlanStatus = 'generating' | 'done' | 'failed';
export type ItemStatus = 'draft' | 'in_slides' | 'done';
export type PlanMode = 'write' | 'copy' | 'mix';
export type ItemMode = 'write' | 'copy';
export type CtaKind = 'comment' | 'follow';

/** A competitor carousel the writer learns from (slides read in full). */
export interface PlanExample {
  src: string; // source account
  strength: number; // likes / median of ±15 days
  likes: number;
  rubric: string | null;
  hook: string | null;
  slides: string; // «1) cover\n2) …», clipped
  caption: string;
}

/** A competitor carousel waiting to be copied (mode 'copy'). */
export interface CopySource {
  username: string;
  job_id: string;
  shortcode: string;
  url: string;
  ratio: number | null;
}

export interface PlanSettings {
  mode?: PlanMode; // missing on older plans = 'write'
  language: string; // 'English'
  q_min: number; // questions per carousel (mode 'write')
  q_max: number;
  cta_variants: string[]; // last slides with a comment keyword, rotated
  follow_variants?: string[]; // last slides «follow for more», rotated (alternate with the above)
  notes: string; // free wishes for the writer
  brief: string; // older snapshot of the source dossiers (fallback when few slides are read)
  playbook?: string; // what wins at the sources — Claude's notes over their strongest carousels
  examples?: PlanExample[]; // those carousels (server only; the writer rotates through them)
  learned?: Record<string, number>; // source → carousels learned from (slides read in full)
  combos: { rubric: string; hook: string; weight: number }[]; // what wins at the sources
  copy_pool?: CopySource[]; // mode 'copy': winners not used yet, best first
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
  mode: ItemMode | null; // mix plans: how this post is made; null = the plan's mode
  cta_kind: CtaKind | null; // older items: null = 'comment'
  cta_variant: number | null; // index in the list of its kind
  caption: string | null;
  source_username: string | null;
  source_shortcode: string | null;
  source_url: string | null;
  status: ItemStatus;
  created_at: string;
  updated_at: string;
}

export interface PlanCard {
  id: string;
  title: string;
  mode: PlanMode;
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

/** The last slide of an item (its CTA text). */
export function ctaTextOf(s: PlanSettings, it: Pick<PlanItem, 'cta_kind' | 'cta_variant'>): string {
  const list =
    it.cta_kind === 'follow'
      ? s.follow_variants?.length
        ? s.follow_variants
        : DEFAULT_FOLLOW_CTAS
      : s.cta_variants?.length
        ? s.cta_variants
        : DEFAULT_CTAS;
  return list[(it.cta_variant ?? 0) % list.length];
}
