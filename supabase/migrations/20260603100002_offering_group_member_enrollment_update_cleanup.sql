-- Cleanup offering_group_members when a class_enrollments row is UPDATED so the
-- user is no longer a student in the original class (role changes away from
-- 'student', or class_id is reassigned).
--
-- The existing `class_enrollments_cleanup_group_members` trigger only fires
-- on DELETE, so a role change leaves stale memberships behind — and because
-- `enforce_offering_group_member_enrollment` only validates new INSERTs, those
-- stale rows would keep satisfying `is_offering_group_member()` in RLS.

CREATE OR REPLACE FUNCTION public.cleanup_offering_group_members_on_enrollment_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Still a student in the same class → nothing to do.
  IF NEW.user_id = OLD.user_id
     AND NEW.class_id = OLD.class_id
     AND NEW.role = 'student'
     AND OLD.role = 'student' THEN
    RETURN NEW;
  END IF;

  -- Otherwise the row no longer represents "student in OLD.class_id" — purge
  -- any memberships the user held for groups in that class.
  DELETE FROM public.offering_group_members
   WHERE user_id = OLD.user_id
     AND group_id IN (
       SELECT og.id
         FROM public.offering_groups og
         JOIN public.offerings o ON o.id = og.offering_id
        WHERE o.class_id = OLD.class_id
     );

  RETURN NEW;
END;
$$;

CREATE TRIGGER class_enrollments_cleanup_group_members_on_update
  AFTER UPDATE ON public.class_enrollments
  FOR EACH ROW
  EXECUTE FUNCTION public.cleanup_offering_group_members_on_enrollment_update();
