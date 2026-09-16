-- Add student_questions_enabled column to courses table
ALTER TABLE public.courses 
ADD COLUMN student_questions_enabled boolean NOT NULL DEFAULT true;