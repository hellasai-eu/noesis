-- Per-question open-question answering mode (#596).
--
-- The mode itself lives in `questions.payload` (jsonb) — no DDL on the
-- `questions` table is needed. Two side-tables ARE needed:
--
--   1. `open_question_grades.submitted_answer` — the new single-answer mode
--      grades a one-shot raw submission; the Socratic path stored the
--      equivalent in `open_question_chats`, which the new
--      `grade-open-answer` edge function deliberately does not touch.
--      Nullable so pre-#596 rows (graded from the chat transcript by
--      `grade-interaction`) keep their NULL.
--
--   2. `open_question_mode_changes` — audit log written every time an
--      instructor flips a question's mode, since the flip is destructive
--      (it wipes every student's progress on that question).
--
-- Both are additive and reversible.

-- ──────────────────────────────────────────────────────────────────────────
-- 1. open_question_grades.submitted_answer
-- ──────────────────────────────────────────────────────────────────────────
ALTER TABLE public.open_question_grades
  ADD COLUMN IF NOT EXISTS submitted_answer text;

COMMENT ON COLUMN public.open_question_grades.submitted_answer IS
  'The raw student submission text for single-answer mode (#596). NULL for '
  'rows written by grade-interaction (interactive Socratic path), where the '
  'equivalent text lives in open_question_chats.';

-- ──────────────────────────────────────────────────────────────────────────
-- 2. open_question_mode_changes — audit log for the destructive flip
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.open_question_mode_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id uuid NOT NULL REFERENCES public.questions(id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  changed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  prior_mode text NOT NULL CHECK (prior_mode IN ('interactive', 'single')),
  new_mode text NOT NULL CHECK (new_mode IN ('interactive', 'single')),
  deleted_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS open_question_mode_changes_question_idx
  ON public.open_question_mode_changes(question_id, created_at DESC);

ALTER TABLE public.open_question_mode_changes ENABLE ROW LEVEL SECURITY;

-- Only super-admins, institution admins, and the question's course instructors
-- can read the audit trail. Students never see it.
CREATE POLICY "Admins and course instructors can view mode-change audits"
  ON public.open_question_mode_changes
  FOR SELECT
  USING (
    is_super_admin(auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.courses c
      WHERE c.id = open_question_mode_changes.course_id
        AND (
          is_institution_admin(auth.uid(), c.institution_id)
          OR is_course_instructor(c.id, auth.uid())
        )
    )
  );

-- Writes are service-role only (edge function uses the service-role key).
-- No INSERT/UPDATE/DELETE policy => the table is effectively append-only from
-- authenticated callers, which is exactly what an audit log should be.

-- ──────────────────────────────────────────────────────────────────────────
-- 3. reset_open_question_progress(question_id) RPC
-- ──────────────────────────────────────────────────────────────────────────
-- Atomically wipes every student's progress on a single question across all
-- five "open question" tables and returns the per-table row counts. The
-- edge function uses these counts for its audit log entry.
--
-- SECURITY DEFINER + service-role-only invocation via the edge function. The
-- function is REVOKEd from public so a logged-in user cannot call it through
-- PostgREST and bypass the instructor / admin authorization check we do in
-- the edge function.
CREATE OR REPLACE FUNCTION public.reset_open_question_progress(_question_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  chats_count       integer;
  progress_count    integer;
  session_count     integer;
  history_count     integer;
  grades_count      integer;
BEGIN
  -- Delete in dependency-safe order. socratic_state_history must be wiped
  -- before socratic_session_state (it FKs the session id), but we use plain
  -- DELETE WHERE so PostgreSQL handles the cascade and we get an exact count
  -- per table.
  WITH d AS (
    DELETE FROM public.socratic_state_history h
    USING public.socratic_session_state s
    WHERE h.session_state_id = s.id
      AND s.open_question_id = _question_id
    RETURNING h.id
  )
  SELECT count(*) INTO history_count FROM d;

  WITH d AS (
    DELETE FROM public.socratic_session_state
    WHERE open_question_id = _question_id
    RETURNING id
  )
  SELECT count(*) INTO session_count FROM d;

  WITH d AS (
    DELETE FROM public.open_question_chats
    WHERE open_question_id = _question_id
    RETURNING id
  )
  SELECT count(*) INTO chats_count FROM d;

  WITH d AS (
    DELETE FROM public.open_question_grades
    WHERE open_question_id = _question_id
    RETURNING id
  )
  SELECT count(*) INTO grades_count FROM d;

  WITH d AS (
    DELETE FROM public.open_question_progress
    WHERE open_question_id = _question_id
    RETURNING id
  )
  SELECT count(*) INTO progress_count FROM d;

  RETURN jsonb_build_object(
    'open_question_chats',       chats_count,
    'open_question_progress',    progress_count,
    'socratic_session_state',    session_count,
    'socratic_state_history',    history_count,
    'open_question_grades',      grades_count
  );
END;
$$;

-- Lock this down — only the service role (used by the edge function) may call
-- it. Public + authenticated roles cannot reach it via PostgREST.
REVOKE ALL ON FUNCTION public.reset_open_question_progress(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reset_open_question_progress(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.reset_open_question_progress(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.reset_open_question_progress(uuid) TO service_role;
