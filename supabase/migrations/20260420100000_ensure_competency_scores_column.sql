-- Idempotent: ensures competency_scores column exists on student_evaluations.
-- A prior migration (20260419100000) should have added it, but may not have
-- been applied in all environments.
ALTER TABLE student_evaluations
  ADD COLUMN IF NOT EXISTS competency_scores JSONB DEFAULT NULL;
