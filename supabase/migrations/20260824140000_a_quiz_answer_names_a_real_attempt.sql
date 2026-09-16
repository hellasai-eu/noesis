-- A quiz answer names a real attempt (#1094, review round 2).
--
-- 20260824130000 bound the answers to the session they name — but only when
-- that session existed. `quiz_answers.session_id` is a bare uuid with no
-- foreign key, so a submission for a formal quiz could name a session id that
-- is not an attempt at all: the whole attribution branch was skipped, the rows
-- were inserted anyway, and the finalize updated nothing while the call
-- reported success.
--
-- The grades on those rows would still be honest — they are computed here from
-- `answer_key`, and the student can only answer questions in their own course.
-- What it costs is the attempt itself. A quiz's one-shot-ness lives in
-- `quiz_sessions`: one row per attempt, checked before a retake is offered and
-- completed when the attempt ends. A student who can write answers without one
-- can submit the same quiz as many times as they like under fresh random
-- session ids, and any report that reads `quiz_answers` by (student, quiz)
-- sees the best of those runs. So for a formal quiz the session must exist.
--
-- Practice keeps no attempt: `quiz_id` is NULL, the session id is a client-side
-- uuid that was never a row, and there is nothing to limit. The requirement is
-- therefore on the quiz path only, which is also every path the frontend takes
-- with a `quiz_id` — timed and non-timed quizzes both INSERT a `quiz_sessions`
-- row before the first question is answered.
--
-- Written as a new migration rather than an edit to 20260824130000 for the same
-- reason that one was not an edit to 20260824120000: both have already been
-- applied to this PR's preview branch, and a branch applies migrations
-- incrementally.

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
  v_session      record;
BEGIN
  -- This function waits for locks on the hot path of a student submitting a
  -- quiz: the question rows below, and the session row further down. Postgres
  -- waits forever by default, so a lock held by something wedged upstream turns
  -- a submission into a request that never answers — the student watches a
  -- spinner during a timed quiz and has no idea whether their work was saved.
  -- Ten seconds is far longer than any writer that legitimately conflicts here
  -- (`update_question_content` holds its lock for one short transaction), so
  -- reaching it means something is wrong and an error the caller can act on is
  -- worth more than an unbounded wait.
  SET LOCAL lock_timeout = '10s';

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
    -- The caller regrades against the new key and calls again. Nothing is
    -- wrong with the submission; it was graded a moment too early.
    --
    -- Signalled by HINT rather than by SQLSTATE 40001, which is what
    -- 20260824120000 used. 40001 is the code the whole ecosystem reads as
    -- "this transaction can simply be retried", and something in front of the
    -- database acts on it: under the PostgREST the CI images pin, the request
    -- never came back, and every later call touching that question blocked
    -- behind the lock the unfinished one still held — 7 tests timing out
    -- behind the first stale-key case, while the one case that used a
    -- different question row passed. A signal for our own caller does not need
    -- a code with that meaning attached, and `raise_exception` (P0001, which
    -- PostgREST answers as 400) with a hint the handler matches on is the same
    -- shape `submit_study_guide_piece_answers` already uses.
    RAISE EXCEPTION 'answer key changed while grading (% question(s))', v_stale
      USING ERRCODE = 'raise_exception', HINT = 'stale_answer_key';
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

  -- The session must be the answering student's own, and must be the attempt
  -- these answers actually belong to. The old policy looked at neither, so
  -- answers could be filed into someone else's attempt, or into their own
  -- attempt at a different assignment. For a quiz it must also exist at all —
  -- see the header. Practice has no session row and is unaffected.
  --
  -- FOR UPDATE so two submits of the same attempt (a double-clicked button, a
  -- retry after a lost response) serialize against each other: the second one
  -- then sees the first one's rows in the NOT EXISTS below instead of racing it
  -- into a duplicate. Same reason `submit_study_guide_piece_answers` locks the
  -- progress row.
  SELECT s.user_id, s.course_id, s.quiz_id, s.offering_id
    INTO v_session
    FROM public.quiz_sessions s
   WHERE s.id = _session_id
     FOR UPDATE;

  -- A formal quiz answer without an attempt row is not a submission, it is a
  -- write that skipped the thing that counts attempts.
  IF v_session.user_id IS NULL AND _quiz_id IS NOT NULL THEN
    RAISE EXCEPTION 'quiz answers must name an attempt: session % does not exist', _session_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_session.user_id IS NOT NULL THEN
    IF v_session.user_id <> _user_id THEN
      RAISE EXCEPTION 'session % belongs to another student', _session_id
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF v_session.course_id IS DISTINCT FROM _course_id
       OR v_session.quiz_id IS DISTINCT FROM _quiz_id
       OR (v_session.offering_id IS NOT NULL
           AND v_session.offering_id IS DISTINCT FROM _offering_id) THEN
      RAISE EXCEPTION
        'answers do not belong to attempt %: it is course %, quiz %, offering %',
        _session_id, v_session.course_id, v_session.quiz_id, v_session.offering_id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
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
  'and refusing (HINT stale_answer_key) if its answer_key changed since that '
  'grading read — the window update_question_content could not close on its own '
  '(#1094). A quiz submission must name an existing session, and that session '
  'must be the caller''s own AND the attempt the answers belong to, so an '
  'attempt cannot be finalized while its answers are filed under another — nor '
  'answers recorded with no attempt at all. Service-role only: it takes the '
  'student as a parameter, so a caller who could choose it could file answers '
  'as anyone.';
