-- Question-evaluation schema: sessions + per-question responses.
-- Issue #665 (epic #663). Pure DB change: two new tables with RLS that lets
-- evaluators own their own rows, and lets instructors/admins of the same
-- course read-only. Fully independent of `questions.validation_status` — no
-- reads or writes touch it.
--
-- Naming intentionally avoids the taken `*evaluation*` names
-- (`student_evaluations`, `generate-student-evaluation`,
-- `evaluation_timeline_cache`) per epic #663 and issue #665. The codes stored
-- here are stable English keys; Greek display labels live in the UI (#668).

-- ──────────────────────────────────────────────────────────────────────────
-- 1. question_evaluation_sessions — one reviewing sitting
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE public.question_evaluation_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evaluator_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz NULL,
  overall_quality int NULL CHECK (overall_quality BETWEEN 1 AND 5),
  recurring_problems text NULL,
  would_use text NULL CHECK (would_use IN ('yes_asis','yes_with_fixes','no')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_question_evaluation_sessions_evaluator
  ON public.question_evaluation_sessions(evaluator_id);
CREATE INDEX idx_question_evaluation_sessions_course
  ON public.question_evaluation_sessions(course_id);

ALTER TABLE public.question_evaluation_sessions ENABLE ROW LEVEL SECURITY;

-- Evaluator owns their own rows: SELECT/INSERT/UPDATE only — DELETE is
-- excluded because question_evaluations.session_id is ON DELETE CASCADE, so
-- deleting a session would silently remove all its evaluation rows. Revoking
-- course_evaluators immediately revokes write access without needing to delete
-- historical sessions.
CREATE POLICY "Evaluators can select their own sessions"
  ON public.question_evaluation_sessions FOR SELECT
  USING (
    evaluator_id = auth.uid()
    AND public.is_course_evaluator(course_id, auth.uid())
  );

CREATE POLICY "Evaluators can insert their own sessions"
  ON public.question_evaluation_sessions FOR INSERT
  WITH CHECK (
    evaluator_id = auth.uid()
    AND public.is_course_evaluator(course_id, auth.uid())
  );

CREATE POLICY "Evaluators can update their own sessions"
  ON public.question_evaluation_sessions FOR UPDATE
  USING (
    evaluator_id = auth.uid()
    AND public.is_course_evaluator(course_id, auth.uid())
  )
  WITH CHECK (
    evaluator_id = auth.uid()
    AND public.is_course_evaluator(course_id, auth.uid())
  );

-- Instructors/admins of the same course: read-only. Mirrors the question
-- surface in #664 — no write branches, so RLS default-deny continues to
-- block INSERT/UPDATE/DELETE for these roles.
CREATE POLICY "Course staff can read sessions"
  ON public.question_evaluation_sessions FOR SELECT
  USING (
    public.is_super_admin(auth.uid())
    OR public.is_course_instructor(course_id, auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.courses c
      WHERE c.id = question_evaluation_sessions.course_id
        AND public.is_institution_admin(auth.uid(), c.institution_id)
    )
  );

-- ──────────────────────────────────────────────────────────────────────────
-- 2. question_evaluations — one row per (evaluator, question), updatable
-- ──────────────────────────────────────────────────────────────────────────
-- The 13 stable problem-category codes. Stored in problem_categories text[];
-- the CHECK rejects any element outside this set. Greek display labels live
-- in the UI (#668).
CREATE TABLE public.question_evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.question_evaluation_sessions(id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES public.questions(id) ON DELETE CASCADE,
  evaluator_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  verdict text NOT NULL CHECK (verdict IN ('good','needs_fixing','reject')),
  difficulty_confirmation text NOT NULL CHECK (difficulty_confirmation IN ('correct','easier','harder')),
  scientifically_accurate boolean NOT NULL,
  stated_answer_correct boolean NOT NULL,
  exactly_one_correct boolean NOT NULL,
  distractors_wrong boolean NOT NULL,
  clarity int NOT NULL CHECK (clarity BETWEEN 1 AND 5),
  distractor_quality int NOT NULL CHECK (distractor_quality BETWEEN 1 AND 5),
  curriculum_alignment int NOT NULL CHECK (curriculum_alignment BETWEEN 1 AND 5),
  question_bank_alignment int NOT NULL CHECK (question_bank_alignment BETWEEN 1 AND 5),
  pedagogical_value int NOT NULL CHECK (pedagogical_value BETWEEN 1 AND 5),
  language_appropriateness int NOT NULL CHECK (language_appropriateness BETWEEN 1 AND 5),
  problem_categories text[] NOT NULL DEFAULT '{}'::text[],
  comment text NULL,
  was_sampled boolean NOT NULL DEFAULT false,
  cognitive_level text NULL CHECK (cognitive_level IN ('recall','understanding','application_analysis')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT question_evaluations_evaluator_question_unique UNIQUE (evaluator_id, question_id),
  -- Every element of problem_categories must be one of the 13 stable codes.
  -- Empty arrays are allowed (verdict='good' generally has none).
  CONSTRAINT question_evaluations_problem_categories_check
    CHECK (problem_categories <@ ARRAY[
      'wrong_stated_answer',
      'content_error',
      'ambiguous_multiple_correct',
      'weak_distractors',
      'out_of_syllabus',
      'wrong_difficulty',
      'unclear_stem',
      'grammatical_giveaway',
      'low_value',
      'inappropriate_language',
      'bias',
      'duplicate',
      'other'
    ]::text[]),
  -- cognitive_level is present iff was_sampled is true. Enforces #663's
  -- "sampled ~1 in 5 per session" coupling at the DB layer.
  CONSTRAINT question_evaluations_sampled_cognitive_level_check
    CHECK ((was_sampled AND cognitive_level IS NOT NULL)
        OR (NOT was_sampled AND cognitive_level IS NULL))
);

CREATE INDEX idx_question_evaluations_question
  ON public.question_evaluations(question_id);
CREATE INDEX idx_question_evaluations_session
  ON public.question_evaluations(session_id);
CREATE INDEX idx_question_evaluations_evaluator
  ON public.question_evaluations(evaluator_id);

CREATE TRIGGER update_question_evaluations_updated_at
  BEFORE UPDATE ON public.question_evaluations
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.question_evaluations ENABLE ROW LEVEL SECURITY;

-- Evaluator owns their own rows. The course is derived from the referenced
-- question and must match the session's course_id — this prevents an evaluator
-- assigned to multiple courses from mixing a Course A session with a Course B
-- question. Also verifies they're currently assigned to that course.
CREATE POLICY "Evaluators can manage their own evaluations"
  ON public.question_evaluations FOR ALL
  USING (
    evaluator_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.questions q
      JOIN public.question_evaluation_sessions s ON s.id = question_evaluations.session_id
      WHERE q.id = question_evaluations.question_id
        AND s.course_id = q.course_id
        AND s.evaluator_id = auth.uid()
        AND public.is_course_evaluator(q.course_id, auth.uid())
    )
  )
  WITH CHECK (
    evaluator_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.questions q
      JOIN public.question_evaluation_sessions s ON s.id = question_evaluations.session_id
      WHERE q.id = question_evaluations.question_id
        AND s.course_id = q.course_id
        AND s.evaluator_id = auth.uid()
        AND public.is_course_evaluator(q.course_id, auth.uid())
    )
  );

-- Instructors/admins of the question's course: read-only. No INSERT/UPDATE/
-- DELETE branch — RLS default-deny continues to block writes for these
-- roles. Students are not included by any branch on this table.
CREATE POLICY "Course staff can read evaluations"
  ON public.question_evaluations FOR SELECT
  USING (
    public.is_super_admin(auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.questions q
      WHERE q.id = question_evaluations.question_id
        AND (
          public.is_course_instructor(q.course_id, auth.uid())
          OR EXISTS (
            SELECT 1 FROM public.courses c
            WHERE c.id = q.course_id
              AND public.is_institution_admin(auth.uid(), c.institution_id)
          )
        )
    )
  );
