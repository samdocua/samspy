-- SamSpy — migration 011: background worker (2026-11-23)
-- pg_cron runs public.samspy_tick() every 20 s; the tick sends (pg_net) one
-- POST {base_url}/api/cron/step?kind=…&id=… per unfinished, unlocked job of «Анализ»,
-- «Карусели» and «План», so jobs finish without an open tab (see lib/worker.ts).
-- The secret lives only here (worker_config, RLS on, no policies → service role only).
--
-- Version history:
--   v0.1.0 (2026-11-23) — initial.

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

create table if not exists worker_config (
  key   text primary key,
  value text not null
);
alter table worker_config enable row level security;

insert into worker_config (key, value) values
  ('secret', encode(extensions.gen_random_bytes(24), 'hex')),
  ('base_url', 'https://samspy.vercel.app')
on conflict (key) do nothing;

create or replace function public.samspy_tick() returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  base text;
  sec  text;
  r    record;
  n    integer := 0;
begin
  select value into base from worker_config where key = 'base_url';
  select value into sec  from worker_config where key = 'secret';
  if base is null or sec is null then return 0; end if;

  for r in
    select 'analysis' as k, id from analysis_jobs
     where status in ('apify','save','thumbs','stats','comments','texts','tag','breakdown','synth')
       and (locked_until is null or locked_until < now())
    union all
    select 'carousels', id from carousel_jobs
     where status in ('apify','ocr','check','escalate','stats')
       and (locked_until is null or locked_until < now())
    union all
    select 'plan', id from content_plans
     where status = 'generating'
       and (locked_until is null or locked_until < now())
  loop
    perform net.http_post(
      url := base || '/api/cron/step?kind=' || r.k || '&id=' || r.id,
      body := '{}'::jsonb,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-worker-secret', sec),
      timeout_milliseconds := 5000
    );
    n := n + 1;
  end loop;
  return n;
end;
$$;

revoke all on function public.samspy_tick() from public, anon, authenticated;

-- schedule (applied after the worker route is live in production):
-- select cron.schedule('samspy-worker', '20 seconds', 'select public.samspy_tick()');
