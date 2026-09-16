-- Close the never-started deadline bypass (PR #1350 review).
--
-- 20260910120000 locked explicit closure (`closed_at`) server-side but left
-- the due date purely presentational: the student tile renders a past-due,
-- never-started guide as locked, yet the submission path authorized from
-- `closed_at` alone — a student could start the guide after its deadline by
-- calling `submit-study-guide-piece` directly. The rule everywhere else
-- (quizzes, the student tile) is: a STARTED attempt keeps its grace past the
-- deadline; a never-started one cannot begin. This migration makes the server
-- agree.
--
-- "Started" is a `study_guide_progress` row, which the player creates on
-- first open. Two gates close the loop:
--   * the edge function refuses a submission when the student has no progress
--     row and every open route to the guide is past due (handler change,
--     alongside this migration);
--   * this migration stops the progress row itself from being CREATED after
--     the deadline — without it, a student could manufacture "started" state
--     post-deadline with a direct insert and then claim the grace period.
--
-- Direct `study_guide_answers` inserts are not deadline-gated: the student
-- INSERT policy already forces every grading column NULL, so bypassing the
-- edge function can only burn the one-shot answer slot with ungraded rows —
-- there is no graded outcome to gain.

-- Startable = assigned, open, and not past due. Deliberately a separate
-- helper from `study_guide_assigned_in_offering` (open, due date ignored):
-- UPDATE keeps using the latter so a started student can advance past the
-- deadline; only INSERT — starting — uses this stricter one.
CREATE OR REPLACE FUNCTION public.study_guide_startable_in_offering(
  _study_guide_id UUID,
  _offering_id UUID
)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.offering_study_guides osg
    WHERE osg.study_guide_id = _study_guide_id
      AND osg.offering_id = _offering_id
      AND osg.published_at IS NOT NULL
      AND osg.closed_at IS NULL
      AND (osg.due_date IS NULL OR osg.due_date >= now())
      AND public.has_offering_access(osg.offering_id)
      AND (osg.group_id IS NULL OR public.is_offering_group_member(osg.group_id))
  )
$$;

-- Split the students' FOR ALL policy so INSERT alone carries the deadline
-- gate. SELECT and DELETE keep the original reach (own rows); UPDATE keeps
-- the original WITH CHECK, preserving the started-student grace period.
DROP POLICY "Students manage their own study guide progress"
  ON public.study_guide_progress;

CREATE POLICY "Students read their own study guide progress"
  ON public.study_guide_progress
  FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "Students start study guides before the deadline"
  ON public.study_guide_progress
  FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND public.study_guide_startable_in_offering(study_guide_id, offering_id)
  );

CREATE POLICY "Students update their own study guide progress"
  ON public.study_guide_progress
  FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (
    user_id = auth.uid()
    AND public.study_guide_assigned_in_offering(study_guide_id, offering_id)
  );

CREATE POLICY "Students delete their own study guide progress"
  ON public.study_guide_progress
  FOR DELETE
  USING (user_id = auth.uid());
