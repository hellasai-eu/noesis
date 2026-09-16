-- Unify the two chat schemas behind one set of tables.
--
-- `study-tutor` and `socratic-chat` are structural clones running over mirrored
-- table families. Five families, cloned under different names, with two
-- implementations of every cross-cutting concern. The #1039 background-mode fix
-- had to be written twice (d14e2cda, aa1fd4f8); so did the #1198 moderation gate.
--
-- This migration creates the unified tables and backfills them. It deliberately
-- does NOT drop the legacy tables: they stay as the recovery path until prod
-- parity has been verified, and a follow-up migration drops them.
--
-- Three divergences are reconciled here rather than carried forward:
--
--   1. The two surfaces reach section scoping by different routes. The study
--      side names the offering the work was recorded under
--      (`instructor_can_write_student_work`); the open-question side has no
--      offering column, so it asks whether the student sits in any section the
--      instructor can reach (`instructor_can_access_student`).
--
--      Both are section-aware — an instructor restricted to 1Α is already
--      refused a 1Β-only student's socratic thread, and
--      `tutoring-section-scope.test.ts` pins exactly that. What differs is a
--      student enrolled in more than one class of the same course: the study
--      rule refuses a write to work recorded under an offering the instructor
--      cannot reach, while the open-question rule allows it because the student
--      is reachable through their other class.
--
--      Carrying `offering_id` on every session lets the stricter rule apply to
--      both. That is a real narrowing, but a narrow one — not the closing of an
--      open door.
--
--   2. A withheld (moderation-flagged) assistant reply is recorded as
--      `role = 'moderation'` on the study side but as `role = 'system'` plus
--      `flagged_offensive` on the socratic side — because
--      `open_question_chats_role_check` forbids 'moderation'. The unified table
--      permits 'moderation' and the backfill maps the socratic form onto it, so
--      one predicate excludes withheld replies from every transcript.
--
--   3. Student writes on `open_question_progress` carry no WITH CHECK at all,
--      so a student can attribute work to an offering they are not enrolled in.
--      The study side's `student_may_attribute_to_offering` now covers both. It
--      short-circuits on a NULL offering, so existing unscoped rows still pass.
--      This is the one unambiguous tightening of the three.

-- =============================================================================
-- Tables
-- =============================================================================

CREATE TABLE public.chat_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  offering_id UUID REFERENCES public.offerings(id) ON DELETE SET NULL,

  -- Exactly one subject. Two typed FKs rather than a polymorphic
  -- (subject_type, subject_id) pair so referential integrity is real and the
  -- erasure/export machinery keeps working through ordinary cascades.
  study_session_id UUID REFERENCES public.study_sessions(id) ON DELETE CASCADE,
  open_question_id UUID REFERENCES public.questions(id) ON DELETE CASCADE,

  status TEXT NOT NULL DEFAULT 'not_started',
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chat_sessions_one_subject
    CHECK (num_nonnulls(study_session_id, open_question_id) = 1)
);

-- Which surface a row belongs to, without every caller repeating the IS NULL test.
ALTER TABLE public.chat_sessions
  ADD COLUMN subject_kind TEXT
  GENERATED ALWAYS AS (
    CASE WHEN study_session_id IS NOT NULL THEN 'study_session' ELSE 'open_question' END
  ) STORED;

-- The legacy uniqueness rules, preserved per subject.
--
-- Plain constraints rather than partial indexes: NULLs are distinct in a
-- unique index, so a student's many study sessions (all NULL on
-- `open_question_id`) do not collide, which is the same guarantee a
-- `WHERE ... IS NOT NULL` index gives. The difference is that ON CONFLICT
-- can only name a *non-partial* constraint, and the graders upsert on
-- `(user_id, open_question_id)` — a partial index fails those at runtime with
-- "no unique or exclusion constraint matching the ON CONFLICT specification".
ALTER TABLE public.chat_sessions
  ADD CONSTRAINT chat_sessions_unique_study_session UNIQUE (user_id, study_session_id);

ALTER TABLE public.chat_sessions
  ADD CONSTRAINT chat_sessions_unique_open_question UNIQUE (user_id, open_question_id);

