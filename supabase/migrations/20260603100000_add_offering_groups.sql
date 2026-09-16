-- Student groups within an offering with group-scoped content assignment (issue #500)
--
-- Adds:
--   * offering_groups + offering_group_members tables
--   * is_offering_group_member() SECURITY DEFINER helper
--   * nullable group_id on all 7 offering_* assignment tables
--   * group-aware UNIQUE constraints (NULLS NOT DISTINCT so whole-class + group can coexist)
--   * updated "Students see published ..." RLS policies on every assignment table
--   * membership-integrity trigger (student must be enrolled in the offering's class)
--   * enrollment-cleanup trigger (removing a student from a class purges their group memberships)

-- ============================================================================
-- 1. Tables
-- ============================================================================

CREATE TABLE public.offering_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  offering_id uuid NOT NULL REFERENCES public.offerings(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (offering_id, name)
);

CREATE INDEX idx_offering_groups_offering ON public.offering_groups(offering_id);

CREATE TABLE public.offering_group_members (
  group_id uuid NOT NULL REFERENCES public.offering_groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  added_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);

CREATE INDEX idx_offering_group_members_user ON public.offering_group_members(user_id);

-- ============================================================================
-- 2. Updated-at trigger on offering_groups
-- ============================================================================

CREATE TRIGGER update_offering_groups_updated_at
  BEFORE UPDATE ON public.offering_groups
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================================================
-- 3. SECURITY DEFINER helper for student-side RLS
-- ============================================================================

CREATE OR REPLACE FUNCTION public.is_offering_group_member(_group_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.offering_group_members
    WHERE group_id = _group_id AND user_id = auth.uid()
  )
$$;

-- ============================================================================
-- 4. Add nullable group_id to every offering_* assignment table
--    + replace UNIQUE constraints so the same content can be assigned both
--      whole-class (group_id NULL) and to a specific group.
-- ============================================================================

ALTER TABLE public.offering_questions
  ADD COLUMN group_id uuid REFERENCES public.offering_groups(id) ON DELETE CASCADE;
ALTER TABLE public.offering_questions
  DROP CONSTRAINT IF EXISTS offering_questions_offering_id_question_id_key;
ALTER TABLE public.offering_questions
  ADD CONSTRAINT offering_questions_offering_question_group_key
    UNIQUE NULLS NOT DISTINCT (offering_id, question_id, group_id);
CREATE INDEX IF NOT EXISTS idx_offering_questions_group ON public.offering_questions(group_id);

ALTER TABLE public.offering_open_questions
  ADD COLUMN group_id uuid REFERENCES public.offering_groups(id) ON DELETE CASCADE;
ALTER TABLE public.offering_open_questions
  DROP CONSTRAINT IF EXISTS offering_open_questions_offering_id_open_question_id_key;
ALTER TABLE public.offering_open_questions
  ADD CONSTRAINT offering_open_questions_offering_oq_group_key
    UNIQUE NULLS NOT DISTINCT (offering_id, open_question_id, group_id);
CREATE INDEX IF NOT EXISTS idx_offering_open_questions_group ON public.offering_open_questions(group_id);

ALTER TABLE public.offering_quizzes
  ADD COLUMN group_id uuid REFERENCES public.offering_groups(id) ON DELETE CASCADE;
ALTER TABLE public.offering_quizzes
  DROP CONSTRAINT IF EXISTS offering_quizzes_offering_id_quiz_id_key;
ALTER TABLE public.offering_quizzes
  ADD CONSTRAINT offering_quizzes_offering_quiz_group_key
    UNIQUE NULLS NOT DISTINCT (offering_id, quiz_id, group_id);
CREATE INDEX IF NOT EXISTS idx_offering_quizzes_group ON public.offering_quizzes(group_id);

ALTER TABLE public.offering_tests
  ADD COLUMN group_id uuid REFERENCES public.offering_groups(id) ON DELETE CASCADE;
ALTER TABLE public.offering_tests
  DROP CONSTRAINT IF EXISTS offering_tests_offering_id_test_id_key;
ALTER TABLE public.offering_tests
  ADD CONSTRAINT offering_tests_offering_test_group_key
    UNIQUE NULLS NOT DISTINCT (offering_id, test_id, group_id);
CREATE INDEX IF NOT EXISTS idx_offering_tests_group ON public.offering_tests(group_id);

ALTER TABLE public.offering_study_sessions
  ADD COLUMN group_id uuid REFERENCES public.offering_groups(id) ON DELETE CASCADE;
ALTER TABLE public.offering_study_sessions
  DROP CONSTRAINT IF EXISTS offering_study_sessions_offering_id_study_session_id_key;
ALTER TABLE public.offering_study_sessions
  ADD CONSTRAINT offering_study_sessions_offering_ss_group_key
    UNIQUE NULLS NOT DISTINCT (offering_id, study_session_id, group_id);
CREATE INDEX IF NOT EXISTS idx_offering_study_sessions_group ON public.offering_study_sessions(group_id);

ALTER TABLE public.offering_chapter_flashcards
  ADD COLUMN group_id uuid REFERENCES public.offering_groups(id) ON DELETE CASCADE;
ALTER TABLE public.offering_chapter_flashcards
  DROP CONSTRAINT IF EXISTS offering_chapter_flashcards_offering_id_chapter_id_key;
ALTER TABLE public.offering_chapter_flashcards
  ADD CONSTRAINT offering_chapter_flashcards_offering_chapter_group_key
    UNIQUE NULLS NOT DISTINCT (offering_id, chapter_id, group_id);
CREATE INDEX IF NOT EXISTS idx_offering_chapter_flashcards_group ON public.offering_chapter_flashcards(group_id);

ALTER TABLE public.offering_chapter_cheatsheets
  ADD COLUMN group_id uuid REFERENCES public.offering_groups(id) ON DELETE CASCADE;
ALTER TABLE public.offering_chapter_cheatsheets
  DROP CONSTRAINT IF EXISTS offering_chapter_cheatsheets_offering_id_chapter_id_key;
ALTER TABLE public.offering_chapter_cheatsheets
  ADD CONSTRAINT offering_chapter_cheatsheets_offering_chapter_group_key
    UNIQUE NULLS NOT DISTINCT (offering_id, chapter_id, group_id);
CREATE INDEX IF NOT EXISTS idx_offering_chapter_cheatsheets_group ON public.offering_chapter_cheatsheets(group_id);

-- ============================================================================
-- 5. RLS for offering_groups + offering_group_members
-- ============================================================================

ALTER TABLE public.offering_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.offering_group_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Managers can manage offering groups"
  ON public.offering_groups
  FOR ALL
  USING (public.can_manage_offering(offering_id))
  WITH CHECK (public.can_manage_offering(offering_id));

CREATE POLICY "Students see their own offering groups"
  ON public.offering_groups
  FOR SELECT
  USING (public.is_offering_group_member(id));

CREATE POLICY "Managers can manage offering group members"
  ON public.offering_group_members
  FOR ALL
  USING (
    public.can_manage_offering(
      (SELECT offering_id FROM public.offering_groups WHERE id = group_id)
    )
  )
  WITH CHECK (
    public.can_manage_offering(
      (SELECT offering_id FROM public.offering_groups WHERE id = group_id)
    )
  );

CREATE POLICY "Students see their own group memberships"
  ON public.offering_group_members
  FOR SELECT
  USING (user_id = auth.uid());

-- ============================================================================
-- 6. Update each "Students see published ..." policy on the 7 assignment tables
--    to incorporate the group predicate.
-- ============================================================================

DROP POLICY IF EXISTS "Students see published questions" ON public.offering_questions;
CREATE POLICY "Students see published questions"
  ON public.offering_questions
  FOR SELECT
  USING (
    published_at IS NOT NULL
    AND public.has_offering_access(offering_id)
    AND (group_id IS NULL OR public.is_offering_group_member(group_id))
  );

DROP POLICY IF EXISTS "Students see published open questions" ON public.offering_open_questions;
CREATE POLICY "Students see published open questions"
  ON public.offering_open_questions
  FOR SELECT
  USING (
    published_at IS NOT NULL
    AND public.has_offering_access(offering_id)
    AND (group_id IS NULL OR public.is_offering_group_member(group_id))
  );

DROP POLICY IF EXISTS "Students see published quizzes" ON public.offering_quizzes;
CREATE POLICY "Students see published quizzes"
  ON public.offering_quizzes
  FOR SELECT
  USING (
    published_at IS NOT NULL
    AND public.has_offering_access(offering_id)
    AND (group_id IS NULL OR public.is_offering_group_member(group_id))
  );

DROP POLICY IF EXISTS "Students see published tests" ON public.offering_tests;
CREATE POLICY "Students see published tests"
  ON public.offering_tests
  FOR SELECT
  USING (
    published_at IS NOT NULL
    AND public.has_offering_access(offering_id)
    AND (group_id IS NULL OR public.is_offering_group_member(group_id))
  );

DROP POLICY IF EXISTS "Students see published study sessions" ON public.offering_study_sessions;
CREATE POLICY "Students see published study sessions"
  ON public.offering_study_sessions
  FOR SELECT
  USING (
    published_at IS NOT NULL
    AND public.has_offering_access(offering_id)
    AND (group_id IS NULL OR public.is_offering_group_member(group_id))
  );

DROP POLICY IF EXISTS "Students see published chapter flashcards" ON public.offering_chapter_flashcards;
CREATE POLICY "Students see published chapter flashcards"
  ON public.offering_chapter_flashcards
  FOR SELECT
  USING (
    published_at IS NOT NULL
    AND public.has_offering_access(offering_id)
    AND (group_id IS NULL OR public.is_offering_group_member(group_id))
  );

DROP POLICY IF EXISTS "Students see published chapter cheatsheets" ON public.offering_chapter_cheatsheets;
CREATE POLICY "Students see published chapter cheatsheets"
  ON public.offering_chapter_cheatsheets
  FOR SELECT
  USING (
    published_at IS NOT NULL
    AND public.has_offering_access(offering_id)
    AND (group_id IS NULL OR public.is_offering_group_member(group_id))
  );

-- ============================================================================
-- 7. Membership integrity: a group member must be enrolled (as student) in the
--    group's offering's class.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.enforce_offering_group_member_enrollment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_class_id uuid;
  v_enrolled boolean;
BEGIN
  SELECT o.class_id
    INTO v_class_id
    FROM public.offering_groups g
    JOIN public.offerings o ON o.id = g.offering_id
   WHERE g.id = NEW.group_id;

  IF v_class_id IS NULL THEN
    RAISE EXCEPTION 'Offering group % no longer exists', NEW.group_id;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.class_enrollments
     WHERE class_id = v_class_id
       AND user_id = NEW.user_id
       AND role = 'student'
  ) INTO v_enrolled;

  IF NOT v_enrolled THEN
    RAISE EXCEPTION 'User % is not a student enrolled in class %', NEW.user_id, v_class_id;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER offering_group_members_enrollment_check
  BEFORE INSERT OR UPDATE ON public.offering_group_members
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_offering_group_member_enrollment();

-- ============================================================================
-- 8. Auto-cleanup: removing a student from a class drops their group memberships
--    for any group whose offering lives in that class.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.cleanup_offering_group_members_on_enrollment_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.offering_group_members
   WHERE user_id = OLD.user_id
     AND group_id IN (
       SELECT og.id
         FROM public.offering_groups og
         JOIN public.offerings o ON o.id = og.offering_id
        WHERE o.class_id = OLD.class_id
     );
  RETURN OLD;
END;
$$;

CREATE TRIGGER class_enrollments_cleanup_group_members
  AFTER DELETE ON public.class_enrollments
  FOR EACH ROW
  EXECUTE FUNCTION public.cleanup_offering_group_members_on_enrollment_delete();
