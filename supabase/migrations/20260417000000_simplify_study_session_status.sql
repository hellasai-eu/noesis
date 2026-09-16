-- Simplify study_sessions status from 3 states (draft/ready/published) to 2 (draft/ready)
-- Convert all 'published' rows to 'ready' since they are functionally equivalent

-- Convert existing published rows to ready
UPDATE public.study_sessions SET status = 'ready' WHERE status = 'published';

-- Drop old constraint and recreate with only two allowed values
ALTER TABLE public.study_sessions DROP CONSTRAINT study_sessions_status_check;
ALTER TABLE public.study_sessions
  ADD CONSTRAINT study_sessions_status_check
  CHECK (status IN ('draft', 'ready'));

-- Update RLS policy to use 'ready' instead of 'published'
DROP POLICY IF EXISTS "Users can view published study sessions for accessible courses" ON public.study_sessions;

CREATE POLICY "Users can view ready study sessions for accessible courses"
ON public.study_sessions
FOR SELECT
USING (
  is_super_admin(auth.uid())
  OR is_institution_admin(auth.uid(), (SELECT courses.institution_id FROM courses WHERE courses.id = study_sessions.course_id))
  OR is_course_instructor(course_id, auth.uid())
  OR (status = 'ready' AND user_can_access_course(course_id, auth.uid()))
);
