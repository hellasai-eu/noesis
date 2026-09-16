-- Issue #1103 (part of #1097): section-scope evaluations, competency scores
-- and the timeline cache.
--
-- All three carried a FOR ALL policy authorising `ui.role = 'admin' OR
-- is_course_instructor(c.id, auth.uid())`. FOR ALL, so this was never only a
-- read: an instructor restricted to Τμήμα 1Α could overwrite or delete a 1Β
-- student's AI-generated evaluation and their competency breakdown.
--
-- This is the same class of content as `study_guide_analyses`, which is
-- section-scoped through `can_manage_offering` precisely because "a report
-- naming which students are struggling with what" needs a tight policy. The
-- per-student equivalent was wider than the per-class one.
--
-- ============================================================
-- Shape of the fix
-- ============================================================
--
-- These tables use `instructor_can_access_student_work`, the two-armed rule the
-- quiz-results migration in this epic introduces:
--
--   * the row names an offering → that offering decides, provided it is
--     coherent with the row (same course, and the student sits in its class);
--   * the row names none        → fall back to the student's enrolment.
--
-- The offering arm has to come first: a student may sit in two classes taking
-- the same course, and deciding such a row on the student alone would let a
-- 1Α-restricted instructor reach 1Β-attributed work through the student's
-- other enrolment. Where the row says which section the work belongs to, that
-- answer wins; the fallback only stands in for rows that cannot say.
--
-- Which arm each table needs follows from its columns:
--
--   * `student_evaluations` — has `offering_id`, nullable, so both arms;
--   * `evaluation_timeline_cache` — no offering column at all, only
--     `course_id` + `user_id`, so the student arm is the only one available;
--   * `evaluation_competency_scores` — neither, only `evaluation_id`, so it
--     hops to the parent evaluation and applies the parent's rule to the
--     parent's `(offering_id, course_id, user_id)`.
--
-- Keeping the child's predicate self-sufficient rather than letting it inherit
-- whatever the parent happens to expose is deliberate: a boundary enforced only
-- by another table's policy is exactly what #1101 turned out to be relying on.
--
-- Verified against a live database before writing: all three policies still
-- carried the predicates #1103 describes, and the column sets are as assumed
-- (`evaluation_timeline_cache` is course_id + user_id; competency scores are
-- evaluation_id only).
--
-- The student-facing SELECT policies ("Students can view their own
-- evaluations" / "...competency scores") are untouched.

-- ============================================================
-- student_evaluations
-- ============================================================

DROP POLICY IF EXISTS "Admins and instructors can manage evaluations" ON public.student_evaluations;
CREATE POLICY "Admins and instructors can manage evaluations"
ON public.student_evaluations
FOR ALL
USING (
  instructor_can_access_student_work(course_id, offering_id, user_id, auth.uid())
)
WITH CHECK (
  -- Write rule on the CHECK side: a row naming an offering must also name a
  -- student who sits in it, so a managed offering cannot be used to forge an
  -- evaluation about anyone. Reads stay on the access rule, so a student who
  -- has left the class does not take their evaluation history with them.
  instructor_can_write_student_work(course_id, offering_id, user_id, auth.uid())
);

-- ============================================================
-- evaluation_competency_scores — via the parent evaluation
-- ============================================================

DROP POLICY IF EXISTS "Admins and instructors can manage evaluation competency scores" ON public.evaluation_competency_scores;
CREATE POLICY "Admins and instructors can manage evaluation competency scores"
ON public.evaluation_competency_scores
FOR ALL
USING (
  EXISTS (
    SELECT 1 FROM student_evaluations se
    WHERE se.id = evaluation_competency_scores.evaluation_id
    AND instructor_can_access_student_work(
      se.course_id, se.offering_id, se.user_id, auth.uid()
    )
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM student_evaluations se
    WHERE se.id = evaluation_competency_scores.evaluation_id
    AND instructor_can_write_student_work(
      se.course_id, se.offering_id, se.user_id, auth.uid()
    )
  )
);

-- ============================================================
-- evaluation_timeline_cache
-- ============================================================

DROP POLICY IF EXISTS "Admins and instructors can manage timeline cache" ON public.evaluation_timeline_cache;
CREATE POLICY "Admins and instructors can manage timeline cache"
ON public.evaluation_timeline_cache
FOR ALL
USING (instructor_can_access_student(course_id, user_id, auth.uid()))
WITH CHECK (instructor_can_access_student(course_id, user_id, auth.uid()));
