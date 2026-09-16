-- Allow free-text grade levels for generic (non-Greek) institutions.
--
-- Generic schools now use the same grade -> sections -> courses workflow as Greek
-- schools, but with custom grade names (e.g. "General", "Year 1") instead of the
-- fixed Greek taxonomy. The old classes_grade_level_check only permitted NULL or
-- the 12 Greek grade values, which rejected those custom grades.
--
-- Relax the constraint to allow any non-empty grade_level. Greek institutions
-- still emit only valid taxonomy values via the grade dropdown (app-level
-- enforcement); this constraint just guards against empty/whitespace values.
-- The unique index classes_institution_grade_section_unique
-- (institution_id, grade_level, section_name) is unaffected and continues to
-- enforce one row per grade + section.

ALTER TABLE public.classes
  DROP CONSTRAINT IF EXISTS classes_grade_level_check;

ALTER TABLE public.classes
  ADD CONSTRAINT classes_grade_level_check
    CHECK (grade_level IS NULL OR char_length(trim(grade_level)) > 0);
