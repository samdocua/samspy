-- SamSpy — migration 013: lighter background load (2026-11-23)
-- samspy_tick(): at most 2 «Анализ» jobs work at once — three 10 000-post accounts in AI steps
-- together overloaded the database (the tab could not even list the dossiers).
-- (A partial index for untagged posts was tried too; building it timed out on the loaded
--  database, the tag step works on idx_analysis_posts_job_date without it.)

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
  busy integer;
  analysis_slots constant integer := 2;
begin
  select value into base from worker_config where key = 'base_url';
  select value into sec  from worker_config where key = 'secret';
  if base is null or sec is null then return 0; end if;

  select count(*) into busy from analysis_jobs
   where status in ('apify','save','thumbs','stats','comments','texts','tag','breakdown','synth')
     and locked_until > now();

  for r in
    (select 'analysis' as k, id from analysis_jobs
      where status in ('apify','save','thumbs','stats','comments','texts','tag','breakdown','synth')
        and (locked_until is null or locked_until < now())
      order by updated_at
      limit greatest(0, analysis_slots - busy))
    union all
    (select 'carousels', id from carousel_jobs
      where status in ('apify','ocr','check','escalate','stats')
        and (locked_until is null or locked_until < now()))
    union all
    (select 'plan', id from content_plans
      where status = 'generating'
        and (locked_until is null or locked_until < now()))
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

-- 2026-11-24: the partial index for untagged posts, built once the load was gone
-- (create index concurrently — not inside a migration transaction):
-- create index concurrently if not exists idx_analysis_posts_untagged
--   on public.analysis_posts (job_id, posted_at desc) where not tagged;
