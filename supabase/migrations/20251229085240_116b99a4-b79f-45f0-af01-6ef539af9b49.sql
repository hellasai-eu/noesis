-- Set default value for is_published to true for new quizzes
ALTER TABLE public.quizzes ALTER COLUMN is_published SET DEFAULT true;