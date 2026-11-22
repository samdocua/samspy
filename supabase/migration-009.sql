-- SamSpy — migration 009: «План» tab (carousel content plans)
--
-- Version history:
--   v0.1.0 (2026-11-22) — content_plans (settings, source dossiers, generation status) and
--                         content_plan_items (one carousel: account, day, slot, slide texts,
--                         comment-bait variant, caption, status draft / in_slides / done).
--
-- Apply AFTER migration-008.sql. Paste into the Supabase SQL editor and Run.

create table if not exists content_plans (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  accounts      text[] not null,             -- e.g. {I0001,I0002}
  days          int  not null default 30,
  per_day       int  not null default 3,
  start_date    date not null,
  sources       text[] not null default '{}', -- analysed accounts (analysis_accounts.username)
  settings      jsonb not null default '{}',  -- language, questions min/max, CTA variants, notes
  status        text not null default 'generating',  -- generating | done | failed
  error         text,
  locked_until  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists content_plan_items (
  id            uuid primary key default gen_random_uuid(),
  plan_id       uuid not null references content_plans(id) on delete cascade,
  account       text not null,
  day           int  not null,               -- 1…days
  slot          int  not null,               -- 1…per_day
  rubric        text,
  hook          text,
  title         text,                        -- short topic, for the calendar
  slides        text[] not null default '{}', -- cover, questions…, comment-bait slide
  cta_variant   int,                         -- index in settings.cta_variants
  caption       text,
  status        text not null default 'draft', -- draft | in_slides | done
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (plan_id, account, day, slot)
);

create index if not exists idx_plan_items_plan on content_plan_items(plan_id, account, day, slot);

alter table content_plans      enable row level security;
alter table content_plan_items enable row level security;
