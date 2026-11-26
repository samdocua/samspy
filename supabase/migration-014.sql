-- SamSpy — migration 014: «План» — copies of competitors' winning carousels (2026-11-26)
-- cta_kind: 'comment' (comment a keyword) | 'follow' (follow for more) — they alternate post by post.
-- source_*: the competitor carousel whose slide texts an item copies (mode 'copy').

alter table content_plan_items add column if not exists cta_kind text;
alter table content_plan_items add column if not exists source_username text;
alter table content_plan_items add column if not exists source_shortcode text;
alter table content_plan_items add column if not exists source_url text;
create index if not exists idx_plan_items_source on content_plan_items (source_shortcode) where source_shortcode is not null;
