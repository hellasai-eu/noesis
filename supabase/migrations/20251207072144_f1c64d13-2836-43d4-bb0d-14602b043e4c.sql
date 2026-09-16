-- Create a table for open-ended questions (non-MCQ)
CREATE TABLE public.open_questions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  model_answer TEXT NOT NULL,
  explanation TEXT,
  difficulty VARCHAR(10) NOT NULL DEFAULT 'medium' CHECK (difficulty IN ('easy', 'medium', 'hard')),
  material_references JSONB,
  upvotes INTEGER NOT NULL DEFAULT 0,
  downvotes INTEGER NOT NULL DEFAULT 0,
  hidden BOOLEAN NOT NULL DEFAULT true,
  created_by UUID,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable Row Level Security
ALTER TABLE public.open_questions ENABLE ROW LEVEL SECURITY;

-- Create RLS policies
CREATE POLICY "Users can view open questions for courses they belong to"
ON public.open_questions
FOR SELECT
USING (
  public.user_has_course_tag_access(course_id, auth.uid())
  OR public.is_institution_admin((SELECT institution_id FROM public.courses WHERE id = course_id), auth.uid())
  OR public.is_super_admin(auth.uid())
);

CREATE POLICY "Admins and instructors can create open questions"
ON public.open_questions
FOR INSERT
WITH CHECK (
  public.is_course_instructor(course_id, auth.uid())
  OR public.is_institution_admin((SELECT institution_id FROM public.courses WHERE id = course_id), auth.uid())
  OR public.is_super_admin(auth.uid())
);

CREATE POLICY "Admins and instructors can update open questions"
ON public.open_questions
FOR UPDATE
USING (
  public.is_course_instructor(course_id, auth.uid())
  OR public.is_institution_admin((SELECT institution_id FROM public.courses WHERE id = course_id), auth.uid())
  OR public.is_super_admin(auth.uid())
);

CREATE POLICY "Admins and instructors can delete open questions"
ON public.open_questions
FOR DELETE
USING (
  public.is_course_instructor(course_id, auth.uid())
  OR public.is_institution_admin((SELECT institution_id FROM public.courses WHERE id = course_id), auth.uid())
  OR public.is_super_admin(auth.uid())
);

-- Create votes table for open questions
CREATE TABLE public.open_question_votes (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  question_id UUID NOT NULL REFERENCES public.open_questions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  vote_type VARCHAR(10) NOT NULL CHECK (vote_type IN ('up', 'down')),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(question_id, user_id)
);

-- Enable RLS for votes
ALTER TABLE public.open_question_votes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view votes on open questions"
ON public.open_question_votes
FOR SELECT
USING (auth.uid() IS NOT NULL);

CREATE POLICY "Users can insert their own votes"
ON public.open_question_votes
FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own votes"
ON public.open_question_votes
FOR UPDATE
USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own votes"
ON public.open_question_votes
FOR DELETE
USING (auth.uid() = user_id);

-- Trigger for updating timestamps
CREATE TRIGGER update_open_questions_updated_at
BEFORE UPDATE ON public.open_questions
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();