CREATE INDEX chat_sessions_user ON public.chat_sessions (user_id);
CREATE INDEX chat_sessions_course ON public.chat_sessions (course_id);
CREATE INDEX chat_sessions_offering ON public.chat_sessions (offering_id);

CREATE TABLE public.chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES public.chat_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  sender_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  flagged_offensive BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- 'moderation' is the withheld-reply record. It is excluded both from the
  -- transcript the student loads and from the history replayed to the model,
  -- so the text is retained for review without re-entering the conversation.
  CONSTRAINT chat_messages_role_check
    CHECK (role = ANY (ARRAY['user', 'assistant', 'system', 'instructor', 'moderation'])),
  CONSTRAINT chat_messages_instructor_sender_check
    CHECK (role <> 'instructor' OR sender_user_id IS NOT NULL)
);

CREATE INDEX chat_messages_session_created
  ON public.chat_messages (session_id, created_at);

CREATE TABLE public.chat_session_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL UNIQUE REFERENCES public.chat_sessions(id) ON DELETE CASCADE,
  current_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.chat_state_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Keyed on the session, not on the 1:1 state row. The legacy tables pointed
  -- history at their state row, which made it a grandchild of anything that
  -- reaches a student — and `chat_session_state` holds no information the
  -- session does not, so the indirection bought nothing. Hanging it off the
  -- session keeps the erasure and export machinery to a single hop.
  session_id UUID NOT NULL REFERENCES public.chat_sessions(id) ON DELETE CASCADE,
  state_before JSONB,
  state_after JSONB NOT NULL,
  transition_type VARCHAR(50) NOT NULL,
  trigger_message_id UUID REFERENCES public.chat_messages(id) ON DELETE SET NULL,
  -- Socratic promoted these out of the state JSON; the study side left them in
  -- it. Keeping the columns costs three nullable fields and gives both surfaces
  -- the same queryable shape.
  llm_decision VARCHAR(20),
  llm_judgement VARCHAR(20),
  llm_confidence DECIMAL(3,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX chat_state_history_session ON public.chat_state_history (session_id);
CREATE INDEX chat_state_history_created ON public.chat_state_history (created_at);

-- =============================================================================
-- Backfill, in FK order. Primary keys are carried across unchanged so that
-- every existing reference (trigger_message_id, session_state_id) survives
-- without a mapping table.
-- =============================================================================

INSERT INTO public.chat_sessions (
  id, user_id, course_id, offering_id, study_session_id, open_question_id,
  status, started_at, completed_at, created_at, updated_at
)
SELECT
  id, user_id, course_id, offering_id, study_session_id, NULL,
  status, started_at, completed_at, created_at, updated_at
FROM public.student_study_progress;

INSERT INTO public.chat_sessions (
  id, user_id, course_id, offering_id, study_session_id, open_question_id,
  status, started_at, completed_at, created_at, updated_at
)
SELECT
  id, user_id, course_id, offering_id, NULL, open_question_id,
  status, started_at, completed_at, created_at, updated_at
FROM public.open_question_progress;

-- A socratic chat or state row is keyed by (user, question) rather than by a
-- progress row, so either can exist without one. Those rows are real student
-- work; synthesise the missing session rather than dropping them on the floor.
INSERT INTO public.chat_sessions (
  user_id, course_id, offering_id, study_session_id, open_question_id,
  status, started_at, created_at, updated_at
)
SELECT
  orphan.user_id,
  -- Grouped by (user, question) only, never by course. A question belongs to
  -- one course, but `open_question_chats` has no constraint saying so, and
  -- grouping on a stray course_id would emit two sessions for one pair and
  -- trip the partial unique index — turning a data blemish into a failed
  -- production migration. The earliest-recorded course wins; there is no
  -- min(uuid), hence the array pick.
  (array_agg(orphan.course_id ORDER BY orphan.created_at, orphan.course_id))[1],
  NULL,
  NULL,
  orphan.open_question_id,
  'in_progress',
  min(orphan.created_at),
  min(orphan.created_at),
  max(orphan.created_at)
FROM (
  SELECT user_id, course_id, open_question_id, created_at
  FROM public.open_question_chats
  UNION ALL
  SELECT s.user_id, s.course_id, s.open_question_id, s.created_at
  FROM public.socratic_session_state s
) AS orphan
WHERE NOT EXISTS (
  SELECT 1 FROM public.open_question_progress p
  WHERE p.user_id = orphan.user_id
    AND p.open_question_id = orphan.open_question_id
)
GROUP BY orphan.user_id, orphan.open_question_id;

-- Scope the open-question sessions that arrived without an offering.
--
-- `instructor_can_access_student_work` deliberately refuses a row with no
-- offering rather than inferring one — 20260822100000 sets out why at length:
-- every witness the inference could lean on is deletable, so once the trace
-- that work belonged to 1Β is gone, any inference returns 1Α. That stance is
-- right, but it means an unscoped session is invisible to a section-restricted
-- instructor, where the legacy open-question rule let them reach it through
-- the student's enrolment.
--
-- So the offering is resolved here, once, while the evidence still exists: the
-- published offering for that question whose class the student is enrolled in.
-- Rows where that is ambiguous or absent stay NULL and take the strict
-- treatment, which is the same treatment the study side already gives them.
UPDATE public.chat_sessions s
SET offering_id = resolved.offering_id
FROM (
  SELECT
    cs.id AS session_id,
    (array_agg(oq.offering_id ORDER BY oq.published_at DESC))[1] AS offering_id
  FROM public.chat_sessions cs
  JOIN public.offering_questions oq
    ON oq.question_id = cs.open_question_id
   AND oq.published_at IS NOT NULL
  JOIN public.offerings o
    ON o.id = oq.offering_id
   AND o.course_id = cs.course_id
  JOIN public.class_enrollments ce
    ON ce.class_id = o.class_id
   AND ce.user_id = cs.user_id
   AND ce.role = 'student'
  WHERE cs.open_question_id IS NOT NULL
    AND cs.offering_id IS NULL
  GROUP BY cs.id
) AS resolved
WHERE s.id = resolved.session_id;

INSERT INTO public.chat_messages (
  id, session_id, role, content, sender_user_id, flagged_offensive, created_at
)
SELECT
  m.id, m.progress_id, m.role, m.content, m.sender_user_id, false, m.created_at
FROM public.study_session_messages m;

INSERT INTO public.chat_messages (
  id, session_id, role, content, sender_user_id, flagged_offensive, created_at
)
SELECT
  c.id,
  s.id,
  -- Divergence 2: socratic could not write 'moderation', so a withheld reply
  -- was stored as a flagged 'system' row. Only that code path writes this
  -- combination, so the mapping is exact.
  CASE WHEN c.role = 'system' AND c.flagged_offensive THEN 'moderation' ELSE c.role END,
  c.content,
  c.sender_user_id,
  coalesce(c.flagged_offensive, false),
  c.created_at
FROM public.open_question_chats c
JOIN public.chat_sessions s
  ON s.user_id = c.user_id
 AND s.open_question_id = c.open_question_id;

INSERT INTO public.chat_session_state (
  id, session_id, current_state, schema_version, created_at, updated_at
)
SELECT
  st.id, st.progress_id, st.current_state, st.schema_version, st.created_at, st.updated_at
FROM public.study_tutor_session_state st;

INSERT INTO public.chat_session_state (
  id, session_id, current_state, schema_version, created_at, updated_at
)
SELECT
  st.id, s.id, st.current_state, st.schema_version, st.created_at, st.updated_at
FROM public.socratic_session_state st
JOIN public.chat_sessions s
  ON s.user_id = st.user_id
 AND s.open_question_id = st.open_question_id;

INSERT INTO public.chat_state_history (
  id, session_id, state_before, state_after, transition_type,
  trigger_message_id, llm_decision, llm_judgement, llm_confidence, created_at
)
SELECT
  h.id, st.progress_id, h.state_before, h.state_after, h.transition_type,
  h.message_id, NULL, NULL, NULL, h.created_at
FROM public.study_tutor_state_history h
JOIN public.study_tutor_session_state st ON st.id = h.session_state_id;

INSERT INTO public.chat_state_history (
  id, session_id, state_before, state_after, transition_type,
  trigger_message_id, llm_decision, llm_judgement, llm_confidence, created_at
)
SELECT
  h.id, s.id, h.state_before, h.state_after, h.transition_type,
  h.trigger_message_id, h.llm_decision, h.llm_judgement, h.llm_confidence, h.created_at
FROM public.socratic_state_history h
JOIN public.socratic_session_state st ON st.id = h.session_state_id
JOIN public.chat_sessions s
  ON s.user_id = st.user_id
 AND s.open_question_id = st.open_question_id;

-- =============================================================================
-- Parity assertions. A silent partial copy must fail the migration rather than
-- ship, because the code switches over in the same release.
-- =============================================================================

DO $$
DECLARE
  expected BIGINT;
  actual BIGINT;
BEGIN
  SELECT (SELECT count(*) FROM public.student_study_progress)
       + (SELECT count(*) FROM public.open_question_progress)
    INTO expected;
  SELECT count(*) FROM public.chat_sessions
   WHERE id IN (SELECT id FROM public.student_study_progress
                UNION ALL SELECT id FROM public.open_question_progress)
    INTO actual;
  IF actual <> expected THEN
    RAISE EXCEPTION 'chat_sessions backfill mismatch: expected %, got %', expected, actual;
  END IF;

  SELECT (SELECT count(*) FROM public.study_session_messages)
       + (SELECT count(*) FROM public.open_question_chats)
    INTO expected;
  SELECT count(*) FROM public.chat_messages INTO actual;
  IF actual <> expected THEN
    RAISE EXCEPTION 'chat_messages backfill mismatch: expected %, got %', expected, actual;
  END IF;

  SELECT (SELECT count(*) FROM public.study_tutor_session_state)
       + (SELECT count(*) FROM public.socratic_session_state)
    INTO expected;
  SELECT count(*) FROM public.chat_session_state INTO actual;
  IF actual <> expected THEN
    RAISE EXCEPTION 'chat_session_state backfill mismatch: expected %, got %', expected, actual;
  END IF;

  SELECT (SELECT count(*) FROM public.study_tutor_state_history)
       + (SELECT count(*) FROM public.socratic_state_history)
    INTO expected;
  SELECT count(*) FROM public.chat_state_history INTO actual;
  IF actual <> expected THEN
    RAISE EXCEPTION 'chat_state_history backfill mismatch: expected %, got %', expected, actual;
  END IF;
END $$;

-- =============================================================================
-- Row Level Security
--
-- Reads keep the course-wide scope both surfaces already grant, so no
-- instructor loses visibility they have today. Writes and deletes take the
-- section-scoped predicates from the study side — that narrowing is the point
-- of divergence 1, and it is the only intended behaviour change.
-- =============================================================================

ALTER TABLE public.chat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_session_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_state_history ENABLE ROW LEVEL SECURITY;

-- ── chat_sessions ────────────────────────────────────────────────────────────

CREATE POLICY "Users can manage their own chat sessions"
ON public.chat_sessions
FOR ALL
USING (user_id = auth.uid())
WITH CHECK (
  user_id = auth.uid()
  AND public.student_may_attribute_to_offering(offering_id, course_id, auth.uid())
);

CREATE POLICY "Staff can view chat sessions in their courses"
ON public.chat_sessions
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.courses c
    WHERE c.id = chat_sessions.course_id
      AND (
        public.is_institution_admin(auth.uid(), c.institution_id)
        OR public.is_course_instructor(c.id, auth.uid())
      )
  )
);

