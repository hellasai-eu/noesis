-- Group-scoped quiz analyses (quiz ↔ study-guide analytics parity).
--
-- `study_guide_analyses` caches one AI assessment per (guide, offering, group)
-- cohort; `quiz_analyses` predates that model and only keyed on
-- (quiz_id, offering_id). That had two consequences:
--
--   1. A quiz assigned to a group could not have its own analysis — a
--      group-scoped refresh would overwrite the whole-class report, and the
--      panel would present one group's weaknesses as the class's.
--   2. The analyze-quiz function's `.maybeSingle()` on (quiz_id, offering_id)
--      errored outright once one quiz carried several group-scoped assignment
--      rows in the same offering.
--
-- This brings quiz_analyses to the study_guide_analyses shape: `group_id` is
-- part of the key (NULL = whole class), with the same composite FK so a group
-- can never be attached to the wrong offering.

ALTER TABLE public.quiz_analyses
  ADD COLUMN group_id UUID,
  ADD CONSTRAINT quiz_analyses_group_id_offering_fkey
    FOREIGN KEY (group_id, offering_id)
    REFERENCES public.offering_groups(id, offering_id)
    ON DELETE CASCADE;

-- One analysis per (quiz, offering, scope). NULLS NOT DISTINCT so the
-- whole-class scope gets exactly one slot — same idiom as
-- study_guide_analyses (20260729090000). Doubles as the upsert target.
DROP INDEX public.idx_quiz_analyses_unique;
CREATE UNIQUE INDEX idx_quiz_analyses_unique
  ON public.quiz_analyses(quiz_id, offering_id, group_id)
  NULLS NOT DISTINCT;
CREATE INDEX idx_quiz_analyses_group ON public.quiz_analyses(group_id);
