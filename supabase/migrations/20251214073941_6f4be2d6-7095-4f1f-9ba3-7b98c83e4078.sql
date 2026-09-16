-- Add instructor feedback column to student_evaluations table
ALTER TABLE public.student_evaluations 
ADD COLUMN IF NOT EXISTS instructor_feedback text DEFAULT NULL;