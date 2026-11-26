-- SamSpy — migration 018: light post list for the dossier
--
-- Version history:
--   v0.1.0 (2026-11-26) — view analysis_posts_list: every column the dossier shows, without the
--                         heavy ones (transcripts, slide texts, image / video links — ~44 MB on a
--                         10k-post account); has_text computed from the stored sizes (no detoast).

create or replace view public.analysis_posts_list
with (security_invoker = true) as
select
  id, job_id, shortcode, url, kind, posted_at, caption, likes, comments, views, duration, slides,
  is_pinned, coauthors, owner, has_cta, thumb_path, title_ru, rubric, hook, format, breadth,
  first_line, tagged, breakdown,
  (coalesce(octet_length(transcript), 0) > 0 or coalesce(octet_length(ocr_text), 0) > 0) as has_text
from public.analysis_posts;

revoke all on public.analysis_posts_list from anon, authenticated;
grant select on public.analysis_posts_list to service_role;
