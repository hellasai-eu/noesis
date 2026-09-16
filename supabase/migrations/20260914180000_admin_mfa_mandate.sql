-- MFA mandate for privileged roles (auth hardening, workstream 2).
--
-- Policy decided 2026-09-14: MFA is REQUIRED for super-admins immediately,
-- RECOMMENDED for institution admins now, and REQUIRED for institution
-- admins from 2026-11-01 (UTC).
--
--   1. public.security_policies — operator-editable auth policy knobs.
--      Service-role only (RLS enabled, no permissive policies). Seeded with
--      the admin MFA deadline so moving the date is an UPDATE, not a
--      migration.
--   2. is_super_admin: the calling session must be aal2 OUTRIGHT — an
--      unenrolled super-admin has no super-admin authority until they
--      enroll and pass the challenge. (They can still sign in; the app's
--      enrollment gate is what they see.)
--   3. is_institution_admin / is_admin: once the deadline passes, same
--      outright-aal2 requirement for the calling session; before it, the
--      existing rule (aal2 only if enrolled, from 20260914150000) applies.
--   4. public.mfa_enrollment_status() — one RPC the frontend calls to
--      decide whether to hard-gate (required) or nudge (recommended).
--
-- A super-admin who also holds an ordinary institution-admin membership is
-- judged on the SUPER-ADMIN timeline for that membership too: every
-- session-gated helper below applies the outright-aal2 rule to any
-- super_admins member, so there is no window in which a super-admin's
-- password alone confers institution-level admin authority.

CREATE TABLE public.security_policies (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER security_policies_updated_at
  BEFORE UPDATE ON public.security_policies
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.security_policies ENABLE ROW LEVEL SECURITY;

-- No permissive policies: service-role reads/writes only. The restrictive
-- policy keeps the aal2 coverage invariant (see 20260914150000).
CREATE POLICY mfa_enforced ON public.security_policies AS RESTRICTIVE
  FOR ALL TO authenticated
  USING (public.mfa_satisfied())
  WITH CHECK (public.mfa_satisfied());

INSERT INTO public.security_policies (key, value)
VALUES ('admin_mfa_deadline', to_jsonb('2026-11-01T00:00:00Z'::text));

-- True once institution admins are required (not just recommended) to have
-- MFA. A missing OR UNPARSEABLE row fails CLOSED (mandate active): the row
-- is seeded above, so its absence means someone deleted it, and a garbage
-- value means someone mistyped an UPDATE — the safe reading of both is
-- "enforce". plpgsql so a bad timestamptz cast degrades to that instead of
-- erroring every admin authorization check.
CREATE OR REPLACE FUNCTION public.admin_mfa_mandate_active()
RETURNS boolean
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  deadline timestamptz;
BEGIN
  BEGIN
    SELECT (value #>> '{}')::timestamptz INTO deadline
      FROM public.security_policies
     WHERE key = 'admin_mfa_deadline';
  EXCEPTION WHEN OTHERS THEN
    deadline := NULL;
  END;
  RETURN now() >= coalesce(deadline, '-infinity'::timestamptz);
END
$$;

-- Raw super_admins membership, WITHOUT the session aal gate — the
-- building block for the gated helpers below. Not for authorization on
-- its own (that is is_super_admin), and not client-callable.
CREATE OR REPLACE FUNCTION public.super_admin_member(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.super_admins sa
    JOIN auth.users u ON u.email = sa.email
    WHERE u.id = _user_id
  )
$$;

-- Super-admin authority now requires an aal2 session outright. The
-- `auth.uid() IS DISTINCT FROM _user_id` arm keeps service-role RPC
-- lookups about OTHER users working (see 20260914150000); in every RLS
-- policy _user_id is auth.uid(), so the gate is always live there.
CREATE OR REPLACE FUNCTION public.is_super_admin(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.super_admin_member(_user_id)
  AND (auth.uid() IS DISTINCT FROM _user_id OR (auth.jwt() ->> 'aal') = 'aal2')
$$;

-- Institution-admin authority: enrolled sessions must be aal2 (as before);
-- once the mandate is active the session must be aal2 outright; and a
-- super_admins member is on the super-admin timeline even for their
-- ordinary membership rows — no password-only window through a side door.
CREATE OR REPLACE FUNCTION public.is_institution_admin(_user_id uuid, _institution_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT (
    EXISTS (
      SELECT 1 FROM public.user_institutions
      WHERE user_id = _user_id
        AND institution_id = _institution_id
        AND role = 'admin'
        AND NOT is_suspended
    ) OR is_super_admin(_user_id)
  )
  AND (
    auth.uid() IS DISTINCT FROM _user_id
    OR (
      public.mfa_satisfied()
      AND (NOT (public.admin_mfa_mandate_active() OR public.super_admin_member(_user_id))
           OR (auth.jwt() ->> 'aal') = 'aal2')
    )
  )
$$;

CREATE OR REPLACE FUNCTION public.is_admin(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_institutions
    WHERE user_id = _user_id AND role = 'admin'
  )
  AND (
    auth.uid() IS DISTINCT FROM _user_id
    OR (
      public.mfa_satisfied()
      AND (NOT (public.admin_mfa_mandate_active() OR public.super_admin_member(_user_id))
           OR (auth.jwt() ->> 'aal') = 'aal2')
    )
  )
$$;

-- The one RPC the frontend needs: does the CALLING user have to enroll now
-- (hard gate), or should we merely recommend it (dismissible banner)?
-- Deliberately reveals nothing about anyone but the caller.
CREATE OR REPLACE FUNCTION public.mfa_enrollment_status()
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  WITH me AS (
    SELECT
      EXISTS (
        SELECT 1 FROM auth.mfa_factors
        WHERE user_id = (SELECT auth.uid()) AND status = 'verified'
      ) AS enrolled,
      public.super_admin_member((SELECT auth.uid())) AS is_super,
      EXISTS (
        SELECT 1 FROM public.user_institutions
        WHERE user_id = (SELECT auth.uid())
          AND role = 'admin' AND NOT is_suspended
      ) AS is_admin_member
  )
  SELECT jsonb_build_object(
    'required',
      NOT enrolled AND (is_super OR (is_admin_member AND public.admin_mfa_mandate_active())),
    'recommended',
      -- Mutually exclusive with `required`: a super-admin member is past
      -- recommending regardless of any admin membership they also hold.
      NOT enrolled AND is_admin_member AND NOT is_super
        AND NOT public.admin_mfa_mandate_active(),
    'deadline',
      (SELECT value #>> '{}' FROM public.security_policies WHERE key = 'admin_mfa_deadline')
  )
  FROM me
$$;

-- Execute-privilege hygiene: Postgres grants EXECUTE to PUBLIC on new
-- functions by default, which would let anonymous clients call these
-- SECURITY DEFINER helpers. Only signed-in users (and the roles that
-- evaluate RLS policies) have any business with them.
REVOKE EXECUTE ON FUNCTION public.admin_mfa_mandate_active() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_mfa_mandate_active() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.mfa_enrollment_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mfa_enrollment_status() TO authenticated, service_role;
-- super_admin_member would let any signed-in user probe who is a
-- super-admin by id, and no client has a reason to call it: the SECURITY
-- DEFINER helpers that need it run as the function owner. Service role
-- only.
REVOKE EXECUTE ON FUNCTION public.super_admin_member(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.super_admin_member(uuid) TO service_role;
