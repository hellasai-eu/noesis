-- Remove due_date column from quizzes table
-- Due dates are now managed per-class assignment in offering_quizzes table
ALTER TABLE public.quizzes DROP COLUMN IF EXISTS due_date;