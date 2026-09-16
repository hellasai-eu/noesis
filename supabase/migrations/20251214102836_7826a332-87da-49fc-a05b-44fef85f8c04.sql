-- Add is_manual column to track instructor-created evaluations vs AI-generated
ALTER TABLE public.student_evaluations 
ADD COLUMN IF NOT EXISTS is_manual boolean NOT NULL DEFAULT false;

-- Drop the existing unique constraint if it exists (allows multiple evaluations per student)
DO $$ 
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'student_evaluations_course_id_user_id_key'
  ) THEN
    ALTER TABLE public.student_evaluations 
    DROP CONSTRAINT student_evaluations_course_id_user_id_key;
  END IF;
END $$;

-- Add index for faster lookups by student
CREATE INDEX IF NOT EXISTS idx_student_evaluations_course_user 
ON public.student_evaluations(course_id, user_id, generated_at DESC);