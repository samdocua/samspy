-- SamSpy — migration 002: block management (min views + per-block blacklist)
--
-- Version history:
--   v0.2.0 (2026-11-17) — saved_searches.min_views, reels.author_external_id,
--                         blacklist table (per search block + per top).
--
-- Apply AFTER schema.sql. Paste into the Supabase SQL editor and Run.

-- Per-block minimum-views display filter.
alter table saved_searches
  add column if not exists min_views bigint not null default 0;

-- Store the platform's author id so Top Reels (which has no @username) can be
-- blacklisted by author.
alter table reels
  add column if not exists author_external_id text;

create index if not exists idx_reels_author_ext on reels(author_external_id);

-- Blacklist: scoped either to one search block, or to Top Reels.
--   scope='search' + saved_search_id + username  -> hide a @handle in that block
--   scope='top'    + author_external_id           -> hide an author in Top Reels
create table if not exists blacklist (
  id                  uuid primary key default gen_random_uuid(),
  scope               text not null,                 -- 'search' | 'top'
  saved_search_id     uuid references saved_searches(id) on delete cascade,
  username            text,                          -- lowercased (search scope)
  author_external_id  text,                          -- (top scope)
  label               text,                          -- what to show in the UI
  created_at          timestamptz not null default now()
);

create index if not exists idx_blacklist_search
  on blacklist(saved_search_id) where scope = 'search';
create index if not exists idx_blacklist_top
  on blacklist(author_external_id) where scope = 'top';
