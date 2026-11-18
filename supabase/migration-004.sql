-- SamSpy — migration 004: carousel text collector (tab «Карусели», Instagram)
--
-- Version history:
--   v0.4.0 (2026-11-18) — carousel_jobs, carousel_posts, carousel_job_posts, carousel_slides
--                         + public Storage bucket "carousels" for slide images.
--
-- Apply AFTER migration-003.sql. Paste into the Supabase SQL editor and Run.

-- ---------------------------------------------------------------------------
-- carousel_jobs — one "Собрать" click (a list of links), advanced step by step
--   status: apify → ocr → check → escalate → done | failed
-- ---------------------------------------------------------------------------
create table if not exists carousel_jobs (
  id                uuid primary key default gen_random_uuid(),
  status            text not null default 'apify',
  urls              text[] not null default '{}',
  apify_run_id      text,
  apify_dataset_id  text,
  error             text,
  locked_until      timestamptz,          -- step lock, so two open tabs don't process one job
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_carousel_jobs_created on carousel_jobs(created_at desc);

-- ---------------------------------------------------------------------------
-- carousel_posts — one Instagram post, shared between jobs by shortcode
--   (a post that is already 'ready' is reused for free by later jobs)
--   status: pending → ready | failed
-- ---------------------------------------------------------------------------
create table if not exists carousel_posts (
  id          uuid primary key default gen_random_uuid(),
  shortcode   text not null unique,
  url         text not null,
  author      text,
  posted_at   timestamptz,
  likes       bigint,
  comments    bigint,
  caption     text,
  brand       text,                 -- repeated watermark lines, e.g. "flamingo cards"
  status      text not null default 'pending',
  checked     boolean not null default false,
  last_split  jsonb,                -- {"content": "...", "cta": "..."} for the last slide
  error       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- carousel_job_posts — which posts belong to a job, in the order they were pasted
-- ---------------------------------------------------------------------------
create table if not exists carousel_job_posts (
  job_id    uuid not null references carousel_jobs(id) on delete cascade,
  post_id   uuid not null references carousel_posts(id) on delete cascade,
  position  int  not null default 0,
  primary key (job_id, post_id)
);
create index if not exists idx_carousel_job_posts_post on carousel_job_posts(post_id);

-- ---------------------------------------------------------------------------
-- carousel_slides — one slide of a post
--   raw_text   = OCR output; text = cleaned (watermarks removed); cta_text = CTA part
--   role       = hook | body | body+cta | cta
--   check_status = ok | flagged | escalated | check_failed | escalate_failed
-- ---------------------------------------------------------------------------
create table if not exists carousel_slides (
  id            uuid primary key default gen_random_uuid(),
  post_id       uuid not null references carousel_posts(id) on delete cascade,
  idx           int  not null,
  source_url    text not null,      -- Instagram CDN URL (expires in ~a day)
  image_path    text,               -- path in Storage bucket "carousels"
  is_video      boolean not null default false,
  ocr_done      boolean not null default false,
  raw_text      text,
  text          text,
  cta_text      text,
  role          text,
  model         text,
  check_status  text,
  issue         text,
  error         text,
  unique (post_id, idx)
);
create index if not exists idx_carousel_slides_ocr   on carousel_slides(post_id, ocr_done);
create index if not exists idx_carousel_slides_check on carousel_slides(post_id, check_status);

-- ---------------------------------------------------------------------------
-- Storage: public bucket for slide images (previews in the UI)
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('carousels', 'carousels', true)
on conflict (id) do nothing;
