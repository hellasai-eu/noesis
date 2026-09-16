-- Add due_date column to quizzes table
ALTER TABLE public.quizzes
ADD COLUMN due_date TIMESTAMP WITH TIME ZONE DEFAULT NULL;

-- Add an index for efficient querying of upcoming/past due quizzes
CREATE INDEX idx_quizzes_due_date ON public.quizzes(due_date) WHERE due_date IS NOT NULL;