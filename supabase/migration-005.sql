-- SamSpy — migration 005: carousel posts base (no repeats) + outlier
--
-- Version history:
--   v0.7.0 (2026-11-20) — carousel_posts: norm_text / text_hash (repeat check by text),
--                         duplicate_of (same text as an earlier post → hidden from the base),
--                         similar_to + similarity (≥ 90% alike → marked, stays in the base),
--                         outlier_ratio (likes ÷ author's median likes);
--                         carousel_authors (median likes cache, 7 days);
--                         carousel_jobs: stats_* (Apify run for authors' recent posts).
--
-- Apply AFTER migration-004.sql. Paste into the Supabase SQL editor and Run.

alter table carousel_posts add column if not exists norm_text     text;
alter table carousel_posts add column if not exists text_hash     text;
alter table carousel_posts add column if not exists duplicate_of  uuid references carousel_posts(id) on delete set null;
alter table carousel_posts add column if not exists similar_to    uuid references carousel_posts(id) on delete set null;
alter table carousel_posts add column if not exists similarity    real;
alter table carousel_posts add column if not exists outlier_ratio real;
alter table carousel_posts add column if not exists stats_done    boolean not null default false;

create index if not exists idx_carousel_posts_hash    on carousel_posts(text_hash);
create index if not exists idx_carousel_posts_created on carousel_posts(created_at desc);
create index if not exists idx_carousel_posts_author  on carousel_posts(author);

-- one row per Instagram author: median likes of their recent posts
create table if not exists carousel_authors (
  username      text primary key,
  median_likes  bigint,               -- null = likes hidden / no data
  posts_count   int not null default 0,
  error         text,
  fetched_at    timestamptz not null default now()
);

alter table carousel_jobs add column if not exists stats_run_id     text;
alter table carousel_jobs add column if not exists stats_dataset_id text;
alter table carousel_jobs add column if not exists stats_started_at timestamptz;
