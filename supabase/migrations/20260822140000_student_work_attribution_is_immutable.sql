-- Issue #1102 (part of #1097): a student may not move their work between
-- sections after the fact.
--
-- 20260822100000 stopped a student attributing their work to an offering they
-- do not sit in. It did not stop a student who sits in *two* sections of a
-- course moving an existing row from one to the other — both destinations pass
-- `student_may_attribute_to_offering`, because both are genuinely theirs. The
-- effect is a transfer of visibility: work done in 1Β becomes work 1Α's
-- instructor can read, at the subject's discretion.
--
-- This is the same shape as the ownership problem that migration ends with, and
-- it has the same answer. A WITH CHECK sees only the finished row, so "the
-- offering did not change" is not expressible in a policy — it is a comparison
-- against OLD. The trigger already guarding `user_id` is the right place, so it
-- widens to cover attribution as a whole:
--
--   * `user_id` never changes. A session belongs to whoever sat it.
--   * `offering_id` may be set once, NULL → an offering the policies accept,
--     which is how previously unattributed work gets filed. It may not then be
--     moved to a different offering, and it may not be cleared back to NULL by
--     a caller. Clearing is not an escalation on its own — unattributed rows
--     reach no restricted instructor at all — but clear-then-refile would be a
--     move in two steps, so both halves have to be shut.
--
-- The one legitimate way a set offering becomes NULL is the FK's
-- ON DELETE SET NULL, when the offering itself is deleted. That is allowed, and
-- distinguished by the referenced row already being gone when the trigger
-- fires. Without that branch this trigger would make deleting an offering
-- impossible.
--
-- Written as a new migration rather than an edit to 20260822100000 because that
-- version has already been applied to this PR's preview branch, and a branch
-- applies migrations incrementally: edits to a version it has already run are
-- silently skipped there, however green a local `db reset` looks.

CREATE OR REPLACE FUNCTION public.student_work_attribution_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION
      'ownership of % is immutable: % cannot be re-filed under %',
      TG_TABLE_NAME, OLD.user_id, NEW.user_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.offering_id IS NOT NULL
     AND NEW.offering_id IS DISTINCT FROM OLD.offering_id THEN
    -- One legitimate way for a set offering to become NULL: the offering was
    -- deleted, and the FK's ON DELETE SET NULL is writing that through. The
    -- referenced row is already gone by the time this fires, which is what
    -- separates the cascade from a caller clearing the column by hand. Without
    -- this branch the trigger would make deleting an offering impossible.
    IF NEW.offering_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM offerings o WHERE o.id = OLD.offering_id) THEN
      RETURN NEW;
    END IF;

    RAISE EXCEPTION
      'attribution of % is immutable once set: offering % cannot become %',
      TG_TABLE_NAME, OLD.offering_id, NEW.offering_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.student_work_attribution_is_immutable() IS
  'Refuses any UPDATE that changes user_id, or that changes offering_id once '
  'it is set. RLS WITH CHECK cannot express "unchanged" — it sees only the '
  'resulting row — so these invariants live here rather than being '
  'approximated in every policy that touches student work (#1097).';

-- Replaces the narrower `BEFORE UPDATE OF user_id` triggers from
-- 20260822100000. `OF user_id, offering_id` so the trigger fires when either
-- column is in the UPDATE's target list.
DROP TRIGGER IF EXISTS trg_quiz_sessions_owner_immutable ON public.quiz_sessions;
DROP TRIGGER IF EXISTS trg_quiz_sessions_attribution_immutable ON public.quiz_sessions;
CREATE TRIGGER trg_quiz_sessions_attribution_immutable
BEFORE UPDATE OF user_id, offering_id ON public.quiz_sessions
FOR EACH ROW EXECUTE FUNCTION public.student_work_attribution_is_immutable();

DROP TRIGGER IF EXISTS trg_quiz_answers_owner_immutable ON public.quiz_answers;
DROP TRIGGER IF EXISTS trg_quiz_answers_attribution_immutable ON public.quiz_answers;
CREATE TRIGGER trg_quiz_answers_attribution_immutable
BEFORE UPDATE OF user_id, offering_id ON public.quiz_answers
FOR EACH ROW EXECUTE FUNCTION public.student_work_attribution_is_immutable();

DROP TRIGGER IF EXISTS trg_student_study_progress_owner_immutable ON public.student_study_progress;
DROP TRIGGER IF EXISTS trg_student_study_progress_attribution_immutable ON public.student_study_progress;
CREATE TRIGGER trg_student_study_progress_attribution_immutable
BEFORE UPDATE OF user_id, offering_id ON public.student_study_progress
FOR EACH ROW EXECUTE FUNCTION public.student_work_attribution_is_immutable();

-- `student_work_owner_is_immutable` from 20260822100000 is left defined rather
-- than dropped. No trigger names it now, so it is inert; dropping a function
-- that a concurrently deployed trigger might still reference is the kind of
-- tidiness that causes an outage during a rollout.
