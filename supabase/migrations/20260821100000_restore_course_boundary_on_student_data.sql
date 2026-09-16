-- Issue #1101 (part of #1097): restore the course boundary on student data.
--
-- Eleven policies across six tables authorised on institution membership plus
-- a role string, with no `course_instructors` lookup anywhere:
--
--   EXISTS (
--     SELECT 1 FROM courses c
--     JOIN user_institutions ui ON ui.institution_id = c.institution_id
--     WHERE c.id = <table>.course_id
--     AND ui.user_id = auth.uid()
--     AND ui.role IN ('admin', 'instructor')
--   )
--
-- Membership in the institution with role = 'instructor' satisfies that for
-- every course in the institution. An instructor therefore read — and in
-- several cases wrote — the AI-tutoring transcripts, tutoring progress and
-- open-question grades of students in courses they have never been assigned
-- to.
--
-- The tables carry the most personal content in the schema:
-- `open_question_chats`, `study_session_messages` and `textbook_chat_messages`
-- are full tutoring transcripts, a student's own words at length;
-- `open_question_grades` holds per-question grades and written feedback.
--
-- Why it survived: 20260401000000_migrate_instructor_rbac_to_course_instructors
-- replaced inline instructor checks with `is_course_instructor` across the
-- schema and did reach `student_study_progress` and `study_session_messages` —
-- but only their UPDATE and DELETE policies. The SELECT policies from
-- 20251208202655 were never dropped, and PostgreSQL ORs permissive policies
-- together, so the narrow policy added later does not constrain the wide one
-- that stayed. The `open_question_*` and `textbook_chat_messages` tables that
-- migration did not touch at all.
--
-- The replacement is what the rest of the schema does post-20260401000000:
--
--   is_institution_admin(auth.uid(), c.institution_id)
--   OR is_course_instructor(c.id, auth.uid())
--
-- Institution admins currently come in through the same `ui.role` term, so
-- `is_institution_admin` is a replacement for that branch, not an addition —
-- and it also folds in `is_super_admin`, which is why the separate
-- `is_super_admin(auth.uid())` disjunct is dropped where it appeared.
--
-- Scope note: this migration restores the *course* boundary only. Narrowing
-- the instructor branch further to the section (`course_instructor_sections`)
-- is the open decision in #1097 and is handled by its other children; nothing
-- has ever claimed the course boundary itself should be absent.
--
-- Three policies beyond those named in #1101 are fixed here, because the live
-- database showed them carrying the identical predicate: `open_question_chats`
-- SELECT (the transcript read the issue title is about, while its body listed
-- only the UPDATE), `open_question_progress` SELECT, and the whole of
-- `textbook_chat_messages`, which the issue did not mention at all. Leaving any
-- of them behind would leave the same hole open under a different table name.

-- ============================================================
-- open_question_grades — per-question grades and written feedback
-- ============================================================

DROP POLICY IF EXISTS "Admins and instructors can view grades" ON public.open_question_grades;
CREATE POLICY "Admins and instructors can view grades"
ON public.open_question_grades
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM courses c
    WHERE c.id = open_question_grades.course_id
    AND (
      is_institution_admin(auth.uid(), c.institution_id)
      OR is_course_instructor(c.id, auth.uid())
    )
  )
);

DROP POLICY IF EXISTS "Admins and instructors can insert grades" ON public.open_question_grades;
CREATE POLICY "Admins and instructors can insert grades"
ON public.open_question_grades
FOR INSERT
WITH CHECK (
  EXISTS (
    SELECT 1 FROM courses c
    WHERE c.id = open_question_grades.course_id
    AND (
      is_institution_admin(auth.uid(), c.institution_id)
      OR is_course_instructor(c.id, auth.uid())
    )
  )
);

DROP POLICY IF EXISTS "Admins and instructors can update grades" ON public.open_question_grades;
CREATE POLICY "Admins and instructors can update grades"
ON public.open_question_grades
FOR UPDATE
USING (
  EXISTS (
    SELECT 1 FROM courses c
    WHERE c.id = open_question_grades.course_id
    AND (
      is_institution_admin(auth.uid(), c.institution_id)
      OR is_course_instructor(c.id, auth.uid())
    )
  )
);

