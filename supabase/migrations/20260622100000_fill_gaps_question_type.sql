-- Add the "fill_gaps" question type (#604).
--
-- The `payload` / `answer_key` JSONB columns already exist and are
-- schema-agnostic, but the `questions_type_check` CHECK constraint added in
-- 20260613000000_expand_questions_schema.sql only permitted ('mcq', 'open').
-- Extend the allow-list and re-validate.
--
-- The new type ALSO needs a place to store student submissions. v1 reuses
-- `open_question_grades` (one row per (question, user) — matches the
-- "one shot, no retry" semantics agreed in #604) with a new JSONB
-- `gap_results` column for the per-gap correctness array. submitted_answer
-- already exists (#596) and stores the JSON-encoded array of raw inputs.

-- 1. Extend the CHECK constraint to include 'fill_gaps'.
-- Use NOT VALID + VALIDATE to avoid a full-table scan during the swap.
ALTER TABLE public.questions
  DROP CONSTRAINT IF EXISTS questions_type_check;

ALTER TABLE public.questions
  ADD CONSTRAINT questions_type_check
  CHECK (type IN ('mcq', 'open', 'fill_gaps')) NOT VALID;

ALTER TABLE public.questions VALIDATE CONSTRAINT questions_type_check;

COMMENT ON COLUMN public.questions.type IS
  'Question type discriminator. One of: mcq, open, fill_gaps. See src/types/question.ts for the payload/answer_key shape per type.';

-- 2. Per-gap correctness column on open_question_grades.
--    Nullable so pre-#604 rows (MCQ / open) keep their NULL.
ALTER TABLE public.open_question_grades
  ADD COLUMN IF NOT EXISTS gap_results jsonb;

COMMENT ON COLUMN public.open_question_grades.gap_results IS
  'Fill-the-gaps per-gap correctness (#604). Shape: '
  '{ "perGap": [bool, bool, ...], "allCorrect": bool }. NULL for non-fill-gaps rows.';
