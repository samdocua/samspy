-- SamSpy — migration 012: posts of a job by date (2026-11-23)
-- loadPosts() reads a job's posts ordered by posted_at in pages of 1000; on 10 000-post jobs the
-- sort without an index ran into the statement timeout at the «stats» step.

create index if not exists idx_analysis_posts_job_date on public.analysis_posts (job_id, posted_at desc, id);
