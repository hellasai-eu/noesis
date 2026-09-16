-- Case-insensitive erasure of the email-keyed and JSON-keyed rows
-- (issue #932, follow-up to 20260726000000).
--
-- `delete-user` originally issued these deletes through PostgREST, matching the
-- subject's email exactly. Emails are stored as typed — `UserManagement.tsx`
-- inserts an invitation with whatever case the admin entered — while the auth
-- record is lowercased, so a `Foo@Bar.com` invitation survived the erasure of
-- `foo@bar.com`. Worse, `public.user_data_footprint()` compares with `lower()`
-- and would have reported the leftover the eraser could not remove.
--
-- Matching in SQL fixes the case sensitivity and removes the mismatch: the
-- predicates below are the same ones the footprint sweep uses. Doing it through
-- PostgREST was not an option — `ilike` is the only case-insensitive filter it
-- offers, and its pattern has no escape, so an address containing `_` (legal,
-- and common) would match other people's rows.
--
-- Storage objects cannot be reached from SQL, so the screenshot paths are
-- returned for the caller to delete.

CREATE OR REPLACE FUNCTION public.erase_user_unlinked_data(
  _user_id uuid,
  _email   text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_paths text[] := '{}';
  v_bug   integer := 0;
  v_inv   integer := 0;
  v_admin integer := 0;
  v_flag  integer := 0;
BEGIN
  -- Bug reports are anonymised, not deleted: the defect record has value, the
  -- reporter does not. `reporter_id` is nulled by its own foreign key when the
  -- account goes; the email copy and the screenshots are cleared here.
  --
  -- The paths are collected BEFORE the update empties the column. Matching on
  -- `reporter_id` still works because this runs before the auth user is deleted.
  --
  -- NARROWER THAN THE UPDATE BELOW, deliberately. An address can be reassigned:
  -- someone changes their email, and the subject later registers the address
  -- they gave up. Their old reports still carry the stale `reporter_email`, so
  -- an email-only match would hand back attachments belonging to a LIVE user,
  -- which the caller then deletes from storage with the service role. Only rows
  -- the subject owns (`reporter_id`) or that have no owner at all — an account
  -- already deleted — can contribute paths.
  SELECT coalesce(array_agg(DISTINCT p) FILTER (WHERE p IS NOT NULL), '{}')
    INTO v_paths
    FROM (
      SELECT unnest(screenshot_paths) AS p
        FROM public.bug_reports
       WHERE reporter_id = _user_id
          OR (reporter_id IS NULL
              AND _email IS NOT NULL
              AND lower(reporter_email) = lower(_email))
    ) s;

  -- Clearing the ADDRESS stays broad: wherever the subject's email appears it
  -- is their personal data, even on a row a reassignment left with someone
  -- else. That costs the other owner nothing — a stale address they no longer
  -- hold. Clearing `screenshot_paths` follows the narrow rule instead, so the
  -- column is only emptied for rows whose objects are actually being deleted;
  -- otherwise a live user's report would keep its attachments in storage while
  -- losing every reference to them.
  UPDATE public.bug_reports
     SET reporter_email = NULL,
         screenshot_paths = CASE
           WHEN reporter_id IS NULL OR reporter_id = _user_id THEN '{}'
           ELSE screenshot_paths
         END
   WHERE reporter_id = _user_id
      OR (_email IS NOT NULL AND lower(reporter_email) = lower(_email));
  GET DIAGNOSTICS v_bug = ROW_COUNT;

  IF _email IS NOT NULL THEN
    -- A pending invitation carries the email and the name it was addressed to.
    -- Invitations the subject SENT keep their rows; `invited_by` is nulled by
    -- its foreign key, because those belong to the institution.
    DELETE FROM public.invitations WHERE lower(email) = lower(_email);
    GET DIAGNOSTICS v_inv = ROW_COUNT;

    -- Keyed by email alone. Leaving the row would retain the address AND
    -- re-grant super admin to whoever next registers it.
    DELETE FROM public.super_admins WHERE lower(email) = lower(_email);
    GET DIAGNOSTICS v_admin = ROW_COUNT;
  END IF;

  -- `data` embeds the user id and up to 500 characters of what they wrote, so
  -- the row goes rather than being anonymised.
  DELETE FROM public.flagged_content WHERE data ->> 'user_id' = _user_id::text;
  GET DIAGNOSTICS v_flag = ROW_COUNT;

  RETURN jsonb_build_object(
    'bug_reports',      v_bug,
    'invitations',      v_inv,
    'super_admins',     v_admin,
    'flagged_content',  v_flag,
    -- FALSE means the email-keyed rows were not touched at all, which the
    -- caller must report as an incomplete erasure rather than a clean one.
    'email_checked',    _email IS NOT NULL,
    'screenshot_paths', to_jsonb(v_paths)
  );
END;
$$;

COMMENT ON FUNCTION public.erase_user_unlinked_data(uuid, text) IS
  'Erases the personal data no foreign key can reach (email-keyed rows, flagged_content payloads) and returns the storage paths the caller must delete. Called by the delete-user edge function before auth.admin.deleteUser.';

-- Service role only: this deletes across tenants and is called by an edge
-- function that has already checked the caller is a super admin.
REVOKE ALL ON FUNCTION public.erase_user_unlinked_data(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.erase_user_unlinked_data(uuid, text) TO postgres, service_role;
