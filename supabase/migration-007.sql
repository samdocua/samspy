-- SamSpy — migration 007: «Анализ» — quick update (only new posts)
--
-- Version history:
--   v0.2.0 (2026-11-22) — analysis_jobs.mode ('full' = whole year, 'update' = only posts
--                         newer than the previous dossier, minus 14 days overlap) and
--                         base_job_id (previous dossier whose older posts are carried over).
--
-- Apply AFTER migration-006.sql. Paste into the Supabase SQL editor and Run.

alter table analysis_jobs add column if not exists mode        text not null default 'full';
alter table analysis_jobs add column if not exists base_job_id uuid references analysis_jobs(id) on delete set null;
