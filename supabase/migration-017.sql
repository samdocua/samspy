-- SamSpy — migration 017: «План» mode 'mix' (2026-11-26)
-- item.mode: 'copy' (slide texts 1:1 from a winning carousel) | 'write' (new, by Claude).
-- null on older items = the plan's mode.

alter table content_plan_items add column if not exists mode text;
