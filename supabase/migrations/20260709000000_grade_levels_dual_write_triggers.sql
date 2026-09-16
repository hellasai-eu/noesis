-- Dual-write phase for grade_levels (#796) — server side.
--
-- Update DB trigger + seed functions so that every row inserted from now on
-- populates grade_level_id alongside the legacy TEXT grade column. The TEXT
-- column stays canonical for reads (that flips in #798), so these updates
-- are additive — they never fail the caller if the FK can't be resolved.
--
-- Three functions change:
--   1. enforce_one_enrollment_per_category — prefer grade_level_id when both
--      sides carry it; fall back to the TEXT column so this migration is a
--      no-op for existing (pre-dual-write) rows.
--   2. seed_default_horizontal_competencies — after inserting the 12 grade
--      rows, populate grade_level_id from grade_levels (seeding the Greek
--      taxonomy rows on the fly for institutions that don't have them yet).
--   3. tg_auto_enable_horizontal_grades_on_school_levels — same treatment:
--      after the CROSS JOIN insert, resolve grade_level_id via a companion
--      UPDATE. Seeds missing grade_levels rows so the FK is always populated.

-- ============================================================================
-- 1. Helper: seed the 12 Greek grade_levels rows for an institution
-- ============================================================================
--
-- Called by the horizontal-competency triggers below. Idempotent — the
-- ON CONFLICT (institution_id, code) DO NOTHING makes this a no-op when
-- the rows already exist (e.g. after the #795 backfill or once #797 wires
-- up client-side writes). Runs SECURITY DEFINER so it can create rows in
-- grade_levels regardless of the caller's RLS context.

CREATE OR REPLACE FUNCTION public.ensure_greek_grade_levels(inst_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.grade_levels
    (institution_id, code, label_el, label_en, ordinal, school_level, is_generic)
  VALUES
    (inst_id, 'dimotiko_1', '1η Δημοτικού', '1st Grade Primary',        1,  'dimotiko', false),
    (inst_id, 'dimotiko_2', '2η Δημοτικού', '2nd Grade Primary',        2,  'dimotiko', false),
    (inst_id, 'dimotiko_3', '3η Δημοτικού', '3rd Grade Primary',        3,  'dimotiko', false),
    (inst_id, 'dimotiko_4', '4η Δημοτικού', '4th Grade Primary',        4,  'dimotiko', false),
    (inst_id, 'dimotiko_5', '5η Δημοτικού', '5th Grade Primary',        5,  'dimotiko', false),
    (inst_id, 'dimotiko_6', '6η Δημοτικού', '6th Grade Primary',        6,  'dimotiko', false),
    (inst_id, 'gymnasio_1', '1η Γυμνασίου', '1st Grade Middle School',  7,  'gymnasio', false),
    (inst_id, 'gymnasio_2', '2η Γυμνασίου', '2nd Grade Middle School',  8,  'gymnasio', false),
    (inst_id, 'gymnasio_3', '3η Γυμνασίου', '3rd Grade Middle School',  9,  'gymnasio', false),
    (inst_id, 'lykeio_1',   '1η Λυκείου',   '1st Grade High School',    10, 'lykeio',   false),
    (inst_id, 'lykeio_2',   '2η Λυκείου',   '2nd Grade High School',    11, 'lykeio',   false),
    (inst_id, 'lykeio_3',   '3η Λυκείου',   '3rd Grade High School',    12, 'lykeio',   false)
  ON CONFLICT (institution_id, code) DO NOTHING;
END;
$$;

GRANT EXECUTE ON FUNCTION public.ensure_greek_grade_levels(uuid) TO service_role;

-- ============================================================================
-- 2. enforce_one_enrollment_per_category — dual-key match
-- ============================================================================
--
-- Rewritten to prefer grade_level_id when both the new class and the
-- existing enrollment carry it. The two possible pairs cover every mixed
-- state during the rollout:
--   both FK non-null      → identity on id (structurally correct)
--   either FK null        → fall back to the TEXT column (legacy behavior)
-- Once every writer populates the FK (after #797), the TEXT fallback becomes
-- dead but harmless; #799 will drop it entirely.

CREATE OR REPLACE FUNCTION enforce_one_enrollment_per_category()
RETURNS TRIGGER AS $$
DECLARE
  new_class RECORD;
  existing_enrollment RECORD;
BEGIN
  -- Only enforce for student role
  IF NEW.role <> 'student' THEN
    RETURN NEW;
  END IF;

  -- Look up the class being enrolled into
  SELECT institution_id, grade_level, grade_level_id, category
  INTO new_class
  FROM classes
  WHERE id = NEW.class_id;

  -- Skip enforcement if the class has no grade_level (generic class)
  IF new_class.grade_level IS NULL AND new_class.grade_level_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Check if the student already has an enrollment in another class
  -- with the same (institution_id, grade, category). Match on the FK when
  -- both sides have it; fall back to the TEXT column otherwise.
  SELECT ce.class_id
  INTO existing_enrollment
  FROM class_enrollments ce
  JOIN classes c ON c.id = ce.class_id
  WHERE ce.user_id = NEW.user_id
    AND ce.role = 'student'
    AND c.institution_id = new_class.institution_id
    AND COALESCE(c.category, '') = COALESCE(new_class.category, '')
    AND ce.class_id <> NEW.class_id
    AND (
      (c.grade_level_id IS NOT NULL
        AND new_class.grade_level_id IS NOT NULL
        AND c.grade_level_id = new_class.grade_level_id)
      OR (
        (c.grade_level_id IS NULL OR new_class.grade_level_id IS NULL)
        AND c.grade_level = new_class.grade_level
      )
    )
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'Student already enrolled in another section of the same grade and category'
      USING ERRCODE = '23505';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- 3. seed_default_horizontal_competencies — dual-write horizontal_competency_grades
-- ============================================================================
--
-- The existing function inserts (competency_id, grade_level) rows for the
-- 12 Greek grades. Add a companion UPDATE that populates grade_level_id
-- from grade_levels matched by (institution_id, code). ensure_greek_grade_levels
-- guarantees the grade_levels rows exist before we try to resolve the FK.

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

  -- Make sure the 12 Greek grade_levels rows exist for this institution
  -- before we try to resolve the FK below.
  PERFORM public.ensure_greek_grade_levels(inst_id);

  INSERT INTO public.horizontal_competency_grades (competency_id, grade_level)
  SELECT hc.id, g.grade_level
  FROM public.horizontal_competencies hc
  CROSS JOIN (VALUES
    ('dimotiko_1'),('dimotiko_2'),('dimotiko_3'),('dimotiko_4'),('dimotiko_5'),('dimotiko_6'),
    ('gymnasio_1'),('gymnasio_2'),('gymnasio_3'),
    ('lykeio_1'),('lykeio_2'),('lykeio_3')
  ) AS g(grade_level)
  WHERE hc.institution_id = inst_id AND hc.is_default = true
  ON CONFLICT DO NOTHING;

  -- Dual-write: populate grade_level_id for every horizontal_competency_grades
  -- row we just added (and any pre-existing rows missing the FK).
  UPDATE public.horizontal_competency_grades hcg
     SET grade_level_id = gl.id
    FROM public.horizontal_competencies hc, public.grade_levels gl
   WHERE hcg.competency_id = hc.id
     AND hc.institution_id = inst_id
     AND gl.institution_id = inst_id
     AND gl.code = hcg.grade_level
     AND hcg.grade_level_id IS NULL;
END;
$$;

GRANT EXECUTE ON FUNCTION public.seed_default_horizontal_competencies(uuid)
  TO service_role;

-- ============================================================================
-- 4. tg_auto_enable_horizontal_grades_on_school_levels — same dual-write
-- ============================================================================
--
-- Fires when institutions.school_levels grows. Inserts one horizontal_
-- competency_grades row per (competency, grade) for every newly-added
-- school level. Add the same grade_level_id dual-write pass so newly-
-- enabled grades don't leave orphan FKs.

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

  -- Seed the 12 Greek grade_levels rows for this institution so the FK
  -- resolve below can't miss.
  PERFORM public.ensure_greek_grade_levels(NEW.id);

  INSERT INTO public.horizontal_competency_grades (competency_id, grade_level)
  SELECT hc.id, g.grade_level
  FROM public.horizontal_competencies hc
  CROSS JOIN (
    VALUES
      ('dimotiko', 'dimotiko_1'), ('dimotiko', 'dimotiko_2'),
      ('dimotiko', 'dimotiko_3'), ('dimotiko', 'dimotiko_4'),
      ('dimotiko', 'dimotiko_5'), ('dimotiko', 'dimotiko_6'),
      ('gymnasio', 'gymnasio_1'), ('gymnasio', 'gymnasio_2'),
      ('gymnasio', 'gymnasio_3'),
      ('lykeio', 'lykeio_1'), ('lykeio', 'lykeio_2'),
      ('lykeio', 'lykeio_3')
  ) AS g(school_level, grade_level)
  WHERE hc.institution_id = NEW.id
    AND g.school_level = ANY(added_levels)
  ON CONFLICT DO NOTHING;

  -- Dual-write: resolve grade_level_id for every row that doesn't have it.
  UPDATE public.horizontal_competency_grades hcg
     SET grade_level_id = gl.id
    FROM public.horizontal_competencies hc, public.grade_levels gl
   WHERE hcg.competency_id = hc.id
     AND hc.institution_id = NEW.id
     AND gl.institution_id = NEW.id
     AND gl.code = hcg.grade_level
     AND hcg.grade_level_id IS NULL;

  RETURN NEW;
END;
$$;