CREATE POLICY "Staff can update chat sessions for their students"
ON public.chat_sessions
FOR UPDATE
USING (public.instructor_can_access_student_work(course_id, offering_id, user_id, auth.uid()))
WITH CHECK (public.instructor_can_access_student_work(course_id, offering_id, user_id, auth.uid()));

CREATE POLICY "Staff can delete chat sessions for their students"
ON public.chat_sessions
FOR DELETE
USING (public.instructor_can_access_student_work(course_id, offering_id, user_id, auth.uid()));

-- ── chat_messages ────────────────────────────────────────────────────────────

CREATE POLICY "Users can view their own chat messages"
ON public.chat_messages
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.chat_sessions s
    WHERE s.id = chat_messages.session_id AND s.user_id = auth.uid()
  )
);

CREATE POLICY "Staff can view chat messages in their courses"
ON public.chat_messages
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.chat_sessions s
    JOIN public.courses c ON c.id = s.course_id
    WHERE s.id = chat_messages.session_id
      AND (
        public.is_institution_admin(auth.uid(), c.institution_id)
        OR public.is_course_instructor(c.id, auth.uid())
      )
  )
);

-- Students write their own turn and nothing else. This is what stops a student
-- inserting an assistant turn and putting words in the tutor's mouth.
CREATE POLICY "Users can insert their own chat messages"
ON public.chat_messages
FOR INSERT
WITH CHECK (
  role = 'user'
  AND EXISTS (
    SELECT 1 FROM public.chat_sessions s
    WHERE s.id = chat_messages.session_id AND s.user_id = auth.uid()
  )
);

