-- Expand `public.questions` with a unified type/payload/answer_key shape
-- so future PRs can incrementally migrate readers and writers onto it
-- (parent epic: #575, this PR: #576).
--
-- Additive only — no readers or writers change yet:
--   * `type` discriminates question kind (currently 'mcq' or 'open').
--   * `payload` holds type-specific configuration (e.g. MCQ options).
--   * `answer_key` holds type-specific correct-answer data
--     (e.g. correct_index for MCQ, model_answer for open).
--
-- Existing rows are backfilled to the MCQ-single shape:
--   type       = 'mcq'
--   payload    = { "options": <old options jsonb> }
--   answer_key = { "correct_index": <old correct_answer int> }
--
-- The old `options` / `correct_answer` columns remain the source of truth
-- until the writer/reader migration PRs (#578-#581) and the contract PR (#582).
-- RLS is unchanged — new columns inherit the existing table policies.

ALTER TABLE public.questions
  ADD COLUMN type        text  NOT NULL DEFAULT 'mcq',
  ADD COLUMN payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN answer_key  jsonb NOT NULL DEFAULT '{}'::jsonb;

-- NOT VALID skips the full-table scan so this ALTER holds only a brief
-- ACCESS EXCLUSIVE lock.  The existing rows are validated in a subsequent
-- migration that uses a weaker SHARE UPDATE EXCLUSIVE lock.
ALTER TABLE public.questions
  ADD CONSTRAINT questions_type_check
  CHECK (type IN ('mcq', 'open')) NOT VALID;

-- Backfill every existing row to the canonical MCQ-single shape.
-- Safe to run unconditionally: this migration only executes once, and the
-- update is a no-op for any row already in the target shape.
UPDATE public.questions
SET
  type       = 'mcq',
  payload    = jsonb_build_object('options', options),
  answer_key = jsonb_build_object('correct_index', correct_answer);

COMMENT ON COLUMN public.questions.type IS
  'Question type discriminator. One of: mcq, open. See src/types/question.ts for the payload/answer_key shape per type.';
COMMENT ON COLUMN public.questions.payload IS
  'Type-specific configuration (e.g. MCQ options). Shape governed by the type column. Zod schemas live in src/types/question.ts.';
COMMENT ON COLUMN public.questions.answer_key IS
  'Type-specific correct-answer data (e.g. correct_index for MCQ, model_answer for open). Shape governed by the type column.';
