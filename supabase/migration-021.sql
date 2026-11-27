-- SamSpy — migration 021: what the paid APIs cost (2026-11-27)
-- One row per step × model of a dossier job / plan step (lib/usage.ts); the UI sums them by ref_id.
create table if not exists public.ai_usage (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  kind text not null,              -- analysis | plan
  ref_id uuid not null,            -- analysis job id / plan id
  step text not null default '',
  provider text not null,          -- anthropic | openai | scrapecreators
  model text not null,
  calls int not null default 0,
  input_tokens bigint not null default 0,
  cached_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  cost_usd numeric(12,6) not null default 0
);
create index if not exists idx_ai_usage_ref on public.ai_usage (ref_id);
alter table public.ai_usage enable row level security;
