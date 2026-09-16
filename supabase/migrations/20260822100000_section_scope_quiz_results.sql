-- Issue #1102 (part of #1097): section-scope quiz sessions and answers.
--
-- Section restrictions (#59) stop at the assignment row. `offering_quizzes` is
-- guarded by `can_manage_offering`, which folds in `course_instructor_sections`
-- — so an instructor restricted to Τμήμα 1Α cannot publish a quiz to 1Β. The
-- *results* of that quiz were guarded by `is_course_instructor`, which is
-- course-level by design and never consults the restriction table. The 1Α
-- instructor could therefore read every 1Β student's session (score, timing)
-- and every 1Β answer (which option, per question), and delete those answers.
--
-- ============================================================
-- Why not simply can_manage_offering(offering_id)
-- ============================================================
--
-- Both tables carry `offering_id` (20251229065522), so that looks like a
-- one-line substitution. It is NULLABLE on both and stays that way by design —
-- practice-mode work belongs to no offering, and
-- 20260605000000_offering_quizzes_closed_at.sql already works around the same
-- nullability when gating inserts. A straight swap would hide every
-- practice-mode and legacy row from every instructor.
--
-- ============================================================
-- The rule
-- ============================================================
--
--   * the row names an offering → that offering decides, as it already does
--     for the assignment tables, provided it is coherent with the row: it must
--     belong to the row's own course.
--   * the row names none        → only an unrestricted instructor may see it.
--
-- The first arm has to come first. A student may sit in two classes taking the
-- same course, so resolving an offering-attributed row through the student's
-- enrolments would let an instructor restricted to 1Α reach a 1Β-attributed
-- result through the student's other enrolment. Where the row says which
-- section the work was done in, that answer wins.
--
-- The second arm refuses to guess, and that is the whole of its design. The
-- tempting alternative — reconstruct the section from the student's enrolments
-- — cannot be made safe, and review established that by counterexample four
-- times over: every witness such a rule can lean on is deletable. The offering
-- goes with ON DELETE SET NULL; deleting the class takes the enrolment with it;
-- `course_instructor_sections` rows can simply be removed. Once the last trace
-- that the work belonged to 1Β is gone, any rule inferring a section from what
-- remains infers 1Α. Declining to infer has no such chain, and it is what the
-- restriction means anyway: an instructor confined to 1Α may see 1Α's work, and
-- unattributed work has not been shown to be 1Α's.
--
-- The deliberate cost: a section-restricted instructor cannot see their own
-- students' practice-mode results. Institution admins and unrestricted
-- instructors are unaffected — no restriction rows means no confinement to
-- contradict (the #59 semantic from 20260402000000:4).
--
-- ============================================================
-- Three things the policies cannot do on their own
-- ============================================================
--
-- 1. A per-(course, student) table has no section to attribute anything to —
--    `evaluation_timeline_cache`, `graded_tests`, `open_question_chats` are one
--    row per student per course. Asking "which section is this row in" is a
--    category error there; the question is "does this instructor teach this
--    student", which `instructor_can_access_student` answers below, in the
--    shape `student_admin_notes` has used since 20260603200000.
--
-- 2. The rule above is only as trustworthy as `offering_id`, and that column is
--    written by the student who owns the row. See "Making `offering_id` worth
--    trusting" below.
--
-- 3. A WITH CHECK sees only the finished row, so it cannot tell a legitimate
--    edit from one that re-files the row under a different student. See
--    "Ownership is immutable" below.
--
-- One boundary is left open on purpose, because it is a data-lifecycle fact
-- rather than a policy hole: deleting a *class* erases the offering, the
-- enrolment and the restriction rows together, and nothing in the database then
-- records which section the work belonged to. The guard there is a foreign key
-- that already exists — `quiz_answers.offering_id` is ON DELETE RESTRICT (as
-- are `open_question_grades` and `student_evaluations`), so wherever the
-- per-question data exists the class delete is refused outright and only an
-- answer-less session can be orphaned. There is a test pinning that refusal.
--
-- Verified against a live database before writing: `SELECT polname,
-- pg_get_expr(polqual, polrelid) FROM pg_policy` confirmed all four policies
-- still carry the predicates #1102 describes.
--
-- ============================================================
-- The helper
-- ============================================================

CREATE OR REPLACE FUNCTION public.instructor_can_access_student(
  _course_id uuid,
  _student_id uuid,
  _user_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM courses c
    WHERE c.id = _course_id
    AND (
      -- Folds in is_super_admin.
      is_institution_admin(_user_id, c.institution_id)
      OR (
        is_course_instructor(_course_id, _user_id)
        AND (
          -- No restriction rows for this (course, instructor) = full access,
          -- which has to hold even for a student with no enrolment at all.
          NOT EXISTS (
            SELECT 1 FROM course_instructor_sections cis
            WHERE cis.course_id = _course_id
            AND cis.user_id = _user_id
          )
          -- Restricted: the student sits in at least one section of this
          -- course that this instructor may reach.
          OR EXISTS (
            SELECT 1
            FROM class_enrollments ce
            JOIN offerings o
              ON o.class_id = ce.class_id
              AND o.course_id = _course_id
            WHERE ce.user_id = _student_id
            AND ce.role = 'student'
            AND instructor_can_access_section(_course_id, ce.class_id, _user_id)
          )
        )
      )
    )
  )
$$;

COMMENT ON FUNCTION public.instructor_can_access_student(uuid, uuid, uuid) IS
  'True when the user teaches or administers this student in this course — the '
  'same shape student_admin_notes has used since 20260603200000. For the '
  'per-(course, student) tables with no section dimension of their own: the '
  'timeline cache, graded tests, open-question threads. Work rows that DO name '
  'a section use instructor_can_access_student_work instead (#1097).';

-- ============================================================
-- The rule the student-work policies apply
-- ============================================================
-- One entry point, so the two arms cannot drift apart across the tables that
-- need them, and so the coherence conditions below are stated once.

CREATE OR REPLACE FUNCTION public.instructor_can_access_student_work(
  _course_id uuid,
  _offering_id uuid,
  _student_id uuid,
  _user_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    -- Institution admins (and super admins, folded in) are unconditional, and
    -- deliberately sit outside the coherence checks below: an incoherent or
    -- orphaned row is exactly the sort of thing an admin has to be able to see
    -- in order to fix it.
    EXISTS (
      SELECT 1 FROM courses c
      WHERE c.id = _course_id
      AND is_institution_admin(_user_id, c.institution_id)
    )
    OR (
      is_course_instructor(_course_id, _user_id)
      AND CASE
        WHEN _offering_id IS NOT NULL THEN EXISTS (
          SELECT 1 FROM offerings o
          WHERE o.id = _offering_id
          -- The offering must belong to the row's own course. Without this an
          -- offering the instructor manages is a key that opens rows naming a
          -- different course entirely.
          AND o.course_id = _course_id
          AND instructor_can_access_section(_course_id, o.class_id, _user_id)
        )
        -- Unattributed: practice-mode work, and rows whose offering was
        -- deleted (`quiz_sessions.offering_id` is ON DELETE SET NULL). There
        -- is nothing in the row placing it in a section, so a section-
        -- restricted instructor does not get it. Full stop.
        --
        -- The alternative — reconstructing the section from the student's
        -- enrolments — cannot be made safe, and review demonstrated that
        -- repeatedly: every witness it can lean on is deletable. The offering
        -- goes with ON DELETE SET NULL, the class takes the enrolment with it,
        -- and `course_instructor_sections` rows can simply be removed. Once
        -- the last trace that the work belonged to 1Β is gone, any rule that
        -- infers a section from what remains infers 1Α. Refusing to infer at
        -- all is the only version of this with no such chain, and it is what
        -- the restriction means anyway: an instructor confined to 1Α may see
        -- 1Α's work, and unattributed work has not been shown to be 1Α's.
        --
        -- Unrestricted instructors are unaffected, which is the #59 semantic:
        -- no restriction rows means no confinement to contradict.
        ELSE NOT EXISTS (
          SELECT 1 FROM course_instructor_sections cis
          WHERE cis.course_id = _course_id
          AND cis.user_id = _user_id
        )
      END
    )
$$;

COMMENT ON FUNCTION public.instructor_can_access_student_work(uuid, uuid, uuid, uuid) IS
  'Section rule for one student''s work in a course (#1097). Where the row '
  'names an offering, that offering decides — and must be coherent with the '
  'row''s course and student. Where it names none, only an unrestricted '
  'instructor may see it — an unattributed row has not been shown to belong '
  'to any section. Institution admins bypass both arms.';

-- The write half of the same rule.
--
-- Reading and writing need different tests here, and collapsing them into one
-- is what an earlier cut of this got wrong. Writing a row that names an
-- offering must also name a student who sits in that offering's class:
-- otherwise an offering the instructor manages is a forging primitive — stamp
-- it onto a new row naming any student at all and the WITH CHECK passes, which
-- on the FOR ALL policies in this epic creates records about people the
-- instructor has no relationship with.
--
-- Requiring that on *reads* would be wrong, though, and would break a case that
-- has nothing to do with forging: a student who leaves the class keeps their
-- quiz history, and an instructor — including an entirely unrestricted one —
-- must still be able to see the work that was done while they were enrolled.
-- Enrolment is a fact about now; the row is a fact about then.

CREATE OR REPLACE FUNCTION public.instructor_can_write_student_work(
  _course_id uuid,
  _offering_id uuid,
  _student_id uuid,
  _user_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    instructor_can_access_student_work(_course_id, _offering_id, _student_id, _user_id)
    AND (
      _offering_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM offerings o
        JOIN class_enrollments ce
          ON ce.class_id = o.class_id
          AND ce.user_id = _student_id
          AND ce.role = 'student'
        WHERE o.id = _offering_id
      )
    )
$$;

COMMENT ON FUNCTION public.instructor_can_write_student_work(uuid, uuid, uuid, uuid) IS
  'instructor_can_access_student_work plus the requirement that the student '
  'currently sits in the named offering''s class. For WITH CHECK only — it '
  'stops a managed offering being used to forge rows about arbitrary students, '
  'and must not gate reads, which have to keep showing the work of students '
  'who have since left the class (#1097).';

-- ============================================================
-- Making `offering_id` worth trusting
-- ============================================================
--
-- Everything above decides on the row's `offering_id`, which means the column
-- has to be something the subject cannot choose freely. It was not.
-- `quiz_sessions` and `quiz_answers` are written by the student who owns them,
-- and "Users can update their own quiz sessions" carried no WITH CHECK at all —
-- PostgreSQL then reuses the USING expression, `user_id = auth.uid()`, which
-- constrains who the row belongs to and nothing else. A student could therefore
-- point their own session at any offering in the system, including another
-- section's, and hand that section's instructor access to it. The subject
-- granting a third party access to their own record is a small thing here and a
-- bad shape anywhere.
--
-- So the student-owned write paths gain the coherence they were missing: a
-- student may only attribute their work to an offering of that work's course
-- that they actually sit in. `offering_id IS NULL` stays allowed — that is
-- practice mode, and the policies above already decline to infer a section
-- from it.

CREATE OR REPLACE FUNCTION public.student_may_attribute_to_offering(
  _offering_id uuid,
  _course_id uuid,
  _student_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    _offering_id IS NULL
    OR EXISTS (
      SELECT 1
      FROM offerings o
      JOIN class_enrollments ce
        ON ce.class_id = o.class_id
        AND ce.user_id = _student_id
        AND ce.role = 'student'
      WHERE o.id = _offering_id
      AND o.course_id = _course_id
    )
$$;

COMMENT ON FUNCTION public.student_may_attribute_to_offering(uuid, uuid, uuid) IS
  'True when a student may file their own work under this offering: it belongs '
  'to the work''s course and they sit in its class. NULL is allowed (practice '
  'mode). Stops a student choosing which section — and so which instructor — '
  'their work is visible to (#1097).';

DROP POLICY IF EXISTS "Users can create their own quiz sessions" ON public.quiz_sessions;
CREATE POLICY "Users can create their own quiz sessions"
ON public.quiz_sessions
FOR INSERT
WITH CHECK (
  user_id = auth.uid()
  AND student_may_attribute_to_offering(offering_id, course_id, auth.uid())
  AND NOT EXISTS (
    SELECT 1 FROM offering_quizzes oq
    WHERE oq.quiz_id = quiz_sessions.quiz_id
    AND oq.offering_id = quiz_sessions.offering_id
    AND oq.closed_at IS NOT NULL
  )
);

DROP POLICY IF EXISTS "Users can update their own quiz sessions" ON public.quiz_sessions;
CREATE POLICY "Users can update their own quiz sessions"
ON public.quiz_sessions
FOR UPDATE
USING (user_id = auth.uid())
WITH CHECK (
  user_id = auth.uid()
  AND student_may_attribute_to_offering(offering_id, course_id, auth.uid())
);

DROP POLICY IF EXISTS "Users can submit quiz answers" ON public.quiz_answers;
CREATE POLICY "Users can submit quiz answers"
ON public.quiz_answers
FOR INSERT
WITH CHECK (
  user_id = auth.uid()
  AND student_may_attribute_to_offering(offering_id, course_id, auth.uid())
  AND NOT EXISTS (
    SELECT 1 FROM offering_quizzes oq
    WHERE oq.quiz_id = quiz_answers.quiz_id
    AND oq.offering_id = quiz_answers.offering_id
    AND oq.closed_at IS NOT NULL
  )
);

-- ============================================================
-- Ownership is immutable
-- ============================================================
--
-- The policies above answer "may this user touch a row about that student".
-- They cannot answer "is this still a row about that student", because a
-- WITH CHECK sees only the finished row — there is no OLD to compare against.
-- So an instructor who may legitimately edit a session could rewrite its
-- `user_id` to name someone else, and the check would pass on the way out: the
-- offering is still theirs, the course still matches. The row would then be a
-- record of one student's attempt filed under another student's name.
--
-- No predicate can close that, and successive attempts to approximate it in
-- the WITH CHECK cost more than they bought: requiring the named student to be
-- enrolled *now* stopped an instructor force-completing a session belonging to
-- a student who had left, which is the case most likely to need it.
--
-- The invariant is simpler than the authorisation question anyway. A quiz
-- session belongs to whoever sat it, permanently; so does an answer, so does a
-- tutoring progress row. A trigger says that once, for everybody — students,
-- instructors, and any policy written here in future that forgets to.

CREATE OR REPLACE FUNCTION public.student_work_owner_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION
      'ownership of % is immutable: % cannot be re-filed under %',
      TG_TABLE_NAME, OLD.user_id, NEW.user_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.student_work_owner_is_immutable() IS
  'Refuses any UPDATE that changes user_id. RLS WITH CHECK cannot express '
  '"unchanged" — it sees only the resulting row — so the invariant lives here '
  'instead of being approximated in every policy that touches student work '
  '(#1097).';

DROP TRIGGER IF EXISTS trg_quiz_sessions_owner_immutable ON public.quiz_sessions;
CREATE TRIGGER trg_quiz_sessions_owner_immutable
BEFORE UPDATE OF user_id ON public.quiz_sessions
FOR EACH ROW EXECUTE FUNCTION public.student_work_owner_is_immutable();

DROP TRIGGER IF EXISTS trg_quiz_answers_owner_immutable ON public.quiz_answers;
CREATE TRIGGER trg_quiz_answers_owner_immutable
BEFORE UPDATE OF user_id ON public.quiz_answers
FOR EACH ROW EXECUTE FUNCTION public.student_work_owner_is_immutable();

DROP TRIGGER IF EXISTS trg_student_study_progress_owner_immutable ON public.student_study_progress;
CREATE TRIGGER trg_student_study_progress_owner_immutable
BEFORE UPDATE OF user_id ON public.student_study_progress
FOR EACH ROW EXECUTE FUNCTION public.student_work_owner_is_immutable();

-- ============================================================
-- quiz_sessions
-- ============================================================

DROP POLICY IF EXISTS "Instructors can view quiz sessions for their courses" ON public.quiz_sessions;
CREATE POLICY "Instructors can view quiz sessions for their courses"
ON public.quiz_sessions
FOR SELECT
USING (
  instructor_can_access_student_work(course_id, offering_id, user_id, auth.uid())
);

-- Exists so an instructor can force-complete a student who left a quiz open —
-- a legitimate action that was being offered against the wrong students.
DROP POLICY IF EXISTS "Instructors can update quiz sessions for their courses" ON public.quiz_sessions;
CREATE POLICY "Instructors can update quiz sessions for their courses"
ON public.quiz_sessions
FOR UPDATE
USING (
  instructor_can_access_student_work(course_id, offering_id, user_id, auth.uid())
)
WITH CHECK (
  -- The access rule, not the write rule. Force-completing a session is a
  -- lifecycle edit, and gating it on current enrolment would mean an
  -- instructor could not close out a session belonging to a student who has
  -- since left the class — the very rows most likely to be left open. The
  -- offering the row names is trustworthy now (see
  -- `student_may_attribute_to_offering` above), so the access rule is enough
  -- to keep the edit inside the instructor's own sections.
  instructor_can_access_student_work(course_id, offering_id, user_id, auth.uid())
);

-- ============================================================
-- quiz_answers
-- ============================================================
-- `user_id = auth.uid()` stays as its own disjunct: a student reads their own
-- answers without any instructor relationship being involved.

DROP POLICY IF EXISTS "Admins and instructors can view quiz answers" ON public.quiz_answers;
CREATE POLICY "Admins and instructors can view quiz answers"
ON public.quiz_answers
FOR SELECT
USING (
  user_id = auth.uid()
  OR instructor_can_access_student_work(course_id, offering_id, user_id, auth.uid())
);

DROP POLICY IF EXISTS "Admins and instructors can delete quiz answers" ON public.quiz_answers;
CREATE POLICY "Admins and instructors can delete quiz answers"
ON public.quiz_answers
FOR DELETE
USING (
  instructor_can_access_student_work(course_id, offering_id, user_id, auth.uid())
);
