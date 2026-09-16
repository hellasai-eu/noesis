-- Add column to track user-generated questions
ALTER TABLE public.questions ADD COLUMN IF NOT EXISTS is_user_generated boolean NOT NULL DEFAULT false;

-- Add RLS policy for students to create their own questions
CREATE POLICY "Students can create user-generated questions"
ON public.questions
FOR INSERT
WITH CHECK (
  is_user_generated = true 
  AND created_by = auth.uid()
  AND user_has_course_tag_access(course_id, auth.uid())
);