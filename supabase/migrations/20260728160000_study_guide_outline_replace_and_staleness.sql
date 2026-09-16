-- Two fixes from the #1004 review.
--
-- 1. Rebuilding an outline was destructive-then-fallible: the handler cleared
--    every piece and its questions, THEN called the model. A failure in the
--    call, in validation, or in the insert left the guide permanently empty,
--    discarding authored content. Generation must happen first and the
--    replacement must be atomic.
--
--    This also removes the need for a rebuild mutex. Two concurrent rebuilds
--    used to both clear, both call the model, and then collide on
--    UNIQUE (study_guide_id, position) — one paying for a call and reporting a
--    500. With an atomic replace they simply serialize: last writer wins, no
--    error and no empty guide. The only cost is a duplicated model call, which
--    is inherent to two people clicking at once.
--
-- 2. "These questions are older than this theory" was client-only state, lost
--    on reopen, so a guide could be published with questions written against
--    superseded text. It is now derivable from the database.

-- ---------------------------------------------------------------------------
-- Staleness, derived rather than remembered
-- ---------------------------------------------------------------------------

ALTER TABLE public.study_guide_pieces
  ADD COLUMN IF NOT EXISTS theory_updated_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS questions_generated_at TIMESTAMP WITH TIME ZONE;

COMMENT ON COLUMN public.study_guide_pieces.theory_updated_at IS
  'Set whenever theory_html actually changes. Compared against questions_generated_at to tell whether a piece''s questions were written from the text it currently holds.';
COMMENT ON COLUMN public.study_guide_pieces.questions_generated_at IS
  'Set by replace_study_guide_piece_questions. Older than theory_updated_at means the questions test text the student no longer reads.';

-- Bumped only on a real theory change — not by renaming the piece, which the
-- generic updated_at trigger would also catch and which would over-warn.
CREATE OR REPLACE FUNCTION public.touch_study_guide_theory_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.theory_html IS DISTINCT FROM OLD.theory_html THEN
    NEW.theory_updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_touch_study_guide_theory_updated_at
  BEFORE UPDATE ON public.study_guide_pieces
  FOR EACH ROW EXECUTE FUNCTION public.touch_study_guide_theory_updated_at();

-- Existing rows: treat current questions as current, so the change does not
-- retroactively flag every already-built guide as stale.
UPDATE public.study_guide_pieces p
   SET theory_updated_at = COALESCE(p.theory_updated_at, p.updated_at),
       questions_generated_at = COALESCE(p.questions_generated_at, p.updated_at)
 WHERE p.theory_updated_at IS NULL
    OR p.questions_generated_at IS NULL;

-- ---------------------------------------------------------------------------
-- Atomic outline replacement
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.replace_study_guide_outline(
  _study_guide_id uuid,
  _pieces jsonb
)
-- SETOF the row type rather than RETURNS TABLE (id, position, title):
-- `position` is a reserved word in Postgres, so naming it as an OUT parameter
-- is a syntax error, and quoting it would then shadow p.position in the body.
RETURNS SETOF public.study_guide_pieces
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  answer_count int;
  piece        jsonb;
  idx          int := 0;
BEGIN
  IF jsonb_typeof(_pieces) IS DISTINCT FROM 'array' OR jsonb_array_length(_pieces) = 0 THEN
    RAISE EXCEPTION 'pieces must be a non-empty json array'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Lock the guide before counting: count-then-delete is not atomic under READ
  -- COMMITTED, and a `study_guide_answers` insert takes FOR KEY SHARE on this
  -- row via its FK, which conflicts with FOR UPDATE. Also serializes two
  -- concurrent rebuilds, so the second waits rather than colliding on the
  -- position constraint.
  PERFORM 1 FROM public.study_guides WHERE id = _study_guide_id FOR UPDATE;

  -- SECURITY DEFINER so this count spans every offering. Under the caller's
  -- RLS a section-restricted instructor would see zero for answers submitted
  -- in another section, and the delete below cascades across all of them.
  SELECT count(*) INTO answer_count
    FROM public.study_guide_answers
   WHERE study_guide_id = _study_guide_id;

  IF answer_count > 0 THEN
    RAISE EXCEPTION
      'study guide % has % student submission(s); rebuilding the outline would delete them',
      _study_guide_id, answer_count
      USING ERRCODE = 'raise_exception';
  END IF;

  -- Delete the generated questions BEFORE the pieces: the cascade on
  -- study_guide_piece_questions.piece_id removes the junction rows, which are
  -- the only thing identifying those questions as this guide's. Dropping the
  -- pieces first would strand them in the instructor's Question Bank.
  DELETE FROM public.questions
   WHERE id IN (
     SELECT pq.question_id
       FROM public.study_guide_piece_questions pq
       JOIN public.study_guide_pieces p ON p.id = pq.piece_id
      WHERE p.study_guide_id = _study_guide_id
   );

  DELETE FROM public.study_guide_pieces WHERE study_guide_id = _study_guide_id;

  FOR piece IN SELECT * FROM jsonb_array_elements(_pieces)
  LOOP
    INSERT INTO public.study_guide_pieces (study_guide_id, position, title, theory_html)
    VALUES (_study_guide_id, idx, piece ->> 'title', NULL);
    idx := idx + 1;
  END LOOP;

  RETURN QUERY
    SELECT p.*
      FROM public.study_guide_pieces p
     WHERE p.study_guide_id = _study_guide_id
     ORDER BY p.position;
