-- Create junction table for study sessions to competencies (many-to-many)
CREATE TABLE public.study_session_competencies (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  study_session_id UUID NOT NULL REFERENCES public.study_sessions(id) ON DELETE CASCADE,
  competency_id UUID NOT NULL REFERENCES public.course_competencies(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(study_session_id, competency_id)
);

-- Enable RLS
ALTER TABLE public.study_session_competencies ENABLE ROW LEVEL SECURITY;

-- Create index for better query performance
CREATE INDEX idx_study_session_competencies_session ON public.study_session_competencies(study_session_id);
CREATE INDEX idx_study_session_competencies_competency ON public.study_session_competencies(competency_id);

-- RLS: Admins and instructors can manage study session competencies
CREATE POLICY "Admins and instructors can manage study session competencies"
ON public.study_session_competencies
FOR ALL
USING (
  (EXISTS (
    SELECT 1
    FROM study_sessions ss
    JOIN courses c ON ss.course_id = c.id
    JOIN user_institutions ui ON c.institution_id = ui.institution_id
    WHERE ss.id = study_session_competencies.study_session_id
    AND ui.user_id = auth.uid()
    AND (ui.role = 'admin' OR is_course_instructor(c.id, auth.uid()))
  ))
  OR is_super_admin(auth.uid())
);

-- RLS: Users can view competencies for accessible study sessions
CREATE POLICY "Users can view study session competencies"
ON public.study_session_competencies
FOR SELECT
USING (
  (EXISTS (
    SELECT 1
    FROM study_sessions ss
    JOIN courses c ON ss.course_id = c.id
    JOIN user_institutions ui ON c.institution_id = ui.institution_id
    WHERE ss.id = study_session_competencies.study_session_id
    AND ui.user_id = auth.uid()
  ))
  OR is_super_admin(auth.uid())
);