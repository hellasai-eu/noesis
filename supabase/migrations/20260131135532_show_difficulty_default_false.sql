-- Change default for show_difficulty_to_students to false
ALTER TABLE public.courses
ALTER COLUMN show_difficulty_to_students SET DEFAULT false;
