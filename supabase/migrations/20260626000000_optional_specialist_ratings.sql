-- #678: Make the four "specialist" rating columns nullable.
--
-- The evaluator rubric now has two tiers (see `src/components/evaluator/rubric.ts`):
--   - core ratings (clarity, pedagogical_value) — always asked, always required
--   - sampled ratings (distractor_quality, curriculum_alignment,
--     question_bank_alignment, language_appropriateness) — only asked inside the
--     sampled block (~20% of questions), so they're NULL on the other ~80%.
--
-- Existing rows already carry 1..5 values in every column (the old form
-- defaulted unset ratings to 3), so dropping NOT NULL leaves them valid. The
-- BETWEEN 1 AND 5 CHECKs continue to apply to non-NULL values per SQL
-- semantics — no constraint changes needed.

ALTER TABLE public.question_evaluations
  ALTER COLUMN distractor_quality DROP NOT NULL,
  ALTER COLUMN curriculum_alignment DROP NOT NULL,
  ALTER COLUMN question_bank_alignment DROP NOT NULL,
  ALTER COLUMN language_appropriateness DROP NOT NULL;
