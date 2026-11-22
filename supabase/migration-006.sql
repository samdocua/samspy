-- SamSpy — migration 006: «Анализ» tab (Instagram account dossiers)
--
-- Version history:
--   v0.1.0 (2026-11-22) — analysis_accounts (profile + card summary), analysis_jobs
--                         (Apify runs, step status, computed stats), analysis_posts
--                         (one row per post of the period, per job), storage bucket
--                         'analysis' for thumbnails / avatars.
--
-- Apply AFTER migration-005.sql. Paste into the Supabase SQL editor and Run.

-- one row per analysed Instagram account (latest profile data + card summary)
create table if not exists analysis_accounts (
  username       text primary key,
  full_name      text,
  biography      text,
  external_url   text,
  followers      bigint,
  follows        bigint,
  posts_count    bigint,
  verified       boolean not null default false,
  category       text,
  avatar_path    text,                 -- storage path in bucket 'analysis'
  last_job_id    uuid,                 -- latest finished dossier
  summary        jsonb,                -- numbers for the card (median, outliers %, per week, trend)
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- one dossier build = one job (re-analysis creates a new job; the latest done one is shown)
create table if not exists analysis_jobs (
  id                 uuid primary key default gen_random_uuid(),
  username           text not null,
  status             text not null default 'apify',  -- apify | save | thumbs | stats | done | failed
  period_from        timestamptz not null,
  profile_run_id     text,
  profile_dataset_id text,
  posts_run_id       text,
  posts_dataset_id   text,
  stats              jsonb,
  error              text,
  locked_until       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists idx_analysis_jobs_user on analysis_jobs(username, created_at desc);

create table if not exists analysis_posts (
  id            uuid primary key default gen_random_uuid(),
  job_id        uuid not null references analysis_jobs(id) on delete cascade,
  shortcode     text not null,
  url           text not null,
  kind          text not null,         -- reel | carousel | photo
  posted_at     timestamptz,
  caption       text,
  likes         bigint,                -- null = hidden
  comments      bigint,
  views         bigint,                -- reels: plays (null for carousels / photos)
  duration      real,                  -- seconds (reels)
  slides        int,                   -- carousels: number of slides
  is_pinned     boolean not null default false,
  coauthors     text[] not null default '{}',
  owner         text,                  -- post owner (differs from the account on collabs)
  has_cta       boolean not null default false,
  display_url   text,                  -- Instagram CDN (expires) — source for the thumbnail
  video_url     text,                  -- Instagram CDN (expires) — for transcription (stage 2)
  thumb_path    text,                  -- storage path in bucket 'analysis'
  thumb_done    boolean not null default false,
  unique (job_id, shortcode)
);

create index if not exists idx_analysis_posts_job   on analysis_posts(job_id);
create index if not exists idx_analysis_posts_thumb on analysis_posts(job_id, thumb_done);

-- public bucket for thumbnails and avatars
insert into storage.buckets (id, name, public)
values ('analysis', 'analysis', true)
on conflict (id) do nothing;
