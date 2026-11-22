-- SamSpy — migration 008: «Анализ» stage 2 — AI dossier
--
-- Version history:
--   v0.3.0 (2026-11-22) — analysis_posts: slide_urls, AI tags (title_ru, rubric, hook, format,
--                         breadth, first_line), transcript (reels), ocr_text (carousels),
--                         breakdown (top posts); analysis_comments; analysis_jobs: comments run,
--                         ai (dossier texts), ai_meta (rubric vocabulary), ai_error.
--
-- Apply AFTER migration-007.sql. Paste into the Supabase SQL editor and Run.

alter table analysis_posts add column if not exists slide_urls  text[] not null default '{}';
alter table analysis_posts add column if not exists title_ru    text;
alter table analysis_posts add column if not exists rubric      text;
alter table analysis_posts add column if not exists hook        text;
alter table analysis_posts add column if not exists format      text;
alter table analysis_posts add column if not exists breadth     text;     -- широкий | узкий
alter table analysis_posts add column if not exists first_line  text;     -- first phrase, in Russian
alter table analysis_posts add column if not exists tagged      boolean not null default false;
alter table analysis_posts add column if not exists transcript  text;     -- reels: speech
alter table analysis_posts add column if not exists ocr_text    text;     -- carousels: slide texts
alter table analysis_posts add column if not exists text_done   boolean not null default false;
alter table analysis_posts add column if not exists breakdown   jsonb;    -- top posts: structure, payoff, cta, why, text_ru

create table if not exists analysis_comments (
  id         uuid primary key default gen_random_uuid(),
  job_id     uuid not null references analysis_jobs(id) on delete cascade,
  shortcode  text not null,
  text       text not null,
  likes      bigint,
  owner      text,
  posted_at  timestamptz
);
create index if not exists idx_analysis_comments_job on analysis_comments(job_id, shortcode);
alter table analysis_comments enable row level security;

alter table analysis_jobs add column if not exists comments_run_id     text;
alter table analysis_jobs add column if not exists comments_dataset_id text;
alter table analysis_jobs add column if not exists ai                  jsonb;
alter table analysis_jobs add column if not exists ai_meta             jsonb;
alter table analysis_jobs add column if not exists ai_error            text;
