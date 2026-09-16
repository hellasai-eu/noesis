-- Replace is_published boolean with status text column on study_sessions
-- Values: 'draft', 'ready', 'published'
-- Default: 'ready'

-- Add new status column
ALTER TABLE public.study_sessions
  ADD COLUMN status text NOT NULL DEFAULT 'ready';

-- Migrate existing data: false -> 'draft', true -> 'published'
UPDATE public.study_sessions SET status = 'draft' WHERE is_published = false;
UPDATE public.study_sessions SET status = 'published' WHERE is_published = true;

-- Drop RLS policy that references is_published before dropping the column
-- (PostgreSQL tracks column dependencies in policy expressions)
DROP POLICY IF EXISTS "Users can view published study sessions for accessible courses" ON public.study_sessions;

-- Drop old column
ALTER TABLE public.study_sessions DROP COLUMN is_published;

-- Add check constraint
ALTER TABLE public.study_sessions
  ADD CONSTRAINT study_sessions_status_check
  CHECK (status IN ('draft', 'ready', 'published'));

-- Recreate RLS policy using status column instead of is_published
CREATE POLICY "Users can view published study sessions for accessible courses"
ON public.study_sessions
FOR SELECT
USING (
  is_super_admin(auth.uid())
  OR is_institution_admin(auth.uid(), (SELECT courses.institution_id FROM courses WHERE courses.id = study_sessions.course_id))
  OR is_course_instructor(course_id, auth.uid())
  OR (status = 'published' AND user_has_course_tag_access(course_id, auth.uid()))
);
