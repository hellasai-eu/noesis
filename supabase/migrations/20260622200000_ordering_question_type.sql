-- Add the "ordering" question type (#606).
--
-- Mirrors the fill-gaps migration pattern (#604, 20260622100000): the
-- `payload` / `answer_key` JSONB columns already exist and are
-- schema-agnostic, but the `questions_type_check` CHECK constraint only
-- permitted ('mcq', 'open', 'fill_gaps'). Extend the allow-list.
--
-- v1 student submissions REUSE `open_question_grades` (one row per
-- (question, user) — matches the "one shot, no retry" semantics agreed in
-- both #604 and the #606 spec):
--   - `submitted_answer` (text, JSON-encoded) stores the student's final
--     ordered array of items.
--   - `gap_results` (jsonb, added in #604) stores
--     `{ "perPosition": [bool, ...], "allCorrect": bool }` — same shape as
--     fill-gaps but keyed by position instead of by gap ordinal. No new
--     column is needed.

ALTER TABLE public.questions
  DROP CONSTRAINT IF EXISTS questions_type_check;

ALTER TABLE public.questions
  ADD CONSTRAINT questions_type_check
  CHECK (type IN ('mcq', 'open', 'fill_gaps', 'ordering')) NOT VALID;

ALTER TABLE public.questions VALIDATE CONSTRAINT questions_type_check;

COMMENT ON COLUMN public.questions.type IS
  'Question type discriminator. One of: mcq, open, fill_gaps, ordering. See src/types/question.ts for the payload/answer_key shape per type.';

COMMENT ON COLUMN public.open_question_grades.gap_results IS
  'Per-gap (fill-gaps, #604) or per-position (ordering, #606) correctness. '
  'Fill-gaps shape: { "perGap": [bool, ...], "allCorrect": bool }. '
  'Ordering shape: { "perPosition": [bool, ...], "allCorrect": bool }. '
  'NULL for MCQ / open rows.';
