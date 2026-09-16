-- Absorb every `public.open_questions` row into the unified `public.questions`
-- table with `type='open'`, preserving the original UUID as `questions.id`.
-- Backfill `public.test_questions.question_id` for rows where
-- `question_type = 'open'`.
--
-- Part of the schema-unification epic (parent #575, this PR: #577).
-- No reader/writer code changes here:
--   * existing readers of `open_questions` keep working unchanged,
--   * `test_questions.open_question_id` and `question_type` stay populated
--     until the contract PR (#582).
--
-- RLS on `public.questions` is `course_id`-scoped; since `course_id` is
-- carried over verbatim, the absorbed rows inherit the correct row-level
-- access without any policy changes.

-- 1. Insert every open_question into questions with the unified shape.
-- `correct_answer` and `options` are MCQ-specific NOT NULL columns that the
-- contract PR will drop; supply schema-valid placeholders (0 / '[]') for now.
-- `open_questions.rubric` does not exist as a column today, so emit
-- `'rubric': null` to satisfy the issue's literal answer_key shape.
INSERT INTO public.questions (
  id,
  course_id,
  question,
  options,
  correct_answer,
  explanation,
  difficulty,
  upvotes,
  downvotes,
  hidden,
  created_by,
  created_at,
  updated_at,
  competency_id,
  generation_rationale,
  type,
  payload,
  answer_key
)
SELECT
  oq.id,
  oq.course_id,
  oq.question,
  '[]'::jsonb,
  0,
  oq.explanation,
  oq.difficulty,
  oq.upvotes,
  oq.downvotes,
  oq.hidden,
  oq.created_by,
  oq.created_at,
  oq.updated_at,
  oq.competency_id,
  oq.generation_rationale,
  'open',
  '{}'::jsonb,
  jsonb_build_object(
    'model_answer', oq.model_answer,
    'rubric',       NULL,
    'explanation',  oq.explanation
  )
FROM public.open_questions oq
ON CONFLICT (id) DO NOTHING;

-- 2. Relax the test_questions `question_reference` CHECK constraint.
-- The original constraint forbade `question_id IS NOT NULL` when
-- `question_type = 'open'`, which would block step 3's backfill.
-- The replacement still asserts internal consistency:
--   * MCQ rows: question_id NOT NULL, open_question_id NULL (unchanged)
--   * Open rows: open_question_id NOT NULL, and question_id is either NULL
--                (legacy state, before step 3 or for new rows from writers
--                that have not yet been migrated by #578) or equal to
--                open_question_id (after step 3 / post-#578).
-- The contract PR (#582) drops open_question_id and question_type entirely.
ALTER TABLE public.test_questions
  DROP CONSTRAINT IF EXISTS question_reference;

-- NOT VALID skips the full-table scan so this ALTER holds only a brief
-- ACCESS EXCLUSIVE lock. Existing rows are validated in migration 000003
-- which uses a weaker SHARE UPDATE EXCLUSIVE lock (same pattern as 000000/000001).
ALTER TABLE public.test_questions
  ADD CONSTRAINT question_reference CHECK (
    (question_type = 'mcq'  AND question_id IS NOT NULL AND open_question_id IS NULL) OR
    (question_type = 'open' AND open_question_id IS NOT NULL
       AND (question_id IS NULL OR question_id = open_question_id))
  ) NOT VALID;

-- 3. Backfill test_questions.question_id where question_type='open'.
-- Step 1 guarantees every open_questions.id has a matching questions.id, so
-- the FK on question_id is satisfied. Idempotent: re-runs match no rows.
UPDATE public.test_questions
SET question_id = open_question_id
WHERE question_type = 'open' AND question_id IS NULL;
