-- Create tests table for storing test configurations
CREATE TABLE public.tests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  custom_header TEXT,
  is_published BOOLEAN NOT NULL DEFAULT false,
  created_by UUID,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create test_questions junction table for both MCQ and Open questions
CREATE TABLE public.test_questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id UUID NOT NULL REFERENCES public.tests(id) ON DELETE CASCADE,
  question_id UUID REFERENCES public.questions(id) ON DELETE CASCADE,
  open_question_id UUID REFERENCES public.open_questions(id) ON DELETE CASCADE,
  question_type TEXT NOT NULL,
  order_num INTEGER NOT NULL DEFAULT 0,
  points INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT valid_question_type CHECK (question_type IN ('mcq', 'open')),
  CONSTRAINT question_reference CHECK (
    (question_type = 'mcq' AND question_id IS NOT NULL AND open_question_id IS NULL) OR
    (question_type = 'open' AND open_question_id IS NOT NULL AND question_id IS NULL)
  )
);

-- Enable RLS
ALTER TABLE public.tests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.test_questions ENABLE ROW LEVEL SECURITY;

-- RLS policies for tests table
CREATE POLICY "Admins and instructors can manage tests"
ON public.tests
FOR ALL
USING (
  is_super_admin(auth.uid()) OR 
  EXISTS (
    SELECT 1 FROM courses c
    JOIN user_institutions ui ON c.institution_id = ui.institution_id
    WHERE c.id = tests.course_id 
    AND ui.user_id = auth.uid() 
    AND (ui.role = 'admin' OR is_course_instructor(c.id, auth.uid()))
  )
)
WITH CHECK (
  is_super_admin(auth.uid()) OR 
  EXISTS (
    SELECT 1 FROM courses c
    JOIN user_institutions ui ON c.institution_id = ui.institution_id
    WHERE c.id = tests.course_id 
    AND ui.user_id = auth.uid() 
    AND (ui.role = 'admin' OR is_course_instructor(c.id, auth.uid()))
  )
);

CREATE POLICY "Users can view published tests for accessible courses"
ON public.tests
FOR SELECT
USING (
  is_super_admin(auth.uid()) OR
  EXISTS (
    SELECT 1 FROM courses c
    JOIN user_institutions ui ON c.institution_id = ui.institution_id
    WHERE c.id = tests.course_id 
    AND ui.user_id = auth.uid() 
    AND (
      ui.role = 'admin' OR 
      is_course_instructor(c.id, auth.uid()) OR 
      (user_has_course_tag_access(c.id, auth.uid()) AND tests.is_published = true)
    )
  )
);

-- RLS policies for test_questions table
CREATE POLICY "Admins and instructors can manage test questions"
ON public.test_questions
FOR ALL
USING (
  EXISTS (
    SELECT 1 FROM tests t
    JOIN courses c ON t.course_id = c.id
    JOIN user_institutions ui ON c.institution_id = ui.institution_id
    WHERE t.id = test_questions.test_id
    AND ui.user_id = auth.uid()
    AND (ui.role = 'admin' OR is_course_instructor(c.id, auth.uid()))
  ) OR is_super_admin(auth.uid())
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM tests t
    JOIN courses c ON t.course_id = c.id
    JOIN user_institutions ui ON c.institution_id = ui.institution_id
    WHERE t.id = test_questions.test_id
    AND ui.user_id = auth.uid()
    AND (ui.role = 'admin' OR is_course_instructor(c.id, auth.uid()))
  ) OR is_super_admin(auth.uid())
);

CREATE POLICY "Users can view test questions for accessible tests"
ON public.test_questions
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM tests t
    JOIN courses c ON t.course_id = c.id
    JOIN user_institutions ui ON c.institution_id = ui.institution_id
    WHERE t.id = test_questions.test_id
    AND ui.user_id = auth.uid()
  ) OR is_super_admin(auth.uid())
);

-- Add triggers for updated_at
CREATE TRIGGER update_tests_updated_at
BEFORE UPDATE ON public.tests
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_test_questions_updated_at
BEFORE UPDATE ON public.test_questions
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();