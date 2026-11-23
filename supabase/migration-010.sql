-- SamSpy — migration 010: ScrapeCreators collection state (2026-11-23)
-- job.scrape keeps the feed cursor / counters and the «to finish» lists (posts, comments,
-- authors that failed and wait for another try). null on Apify jobs.

alter table analysis_jobs add column if not exists scrape jsonb;
alter table carousel_jobs add column if not exists scrape jsonb;
