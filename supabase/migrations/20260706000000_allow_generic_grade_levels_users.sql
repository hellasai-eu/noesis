-- Allow free-text grade levels on user grade columns (mirror classes/courses).
--
-- Migrations 20260627000000_allow_generic_grade_levels.sql and
-- 20260627200000_allow_generic_grade_levels_courses.sql relaxed
-- classes_grade_level_check and courses_grade_level_check so generic
-- (non-Greek) institutions can use free-text grades like "General".
--
-- The user-side grade columns were left locked to the 12 Greek taxonomy
-- values, so a student created in a generic institution could never be
-- tagged with the grade their class uses. Grade-based filtering in
-- fetchAvailableUsers (src/components/class-management/hooks/useClassManagement.ts)
-- silently hides those students from the section "Add students" picker,
-- breaking enrollment.
--
-- Relax the three user grade constraints to the same shape as classes
-- (NULL or non-empty), so a generic grade value flows end-to-end:
-- invitation.invited_grade_level → user_institutions.grade_level →
-- matches classes.grade_level in the enrollment picker. Greek
-- institutions still emit only taxonomy values via the app-level grade
-- dropdown (now derived from the institution's actual classes), so this
-- change does not weaken their data quality.
--
-- Note: existing mis-tagged students (grade_level = NULL because the
-- Greek-only insert failed silently) may need a manual re-tag via the
-- inline grade selector after this migration runs.

ALTER TABLE public.user_institutions
  DROP CONSTRAINT IF EXISTS user_institutions_grade_level_check;

ALTER TABLE public.user_institutions
  ADD CONSTRAINT user_institutions_grade_level_check
    CHECK (grade_level IS NULL OR char_length(trim(grade_level)) > 0);

ALTER TABLE public.invitations
  DROP CONSTRAINT IF EXISTS invitations_invited_grade_level_check;

ALTER TABLE public.invitations
  ADD CONSTRAINT invitations_invited_grade_level_check
    CHECK (invited_grade_level IS NULL OR char_length(trim(invited_grade_level)) > 0);

-- user_institution_grades' original check was table-level and anonymous
-- (see 20260330000000_user_institution_grades.sql). Postgres names such
-- checks like <table>_check[N], not <table>_<column>_check. Drop any
-- CHECK on the table that references the Greek taxonomy, then add a
-- named non-empty check so future migrations can drop it explicitly.
DO $$
DECLARE
  con_name text;
BEGIN
  FOR con_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.user_institution_grades'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%dimotiko_1%'
  LOOP
    EXECUTE format(
      'ALTER TABLE public.user_institution_grades DROP CONSTRAINT %I',
      con_name
    );
  END LOOP;
END $$;

ALTER TABLE public.user_institution_grades
  DROP CONSTRAINT IF EXISTS user_institution_grades_grade_level_check;

-- grade_level is NOT NULL on this table (instructor multi-grade
-- assignments); require non-empty rather than allowing NULL.
ALTER TABLE public.user_institution_grades
  ADD CONSTRAINT user_institution_grades_grade_level_check
    CHECK (char_length(trim(grade_level)) > 0);
