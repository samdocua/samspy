-- SamSpy — database schema (Supabase / Postgres)
-- Internal viral Instagram Reels catalog, powered by the Virlo API.
--
-- Version history:
--   v0.1.0 (2026-11-17) — Initial schema. Tab 1 "By competitors" only.
--                         Tables: niches, competitors, reels, reel_snapshots.
--                         Tabs 2 (search) and 3 (top reels) reuse `reels.source`.
--
-- Apply with: psql <connection-string> -f supabase/schema.sql
-- or paste into the Supabase SQL editor.

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------
create extension if not exists "pgcrypto";   -- gen_random_uuid()

-- ---------------------------------------------------------------------------
-- niches
--   Folders we define ourselves. Virlo has no concept of a niche;
--   we attach each competitor to one niche on our side.
-- ---------------------------------------------------------------------------
create table if not exists niches (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text not null unique,
  description text,
  sort_order  int  not null default 0,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- competitors
--   Instagram accounts we track. Added manually by @username.
--   Mirrors a Virlo "tracked creator": we store Virlo's creator id
--   so we can pull posts/signals and stop/resume tracking.
-- ---------------------------------------------------------------------------
create table if not exists competitors (
  id                 uuid primary key default gen_random_uuid(),
  niche_id           uuid references niches(id) on delete set null,

  -- Instagram identity
  username           text not null unique,          -- e.g. "flamingoappreels" (no @)
  display_name       text,
  avatar_url         text,                           -- stored by Virlo (doesn't expire)
  bio                text,
  is_verified        boolean default false,

  -- Virlo tracking linkage
  virlo_creator_id   text unique,                    -- Virlo's tracked-creator UUID
  virlo_status       text default 'pending',         -- pending | active | paused | failed | deleted
  scrape_cadence     text default 'daily',           -- daily | every_other_day | weekly | ...

  -- latest rollups (refreshed on each sync)
  latest_followers   bigint,
  median_views       bigint,                         -- our computed median for outlier context
  last_synced_at     timestamptz,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists idx_competitors_niche   on competitors(niche_id);
create index if not exists idx_competitors_status  on competitors(virlo_status);

-- ---------------------------------------------------------------------------
-- reels
--   The catalog. One row per reel, from any of the three tabs.
--   `source` distinguishes where it came from so a reel that shows up in
--   both "competitors" and "search" is stored once (upsert on url).
-- ---------------------------------------------------------------------------
create table if not exists reels (
  id                 uuid primary key default gen_random_uuid(),

  -- where this reel entered the catalog
  source             text not null default 'competitor',  -- competitor | search | top
  competitor_id      uuid references competitors(id) on delete cascade,
  saved_search_id    uuid,                                 -- FK added after saved_searches (tab 2)

  -- Instagram identity of the reel
  url                text not null unique,                 -- https://www.instagram.com/reel/CODE/
  external_id        text,                                 -- Virlo's platform video id
  thumbnail_url      text,                                 -- stored by Virlo (doesn't expire)
  caption            text,

  -- author (denormalized — search/top reels aren't tied to a tracked competitor)
  author_username    text,

  -- metrics (latest snapshot)
  views              bigint default 0,
  likes              bigint default 0,
  comments           bigint default 0,
  hashtags           text[] default '{}',

  -- virality
  outlier_ratio          numeric,                          -- views / creator median; null if unknown
  outlier_weighted_score numeric,                          -- Virlo's ranked breakout score
  is_outlier             boolean default false,            -- true when ratio >= 3 (Virlo's threshold)

  published_at       timestamptz,
  first_seen_at      timestamptz not null default now(),   -- when it entered our catalog
  last_synced_at     timestamptz not null default now(),

  created_at         timestamptz not null default now()
);

create index if not exists idx_reels_competitor on reels(competitor_id);
create index if not exists idx_reels_source     on reels(source);
create index if not exists idx_reels_outlier    on reels(outlier_ratio desc nulls last);
create index if not exists idx_reels_published  on reels(published_at desc nulls last);
create index if not exists idx_reels_views      on reels(views desc);

-- ---------------------------------------------------------------------------
-- reel_snapshots
--   Metric history per reel, one row per sync. Powers the "rising" view
--   (velocity between snapshots) and charts.
-- ---------------------------------------------------------------------------
create table if not exists reel_snapshots (
  id           uuid primary key default gen_random_uuid(),
  reel_id      uuid not null references reels(id) on delete cascade,
  views        bigint default 0,
  likes        bigint default 0,
  comments     bigint default 0,
  snapshot_at  timestamptz not null default now()
);

create index if not exists idx_snapshots_reel on reel_snapshots(reel_id, snapshot_at desc);

-- ---------------------------------------------------------------------------
-- saved_searches  (tab 2 — added now so the FK on reels resolves;
--                  the search module itself comes in a later step)
-- ---------------------------------------------------------------------------
create table if not exists saved_searches (
  id           uuid primary key default gen_random_uuid(),
  query        text not null,
  label        text,
  last_run_at  timestamptz,
  created_at   timestamptz not null default now()
);

-- wire the deferred FK from reels.saved_search_id
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'reels_saved_search_fk'
  ) then
    alter table reels
      add constraint reels_saved_search_fk
      foreign key (saved_search_id) references saved_searches(id) on delete set null;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- updated_at trigger for competitors
-- ---------------------------------------------------------------------------
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_competitors_updated_at on competitors;
create trigger trg_competitors_updated_at
  before update on competitors
  for each row execute function set_updated_at();
