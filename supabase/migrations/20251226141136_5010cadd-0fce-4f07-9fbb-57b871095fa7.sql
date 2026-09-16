-- Create table to track chapter completion status (set by instructors)
CREATE TABLE public.course_chapter_progress (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  chapter_id UUID NOT NULL REFERENCES public.material_chapters(id) ON DELETE CASCADE,
  is_complete BOOLEAN NOT NULL DEFAULT false,
  completed_at TIMESTAMP WITH TIME ZONE,
  completed_by UUID,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(course_id, chapter_id)
);

-- Enable RLS
ALTER TABLE public.course_chapter_progress ENABLE ROW LEVEL SECURITY;

-- Admins and instructors can manage chapter progress
CREATE POLICY "Admins and instructors can manage chapter progress"
ON public.course_chapter_progress
FOR ALL
USING (
  is_super_admin(auth.uid()) OR
  EXISTS (
    SELECT 1 FROM courses c
    JOIN user_institutions ui ON c.institution_id = ui.institution_id
    WHERE c.id = course_chapter_progress.course_id
    AND ui.user_id = auth.uid()
    AND (ui.role = 'admin' OR is_course_instructor(c.id, auth.uid()))
  )
)
WITH CHECK (
  is_super_admin(auth.uid()) OR
  EXISTS (
    SELECT 1 FROM courses c
    JOIN user_institutions ui ON c.institution_id = ui.institution_id
    WHERE c.id = course_chapter_progress.course_id
    AND ui.user_id = auth.uid()
    AND (ui.role = 'admin' OR is_course_instructor(c.id, auth.uid()))
  )
);

-- Students can view chapter progress
CREATE POLICY "Students can view chapter progress"
ON public.course_chapter_progress
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM courses c
    JOIN user_institutions ui ON c.institution_id = ui.institution_id
    WHERE c.id = course_chapter_progress.course_id
    AND ui.user_id = auth.uid()
    AND user_has_course_tag_access(c.id, auth.uid())
  )
);

-- Add trigger for updated_at
CREATE TRIGGER update_course_chapter_progress_updated_at
BEFORE UPDATE ON public.course_chapter_progress
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();