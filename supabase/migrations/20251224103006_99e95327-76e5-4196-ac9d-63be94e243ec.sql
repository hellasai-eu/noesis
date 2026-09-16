-- Create table to store per-user, per-flashcard spaced repetition state
CREATE TABLE public.flashcard_reviews (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  chapter_id UUID NOT NULL REFERENCES public.material_chapters(id) ON DELETE CASCADE,
  flashcard_index INTEGER NOT NULL,
  course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  
  -- SM-2 algorithm state
  repetitions INTEGER NOT NULL DEFAULT 0,
  interval_days NUMERIC NOT NULL DEFAULT 1,
  ease_factor NUMERIC NOT NULL DEFAULT 2.5,
  due_date TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  last_reviewed TIMESTAMP WITH TIME ZONE,
  
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  
  -- Ensure unique combination of user, chapter, and flashcard index
  UNIQUE(user_id, chapter_id, flashcard_index)
);

-- Enable Row Level Security
ALTER TABLE public.flashcard_reviews ENABLE ROW LEVEL SECURITY;

-- Users can manage their own flashcard reviews
CREATE POLICY "Users can manage their own flashcard reviews"
ON public.flashcard_reviews
FOR ALL
USING (user_id = auth.uid());

-- Admins and instructors can view all flashcard reviews in their courses
CREATE POLICY "Admins and instructors can view flashcard reviews"
ON public.flashcard_reviews
FOR SELECT
USING (
  is_super_admin(auth.uid()) OR
  EXISTS (
    SELECT 1 FROM courses c
    JOIN user_institutions ui ON c.institution_id = ui.institution_id
    WHERE c.id = flashcard_reviews.course_id
    AND ui.user_id = auth.uid()
    AND (ui.role = 'admin' OR is_course_instructor(c.id, auth.uid()))
  )
);

-- Create index for efficient queries
CREATE INDEX idx_flashcard_reviews_user_course ON public.flashcard_reviews(user_id, course_id);
CREATE INDEX idx_flashcard_reviews_due_date ON public.flashcard_reviews(user_id, due_date);
CREATE INDEX idx_flashcard_reviews_chapter ON public.flashcard_reviews(chapter_id);

-- Create trigger for automatic timestamp updates
CREATE TRIGGER update_flashcard_reviews_updated_at
BEFORE UPDATE ON public.flashcard_reviews
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();