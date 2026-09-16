-- Multi-correct MCQ support (parent issue #592).
--
-- Storage extends the unified MCQ answer_key shape from
--   { correct_index: N }
-- to
--   { correct_indices: [N, M, ...] }
-- and unifies the answer side of `quiz_answers` from a single integer
-- `selected_answer` into a JSONB `submission` of
--   { selected_indices: [N, M, ...] }
--
-- Expand-only (dual-write). Mirrors #579-#582:
--   * `correct_indices` is added next to `correct_index`; existing rows are
--     backfilled `correct_index: N` -> `correct_indices: [N]`. The legacy
--     `correct_index` stays populated so a frontend rollback (or any reader
--     not yet rebuilt) keeps grading single-correct rows correctly.
--   * `quiz_answers.submission` is added next to `selected_answer`; existing
--     rows are backfilled. `selected_answer` stays NOT NULL for this PR;
--     a follow-up contract migration drops both legacy keys.
--
-- This migration is reversible per-statement (downgrade by dropping the new
-- columns / keys), but we deliberately keep the contract step out of this PR
-- so any in-flight session that started on the old build can finish.

-- ---------------------------------------------------------------------------
-- 1. questions.answer_key: backfill correct_indices for every MCQ row.
-- ---------------------------------------------------------------------------
-- Only MCQ rows have a meaningful correct_index. Open-type rows (absorbed in
-- #577) have answer_key shaped { model_answer, rubric, explanation } and are
-- left untouched.
UPDATE public.questions
SET answer_key = answer_key || jsonb_build_object(
  'correct_indices',
  jsonb_build_array((answer_key->>'correct_index')::int)
)
WHERE type = 'mcq'
  AND answer_key ? 'correct_index'
  AND NOT (answer_key ? 'correct_indices');

-- ---------------------------------------------------------------------------
-- 2. questions: validation constraint for the new shape.
-- ---------------------------------------------------------------------------
-- PostgreSQL CHECK constraints cannot contain subqueries (SQLSTATE 0A000),
-- so the per-element validation is wrapped in an IMMUTABLE SQL helper.
-- Reject MCQ rows whose correct_indices is anything other than a JSON array
-- of distinct non-negative integers each within range of the options array.
CREATE OR REPLACE FUNCTION public.questions_mcq_correct_indices_valid(
  p_answer_key jsonb,
  p_payload jsonb
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT
    jsonb_typeof(p_answer_key->'correct_indices') = 'array'
    AND jsonb_array_length(p_answer_key->'correct_indices') >= 1
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(p_answer_key->'correct_indices') AS e
      WHERE jsonb_typeof(e) <> 'number'
         OR (e::text)::int < 0
         OR (e::text)::int >= jsonb_array_length(p_payload->'options')
    )
    AND (
      SELECT COUNT(*) = COUNT(DISTINCT (e::text)::int)
      FROM jsonb_array_elements(p_answer_key->'correct_indices') AS e
    );
$$;

-- NOT VALID lets the ALTER hold only a brief ACCESS EXCLUSIVE lock; the
-- backfill above guarantees every existing row already satisfies the check.
ALTER TABLE public.questions
  ADD CONSTRAINT questions_mcq_correct_indices_check
  CHECK (
    type <> 'mcq'
    OR public.questions_mcq_correct_indices_valid(answer_key, payload)
  ) NOT VALID;

ALTER TABLE public.questions
  VALIDATE CONSTRAINT questions_mcq_correct_indices_check;

-- ---------------------------------------------------------------------------
-- 3. quiz_answers: add `submission` jsonb and backfill.
-- ---------------------------------------------------------------------------
-- Nullable for now -- in-flight inserts from older deploys still write only
-- the legacy `selected_answer`. The frontend dual-writes both during this
-- release; the follow-up migration flips this NOT NULL and drops
-- selected_answer.
ALTER TABLE public.quiz_answers
  ADD COLUMN submission jsonb;

UPDATE public.quiz_answers
SET submission = jsonb_build_object(
  'selected_indices', jsonb_build_array(selected_answer)
)
WHERE submission IS NULL;

-- ---------------------------------------------------------------------------
-- 4. quiz_answers: shape constraint on `submission`.
-- ---------------------------------------------------------------------------
-- Same subquery-in-CHECK restriction as step 2 -- wrap in an IMMUTABLE helper.
-- Allow NULL (rows from older deploys), but if present require a
-- selected_indices array of distinct non-negative integers. Empty array is
-- allowed and represents "no answer" (auto-submit before student picked).
CREATE OR REPLACE FUNCTION public.quiz_answers_submission_valid(
  p_submission jsonb
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT
    p_submission IS NULL
    OR (
      jsonb_typeof(p_submission->'selected_indices') = 'array'
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(p_submission->'selected_indices') AS e
        WHERE jsonb_typeof(e) <> 'number'
           OR (e::text)::int < 0
      )
      AND (
        SELECT COUNT(*) = COUNT(DISTINCT (e::text)::int)
        FROM jsonb_array_elements(p_submission->'selected_indices') AS e
      )
    );
$$;

ALTER TABLE public.quiz_answers
  ADD CONSTRAINT quiz_answers_submission_check
  CHECK (public.quiz_answers_submission_valid(submission)) NOT VALID;

ALTER TABLE public.quiz_answers
  VALIDATE CONSTRAINT quiz_answers_submission_check;

COMMENT ON COLUMN public.quiz_answers.submission IS
  'Unified student submission shape for MCQs: { selected_indices: number[] }. Mirrors questions.answer_key.correct_indices. See issue #592.';
