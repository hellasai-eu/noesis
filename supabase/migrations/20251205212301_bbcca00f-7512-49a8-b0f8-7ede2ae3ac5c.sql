-- Add time_limit_minutes column to quizzes table
ALTER TABLE public.quizzes 
ADD COLUMN time_limit_minutes integer DEFAULT NULL;