-- Create junction table for MCQ questions to competencies (many-to-many)
CREATE TABLE public.question_competencies (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  question_id UUID NOT NULL REFERENCES public.questions(id) ON DELETE CASCADE,
  competency_id UUID NOT NULL REFERENCES public.course_competencies(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(question_id, competency_id)
);

-- Create junction table for open questions to competencies (many-to-many)
CREATE TABLE public.open_question_competencies (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  open_question_id UUID NOT NULL REFERENCES public.open_questions(id) ON DELETE CASCADE,
  competency_id UUID NOT NULL REFERENCES public.course_competencies(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(open_question_id, competency_id)
);

-- Enable RLS
ALTER TABLE public.question_competencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.open_question_competencies ENABLE ROW LEVEL SECURITY;

-- RLS policies for question_competencies
CREATE POLICY "Users can view question competencies for accessible courses"
ON public.question_competencies
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.questions q
    JOIN public.courses c ON q.course_id = c.id
    JOIN public.user_institutions ui ON c.institution_id = ui.institution_id
    WHERE q.id = question_competencies.question_id
    AND ui.user_id = auth.uid()
  )
  OR is_super_admin(auth.uid())
);

CREATE POLICY "Admins and instructors can manage question competencies"
ON public.question_competencies
FOR ALL
USING (
  EXISTS (
    SELECT 1 FROM public.questions q
    JOIN public.courses c ON q.course_id = c.id
    JOIN public.user_institutions ui ON c.institution_id = ui.institution_id
    WHERE q.id = question_competencies.question_id
    AND ui.user_id = auth.uid()
    AND (ui.role = 'admin' OR is_course_instructor(c.id, auth.uid()))
  )
  OR is_super_admin(auth.uid())
);

-- RLS policies for open_question_competencies
CREATE POLICY "Users can view open question competencies for accessible courses"
ON public.open_question_competencies
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.open_questions oq
    JOIN public.courses c ON oq.course_id = c.id
    JOIN public.user_institutions ui ON c.institution_id = ui.institution_id
    WHERE oq.id = open_question_competencies.open_question_id
    AND ui.user_id = auth.uid()
  )
  OR is_super_admin(auth.uid())
);

CREATE POLICY "Admins and instructors can manage open question competencies"
ON public.open_question_competencies
FOR ALL
USING (
  EXISTS (
    SELECT 1 FROM public.open_questions oq
    JOIN public.courses c ON oq.course_id = c.id
    JOIN public.user_institutions ui ON c.institution_id = ui.institution_id
    WHERE oq.id = open_question_competencies.open_question_id
    AND ui.user_id = auth.uid()
    AND (ui.role = 'admin' OR is_course_instructor(c.id, auth.uid()))
  )
  OR is_super_admin(auth.uid())
);

-- Migrate existing data from competency_id to junction tables
INSERT INTO public.question_competencies (question_id, competency_id)
SELECT id, competency_id FROM public.questions WHERE competency_id IS NOT NULL;

INSERT INTO public.open_question_competencies (open_question_id, competency_id)
SELECT id, competency_id FROM public.open_questions WHERE competency_id IS NOT NULL;

-- Create indexes for performance
CREATE INDEX idx_question_competencies_question_id ON public.question_competencies(question_id);
CREATE INDEX idx_question_competencies_competency_id ON public.question_competencies(competency_id);
CREATE INDEX idx_open_question_competencies_open_question_id ON public.open_question_competencies(open_question_id);
CREATE INDEX idx_open_question_competencies_competency_id ON public.open_question_competencies(competency_id);