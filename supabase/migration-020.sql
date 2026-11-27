-- SamSpy — migration 020: caption of a phone share (2026-11-27)
-- «На телефон» sends the post caption too; the phone page has «Скопировать подпись».
alter table slide_shares add column if not exists caption text;
