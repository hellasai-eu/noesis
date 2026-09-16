-- Contract phase for the grade_levels normalization (#799).
--
-- After #798 flipped every read/filter to grade_level_id and #796/#797 dual-
-- wrote the FK on every insert, the six legacy TEXT columns are dead reads.
-- This migration:
--   1. Drops the CHECK constraints and stale indexes/uniques keyed on the
--      string.
--   2. Rebuilds the indexes and uniqueness on grade_level_id.
--   3. Sets grade_level_id NOT NULL on the two tables where the string was
--      required (user_institution_grades, horizontal_competency_grades).
--   4. Drops the six TEXT columns.
--   5. Rewrites the three trigger functions to work on grade_level_id only.

-- ============================================================================
-- 1. Drop CHECK constraints on the legacy TEXT columns
-- ============================================================================

ALTER TABLE public.classes
  DROP CONSTRAINT IF EXISTS classes_grade_level_check;

ALTER TABLE public.courses
  DROP CONSTRAINT IF EXISTS courses_grade_level_check;

ALTER TABLE public.user_institutions
  DROP CONSTRAINT IF EXISTS user_institutions_grade_level_check;

ALTER TABLE public.invitations
  DROP CONSTRAINT IF EXISTS invitations_invited_grade_level_check;

ALTER TABLE public.user_institution_grades
  DROP CONSTRAINT IF EXISTS user_institution_grades_grade_level_check;

-- horizontal_competency_grades' original CHECK was anonymous (see
-- 20260426000000_horizontal_competencies.sql). Sweep any CHECK on the table
-- that mentions the Greek taxonomy, mirroring the pattern in
-- 20260706000000_allow_generic_grade_levels_users.sql.
DO $$
DECLARE
  con_name text;
BEGIN
  FOR con_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.horizontal_competency_grades'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%dimotiko_1%'
  LOOP
    EXECUTE format(
      'ALTER TABLE public.horizontal_competency_grades DROP CONSTRAINT %I',
      con_name
    );
  END LOOP;
END $$;

-- ============================================================================
-- 2. Drop stale indexes/uniques keyed on the string
-- ============================================================================

-- 20260329000000_add_grade_level_to_user_institutions.sql
DROP INDEX IF EXISTS public.idx_user_institutions_grade;

-- 20260328000000_grade_level_sections.sql
DROP INDEX IF EXISTS public.classes_institution_grade_level_idx;

-- 20260416130000_add_class_categories.sql (this replaces the earlier
-- classes_institution_grade_section_unique from 20260328000000_).
DROP INDEX IF EXISTS public.classes_institution_grade_section_category_unique;

-- 20260426000000_horizontal_competencies.sql
DROP INDEX IF EXISTS public.idx_horizontal_competency_grades_grade_level;

-- ============================================================================
-- 3. Rebuild indexes and uniqueness on grade_level_id
-- ============================================================================

-- classes: one (grade, category, section) per institution — mirrors the shape
-- of classes_institution_grade_section_category_unique but keys on the FK.
CREATE UNIQUE INDEX IF NOT EXISTS classes_institution_grade_id_section_category_unique
  ON public.classes (
    institution_id,
    grade_level_id,
    COALESCE(category, ''),
    section_name
  )
  WHERE grade_level_id IS NOT NULL AND section_name IS NOT NULL;

-- Hot path for grouping/filtering classes by grade at the institution level.
CREATE INDEX IF NOT EXISTS classes_institution_grade_level_id_idx
  ON public.classes (institution_id, grade_level_id)
  WHERE grade_level_id IS NOT NULL;

-- Replace the legacy student-grade filter index.
CREATE INDEX IF NOT EXISTS idx_user_institutions_grade_id_students
  ON public.user_institutions (institution_id, role, grade_level_id)
  WHERE role = 'student';

-- Cross-competency lookup path (used by evaluate-horizontal-competencies).
CREATE INDEX IF NOT EXISTS idx_horizontal_competency_grades_grade_level_id_lookup
  ON public.horizontal_competency_grades (grade_level_id);

-- ============================================================================
-- 4. Set NOT NULL on grade_level_id where the TEXT column was required
-- ============================================================================

-- Defensive: dual-write has been on for weeks, but backfill any residual NULLs
-- from the (institution, code) match before the NOT NULL flip so the migration
-- can't fail on legacy rows.
UPDATE public.user_institution_grades uig
   SET grade_level_id = gl.id
  FROM public.user_institutions ui, public.grade_levels gl
 WHERE ui.id = uig.user_institution_id
   AND gl.institution_id = ui.institution_id
   AND gl.code = uig.grade_level
   AND uig.grade_level_id IS NULL;

