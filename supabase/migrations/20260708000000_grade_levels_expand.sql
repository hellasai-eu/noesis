-- Expand phase: introduce a per-institution `grade_levels` table and populate
-- nullable FK columns on every table that currently carries a free-text grade.
-- The existing TEXT columns and CHECK constraints are intentionally left
-- untouched — no writer or reader in the app touches the new FKs yet. Dual-
-- write is issue #796/#797, read cutover is #798, and drop of the TEXT
-- columns is #799.
--
-- Sources of grades today (all six mentioned in the parent plan #794):
--   classes.grade_level
--   courses.grade_level
--   user_institutions.grade_level
--   invitations.invited_grade_level
--   user_institution_grades.grade_level  (institution via user_institutions)
--   horizontal_competency_grades.grade_level  (institution via horizontal_competencies)
--
-- Greek codes (isGreekGradeLevel === true) come from the fixed taxonomy in
-- src/lib/greek-school.ts and are seeded here with their canonical labels,
-- school_level, and taxonomy ordinal. Anything else is treated as a generic
-- free-text grade: label_el == label_en == code, is_generic = true, and
-- ordinal is 100 + per-institution insertion index so it can never collide
-- with the 1–12 Greek ordinals inside the same institution.

-- ============================================================================
-- 1. grade_levels table
-- ============================================================================

CREATE TABLE public.grade_levels (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
  code           text NOT NULL,
  label_el       text NOT NULL,
  label_en       text NOT NULL,
  ordinal        int  NOT NULL,
  school_level   text,
  is_generic     boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (institution_id, code),
  CHECK (school_level IS NULL OR school_level IN ('dimotiko','gymnasio','lykeio')),
  CHECK (char_length(trim(code)) > 0)
);

CREATE INDEX idx_grade_levels_institution ON public.grade_levels (institution_id);

ALTER TABLE public.grade_levels ENABLE ROW LEVEL SECURITY;

-- Policies mirror horizontal_competencies (20260426000000): institution admins
-- and super-admins can manage; every member of the institution can read.
CREATE POLICY "Admins manage grade levels"
ON public.grade_levels
FOR ALL
USING (
  is_super_admin(auth.uid()) OR
  EXISTS (
    SELECT 1 FROM public.user_institutions ui
    WHERE ui.user_id = auth.uid()
      AND ui.institution_id = grade_levels.institution_id
      AND ui.role = 'admin'
  )
);

CREATE POLICY "Institution members view grade levels"
ON public.grade_levels
FOR SELECT
USING (
  is_super_admin(auth.uid()) OR
  EXISTS (
    SELECT 1 FROM public.user_institutions ui
    WHERE ui.user_id = auth.uid()
      AND ui.institution_id = grade_levels.institution_id
  )
);

-- ============================================================================
-- 2. Backfill from every distinct (institution_id, grade string)
-- ============================================================================

WITH taxonomy(code, label_el, label_en, ordinal, school_level) AS (
  VALUES
    ('dimotiko_1', '1η Δημοτικού', '1st Grade Primary',        1,  'dimotiko'),
    ('dimotiko_2', '2η Δημοτικού', '2nd Grade Primary',        2,  'dimotiko'),
    ('dimotiko_3', '3η Δημοτικού', '3rd Grade Primary',        3,  'dimotiko'),
    ('dimotiko_4', '4η Δημοτικού', '4th Grade Primary',        4,  'dimotiko'),
    ('dimotiko_5', '5η Δημοτικού', '5th Grade Primary',        5,  'dimotiko'),
    ('dimotiko_6', '6η Δημοτικού', '6th Grade Primary',        6,  'dimotiko'),
    ('gymnasio_1', '1η Γυμνασίου', '1st Grade Middle School',  7,  'gymnasio'),
    ('gymnasio_2', '2η Γυμνασίου', '2nd Grade Middle School',  8,  'gymnasio'),
    ('gymnasio_3', '3η Γυμνασίου', '3rd Grade Middle School',  9,  'gymnasio'),
    ('lykeio_1',   '1η Λυκείου',   '1st Grade High School',    10, 'lykeio'),
    ('lykeio_2',   '2η Λυκείου',   '2nd Grade High School',    11, 'lykeio'),
    ('lykeio_3',   '3η Λυκείου',   '3rd Grade High School',    12, 'lykeio')
),
sources AS (
  SELECT DISTINCT institution_id, grade_level AS code
    FROM public.classes
    WHERE grade_level IS NOT NULL
  UNION
  SELECT DISTINCT institution_id, grade_level
    FROM public.courses
    WHERE grade_level IS NOT NULL
  UNION
  SELECT DISTINCT institution_id, grade_level
    FROM public.user_institutions
    WHERE grade_level IS NOT NULL
  UNION
  SELECT DISTINCT institution_id, invited_grade_level
    FROM public.invitations
    WHERE invited_grade_level IS NOT NULL
  UNION
  SELECT DISTINCT ui.institution_id, uig.grade_level
    FROM public.user_institution_grades uig
    JOIN public.user_institutions ui ON ui.id = uig.user_institution_id
    WHERE uig.grade_level IS NOT NULL
  UNION
  SELECT DISTINCT hc.institution_id, hcg.grade_level
    FROM public.horizontal_competency_grades hcg
    JOIN public.horizontal_competencies hc ON hc.id = hcg.competency_id
    WHERE hcg.grade_level IS NOT NULL
),
joined AS (
  SELECT
    s.institution_id,
    s.code,
    t.label_el,
    t.label_en,
    t.ordinal      AS taxonomy_ordinal,
    t.school_level,
    (t.code IS NULL) AS is_generic
  FROM sources s
  LEFT JOIN taxonomy t ON t.code = s.code
),
enriched AS (
  SELECT
    institution_id,
    code,
    COALESCE(label_el, code) AS label_el,
    COALESCE(label_en, code) AS label_en,
    COALESCE(
      taxonomy_ordinal,
      -- generic grades: partition just among the generic ones per institution
      -- so ordinals start at 100 and increment sequentially by code order.
      100 + row_number() OVER (
        PARTITION BY institution_id, is_generic
        ORDER BY code
      ) - 1
    ) AS ordinal,
    school_level,
    is_generic
  FROM joined
)
INSERT INTO public.grade_levels
  (institution_id, code, label_el, label_en, ordinal, school_level, is_generic)
SELECT
  institution_id, code, label_el, label_en, ordinal, school_level, is_generic
FROM enriched
ON CONFLICT (institution_id, code) DO NOTHING;

-- ============================================================================
-- 3. Add nullable grade_level_id FK columns to the six carrier tables
-- ============================================================================

ALTER TABLE public.classes
  ADD COLUMN grade_level_id uuid REFERENCES public.grade_levels(id) ON DELETE SET NULL;

ALTER TABLE public.courses
  ADD COLUMN grade_level_id uuid REFERENCES public.grade_levels(id) ON DELETE SET NULL;

ALTER TABLE public.user_institutions
  ADD COLUMN grade_level_id uuid REFERENCES public.grade_levels(id) ON DELETE SET NULL;

ALTER TABLE public.invitations
  ADD COLUMN invited_grade_level_id uuid REFERENCES public.grade_levels(id) ON DELETE SET NULL;

ALTER TABLE public.user_institution_grades
  ADD COLUMN grade_level_id uuid REFERENCES public.grade_levels(id) ON DELETE SET NULL;

ALTER TABLE public.horizontal_competency_grades
  ADD COLUMN grade_level_id uuid REFERENCES public.grade_levels(id) ON DELETE SET NULL;

-- ============================================================================
-- 4. Populate the FKs by (institution_id, code) match
-- ============================================================================

UPDATE public.classes c
   SET grade_level_id = gl.id
  FROM public.grade_levels gl
 WHERE gl.institution_id = c.institution_id
   AND gl.code = c.grade_level
   AND c.grade_level IS NOT NULL;

UPDATE public.courses co
   SET grade_level_id = gl.id
  FROM public.grade_levels gl
 WHERE gl.institution_id = co.institution_id
   AND gl.code = co.grade_level
   AND co.grade_level IS NOT NULL;

UPDATE public.user_institutions ui
   SET grade_level_id = gl.id
  FROM public.grade_levels gl
 WHERE gl.institution_id = ui.institution_id
   AND gl.code = ui.grade_level
   AND ui.grade_level IS NOT NULL;

UPDATE public.invitations inv
   SET invited_grade_level_id = gl.id
  FROM public.grade_levels gl
 WHERE gl.institution_id = inv.institution_id
   AND gl.code = inv.invited_grade_level
   AND inv.invited_grade_level IS NOT NULL;

UPDATE public.user_institution_grades uig
   SET grade_level_id = gl.id
  FROM public.user_institutions ui, public.grade_levels gl
 WHERE ui.id = uig.user_institution_id
   AND gl.institution_id = ui.institution_id
   AND gl.code = uig.grade_level;

UPDATE public.horizontal_competency_grades hcg
   SET grade_level_id = gl.id
  FROM public.horizontal_competencies hc, public.grade_levels gl
 WHERE hc.id = hcg.competency_id
   AND gl.institution_id = hc.institution_id
   AND gl.code = hcg.grade_level;

-- ============================================================================
-- 5. Partial indexes on each new FK for join performance in later phases
-- ============================================================================

CREATE INDEX idx_classes_grade_level_id
  ON public.classes (grade_level_id) WHERE grade_level_id IS NOT NULL;

CREATE INDEX idx_courses_grade_level_id
  ON public.courses (grade_level_id) WHERE grade_level_id IS NOT NULL;

CREATE INDEX idx_user_institutions_grade_level_id
  ON public.user_institutions (grade_level_id) WHERE grade_level_id IS NOT NULL;

CREATE INDEX idx_invitations_invited_grade_level_id
  ON public.invitations (invited_grade_level_id) WHERE invited_grade_level_id IS NOT NULL;

CREATE INDEX idx_user_institution_grades_grade_level_id
  ON public.user_institution_grades (grade_level_id) WHERE grade_level_id IS NOT NULL;

CREATE INDEX idx_horizontal_competency_grades_grade_level_id
  ON public.horizontal_competency_grades (grade_level_id) WHERE grade_level_id IS NOT NULL;

-- ============================================================================
-- 6. Parity check: every non-null grade string must have populated its FK.
-- Any orphan aborts the migration — this catches sources the backfill union
-- above missed (e.g. mid-migration race, or a future table added to the plan).
-- ============================================================================

DO $$
DECLARE
  orphan_count integer;
BEGIN
  SELECT count(*) INTO orphan_count
    FROM public.classes
   WHERE grade_level IS NOT NULL AND grade_level_id IS NULL;
  IF orphan_count > 0 THEN
    RAISE EXCEPTION 'grade_levels backfill left % orphan row(s) in classes', orphan_count;
  END IF;

  SELECT count(*) INTO orphan_count
    FROM public.courses
   WHERE grade_level IS NOT NULL AND grade_level_id IS NULL;
  IF orphan_count > 0 THEN
    RAISE EXCEPTION 'grade_levels backfill left % orphan row(s) in courses', orphan_count;
  END IF;

  SELECT count(*) INTO orphan_count
    FROM public.user_institutions
   WHERE grade_level IS NOT NULL AND grade_level_id IS NULL;
  IF orphan_count > 0 THEN
    RAISE EXCEPTION 'grade_levels backfill left % orphan row(s) in user_institutions', orphan_count;
  END IF;

  SELECT count(*) INTO orphan_count
    FROM public.invitations
   WHERE invited_grade_level IS NOT NULL AND invited_grade_level_id IS NULL;
  IF orphan_count > 0 THEN
    RAISE EXCEPTION 'grade_levels backfill left % orphan row(s) in invitations', orphan_count;
  END IF;

  SELECT count(*) INTO orphan_count
    FROM public.user_institution_grades
   WHERE grade_level IS NOT NULL AND grade_level_id IS NULL;
  IF orphan_count > 0 THEN
    RAISE EXCEPTION 'grade_levels backfill left % orphan row(s) in user_institution_grades', orphan_count;
  END IF;

  SELECT count(*) INTO orphan_count
    FROM public.horizontal_competency_grades
   WHERE grade_level IS NOT NULL AND grade_level_id IS NULL;
  IF orphan_count > 0 THEN
    RAISE EXCEPTION 'grade_levels backfill left % orphan row(s) in horizontal_competency_grades', orphan_count;
  END IF;
END $$;
