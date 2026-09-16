-- Create competency mastery history table
CREATE TABLE public.competency_mastery_history (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  competency_id UUID NOT NULL REFERENCES public.course_competencies(id) ON DELETE CASCADE,
  course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  total_mcq_questions INTEGER NOT NULL DEFAULT 0,
  correct_mcq_answers INTEGER NOT NULL DEFAULT 0,
  total_open_questions INTEGER NOT NULL DEFAULT 0,
  open_question_avg_grade NUMERIC,
  mastery_percentage NUMERIC NOT NULL DEFAULT 0,
  change_type TEXT NOT NULL, -- 'mcq' or 'open_question'
  change_details JSONB, -- e.g., {"is_correct": true} or {"grade": 85}
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create index for efficient querying
CREATE INDEX idx_competency_mastery_history_user_course ON public.competency_mastery_history(user_id, course_id);
CREATE INDEX idx_competency_mastery_history_competency ON public.competency_mastery_history(competency_id);
CREATE INDEX idx_competency_mastery_history_created ON public.competency_mastery_history(created_at DESC);

-- Enable RLS
ALTER TABLE public.competency_mastery_history ENABLE ROW LEVEL SECURITY;

-- Users can manage their own history
CREATE POLICY "Users can manage their own mastery history"
ON public.competency_mastery_history
FOR ALL
USING (user_id = auth.uid());

-- Admins and instructors can view all history
CREATE POLICY "Admins and instructors can view all mastery history"
ON public.competency_mastery_history
FOR SELECT
USING (
  is_super_admin(auth.uid()) OR 
  EXISTS (
    SELECT 1 FROM courses c
    JOIN user_institutions ui ON c.institution_id = ui.institution_id
    WHERE c.id = competency_mastery_history.course_id
    AND ui.user_id = auth.uid()
    AND (ui.role = 'admin' OR is_course_instructor(c.id, auth.uid()))
  )
);