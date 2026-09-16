-- Allow instructors and institution admins to view quiz sessions for their courses.
-- Without this, AssignedQuizzesBoard sees no session rows under RLS and falls back
-- to inferring status from quiz_answers, which disagrees with what the student sees.
CREATE POLICY "Instructors can view quiz sessions for their courses"
ON public.quiz_sessions
FOR SELECT
USING (
  is_super_admin(auth.uid())
  OR is_course_instructor(course_id, auth.uid())
  OR EXISTS (
    SELECT 1 FROM courses c
    WHERE c.id = quiz_sessions.course_id
    AND is_institution_admin(auth.uid(), c.institution_id)
  )
);

-- Allow instructors to force-complete an in-progress session (lifting the lock
-- on a student who left a quiz open).
CREATE POLICY "Instructors can update quiz sessions for their courses"
ON public.quiz_sessions
FOR UPDATE
USING (
  is_super_admin(auth.uid())
  OR is_course_instructor(course_id, auth.uid())
  OR EXISTS (
    SELECT 1 FROM courses c
    WHERE c.id = quiz_sessions.course_id
    AND is_institution_admin(auth.uid(), c.institution_id)
  )
)
WITH CHECK (
  is_super_admin(auth.uid())
  OR is_course_instructor(course_id, auth.uid())
  OR EXISTS (
    SELECT 1 FROM courses c
    WHERE c.id = quiz_sessions.course_id
    AND is_institution_admin(auth.uid(), c.institution_id)
  )
);
