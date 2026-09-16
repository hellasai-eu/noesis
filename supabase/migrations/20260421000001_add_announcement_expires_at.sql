-- Migration: Add optional expiration date to class_announcements
-- Issue #394: Announcements support an optional expires_at. Expired announcements
-- move from the active list to a collapsible Archived section on the student
-- dashboard. NULL means never expires (the default for existing rows).
--
-- RLS policies reference course_id and the announcement_offerings junction, not
-- time, so they continue to work unchanged.

ALTER TABLE public.class_announcements
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

-- Partial index to support server-side filtering on (course_id, expires_at).
-- Filtering is currently done client-side; rows without an expiration are covered
-- by idx_class_announcements_course_created.
CREATE INDEX IF NOT EXISTS idx_class_announcements_course_expires_at
  ON public.class_announcements (course_id, expires_at)
  WHERE expires_at IS NOT NULL;
