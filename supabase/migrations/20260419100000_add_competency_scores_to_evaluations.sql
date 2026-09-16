ALTER TABLE student_evaluations
  ADD COLUMN IF NOT EXISTS competency_scores JSONB DEFAULT NULL;

COMMENT ON COLUMN student_evaluations.competency_scores IS
  'Array of {competencyTitle, score (0-100 or null), rationale} objects';
