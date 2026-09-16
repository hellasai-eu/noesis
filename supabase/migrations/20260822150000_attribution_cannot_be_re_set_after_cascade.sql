-- Issue #1102 (part of #1097): close the two-step version of the section
-- transfer that 20260822140000 left reachable.
--
-- That migration made attribution immutable "once set", and allowed NULL → an
-- offering so that previously unattributed work could be filed. It also had to
-- allow the FK's ON DELETE SET NULL, or deleting an offering became impossible.
-- Those two exceptions compose into the thing the trigger exists to prevent:
-- delete the offering, the cascade clears the column, and the row is now
-- "unattributed" — so a dual-enrolled student may set it to their *other*
-- section, transferring visibility to that section's instructor after all. Two
-- steps instead of one, same outcome.
--
-- Distinguishing "never attributed" from "attribution erased by a cascade"
-- would need somewhere to remember the difference, and there is no need for the
-- distinction at all: nothing sets `offering_id` after insert. The frontend
-- writes it when it creates the row (`StudentQuiz`), and the only other
-- mentions of the column in the client are `.eq()` filters. Practice-mode work
-- is inserted with NULL and stays NULL, which is exactly what the policies
-- expect.
--
-- So attribution is simply immutable. The row says where the work was done when
-- it is written, and nothing moves it afterwards. The single exception remains
-- the FK cascade, which is not a caller choosing a section but the section
-- ceasing to exist.

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

  IF NEW.offering_id IS DISTINCT FROM OLD.offering_id THEN
    -- The one legitimate write: the offering was deleted and the FK's
    -- ON DELETE SET NULL is writing that through. The referenced row is
    -- already gone by the time this fires, which is what separates the cascade
    -- from a caller clearing or re-pointing the column by hand. Without this
    -- branch, deleting an offering would be impossible.
    IF NEW.offering_id IS NULL
       AND OLD.offering_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM offerings o WHERE o.id = OLD.offering_id) THEN
      RETURN NEW;
    END IF;

    RAISE EXCEPTION
      'attribution of % is immutable: offering % cannot become %',
      TG_TABLE_NAME, OLD.offering_id, NEW.offering_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.student_work_attribution_is_immutable() IS
  'Refuses any UPDATE that changes user_id or offering_id. The sole exception '
  'is the FK''s ON DELETE SET NULL, recognised by the referenced offering '
  'already being gone — that is the section ceasing to exist, not a caller '
  'choosing one. Nothing sets offering_id after insert, so there is no '
  'legitimate write this turns away (#1097).';

-- The triggers from 20260822140000 already point at this function and fire on
-- `UPDATE OF user_id, offering_id`, so replacing the body is the whole change.
