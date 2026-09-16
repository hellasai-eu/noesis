-- Create quizzes table for pre-defined quizzes
CREATE TABLE public.quizzes (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  is_published BOOLEAN NOT NULL DEFAULT false,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create junction table for quiz questions
CREATE TABLE public.quiz_questions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  quiz_id UUID NOT NULL REFERENCES public.quizzes(id) ON DELETE CASCADE,
  question_id UUID NOT NULL REFERENCES public.questions(id) ON DELETE CASCADE,
  order_num INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(quiz_id, question_id)
);

-- Enable RLS
ALTER TABLE public.quizzes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quiz_questions ENABLE ROW LEVEL SECURITY;

-- RLS policies for quizzes
CREATE POLICY "Admins and instructors can create quizzes"
ON public.quizzes
FOR INSERT
WITH CHECK (
  EXISTS (
    SELECT 1 FROM courses c
    JOIN profiles p ON c.institution_id = p.institution_id
    WHERE c.id = quizzes.course_id
    AND p.user_id = auth.uid()
    AND (p.role = 'admin' OR is_course_instructor(c.id, auth.uid()))
  )
);

CREATE POLICY "Admins and instructors can update quizzes"
ON public.quizzes
FOR UPDATE
USING (
  EXISTS (
    SELECT 1 FROM courses c
    JOIN profiles p ON c.institution_id = p.institution_id
    WHERE c.id = quizzes.course_id
    AND p.user_id = auth.uid()
    AND (p.role = 'admin' OR is_course_instructor(c.id, auth.uid()))
  )
);

CREATE POLICY "Admins and instructors can delete quizzes"
ON public.quizzes
FOR DELETE
USING (
  EXISTS (
    SELECT 1 FROM courses c
    JOIN profiles p ON c.institution_id = p.institution_id
    WHERE c.id = quizzes.course_id
    AND p.user_id = auth.uid()
    AND (p.role = 'admin' OR is_course_instructor(c.id, auth.uid()))
  )
);

CREATE POLICY "Users can view quizzes for accessible courses"
ON public.quizzes
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM courses c
    JOIN profiles p ON c.institution_id = p.institution_id
    WHERE c.id = quizzes.course_id
    AND p.user_id = auth.uid()
    AND (
      is_admin(auth.uid()) 
      OR is_course_instructor(c.id, auth.uid())
      OR (user_has_course_tag_access(c.id, auth.uid()) AND quizzes.is_published = true)
    )
  )
);

-- RLS policies for quiz_questions
CREATE POLICY "Admins and instructors can manage quiz questions"
ON public.quiz_questions
FOR ALL
USING (
  EXISTS (
    SELECT 1 FROM quizzes q
    JOIN courses c ON q.course_id = c.id
    JOIN profiles p ON c.institution_id = p.institution_id
    WHERE q.id = quiz_questions.quiz_id
    AND p.user_id = auth.uid()
    AND (p.role = 'admin' OR is_course_instructor(c.id, auth.uid()))
  )
);

CREATE POLICY "Users can view quiz questions for accessible quizzes"
ON public.quiz_questions
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM quizzes q
    JOIN courses c ON q.course_id = c.id
    JOIN profiles p ON c.institution_id = p.institution_id
    WHERE q.id = quiz_questions.quiz_id
    AND p.user_id = auth.uid()
    AND (
      is_admin(auth.uid()) 
      OR is_course_instructor(c.id, auth.uid())
      OR (user_has_course_tag_access(c.id, auth.uid()) AND q.is_published = true)
    )
  )
);

-- Add trigger for updated_at
CREATE TRIGGER update_quizzes_updated_at
BEFORE UPDATE ON public.quizzes
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();