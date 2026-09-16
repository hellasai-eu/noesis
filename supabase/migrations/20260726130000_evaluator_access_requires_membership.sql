-- Evaluator access requires a current evaluator membership.
--
-- `is_course_evaluator()` (20260624100000) authorises purely on the existence
-- of a `course_evaluators` row and never consults `user_institutions`. Every
-- evaluator-access bug in this area comes back to that: the row is the grant,
-- so anything that fails to delete it leaves the access standing.
--
-- 20260726120000 closed the paths that forgot to delete, by making the
-- membership change and the revoke one transaction. It cannot close the race,
-- though: that function takes `FOR UPDATE` on the membership row, but an admin
-- assigning a course inserts into `course_evaluators` without touching that
-- row, so an insert landing after the revoke's DELETE survives the role change
-- and keeps granting access.
--
-- Two halves, because either alone leaves something behind:
--
--   1. The grant now requires a live `evaluator` membership in the course's
--      institution. A raced row — or one stranded by an older code path, or by
--      a direct DB edit — grants nothing.
--   2. Creating an assignment for a non-evaluator is refused, and the check
--      takes `FOR SHARE` on the same membership row, so a racing insert waits
--      for the revoke to commit and is then rejected. Without this the row
--      would be created anyway: harmless while the user is not an evaluator,
--      but silently reviving if they are ever made one again — and the admin
--      would see "Assigned to X" for an assignment granting nothing.

-- ---------------------------------------------------------------------------
-- 1. The grant
-- ---------------------------------------------------------------------------

-- `is_suspended` is honoured here for the same reason `is_institution_admin`
-- honours it (20260323000000): suspension exists to cut access off, and an
-- evaluator was the one role where it did not.
CREATE OR REPLACE FUNCTION public.is_course_evaluator(_course_id uuid, _user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM course_evaluators ce
      JOIN courses c            ON c.id = ce.course_id
      JOIN user_institutions ui ON ui.institution_id = c.institution_id
                              AND ui.user_id = ce.user_id
     WHERE ce.course_id = _course_id
       AND ce.user_id   = _user_id
       AND ui.role      = 'evaluator'
       AND NOT ui.is_suspended
  )
$$;

-- ---------------------------------------------------------------------------
-- 2. The assignment
-- ---------------------------------------------------------------------------

-- Refuses an assignment for someone who is not a current evaluator of the
-- course's institution.
--
-- `FOR SHARE` is what makes this race-safe rather than merely tidy: it takes
-- the same membership row `set_institution_membership_role()` holds `FOR
-- UPDATE`, so a concurrent insert blocks until that transaction commits and
-- then re-reads the row. A role change makes the insert fail; a removal leaves
-- no row to find, and it fails the same way.
--
-- Lock order matches the revoke — membership first, then `course_evaluators` —
-- so the two cannot deadlock against each other.
CREATE OR REPLACE FUNCTION public.course_evaluators_require_membership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role       text;
  v_suspended  boolean;
BEGIN
  SELECT ui.role, ui.is_suspended
    INTO v_role, v_suspended
    FROM public.courses c
    JOIN public.user_institutions ui
      ON ui.institution_id = c.institution_id
     AND ui.user_id = NEW.user_id
   WHERE c.id = NEW.course_id
     FOR SHARE OF ui;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Cannot assign an evaluator course: user is not a member of the course''s institution'
      USING ERRCODE = '23503';
  END IF;

  IF v_role <> 'evaluator' OR v_suspended THEN
    RAISE EXCEPTION
      'Cannot assign an evaluator course: user is not an active evaluator in that institution'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

-- Existing rows are left alone: this constrains what can be created from here
-- on, while half 1 above is what makes any already-stranded row inert.
DROP TRIGGER IF EXISTS trg_course_evaluators_require_membership ON public.course_evaluators;
CREATE TRIGGER trg_course_evaluators_require_membership
  BEFORE INSERT OR UPDATE ON public.course_evaluators
  FOR EACH ROW
  EXECUTE FUNCTION public.course_evaluators_require_membership();

-- Every legitimate writer already creates the membership first — `create-user`
-- and `accept-invitation` insert `user_institutions` before `course_evaluators`,
-- the UI only offers the assign action for users who are already evaluators,
-- and `seed.sql` seeds membership ahead of assignments — so the trigger rejects
-- nothing that works today.