CREATE POLICY "Instructors can insert instructor messages"
ON public.chat_messages
FOR INSERT
WITH CHECK (
  role = 'instructor'
  AND sender_user_id = auth.uid()
  AND EXISTS (
    SELECT 1 FROM public.chat_sessions s
    WHERE s.id = chat_messages.session_id
      AND public.instructor_can_write_student_work(s.course_id, s.offering_id, s.user_id, auth.uid())
  )
);

CREATE POLICY "Staff can update chat messages in their courses"
ON public.chat_messages
FOR UPDATE
USING (
  EXISTS (
    SELECT 1 FROM public.chat_sessions s
    JOIN public.courses c ON c.id = s.course_id
    WHERE s.id = chat_messages.session_id
      AND (
        public.is_institution_admin(auth.uid(), c.institution_id)
        OR public.is_course_instructor(c.id, auth.uid())
      )
  )
);

CREATE POLICY "Staff can delete chat messages for their students"
ON public.chat_messages
FOR DELETE
USING (
  EXISTS (
    SELECT 1 FROM public.chat_sessions s
    WHERE s.id = chat_messages.session_id
      AND public.instructor_can_access_student_work(s.course_id, s.offering_id, s.user_id, auth.uid())
  )
);

-- ── chat_session_state ───────────────────────────────────────────────────────