UPDATE public.horizontal_competency_grades hcg
   SET grade_level_id = gl.id
  FROM public.horizontal_competencies hc, public.grade_levels gl
 WHERE hc.id = hcg.competency_id
   AND gl.institution_id = hc.institution_id
   AND gl.code = hcg.grade_level
   AND hcg.grade_level_id IS NULL;

-- Preflight: abort if any row still has grade_level_id = NULL after backfill.
-- This catches rows whose grade_level text had no matching grade_levels entry
-- (e.g. NULL grade_level, or a code that was never seeded), so the NOT NULL
-- flip below fails explicitly rather than with a cryptic constraint error.
DO $$
DECLARE
  null_count integer;
BEGIN
  SELECT count(*) INTO null_count
    FROM public.user_institution_grades
   WHERE grade_level_id IS NULL;
  IF null_count > 0 THEN
    RAISE EXCEPTION
      'Cannot set grade_level_id NOT NULL: % row(s) in user_institution_grades still NULL after backfill — fix or delete those rows first',
      null_count;
  END IF;

  SELECT count(*) INTO null_count
    FROM public.horizontal_competency_grades
   WHERE grade_level_id IS NULL;
  IF null_count > 0 THEN
    RAISE EXCEPTION
      'Cannot set grade_level_id NOT NULL: % row(s) in horizontal_competency_grades still NULL after backfill — fix or delete those rows first',
      null_count;
  END IF;
END $$;

ALTER TABLE public.user_institution_grades
  ALTER COLUMN grade_level_id SET NOT NULL;

ALTER TABLE public.horizontal_competency_grades
  ALTER COLUMN grade_level_id SET NOT NULL;

-- ============================================================================
-- 5. Rebuild uniqueness on grade_level_id for the two required tables
-- ============================================================================

-- user_institution_grades used UNIQUE(user_institution_id, grade_level).
-- Add the FK-keyed equivalent before dropping the string one.
ALTER TABLE public.user_institution_grades
  ADD CONSTRAINT user_institution_grades_ui_id_grade_level_id_key
    UNIQUE (user_institution_id, grade_level_id);

ALTER TABLE public.user_institution_grades
  DROP CONSTRAINT IF EXISTS user_institution_grades_user_institution_id_grade_level_key;

-- horizontal_competency_grades used PRIMARY KEY (competency_id, grade_level).
-- Swap in an FK-keyed PK before dropping the old.
ALTER TABLE public.horizontal_competency_grades
  DROP CONSTRAINT IF EXISTS horizontal_competency_grades_pkey;

ALTER TABLE public.horizontal_competency_grades
  ADD CONSTRAINT horizontal_competency_grades_pkey
    PRIMARY KEY (competency_id, grade_level_id);

-- ============================================================================
-- 6. Rewrite triggers so they never reference the TEXT columns
-- ============================================================================

-- enforce_one_enrollment_per_category — FK-identity only.
CREATE OR REPLACE FUNCTION enforce_one_enrollment_per_category()
RETURNS TRIGGER AS $$
DECLARE
  new_class RECORD;
  existing_enrollment RECORD;
BEGIN
  IF NEW.role <> 'student' THEN
    RETURN NEW;
  END IF;

  SELECT institution_id, grade_level_id, category
  INTO new_class
  FROM classes
  WHERE id = NEW.class_id;

  -- Generic classes (no grade) never conflict.
  IF new_class.grade_level_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT ce.class_id
  INTO existing_enrollment
  FROM class_enrollments ce
  JOIN classes c ON c.id = ce.class_id
  WHERE ce.user_id = NEW.user_id
    AND ce.role = 'student'
    AND c.institution_id = new_class.institution_id
    AND c.grade_level_id = new_class.grade_level_id
    AND COALESCE(c.category, '') = COALESCE(new_class.category, '')
    AND ce.class_id <> NEW.class_id
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'Student already enrolled in another section of the same grade and category'
      USING ERRCODE = '23505';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- seed_default_horizontal_competencies — insert the FK directly. The Greek
