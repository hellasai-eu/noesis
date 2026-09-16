-- Issue #1105 (part of #1097): section-scope tutoring progress, tutoring
-- transcripts and chapter progress.
--
-- These are the write surfaces. A 1Α-restricted instructor could:
--
--   * unpause, edit or delete a 1Β student's tutoring progress — the
--     pause/unpause flow in OpenQuestionChatHistory.tsx writes exactly this;
--   * delete a 1Β student's tutoring messages;
--   * post an `instructor`-role message into a 1Β student's thread with the
--     tutor, which the student sees attributed to a named instructor;
--   * read and edit another class's chapter-completion state.
--
-- The rule is the two-armed one this epic uses throughout, via
-- `instructor_can_access_student_work`: if the row names an offering (or a
-- class), that decides, provided it is coherent with the row; otherwise fall
-- back to the student's enrolment. The offering arm has to come first, because
-- a student may sit in two classes taking the same course and deciding on the
-- student alone would let a 1Α-restricted instructor reach 1Β work through the
-- student's other enrolment.
--
-- ============================================================
-- course_chapter_progress had a second, older problem
-- ============================================================
--
-- The live database carries FOUR policies on it, not the two #1105 names.
-- 20260401000000 added class-scoped ones (`:193`, `:226`) but never dropped
-- the course-scoped pair from 20251226141136, and PostgreSQL ORs permissive
-- policies together — so the narrow pair has been inert ever since:
--
--   "Admins and instructors can manage chapter progress"  (FOR ALL)
--       course-wide, ignores class_id entirely
--   "Students can view chapter progress"                  (SELECT)
--       any institution member with course access, every class
--
-- That is the same failure as #1101, on a different table: a wide policy left
-- standing next to the narrow one written to replace it. Section-scoping
-- `:193` and `:226` without dropping these two would change nothing at all, so
-- they go here.
--
-- `class_id` is nullable — rows predating 20260129082800 have none. Those
-- cannot be placed in a class at all, so they fall back to course-level
-- instructor access rather than becoming invisible.
--
-- ============================================================
-- One access arm is deliberately removed
-- ============================================================
--
-- The `student_study_progress` UPDATE/DELETE policies carried
-- `c.created_by = auth.uid()` — whoever created the course, regardless of
-- whether they teach it now or are restricted to a section of it. That arm is
-- dropped rather than carried through. It is course-wide by construction, so
-- keeping it would leave the exact hole this migration closes open to one
-- specific user; a course creator who should retain access has it through
-- `course_instructors` or an admin role.
--
-- Verified against a live database before writing.

-- ============================================================
-- student_study_progress — the instructor pause/unpause and delete paths
-- ============================================================

DROP POLICY IF EXISTS "Admins and instructors can update study progress in their courses" ON public.student_study_progress;
CREATE POLICY "Admins and instructors can update study progress in their courses"
ON public.student_study_progress
FOR UPDATE
USING (
  instructor_can_access_student_work(course_id, offering_id, user_id, auth.uid())
)
WITH CHECK (
  -- The access rule, not the write rule. Unpausing is a lifecycle edit, and
  -- gating it on current enrolment would stop an instructor tidying up the
  -- progress of a student who has left the class. The offering the row names
  -- is trustworthy — the student policy below constrains what they may file
  -- their own progress under — so the access rule keeps the edit inside the
  -- instructor's sections without that cost.
  instructor_can_access_student_work(course_id, offering_id, user_id, auth.uid())
);

DROP POLICY IF EXISTS "Admins and instructors can delete study progress in their courses" ON public.student_study_progress;
CREATE POLICY "Admins and instructors can delete study progress in their courses"
ON public.student_study_progress
FOR DELETE
USING (
  instructor_can_access_student_work(course_id, offering_id, user_id, auth.uid())
);

-- The same trust problem as `quiz_sessions`, on the same shape of policy.
-- "Users can manage their own progress" is FOR ALL with a USING clause and no
-- WITH CHECK, so PostgreSQL reuses `user_id = auth.uid()` for writes — which
-- says who the row belongs to and nothing about which offering it may name. A
-- student could file their tutoring progress under another section's offering
-- and choose which instructor gets to see and pause it.

DROP POLICY IF EXISTS "Users can manage their own progress" ON public.student_study_progress;
CREATE POLICY "Users can manage their own progress"
ON public.student_study_progress
FOR ALL
USING (user_id = auth.uid())
WITH CHECK (
  user_id = auth.uid()
  AND student_may_attribute_to_offering(offering_id, course_id, auth.uid())
);

-- ============================================================
-- study_session_messages — reached through the parent progress row
-- ============================================================

