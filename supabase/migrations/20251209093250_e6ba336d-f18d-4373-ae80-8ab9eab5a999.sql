-- Add student_notes column for HTML content that students can read
ALTER TABLE public.study_sessions 
ADD COLUMN student_notes TEXT DEFAULT NULL;