-- grade_levels rows are guaranteed to exist because ensure_greek_grade_levels
-- runs first (idempotent).
CREATE OR REPLACE FUNCTION public.seed_default_horizontal_competencies(inst_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  lang text;
BEGIN
  SELECT default_language INTO lang
  FROM public.institutions
  WHERE id = inst_id;

  IF lang IS NULL THEN
    lang := 'en';
  END IF;

  IF lang = 'el' THEN
    INSERT INTO public.horizontal_competencies
      (institution_id, title, description, is_default, order_num)
    VALUES
      (inst_id, 'Επίλυση Προβλημάτων',
        'Ικανότητα προσέγγισης προβλημάτων με δομημένο και αποτελεσματικό τρόπο, αναλύοντάς τα σε βήματα και προχωρώντας λογικά προς τη λύση',
        true, 0),
      (inst_id, 'Λογική Σκέψη',
        'Ικανότητα εξαγωγής ορθών συμπερασμάτων από δεδομένες πληροφορίες, εφαρμόζοντας τη λογική με συνέπεια και αποφεύγοντας άκυρες παραδοχές',
        true, 1),
      (inst_id, 'Εννοιολογική Κατανόηση',
        'Βάθος κατανόησης των υποκείμενων ιδεών, που αποδεικνύεται με την εφαρμογή της γνώσης σε νέες καταστάσεις αντί της εξάρτησης από απομνημονευμένα μοτίβα',
        true, 2),
      (inst_id, 'Ανίχνευση & Διόρθωση Σφαλμάτων',
        'Ικανότητα αναγνώρισης λαθών, κατανόησης του λόγου εμφάνισής τους και αποτελεσματικής βελτίωσης ή διόρθωσής τους',
        true, 3)
    ON CONFLICT (institution_id, lower(btrim(title))) DO NOTHING;
  ELSE
    INSERT INTO public.horizontal_competencies
      (institution_id, title, description, is_default, order_num)
    VALUES
      (inst_id, 'Problem Solving',
        'Ability to approach problems in a structured and effective way, breaking them into steps and progressing logically toward a solution',
        true, 0),
      (inst_id, 'Reasoning',
        'Ability to draw correct conclusions from given information, applying logic consistently and avoiding invalid assumptions',
        true, 1),
      (inst_id, 'Conceptual Understanding',
        'Depth of understanding of underlying ideas, shown by applying knowledge to new situations rather than relying on memorized patterns',
        true, 2),
      (inst_id, 'Error Detection & Correction',
        'Ability to recognize mistakes, understand why they occurred, and improve or correct them effectively',
        true, 3)
    ON CONFLICT (institution_id, lower(btrim(title))) DO NOTHING;
  END IF;

  PERFORM public.ensure_greek_grade_levels(inst_id);

  INSERT INTO public.horizontal_competency_grades (competency_id, grade_level_id)
  SELECT hc.id, gl.id
  FROM public.horizontal_competencies hc
  JOIN public.grade_levels gl ON gl.institution_id = inst_id
  WHERE hc.institution_id = inst_id
    AND hc.is_default = true
    AND gl.code IN (
      'dimotiko_1','dimotiko_2','dimotiko_3','dimotiko_4','dimotiko_5','dimotiko_6',
      'gymnasio_1','gymnasio_2','gymnasio_3',
      'lykeio_1','lykeio_2','lykeio_3'
    )
  ON CONFLICT DO NOTHING;
END;
$$;

-- tg_auto_enable_horizontal_grades_on_school_levels — same treatment.
CREATE OR REPLACE FUNCTION public.tg_auto_enable_horizontal_grades_on_school_levels()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  added_levels TEXT[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    added_levels := COALESCE(NEW.school_levels, ARRAY[]::TEXT[]);
  ELSE
    added_levels := ARRAY(
      SELECT unnest(NEW.school_levels)
      EXCEPT
      SELECT unnest(COALESCE(OLD.school_levels, ARRAY[]::TEXT[]))
    );
  END IF;

  IF array_length(added_levels, 1) IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM public.ensure_greek_grade_levels(NEW.id);

  INSERT INTO public.horizontal_competency_grades (competency_id, grade_level_id)
  SELECT hc.id, gl.id
  FROM public.horizontal_competencies hc
  JOIN public.grade_levels gl ON gl.institution_id = NEW.id
  WHERE hc.institution_id = NEW.id
    AND gl.school_level = ANY(added_levels)
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$;

-- ============================================================================
-- 7. Drop the six legacy TEXT columns
-- ============================================================================

-- Defensive: the expand migration (#798) backfilled invited_grade_level_id at
-- that point in time, but invitations created afterwards (before this contract
-- migration) may have slipped through if dual-write was not yet active. Catch
-- them here the same way the other tables were handled above.
UPDATE public.invitations inv
   SET invited_grade_level_id = gl.id
  FROM public.grade_levels gl
 WHERE gl.institution_id = inv.institution_id
   AND gl.code = inv.invited_grade_level
   AND inv.invited_grade_level IS NOT NULL
   AND inv.invited_grade_level_id IS NULL;

ALTER TABLE public.classes                    DROP COLUMN grade_level;
ALTER TABLE public.courses                    DROP COLUMN grade_level;
ALTER TABLE public.user_institutions          DROP COLUMN grade_level;
ALTER TABLE public.invitations                DROP COLUMN invited_grade_level;
ALTER TABLE public.user_institution_grades    DROP COLUMN grade_level;
ALTER TABLE public.horizontal_competency_grades DROP COLUMN grade_level;