DROP POLICY IF EXISTS "Admins and instructors can delete study messages in their courses" ON public.study_session_messages;
CREATE POLICY "Admins and instructors can delete study messages in their courses"
ON public.study_session_messages
FOR DELETE
USING (
  EXISTS (
    SELECT 1 FROM student_study_progress ssp
    WHERE ssp.id = study_session_messages.progress_id
    AND instructor_can_access_student_work(
      ssp.course_id, ssp.offering_id, ssp.user_id, auth.uid()
    )
  )
);

-- Posting into a student's thread as a named instructor. Same rule: an
-- instructor restricted to 1Α must not be able to speak into a 1Β student's
-- conversation with the tutor.
DROP POLICY IF EXISTS "Instructors can insert instructor messages" ON public.study_session_messages;
CREATE POLICY "Instructors can insert instructor messages"
ON public.study_session_messages
FOR INSERT
WITH CHECK (
  role = 'instructor'
  AND sender_user_id = auth.uid()
  AND EXISTS (
    SELECT 1 FROM student_study_progress ssp
    WHERE ssp.id = study_session_messages.progress_id
    -- The write rule: posting into the thread of a student who is not in the
    -- offering is not something an instructor should be able to do.
    AND instructor_can_write_student_work(
      ssp.course_id, ssp.offering_id, ssp.user_id, auth.uid()
    )
  )
);

-- ============================================================
-- open_question_chats — the same injection path on the other tutoring surface
-- ============================================================
-- Not named in #1105, but it is the identical policy under the identical name
-- guarding the identical harm on the sibling table, and `open_question_chats`
-- has no offering column, so the student's enrolment is the only route.

DROP POLICY IF EXISTS "Instructors can insert instructor messages" ON public.open_question_chats;
CREATE POLICY "Instructors can insert instructor messages"
ON public.open_question_chats
FOR INSERT
WITH CHECK (
  role = 'instructor'
  AND sender_user_id = auth.uid()
  AND instructor_can_access_student(course_id, user_id, auth.uid())
);

-- ============================================================
-- course_chapter_progress
-- ============================================================

-- Superseded by the class-scoped pair below, and wider than them, so they have
-- had no effect while these stood.
DROP POLICY IF EXISTS "Admins and instructors can manage chapter progress" ON public.course_chapter_progress;
DROP POLICY IF EXISTS "Students can view chapter progress" ON public.course_chapter_progress;

DROP POLICY IF EXISTS "Users can view chapter progress for their classes" ON public.course_chapter_progress;
CREATE POLICY "Users can view chapter progress for their classes"
ON public.course_chapter_progress
FOR SELECT
USING (
  -- Students enrolled in the class the row is about.
  EXISTS (
    SELECT 1 FROM class_enrollments ce
    WHERE ce.class_id = course_chapter_progress.class_id
    AND ce.user_id = auth.uid()
    AND ce.role = 'student'
  )
  OR CASE
    -- `is_class_instructor` folds in course_instructor_sections.
    WHEN class_id IS NOT NULL THEN
      is_class_instructor(class_id)
      OR EXISTS (
        SELECT 1 FROM classes c
        WHERE c.id = course_chapter_progress.class_id
        AND is_institution_admin(auth.uid(), c.institution_id)
      )
    -- Rows predating 20260129082800 name no class, so there is no section to
    -- check and course-level access is the most that can be resolved.
    ELSE
      is_course_instructor(course_id, auth.uid())
      OR EXISTS (
        SELECT 1 FROM courses c
        WHERE c.id = course_chapter_progress.course_id
        AND is_institution_admin(auth.uid(), c.institution_id)
      )
  END
);

DROP POLICY IF EXISTS "Instructors and admins can manage chapter progress" ON public.course_chapter_progress;
CREATE POLICY "Instructors and admins can manage chapter progress"
ON public.course_chapter_progress
FOR ALL
USING (
  CASE
    WHEN class_id IS NOT NULL THEN
      is_class_instructor(class_id)
      OR EXISTS (
        SELECT 1 FROM classes c
        WHERE c.id = course_chapter_progress.class_id
        AND is_institution_admin(auth.uid(), c.institution_id)
      )
    ELSE
      is_course_instructor(course_id, auth.uid())
      OR EXISTS (
        SELECT 1 FROM courses c
        WHERE c.id = course_chapter_progress.course_id
        AND is_institution_admin(auth.uid(), c.institution_id)
      )
  END
)
WITH CHECK (
  CASE
    WHEN class_id IS NOT NULL THEN
      is_class_instructor(class_id)
      OR EXISTS (
        SELECT 1 FROM classes c
        WHERE c.id = course_chapter_progress.class_id
        AND is_institution_admin(auth.uid(), c.institution_id)
      )
    ELSE
      is_course_instructor(course_id, auth.uid())
      OR EXISTS (
        SELECT 1 FROM courses c
        WHERE c.id = course_chapter_progress.course_id
        AND is_institution_admin(auth.uid(), c.institution_id)
      )
  END
);