CREATE POLICY "Service role full access to chat session state"
ON public.chat_session_state
FOR ALL
USING (auth.jwt() ->> 'role' = 'service_role');

CREATE POLICY "Users can read own chat session state"
ON public.chat_session_state
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.chat_sessions s
    WHERE s.id = chat_session_state.session_id AND s.user_id = auth.uid()
  )
);

CREATE POLICY "Users can insert own chat session state"
ON public.chat_session_state
FOR INSERT
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.chat_sessions s
    WHERE s.id = chat_session_state.session_id AND s.user_id = auth.uid()
  )
);

CREATE POLICY "Users can update own chat session state"
ON public.chat_session_state
FOR UPDATE
USING (
  EXISTS (
    SELECT 1 FROM public.chat_sessions s
    WHERE s.id = chat_session_state.session_id AND s.user_id = auth.uid()
  )
);

CREATE POLICY "Staff can read chat session state in their courses"
ON public.chat_session_state
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.chat_sessions s
    JOIN public.courses c ON c.id = s.course_id
    WHERE s.id = chat_session_state.session_id
      AND (
        public.is_institution_admin(auth.uid(), c.institution_id)
        OR public.is_course_instructor(c.id, auth.uid())
      )
  )
);

-- ── chat_state_history ───────────────────────────────────────────────────────

CREATE POLICY "Service role full access to chat state history"
ON public.chat_state_history
FOR ALL
USING (auth.jwt() ->> 'role' = 'service_role');

CREATE POLICY "Users can read own chat state history"
ON public.chat_state_history
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.chat_sessions s
    WHERE s.id = chat_state_history.session_id AND s.user_id = auth.uid()
  )
);

CREATE POLICY "Staff can read chat state history in their courses"
ON public.chat_state_history
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.chat_sessions s
    JOIN public.courses c ON c.id = s.course_id
    WHERE s.id = chat_state_history.session_id
      AND (
        public.is_institution_admin(auth.uid(), c.institution_id)
        OR public.is_course_instructor(c.id, auth.uid())
      )
  )
);

-- =============================================================================
-- updated_at triggers (reuse the generic helper rather than adding two more
-- single-table copies of it)
-- =============================================================================

CREATE TRIGGER chat_sessions_set_updated_at
  BEFORE UPDATE ON public.chat_sessions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER chat_session_state_set_updated_at
  BEFORE UPDATE ON public.chat_session_state
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
