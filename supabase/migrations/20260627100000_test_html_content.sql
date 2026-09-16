-- Issue #728: rich-text test editor with page breaks + font sizes.
--
-- Add two nullable columns to `tests` so instructors can store an editable
-- HTML snapshot of the printable test document alongside the legacy
-- `custom_header` markdown header. The HTML path is additive — when
-- `html_content` is NULL the existing markdown/HTML export pipeline
-- continues to render from `tests` + `test_questions`. When it's set,
-- the new HTML→PDF function consumes it directly so instructors get the
-- exact layout (page breaks, font sizes, headings) they assembled.
--
-- Reuses existing `tests` RLS — no policy changes.

ALTER TABLE public.tests
  ADD COLUMN IF NOT EXISTS html_content TEXT NULL,
  ADD COLUMN IF NOT EXISTS html_updated_at TIMESTAMPTZ NULL;
