-- Add column to toggle difficulty visibility for students
ALTER TABLE public.courses 
ADD COLUMN show_difficulty_to_students boolean NOT NULL DEFAULT true;