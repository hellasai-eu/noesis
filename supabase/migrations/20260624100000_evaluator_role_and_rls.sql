-- Evaluator role + course assignment + read-only RLS.
-- Issue #664 (epic #663). Pure DB change: adds the role, the assignment table,
-- one helper, and additive evaluator-only SELECT branches on the question
-- surface. No existing INSERT/UPDATE/DELETE policy is touched, so evaluators
-- inherit RLS's default-deny on writes.

-- ──────────────────────────────────────────────────────────────────────────
-- 1. Role membership: allow 'evaluator' on user_institutions and invitations
-- ──────────────────────────────────────────────────────────────────────────
-- user_institutions.role had no explicit CHECK constraint (only a DEFAULT).
-- Lock the role surface down now that we're adding a fourth value so future
-- inserts can't smuggle in a typo or an unsupported role.
ALTER TABLE public.user_institutions
  DROP CONSTRAINT IF EXISTS user_institutions_role_check;
ALTER TABLE public.user_institutions
  ADD CONSTRAINT user_institutions_role_check
  CHECK (role IN ('admin', 'instructor', 'student', 'evaluator'));

ALTER TABLE public.invitations
  DROP CONSTRAINT IF EXISTS invitations_role_check;
ALTER TABLE public.invitations
  ADD CONSTRAINT invitations_role_check
  CHECK (role IN ('admin', 'instructor', 'student', 'evaluator'));

-- ──────────────────────────────────────────────────────────────────────────
-- 2. course_evaluators: byte-for-byte mirror of course_instructors
--    (see 20260331000000_course_instructors_and_academic_period.sql)
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE public.course_evaluators (
  course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (course_id, user_id)
);

ALTER TABLE public.course_evaluators ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_course_evaluators_user ON public.course_evaluators(user_id);

CREATE POLICY "Admins can manage course evaluators"
  ON public.course_evaluators FOR ALL
  USING (
    is_super_admin(auth.uid())
    OR EXISTS (
      SELECT 1 FROM courses c
      WHERE c.id = course_evaluators.course_id
      AND is_institution_admin(auth.uid(), c.institution_id)
    )
  )
  WITH CHECK (
    is_super_admin(auth.uid())
    OR EXISTS (
      SELECT 1 FROM courses c
      WHERE c.id = course_evaluators.course_id
      AND is_institution_admin(auth.uid(), c.institution_id)
    )
  );

CREATE POLICY "Institution members can view course evaluators"
  ON public.course_evaluators FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM courses c
      JOIN user_institutions ui ON ui.institution_id = c.institution_id
      WHERE c.id = course_evaluators.course_id
      AND ui.user_id = auth.uid()
    )
  );

-- ──────────────────────────────────────────────────────────────────────────
-- 3. Helper: is_course_evaluator (mirrors is_course_instructor)
-- ──────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.is_course_evaluator(_course_id uuid, _user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM course_evaluators
    WHERE course_id = _course_id AND user_id = _user_id
  )
$$;

-- ──────────────────────────────────────────────────────────────────────────
-- 4. Evaluator SELECT policies (additive — existing policies untouched)
-- ──────────────────────────────────────────────────────────────────────────
-- Permissive policies OR together, so each new policy only widens SELECT for
-- evaluators on their assigned courses. No INSERT/UPDATE/DELETE branches are
-- added anywhere, so RLS's default-deny continues to block writes for the
-- evaluator role on every table below.

-- 4a. questions
CREATE POLICY "Evaluators can view questions for assigned courses"
  ON public.questions FOR SELECT
  USING (is_course_evaluator(questions.course_id, auth.uid()));

-- 4b. question_chapters
CREATE POLICY "Evaluators can view question chapters for assigned courses"
  ON public.question_chapters FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.questions q
      WHERE q.id = question_chapters.question_id
      AND is_course_evaluator(q.course_id, auth.uid())
    )
  );

-- 4c. question_competencies
CREATE POLICY "Evaluators can view question competencies for assigned courses"
  ON public.question_competencies FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.questions q
      WHERE q.id = question_competencies.question_id
      AND is_course_evaluator(q.course_id, auth.uid())
    )
  );

-- 4d. question_votes — read-only access to aggregated voting context. No
-- INSERT/UPDATE/DELETE branch: evaluators must not vote on questions.
CREATE POLICY "Evaluators can view question votes for assigned courses"
  ON public.question_votes FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.questions q
      WHERE q.id = question_votes.question_id
      AND is_course_evaluator(q.course_id, auth.uid())
    )
  );

-- 4e. courses
CREATE POLICY "Evaluators can view assigned courses"
  ON public.courses FOR SELECT
  USING (is_course_evaluator(courses.id, auth.uid()));

-- 4f. material_chapters — needed to render chapter context on a question
CREATE POLICY "Evaluators can view material chapters for assigned courses"
  ON public.material_chapters FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.course_materials cm
      WHERE cm.id = material_chapters.material_id
      AND is_course_evaluator(cm.course_id, auth.uid())
    )
  );

-- 4g. course_competencies — needed to render competency badges on a question
CREATE POLICY "Evaluators can view course competencies for assigned courses"
  ON public.course_competencies FOR SELECT
  USING (is_course_evaluator(course_competencies.course_id, auth.uid()));
