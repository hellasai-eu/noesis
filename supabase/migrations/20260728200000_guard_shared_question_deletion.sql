-- Never delete a question another piece still uses (#1005 review).
--
-- `study_guide_piece_questions` has PRIMARY KEY (piece_id, question_id), so one
-- question may legitimately belong to several pieces. Every function that
-- cleans up a piece or a guide deleted EVERY question reachable through the
-- junction, without asking whether some other piece still pointed at it —
-- taking that piece's question, and any assessment data cascading from it, with
-- it.
--
-- Nothing shares questions today: the generator always writes fresh rows per
-- piece. But the schema permits sharing, and a guard that only holds while no
-- one uses a feature is not a guard.
--
-- Fixed in ALL FOUR call sites rather than the one that was flagged. Three of
-- them had the identical statement; patching only the reported instance would
-- have left the same defect in the functions nobody happened to look at.
--
-- The predicate is the same everywhere: delete a question only when every
-- piece link it has falls inside the scope being removed.
--
-- Every multi-row FOR UPDATE here carries ORDER BY id. Postgres locks rows in
-- whatever order the scan returns them, which is not stable across plans, so
-- two of these functions working over an overlapping set of questions could
-- otherwise acquire them in opposite orders and deadlock — aborting a cleanup
-- rather than completing it. A single ordering makes acquisition deterministic
-- across all four.

-- ---------------------------------------------------------------------------
-- 1. Piece deletion (#1005)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.delete_study_guide_piece(_piece_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  guide_id         uuid;
  guide_course     uuid;
  removed_position int;
  answer_count     int;
BEGIN
  SELECT p.study_guide_id, p.position INTO guide_id, removed_position
    FROM public.study_guide_pieces p
   WHERE p.id = _piece_id
     FOR UPDATE;

  IF guide_id IS NULL THEN
    RAISE EXCEPTION 'study guide piece % not found', _piece_id
      USING ERRCODE = 'no_data_found';
  END IF;

  SELECT sg.course_id INTO guide_course
    FROM public.study_guides sg
   WHERE sg.id = guide_id;

  IF NOT (
    public.is_super_admin(auth.uid())
    OR public.is_institution_admin(
         auth.uid(),
         (SELECT c.institution_id FROM public.courses c WHERE c.id = guide_course)
       )
    OR public.is_course_instructor(guide_course, auth.uid())
  ) THEN
    RAISE EXCEPTION 'not authorized to delete piece %', _piece_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT count(*) INTO answer_count
    FROM public.study_guide_answers
   WHERE piece_id = _piece_id;

  IF answer_count > 0 THEN
    RAISE EXCEPTION
      'study guide piece % has % student submission(s) and cannot be deleted',
      _piece_id, answer_count
      USING ERRCODE = 'raise_exception';
  END IF;

  -- Lock the candidate questions before testing whether anything else uses
  -- them. The NOT EXISTS below evaluates at statement snapshot, so without this
  -- a concurrent transaction could link one of them to another piece, commit
  -- after the check, and have the question deleted out from under it — taking
  -- the brand-new link with it. Inserting a junction row takes FOR KEY SHARE on
  -- the referenced `questions` row via the FK, which conflicts with FOR UPDATE,
  -- so that writer waits. The piece-row lock above does not help: it guards the
  -- piece, not the questions.
  PERFORM 1
     FROM public.questions
    WHERE id IN (
      SELECT pq.question_id
        FROM public.study_guide_piece_questions pq
       WHERE pq.piece_id = _piece_id
    )
    ORDER BY id
      FOR UPDATE;

  -- Only questions this piece alone owns. One still linked to another piece
  -- stays; its junction row for THIS piece cascades away with the piece.
  DELETE FROM public.questions q
   WHERE q.id IN (
     SELECT pq.question_id
       FROM public.study_guide_piece_questions pq
      WHERE pq.piece_id = _piece_id
   )
     AND NOT EXISTS (
       SELECT 1
         FROM public.study_guide_piece_questions other
        WHERE other.question_id = q.id
          AND other.piece_id <> _piece_id
     );

  DELETE FROM public.study_guide_pieces WHERE id = _piece_id;

  UPDATE public.study_guide_pieces
     SET position = position - 1
   WHERE study_guide_id = guide_id
     AND position > removed_position;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Replacing a piece's questions (#978)
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
    ORDER BY id
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

  -- Only questions this piece alone owns; a shared one keeps its other links.
  DELETE FROM public.questions q2
   WHERE q2.id IN (
     SELECT question_id
       FROM public.study_guide_piece_questions
      WHERE piece_id = _piece_id
   )
     AND NOT EXISTS (
       SELECT 1
         FROM public.study_guide_piece_questions other
        WHERE other.question_id = q2.id
          AND other.piece_id <> _piece_id
     );

  -- A shared question's link to THIS piece still has to go, or the piece would
  -- keep a question the replacement did not produce.
  DELETE FROM public.study_guide_piece_questions WHERE piece_id = _piece_id;

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

  UPDATE public.study_guide_pieces
     SET questions_generated_at = now()
   WHERE id = _piece_id;

  RETURN inserted_ids;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Clearing a whole guide (#978)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.clear_study_guide_pieces(_study_guide_id uuid)
RETURNS TABLE (deleted_questions int, deleted_pieces int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  q_count      int;
  p_count      int;
  answer_count int;
BEGIN
  PERFORM 1
     FROM public.questions
    WHERE id IN (
      SELECT pq.question_id
        FROM public.study_guide_piece_questions pq
        JOIN public.study_guide_pieces p ON p.id = pq.piece_id
       WHERE p.study_guide_id = _study_guide_id
    )
    ORDER BY id
      FOR UPDATE;

  SELECT count(*) INTO answer_count
    FROM public.study_guide_answers
   WHERE study_guide_id = _study_guide_id;

  IF answer_count > 0 THEN
    RAISE EXCEPTION
      'study guide % has % student submission(s); regenerating would delete them',
      _study_guide_id, answer_count
      USING ERRCODE = 'raise_exception';
  END IF;

  -- Only questions whose every piece link is inside this guide.
  DELETE FROM public.questions q
   WHERE q.id IN (
     SELECT pq.question_id
       FROM public.study_guide_piece_questions pq
       JOIN public.study_guide_pieces p ON p.id = pq.piece_id
      WHERE p.study_guide_id = _study_guide_id
   )
     AND NOT EXISTS (
       SELECT 1
         FROM public.study_guide_piece_questions other
         JOIN public.study_guide_pieces op ON op.id = other.piece_id
        WHERE other.question_id = q.id
          AND op.study_guide_id <> _study_guide_id
     );
  GET DIAGNOSTICS q_count = ROW_COUNT;

  DELETE FROM public.study_guide_pieces
   WHERE study_guide_id = _study_guide_id;
  GET DIAGNOSTICS p_count = ROW_COUNT;

  RETURN QUERY SELECT q_count, p_count;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Replacing a guide's outline (#1004)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.replace_study_guide_outline(
  _study_guide_id uuid,
  _pieces jsonb
)
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

  PERFORM 1 FROM public.study_guides WHERE id = _study_guide_id FOR UPDATE;

  SELECT count(*) INTO answer_count
    FROM public.study_guide_answers
   WHERE study_guide_id = _study_guide_id;

  IF answer_count > 0 THEN
    RAISE EXCEPTION
      'study guide % has % student submission(s); rebuilding the outline would delete them',
      _study_guide_id, answer_count
      USING ERRCODE = 'raise_exception';
  END IF;

  -- Lock the candidate questions before the sharing test, for the same reason
  -- as in delete_study_guide_piece: the guide-row lock above guards the guide,
  -- not the questions, so a concurrent junction insert would otherwise commit
  -- after the NOT EXISTS evaluated and lose its link.
  PERFORM 1
     FROM public.questions
    WHERE id IN (
      SELECT pq.question_id
        FROM public.study_guide_piece_questions pq
        JOIN public.study_guide_pieces p ON p.id = pq.piece_id
       WHERE p.study_guide_id = _study_guide_id
    )
    ORDER BY id
      FOR UPDATE;

  -- Only questions whose every piece link is inside this guide.
  DELETE FROM public.questions q
   WHERE q.id IN (
     SELECT pq.question_id
       FROM public.study_guide_piece_questions pq
       JOIN public.study_guide_pieces p ON p.id = pq.piece_id
      WHERE p.study_guide_id = _study_guide_id
   )
     AND NOT EXISTS (
       SELECT 1
         FROM public.study_guide_piece_questions other
         JOIN public.study_guide_pieces op ON op.id = other.piece_id
        WHERE other.question_id = q.id
          AND op.study_guide_id <> _study_guide_id
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
