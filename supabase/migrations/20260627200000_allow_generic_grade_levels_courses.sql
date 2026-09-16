-- Allow free-text grade levels for courses (mirror classes constraint).
--
-- The generic-grades migration 20260627000000_allow_generic_grade_levels.sql
-- relaxed classes_grade_level_check to allow any non-empty grade_level, but the
-- matching courses_grade_level_check on public.courses was left strict (only
-- NULL or the 12 Greek codes). That blocked course creation for any grade
-- whose grade_level is a free-text value such as "General" — every generic
-- institution gets a default "General" grade, so the grade-driven Create
-- Course flow failed with:
--   new row for relation "courses" violates check constraint
--   "courses_grade_level_check"
--
-- Relax the constraint to the same shape as classes so courses can be attached
-- to free-text grades. The Dashboard auto-attach matches by grade_level
-- string equality and is unaffected.

ALTER TABLE public.courses
  DROP CONSTRAINT IF EXISTS courses_grade_level_check;

ALTER TABLE public.courses
  ADD CONSTRAINT courses_grade_level_check
    CHECK (grade_level IS NULL OR char_length(trim(grade_level)) > 0);
