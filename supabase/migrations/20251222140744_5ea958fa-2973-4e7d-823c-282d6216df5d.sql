-- Create junction table for competency-chapter relationships
CREATE TABLE public.competency_chapters (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  competency_id UUID NOT NULL REFERENCES public.course_competencies(id) ON DELETE CASCADE,
  chapter_id UUID NOT NULL REFERENCES public.material_chapters(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(competency_id, chapter_id)
);

-- Enable RLS
ALTER TABLE public.competency_chapters ENABLE ROW LEVEL SECURITY;

-- Create policies matching course_competencies access patterns
CREATE POLICY "Admins and instructors can manage competency chapters"
ON public.competency_chapters
FOR ALL
USING (
  EXISTS (
    SELECT 1 FROM course_competencies cc
    JOIN courses c ON cc.course_id = c.id
    JOIN user_institutions ui ON c.institution_id = ui.institution_id
    WHERE cc.id = competency_chapters.competency_id
    AND ui.user_id = auth.uid()
    AND (ui.role = 'admin' OR is_course_instructor(c.id, auth.uid()))
  )
  OR is_super_admin(auth.uid())
);

CREATE POLICY "Students can view competency chapters"
ON public.competency_chapters
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM course_competencies cc
    JOIN courses c ON cc.course_id = c.id
    JOIN user_institutions ui ON c.institution_id = ui.institution_id
    WHERE cc.id = competency_chapters.competency_id
    AND ui.user_id = auth.uid()
    AND user_has_course_tag_access(c.id, auth.uid())
  )
);

-- Migrate existing chapter_id data to the junction table
INSERT INTO public.competency_chapters (competency_id, chapter_id)
SELECT id, chapter_id FROM public.course_competencies
WHERE chapter_id IS NOT NULL
ON CONFLICT DO NOTHING;