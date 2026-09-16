-- #690: Collapse the four granular yes/no correctness checks on
-- `question_evaluations` into two professional, higher-level ones:
--
--   - `question_good`  — "Η ερώτηση είναι ποιοτική και ορθά διατυπωμένη;"
--   - `answer_good`    — "Η δηλωμένη ορθή απάντηση είναι έγκυρη και επαρκής;"
--
-- Drop-and-replace per the issue (#690): the four old columns are removed
-- outright. Per the issue, early data on these fields is discarded — and
-- because the two new columns are NOT NULL with no defensible backfill from
-- the old four (the new judgments aren't derivable from any single old
-- boolean), we truncate the table so the ADD COLUMN ... NOT NULL succeeds
-- on an empty table. The feature is pre-launch, no production data.
--
-- `question_evaluation_sessions` rows are left intact — their schema is
-- unchanged. The FK from question_evaluations to sessions is ON DELETE
-- CASCADE on the child side, so a TRUNCATE of the child has no fan-out.

TRUNCATE TABLE public.question_evaluations;

ALTER TABLE public.question_evaluations
  DROP COLUMN scientifically_accurate,
  DROP COLUMN stated_answer_correct,
  DROP COLUMN exactly_one_correct,
  DROP COLUMN distractors_wrong,
  ADD COLUMN question_good boolean NOT NULL,
  ADD COLUMN answer_good boolean NOT NULL;