END;
$$;

REVOKE ALL ON FUNCTION public.replace_study_guide_outline(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.replace_study_guide_outline(uuid, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.replace_study_guide_outline(uuid, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.replace_study_guide_outline(uuid, jsonb) TO service_role;

-- ---------------------------------------------------------------------------
-- Stamp questions_generated_at when questions are written
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.replace_study_guide_piece_questions(
  _piece_id uuid,
  _course_id uuid,
  _created_by uuid,
  _questions jsonb
)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  q               jsonb;
  new_question_id uuid;
  inserted_ids    uuid[] := ARRAY[]::uuid[];
  chapter         uuid;
  competency      uuid;
  position_index  int := 0;
  guide_id        uuid;
  answer_count    int;
BEGIN
  SELECT study_guide_id INTO guide_id
    FROM public.study_guide_pieces
   WHERE id = _piece_id;
  IF guide_id IS NULL THEN
    RAISE EXCEPTION 'study guide piece % not found', _piece_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF jsonb_typeof(_questions) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'questions must be a json array'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF jsonb_array_length(_questions) = 0 THEN
    RAISE EXCEPTION 'questions must not be empty'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  PERFORM 1
     FROM public.questions
    WHERE id IN (
      SELECT pq.question_id
        FROM public.study_guide_piece_questions pq
       WHERE pq.piece_id = _piece_id
    )
      FOR UPDATE;

  SELECT count(*) INTO answer_count
    FROM public.study_guide_answers a
    JOIN public.study_guide_piece_questions pq ON pq.question_id = a.question_id
   WHERE pq.piece_id = _piece_id;

  IF answer_count > 0 THEN
    RAISE EXCEPTION
      'study guide piece % has % student submission(s); replacing its questions would delete them',
      _piece_id, answer_count
      USING ERRCODE = 'raise_exception';
  END IF;

  DELETE FROM public.questions
   WHERE id IN (
     SELECT question_id
       FROM public.study_guide_piece_questions
      WHERE piece_id = _piece_id
   );

  FOR q IN SELECT * FROM jsonb_array_elements(_questions)
  LOOP
    INSERT INTO public.questions (
      course_id, question, type, payload, answer_key, explanation,
      difficulty, hidden, is_user_generated, competency_id,
      generation_rationale, created_by
    )
    VALUES (
      _course_id,
      q ->> 'question',
      q ->> 'type',
      COALESCE(q -> 'payload', '{}'::jsonb),
      COALESCE(q -> 'answer_key', '{}'::jsonb),
      COALESCE(q ->> 'explanation', ''),
      COALESCE(q ->> 'difficulty', 'medium'),
      false,
      false,
      NULLIF(q ->> 'competency_id', '')::uuid,
      NULLIF(q ->> 'generation_rationale', ''),
      _created_by
    )
    RETURNING id INTO new_question_id;

    inserted_ids := inserted_ids || new_question_id;

    IF jsonb_typeof(q -> 'chapter_ids') = 'array' THEN
      FOR chapter IN
        SELECT value::text::uuid FROM jsonb_array_elements_text(q -> 'chapter_ids') AS value
      LOOP
        INSERT INTO public.question_chapters (question_id, chapter_id)
        VALUES (new_question_id, chapter)
        ON CONFLICT DO NOTHING;
      END LOOP;
    END IF;

    IF jsonb_typeof(q -> 'competency_ids') = 'array' THEN
      FOR competency IN
        SELECT value::text::uuid FROM jsonb_array_elements_text(q -> 'competency_ids') AS value
      LOOP
        INSERT INTO public.question_competencies (question_id, competency_id)
        VALUES (new_question_id, competency)
        ON CONFLICT DO NOTHING;
      END LOOP;
    END IF;

    INSERT INTO public.study_guide_piece_questions (piece_id, question_id, position)
    VALUES (_piece_id, new_question_id, position_index);

    position_index := position_index + 1;
  END LOOP;

  -- Stamped inside the same transaction as the questions themselves, so the
  -- staleness comparison can never disagree with what was actually written.
  UPDATE public.study_guide_pieces
     SET questions_generated_at = now()
   WHERE id = _piece_id;

  RETURN inserted_ids;
END;
$$;
