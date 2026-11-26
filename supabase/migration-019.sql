-- SamSpy — migration 019: check of new plan posts (2026-11-26)
-- review: {by, verdict ok|fixed|skipped, note, issues[], left[]} — script rules + GPT's second opinion.

alter table content_plan_items add column if not exists review jsonb;
