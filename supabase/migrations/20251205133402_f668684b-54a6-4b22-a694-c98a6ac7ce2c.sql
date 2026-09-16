-- Create questions table
CREATE TABLE public.questions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  options JSONB NOT NULL DEFAULT '[]',
  correct_answer INTEGER NOT NULL,
  explanation TEXT,
  difficulty TEXT NOT NULL DEFAULT 'medium',
  material_references JSONB DEFAULT '[]',
  upvotes INTEGER NOT NULL DEFAULT 0,
  downvotes INTEGER NOT NULL DEFAULT 0,
  hidden BOOLEAN NOT NULL DEFAULT false,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.questions ENABLE ROW LEVEL SECURITY;

-- Policies
CREATE POLICY "Users can view questions for accessible courses"
ON public.questions
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM courses c
    JOIN profiles p ON c.institution_id = p.institution_id
    WHERE c.id = questions.course_id 
    AND p.user_id = auth.uid()
    AND (is_admin(auth.uid()) OR user_has_course_tag_access(c.id, auth.uid()))
  )
);

CREATE POLICY "Admins can create questions"
ON public.questions
FOR INSERT
WITH CHECK (
  EXISTS (
    SELECT 1 FROM courses c
    JOIN profiles p ON c.institution_id = p.institution_id
    WHERE c.id = questions.course_id
    AND p.user_id = auth.uid()
    AND p.role = 'admin'
  )
);

CREATE POLICY "Admins can update questions"
ON public.questions
FOR UPDATE
USING (
  EXISTS (
    SELECT 1 FROM courses c
    JOIN profiles p ON c.institution_id = p.institution_id
    WHERE c.id = questions.course_id
    AND p.user_id = auth.uid()
    AND p.role = 'admin'
  )
);

CREATE POLICY "Admins can delete questions"
ON public.questions
FOR DELETE
USING (
  EXISTS (
    SELECT 1 FROM courses c
    JOIN profiles p ON c.institution_id = p.institution_id
    WHERE c.id = questions.course_id
    AND p.user_id = auth.uid()
    AND p.role = 'admin'
  )
);

-- Add trigger for updated_at
CREATE TRIGGER update_questions_updated_at
BEFORE UPDATE ON public.questions
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();