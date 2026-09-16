-- Atomic institution membership changes, with evaluator access revoked in the
-- same transaction.
--
-- Changing someone's role or removing their membership is two writes, because
-- evaluator read access does not hang off the membership row: RLS authorises it
-- through `course_evaluators`, and `is_course_evaluator()` (20260624100000)
-- never consults `user_institutions`. A former evaluator whose assignments
-- survive keeps reading the questions, materials and competencies of every
-- course they reviewed.
--
-- Done from the client, those two writes cannot be made atomic, and either
-- order has a bad failure:
--
--   revoke, then update  — update fails and the assignments are gone for good
--                          while the user is still an evaluator, with the UI
--                          reporting that nothing happened.
--   update, then revoke  — revoke fails and the new student or instructor keeps
--                          evaluator read access, which is the hole this closes.
--
-- One function, one transaction, neither failure. Callers:
-- `SuperAdminUsers.tsx` (edit role, remove from institution).

CREATE OR REPLACE FUNCTION public.set_institution_membership_role(
  _user_id        uuid,
  _institution_id uuid,
  -- NULL removes the membership entirely.
  _role           text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_previous_role text;
BEGIN
  -- SECURITY DEFINER bypasses RLS, so the policy this replaces is restated
  -- here: a super admin, or an admin OF THAT INSTITUTION. Scoping to
  -- `_institution_id` is what stops an admin of one school from editing
  -- memberships at another.
  IF NOT (
    public.is_super_admin(auth.uid())
    OR public.is_institution_admin(auth.uid(), _institution_id)
  ) THEN
    RAISE EXCEPTION 'Not authorized to change memberships in this institution'
      USING ERRCODE = '42501';
  END IF;

  -- The set of roles `user_institutions.role` is expected to hold. Rejecting
  -- anything else keeps a typo from creating a membership no policy matches,
  -- which reads as "access silently stopped working".
  IF _role IS NOT NULL AND _role NOT IN ('student', 'instructor', 'evaluator', 'admin') THEN
    RAISE EXCEPTION 'Unknown role: %', _role USING ERRCODE = '22023';
  END IF;

  SELECT role
    INTO v_previous_role
    FROM public.user_institutions
   WHERE user_id = _user_id
     AND institution_id = _institution_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'User is not a member of this institution'
      USING ERRCODE = 'P0002';
  END IF;

  -- Revoke first, so a caller reading the row mid-flight can never see the new
  -- role alongside the old access. Both statements are in one transaction, so
  -- the ordering is only about what a concurrent reader could observe.
  --
  -- Scoped to this institution's courses: the same person may legitimately
  -- evaluate courses at another one. A removal always revokes — someone with no
  -- membership at all must not keep reading the institution's courses.
  --
  -- Only when the user CEASES to be an evaluator. Re-setting the role to
  -- `evaluator` is a no-op that must keep their course scope: taking the
  -- previous role alone would let a re-save wipe every assignment while
  -- reporting nothing changed, leaving a scopeless evaluator who sees nothing.
  IF _role IS NULL OR (v_previous_role = 'evaluator' AND _role <> 'evaluator') THEN
    DELETE FROM public.course_evaluators ce
     USING public.courses c
     WHERE ce.course_id = c.id
       AND ce.user_id = _user_id
       AND c.institution_id = _institution_id;
  END IF;

  IF _role IS NULL THEN
    DELETE FROM public.user_institutions
     WHERE user_id = _user_id
       AND institution_id = _institution_id;
  ELSE
    UPDATE public.user_institutions
       SET role = _role
     WHERE user_id = _user_id
       AND institution_id = _institution_id;
  END IF;
END;
$$;

COMMENT ON FUNCTION public.set_institution_membership_role(uuid, uuid, text) IS
  'Changes or removes a user''s institution membership, revoking their evaluator course assignments in the same transaction. NULL _role removes the membership. Callable by super admins and admins of that institution.';

-- Called from the browser as the signed-in admin; the privilege check above is
-- what authorizes it, not the grant.
REVOKE ALL ON FUNCTION public.set_institution_membership_role(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_institution_membership_role(uuid, uuid, text) TO authenticated;
