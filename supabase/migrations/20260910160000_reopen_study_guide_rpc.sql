-- Atomic reopen for study guide assignments (#1357, review).
--
-- The instructor's Reopen action must clear each published row's closure AND
-- its passed due date together: split across two client statements, a partial
-- commit reopens submissions on some sections while others still read Done
-- (or vice versa), and #1350's review already rejected exactly that shape
-- once. Due dates are per section now, so the fix cannot be one uniform
-- UPDATE from the client either — a section whose deadline is still ahead
-- must keep it while a passed one is cleared, which is a per-row CASE only
-- the database can do in a single statement.
--
-- Mirrors reopen_offering_quiz (20260907120000): SECURITY DEFINER with an
-- explicit instructor/admin/super-admin check, so the authorization is the
-- function's own rather than whatever RLS happens to allow the caller.
-- Re-runnable on purpose: CREATE OR REPLACE + REVOKE/GRANT only, so applying
-- it to a database that already has it is a no-op.

CREATE OR REPLACE FUNCTION public.reopen_study_guide(_study_guide_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_course_id uuid;
  v_institution_id uuid;
BEGIN
  SELECT sg.course_id, c.institution_id
    INTO v_course_id, v_institution_id
  FROM public.study_guides sg
  JOIN public.courses c ON c.id = sg.course_id
  WHERE sg.id = _study_guide_id;

  IF v_course_id IS NULL THEN
    RAISE EXCEPTION 'Study guide not found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT (
    public.is_super_admin(auth.uid())
    OR public.is_course_instructor(v_course_id, auth.uid())
    OR public.is_institution_admin(auth.uid(), v_institution_id)
  ) THEN
    RAISE EXCEPTION 'Not authorized to reopen this study guide' USING ERRCODE = '42501';
  END IF;

  -- One statement over every published row: closure always cleared, the due
  -- date only where it has already passed. A still-future deadline survives.
  UPDATE public.offering_study_guides
    SET closed_at = NULL,
        due_date = CASE WHEN due_date < now() THEN NULL ELSE due_date END,
        updated_at = now()
    WHERE study_guide_id = _study_guide_id
      AND published_at IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.reopen_study_guide(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reopen_study_guide(uuid) TO authenticated;
