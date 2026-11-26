-- SamSpy — migration 016: «На телефон» — slides shared by a link (2026-11-26)
-- One row per sending: an unguessable token (the link /s/<token>), the JPEG paths in the public
-- bucket 'shares', and an expiry (7 days). The page /s/<token> needs no password; the token is
-- the key. Expired or deleted shares lose their files too.

create table if not exists slide_shares (
  id          uuid primary key default gen_random_uuid(),
  token       text not null unique,
  title       text,
  files       text[] not null default '{}',
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);
alter table slide_shares enable row level security;

insert into storage.buckets (id, name, public)
values ('shares', 'shares', true)
on conflict (id) do nothing;