DROP POLICY IF EXISTS "Admins and instructors can delete grades" ON public.open_question_grades;
CREATE POLICY "Admins and instructors can delete grades"
ON public.open_question_grades
FOR DELETE
USING (
  EXISTS (
    SELECT 1 FROM courses c
    WHERE c.id = open_question_grades.course_id
    AND (
      is_institution_admin(auth.uid(), c.institution_id)
      OR is_course_instructor(c.id, auth.uid())
    )
  )
);

-- ============================================================
-- open_question_progress — tutoring progress, incl. the flag/unflag path
-- ============================================================

DROP POLICY IF EXISTS "Admins can view all progress" ON public.open_question_progress;
CREATE POLICY "Admins can view all progress"
ON public.open_question_progress
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM courses c
    WHERE c.id = open_question_progress.course_id
    AND (
      is_institution_admin(auth.uid(), c.institution_id)
      OR is_course_instructor(c.id, auth.uid())
    )
  )
);

DROP POLICY IF EXISTS "Admins and instructors can update progress in their courses" ON public.open_question_progress;
CREATE POLICY "Admins and instructors can update progress in their courses"
ON public.open_question_progress
FOR UPDATE
USING (
  EXISTS (
    SELECT 1 FROM courses c
    WHERE c.id = open_question_progress.course_id
    AND (
      is_institution_admin(auth.uid(), c.institution_id)
      OR is_course_instructor(c.id, auth.uid())
    )
  )
);

-- ============================================================
-- open_question_chats — the tutoring transcript itself
-- ============================================================

DROP POLICY IF EXISTS "Admins can view all chats in their courses" ON public.open_question_chats;
CREATE POLICY "Admins can view all chats in their courses"
ON public.open_question_chats
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM courses c
    WHERE c.id = open_question_chats.course_id
    AND (
      is_institution_admin(auth.uid(), c.institution_id)
      OR is_course_instructor(c.id, auth.uid())
    )
  )
);

DROP POLICY IF EXISTS "Admins and instructors can update chats in their courses" ON public.open_question_chats;
CREATE POLICY "Admins and instructors can update chats in their courses"
ON public.open_question_chats
FOR UPDATE
USING (
  EXISTS (
    SELECT 1 FROM courses c
    WHERE c.id = open_question_chats.course_id
    AND (
      is_institution_admin(auth.uid(), c.institution_id)
      OR is_course_instructor(c.id, auth.uid())
    )
  )
);

-- ============================================================
-- student_study_progress — SELECT only; UPDATE/DELETE were already narrowed
-- by 20260401000000 and are left untouched here.
-- ============================================================

DROP POLICY IF EXISTS "Admins can view all progress in their courses" ON public.student_study_progress;
CREATE POLICY "Admins can view all progress in their courses"
ON public.student_study_progress
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM courses c
    WHERE c.id = student_study_progress.course_id
    AND (
      is_institution_admin(auth.uid(), c.institution_id)
      OR is_course_instructor(c.id, auth.uid())
    )
  )
);

-- ============================================================
-- study_session_messages — reaches the course through the parent progress row
-- ============================================================

DROP POLICY IF EXISTS "Admins can view messages" ON public.study_session_messages;
CREATE POLICY "Admins can view messages"
ON public.study_session_messages
FOR SELECT
USING (
  EXISTS (
    SELECT 1
    FROM student_study_progress p
    JOIN courses c ON c.id = p.course_id
    WHERE p.id = study_session_messages.progress_id
    AND (
      is_institution_admin(auth.uid(), c.institution_id)
      OR is_course_instructor(c.id, auth.uid())
    )
  )
);

-- ============================================================
-- textbook_chat_messages — the textbook copilot transcript
-- ============================================================

DROP POLICY IF EXISTS "Admins can view textbook chat messages" ON public.textbook_chat_messages;
CREATE POLICY "Admins can view textbook chat messages"
ON public.textbook_chat_messages
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM courses c
    WHERE c.id = textbook_chat_messages.course_id
    AND (
      is_institution_admin(auth.uid(), c.institution_id)
      OR is_course_instructor(c.id, auth.uid())
    )
  )
);
