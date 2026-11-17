-- SamSpy — migration 003: multi-platform (Instagram + TikTok)
--
-- Version history:
--   v0.3.0 (2026-11-17) — add `platform` to competitors, reels, saved_searches,
--                         blacklist. Existing rows default to 'instagram'.
--                         Competitor uniqueness becomes (platform, username).
--
-- Apply AFTER migration-002.sql. Paste into the Supabase SQL editor and Run.

-- platform columns (existing data stays Instagram)
alter table competitors    add column if not exists platform text not null default 'instagram';
alter table reels          add column if not exists platform text not null default 'instagram';
alter table saved_searches add column if not exists platform text not null default 'instagram';
alter table blacklist      add column if not exists platform text not null default 'instagram';

-- the same @handle can exist on both platforms, so uniqueness is per-platform
alter table competitors drop constraint if exists competitors_username_key;
create unique index if not exists competitors_platform_username_key
  on competitors (platform, lower(username));

create index if not exists idx_competitors_platform    on competitors(platform);
create index if not exists idx_reels_platform          on reels(platform);
create index if not exists idx_saved_searches_platform on saved_searches(platform);
