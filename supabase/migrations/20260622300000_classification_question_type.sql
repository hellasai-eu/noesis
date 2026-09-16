-- Add the "classification" question type (#610).
--
-- Mirrors the ordering migration pattern (#606, 20260622200000): the
-- `payload` / `answer_key` JSONB columns already exist and are
-- schema-agnostic, but the `questions_type_check` CHECK constraint only
-- permitted ('mcq', 'open', 'fill_gaps', 'ordering'). Extend the
-- allow-list.
--
-- v1 student submissions REUSE `open_question_grades` (one row per
-- (question, user) — matches the "one shot, no retry" semantics agreed
-- in #604, #606, and this issue):
--   - `submitted_answer` (text, JSON-encoded) stores the student's final
--     `{ [item_id]: category_id }` map.
--   - `gap_results` (jsonb, added in #604) stores
--     `{ "perItem": { [item_id]: bool, ... }, "allCorrect": bool, "hintsUsed": number }`
--     — third polymorphic shape under this column.
-- No new column is needed.

ALTER TABLE public.questions
  DROP CONSTRAINT IF EXISTS questions_type_check;

ALTER TABLE public.questions
  ADD CONSTRAINT questions_type_check
  CHECK (type IN ('mcq', 'open', 'fill_gaps', 'ordering', 'classification')) NOT VALID;

ALTER TABLE public.questions VALIDATE CONSTRAINT questions_type_check;

COMMENT ON COLUMN public.questions.type IS
  'Question type discriminator. One of: mcq, open, fill_gaps, ordering, classification. See src/types/question.ts for the payload/answer_key shape per type.';

COMMENT ON COLUMN public.open_question_grades.gap_results IS
  'Per-item correctness blob — polymorphic by question type. '
  'Fill-gaps (#604): { "perGap": [bool, ...], "allCorrect": bool }. '
  'Ordering (#606): { "perPosition": [bool, ...], "allCorrect": bool }. '
  'Classification (#610): { "perItem": { [item_id]: bool, ... }, "allCorrect": bool, "hintsUsed": number }. '
  'NULL for MCQ / open rows.';
