-- Change default for student_questions_enabled from true to false
-- New courses will have student question generation disabled by default
ALTER TABLE public.courses
ALTER COLUMN student_questions_enabled SET DEFAULT false;
