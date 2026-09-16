-- Drop the unique index that's still blocking multiple evaluations per student
DROP INDEX IF EXISTS idx_student_evaluations_unique;

-- Ensure the non-unique index exists for performance
CREATE INDEX IF NOT EXISTS idx_student_evaluations_course_user ON public.student_evaluations(course_id, user_id, generated_at DESC);