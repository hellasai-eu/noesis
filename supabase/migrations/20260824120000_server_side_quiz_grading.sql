-- Server-side quiz grading (#1094, quiz half).
--
-- Until now `quiz_answers` was the one answer surface a student wrote for
-- themselves. `StudentQuiz` read `questions.answer_key` into the browser,
-- compared it against the student's picks in JavaScript, and INSERTed the row
-- with its own `is_correct`. The RLS policy authorising that insert checked who
-- the row was about and which offering it named — it could not check whether
-- the verdict was true, because the verdict arrived already formed. Anyone able
-- to open devtools could file a perfect score without answering a question.
--
-- Every other answer surface already grades on the server: `open_question_grades`
-- has no student INSERT policy at all (grade-deterministic-answer / -open-answer
-- write it under the service role), and `study_guide_answers` is written only by
-- `submit_study_guide_piece_answers`. This brings `quiz_answers` to the same
-- shape:
--
--   * the student INSERT policy is dropped — students no longer write their own
--     answers at all;
--   * `record_quiz_answers` below is the sole writer, service-role only, called
--     by the `submit-quiz-answers` edge function which grades with the shared
--     graders after resolving the caller from their JWT.
--
-- ---------------------------------------------------------------------------
-- Grading under lock (#1094)
-- ---------------------------------------------------------------------------
--
-- Moving grading to the server is not by itself enough. `update_question_content`
-- (20260805120000) refuses to edit a question that has any recorded answer, and
-- takes `FOR UPDATE` on the row so the refusal cannot race the answer INSERT.
-- Its own comment names the window it could not close: grading reads the key in
-- one transaction and the graded row lands in a LATER one, so an edit can slip
-- between the two and persist a grade computed against a key the question no
-- longer has.
--
-- This function closes that window for quizzes. It takes `FOR KEY SHARE` on
-- every question being answered — the lock mode `FOR UPDATE` conflicts with —
-- and only then compares each question's `updated_at` against the version the
-- caller graded. An instructor's edit therefore either waits for this
-- transaction (and is then refused, because the answers now exist) or lands
-- first and is caught by the version check, which aborts with
-- SQLSTATE 40001 so the caller can re-read, re-grade and retry.
--
-- `updated_at` is a sound row version here: `update_questions_updated_at` is a
-- BEFORE UPDATE trigger on `questions` FOR EACH ROW, so no update to the row can
-- leave it unchanged.

CREATE OR REPLACE FUNCTION public.record_quiz_answers(
  _user_id     uuid,
  _course_id   uuid,
  _quiz_id     uuid,
  _offering_id uuid,
  _session_id  uuid,
  _answers     jsonb,
  _finalize    boolean DEFAULT false
)
RETURNS TABLE (question_id uuid, is_correct boolean, recorded_now boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ids          uuid[];
  v_locked       uuid[];
  v_inserted     uuid[];
  v_stale        int;
  v_wrong_course int;
  v_session_owner uuid;
BEGIN
  IF _user_id IS NULL OR _course_id IS NULL OR _session_id IS NULL THEN
    RAISE EXCEPTION 'user, course and session are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF jsonb_typeof(_answers) IS DISTINCT FROM 'array' OR jsonb_array_length(_answers) = 0 THEN
    RAISE EXCEPTION 'answers must be a non-empty json array'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT array_agg(DISTINCT (e ->> 'question_id')::uuid)
    INTO v_ids
    FROM jsonb_array_elements(_answers) e;

  IF v_ids IS NULL OR array_length(v_ids, 1) IS DISTINCT FROM jsonb_array_length(_answers) THEN
    RAISE EXCEPTION 'each answer must name a distinct question'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Every answer states which version of the question it was graded against.
  -- Without it the check below has nothing to compare, and a caller that simply
  -- omitted the field would look identical to one whose key had moved.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(_answers) e
     WHERE (e ->> 'question_version') IS NULL
  ) THEN
    RAISE EXCEPTION 'each answer must carry the question_version it was graded against'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Lock every question being answered, in id order so two students submitting
  -- overlapping sets cannot deadlock. FOR KEY SHARE is the mode the FK from
  -- quiz_answers takes anyway; taking it HERE, before the grades below are
  -- trusted, is what makes the version check that follows meaningful.
  SELECT array_agg(id ORDER BY id)
    INTO v_locked
    FROM (
      SELECT q.id
        FROM public.questions q
       WHERE q.id = ANY(v_ids)
       ORDER BY q.id
         FOR KEY SHARE
    ) locked;

  IF v_locked IS NULL OR array_length(v_locked, 1) <> array_length(v_ids, 1) THEN
    RAISE EXCEPTION 'one or more questions do not exist'
      USING ERRCODE = 'no_data_found';
  END IF;

  -- Read AFTER the lock: under READ COMMITTED each statement takes a fresh
  -- snapshot, so a concurrent edit that committed while we waited is visible
  -- here and trips the check rather than being silently graded against.
  SELECT count(*)
    INTO v_stale
    FROM jsonb_array_elements(_answers) e
    JOIN public.questions q ON q.id = (e ->> 'question_id')::uuid
   WHERE q.updated_at IS DISTINCT FROM (e ->> 'question_version')::timestamptz;

  IF v_stale > 0 THEN
    -- 40001 (serialization_failure): the caller regrades against the new key
    -- and calls again. Deliberately not a plain error — nothing is wrong with
    -- the submission, it was graded a moment too early.
    RAISE EXCEPTION 'answer key changed while grading (% question(s))', v_stale
      USING ERRCODE = 'serialization_failure';
  END IF;

  -- The question has to belong to the course the answer is filed under.
  -- Nothing checked this before: the dropped policy constrained the student and
  -- the offering but never the question, so a row could name any question in
  -- the database.
  SELECT count(*)
    INTO v_wrong_course
    FROM public.questions q
   WHERE q.id = ANY(v_ids)
     AND q.course_id IS DISTINCT FROM _course_id;

  IF v_wrong_course > 0 THEN
    RAISE EXCEPTION 'question does not belong to course %', _course_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- The two predicates the dropped INSERT policy carried. A SECURITY DEFINER
  -- bypasses RLS, so they have to be re-stated here or moving the writer
  -- server-side would quietly drop them.
  IF NOT public.student_may_attribute_to_offering(_offering_id, _course_id, _user_id) THEN
    RAISE EXCEPTION 'student may not file work under offering %', _offering_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF _quiz_id IS NOT NULL AND _offering_id IS NOT NULL AND EXISTS (
    SELECT 1
      FROM public.offering_quizzes oq
     WHERE oq.quiz_id = _quiz_id
       AND oq.offering_id = _offering_id
       AND oq.closed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'assignment is closed'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- A session that exists must be the answering student's own. The old policy
  -- never looked at `session_id`, so answers could be filed into someone
  -- else's attempt; practice mode has no session row and is unaffected.
  --
  -- FOR UPDATE so two submits of the same attempt (a double-clicked button, a
  -- retry after a lost response) serialize against each other: the second one
  -- then sees the first one's rows in the NOT EXISTS below instead of racing it
  -- into a duplicate. Same reason `submit_study_guide_piece_answers` locks the
  -- progress row.
  SELECT s.user_id INTO v_session_owner
    FROM public.quiz_sessions s
   WHERE s.id = _session_id
     FOR UPDATE;

  IF v_session_owner IS NOT NULL AND v_session_owner <> _user_id THEN
    RAISE EXCEPTION 'session % belongs to another student', _session_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- `is_correct` here is the SERVER's verdict: this function is service-role
  -- only and its one caller is the edge function that graded the submission
  -- from `answer_key` moments ago, under the version check above. The student's
  -- browser never supplies it.
  --
  -- Skip-if-present rather than error: a submit whose answers landed but whose
  -- response was lost is retried by the student, and the honest outcome of that
  -- retry is the answers they already have. An answer is one-shot per
  -- (student, question, session) — a second submission does not overwrite the
  -- first.
  --
  -- Expressed as NOT EXISTS rather than ON CONFLICT because that triple has no
  -- unique index: 20251206062952 added one, and 20251206101851 re-created the
  -- table without it. Recreating it now would need the existing duplicates
  -- (which the old delete-then-reinsert client path could produce, since
  -- students have no DELETE policy and the delete silently removed nothing)
  -- dealt with first — a data decision, not this change's to make. The session
  -- lock above is what keeps two concurrent submits from both passing this.
  WITH ins AS (
    INSERT INTO public.quiz_answers (
      user_id, question_id, course_id, offering_id, quiz_id, session_id,
      selected_answer, submission, is_correct
    )
    SELECT
      _user_id,
      (e ->> 'question_id')::uuid,
      _course_id,
      _offering_id,
      _quiz_id,
      _session_id,
      COALESCE((e ->> 'selected_answer')::int, 0),
      COALESCE(e -> 'submission', '{}'::jsonb),
      (e ->> 'is_correct')::boolean
    FROM jsonb_array_elements(_answers) e
    WHERE NOT EXISTS (
      SELECT 1
        FROM public.quiz_answers prior
       WHERE prior.user_id = _user_id
         AND prior.session_id = _session_id
         AND prior.question_id = (e ->> 'question_id')::uuid
    )
    RETURNING quiz_answers.question_id AS qid
  )
  SELECT array_agg(qid) INTO v_inserted FROM ins;

  IF _finalize AND _quiz_id IS NOT NULL THEN
    UPDATE public.quiz_sessions s
       SET status = 'completed',
           completed_at = now(),
           draft_answers = NULL
     WHERE s.id = _session_id
       AND s.user_id = _user_id
       AND s.status NOT IN ('completed', 'expired');
  END IF;

  -- The STORED verdict, not the one just computed: where a row already existed
  -- the caller must show what the student's attempt actually holds. DISTINCT ON
  -- because historic duplicates are possible (see above) — the first answer
  -- recorded for the question is the one that counts.
  RETURN QUERY
  SELECT DISTINCT ON (a.question_id)
         a.question_id, a.is_correct, a.question_id = ANY(COALESCE(v_inserted, '{}'::uuid[]))
    FROM public.quiz_answers a
   WHERE a.user_id = _user_id
     AND a.session_id = _session_id
     AND a.question_id = ANY(v_ids)
   ORDER BY a.question_id, a.answered_at;
END;
$$;

COMMENT ON FUNCTION public.record_quiz_answers(uuid, uuid, uuid, uuid, uuid, jsonb, boolean) IS
  'Sole writer of quiz_answers. Records answers already graded by the '
  'submit-quiz-answers edge function, holding FOR KEY SHARE on each question '
  'and refusing (SQLSTATE 40001) if its answer_key changed since that grading '
  'read — the window update_question_content could not close on its own '
  '(#1094). Service-role only: it takes the student as a parameter, so a '
  'caller who could choose it could file answers as anyone.';

REVOKE ALL ON FUNCTION public.record_quiz_answers(uuid, uuid, uuid, uuid, uuid, jsonb, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_quiz_answers(uuid, uuid, uuid, uuid, uuid, jsonb, boolean) FROM anon;
REVOKE ALL ON FUNCTION public.record_quiz_answers(uuid, uuid, uuid, uuid, uuid, jsonb, boolean) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.record_quiz_answers(uuid, uuid, uuid, uuid, uuid, jsonb, boolean) TO service_role;

-- ---------------------------------------------------------------------------
-- Students no longer write their own answers
-- ---------------------------------------------------------------------------
--
-- With the function above in place this policy is the whole hole: it authorises
-- an INSERT whose `is_correct` the student chose. There is no narrower version
-- worth keeping — a WITH CHECK cannot tell a true verdict from a false one, and
-- `is_correct` is NOT NULL, so the study-guide trick of demanding the grading
-- columns be NULL on a student insert is not available either.
--
-- Deployment note: this makes the previous frontend bundle unable to submit a
-- quiz, so the migration and the new bundle belong to the same release (they
-- are, `npm run deploy` runs migrations, functions, then the frontend). A
-- student mid-attempt across the switch resubmits on the new bundle; nothing
-- they have already recorded is lost.
DROP POLICY IF EXISTS "Users can submit quiz answers" ON public.quiz_answers;

COMMENT ON TABLE public.quiz_answers IS
  'Student quiz/practice answers. Written only by public.record_quiz_answers '
  'under the service role — there is deliberately no student INSERT policy, '
  'because the grade is the server''s to compute (#1094).';
