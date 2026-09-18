-- Per-role MFA policy, replacing the hard-coded super-admin/admin mandate.
--
-- Migration 20260914180000 encoded one operator's decision in SQL: MFA
-- required for super-admins immediately, for institution admins from a date
-- held in `security_policies.admin_mfa_deadline`. Every other role was
-- unreachable by policy — an operator who wanted MFA for instructors had to
-- patch the codebase.
--
-- This makes the *set of roles* data too. The deployment overlay declares it
-- (`deployment/settings.json`), `npm run settings:sql` turns the declaration
-- into an UPDATE of the row below, and the deployment repository applies it.
--
--   1. security_policies.mfa_policy — jsonb, role -> enforcement start.
--      A key's presence enforces that role; its value is the ISO instant
--      enforcement begins, or null for immediately.
--
--        {"super_admin": null, "admin": "2026-11-01T00:00:00Z"}
--
--   2. public.mfa_role_state(_user_id) -> 'required' | 'recommended' | 'none'
--      The one place the policy is interpreted. Most-strict-wins across a
--      user's roles: someone who is an instructor here and an admin there is
--      judged by whichever membership is furthest along.
--
--   3. public.mfa_satisfied() gains the role test. It backs the blanket
--      restrictive RLS policy on every table (20260914150000), so this is
--      what turns the policy into enforcement for instructors, evaluators and
--      students — roles with no privileged-helper function to gate. An
--      unenrolled user in a 'required' role reads nothing at all.
--
--   4. is_super_admin / is_institution_admin / is_admin keep their outright-
--      aal2 requirement, now driven by mfa_role_state rather than by a
--      hard-coded role list plus a single deadline.
--
--   5. mfa_enrollment_status() answers for every role, not just the two.
--
--   6. public.mfa_policy_effective() — super-admins only. Lets the app show
--      the live policy next to the declared one, because a declaration that
--      never reached the database is the failure mode this design trades for
--      its single source of truth.
--
-- Backwards compatible by construction: the seeded mfa_policy reproduces the
-- previous behaviour exactly, and admin_mfa_deadline is migrated into it
-- rather than assumed, so a deployment that already moved its deadline keeps
-- the date it chose. admin_mfa_mandate_active() is kept as a thin shim over
-- the new policy — dropping it would break the RLS suite and any operator
-- SQL that calls it.
--
-- Fail-closed, deliberately: a missing or unparseable mfa_policy falls back
-- to {"super_admin": null, "admin": null} — privileged roles enforced
-- immediately. It does NOT fall back to enforcing every role, because
-- bricking every pupil's account is not the safe reading of a typo.

-- ── 1. The policy row ───────────────────────────────────────────────────────

-- Carry the operator's existing deadline across rather than restating the
-- default: a deployment that already pushed its admin deadline out keeps it.
INSERT INTO public.security_policies (key, value)
SELECT
  'mfa_policy',
  jsonb_build_object(
    'super_admin', 'null'::jsonb,
    'admin', coalesce(
      (SELECT value FROM public.security_policies WHERE key = 'admin_mfa_deadline'),
      to_jsonb('2026-11-01T00:00:00Z'::text)
    )
  )
ON CONFLICT (key) DO NOTHING;

-- The old single-purpose knob is now inert: nothing reads it, and a row that
-- looks like policy but changes nothing is a trap for the next operator who
-- edits it and wonders why access did not change. Its value has just been
-- migrated into mfa_policy above, so dropping it loses nothing.
DELETE FROM public.security_policies WHERE key = 'admin_mfa_deadline';

COMMENT ON TABLE public.security_policies IS
  'Operator-editable auth policy. Service-role only. `mfa_policy` is role -> '
  'enforcement start (null = immediately); generate it with `npm run settings:sql`.';

-- ── 2. Interpreting the policy ──────────────────────────────────────────────

-- The effective policy, with the fail-closed fallback applied. plpgsql so a
-- malformed value degrades to the fallback instead of erroring inside every
-- RLS check on every table.
CREATE OR REPLACE FUNCTION public.mfa_policy()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  policy jsonb;
BEGIN
  BEGIN
    SELECT value INTO policy
      FROM public.security_policies
     WHERE key = 'mfa_policy';
  EXCEPTION WHEN OTHERS THEN
    policy := NULL;
  END;

  -- An object is the only usable shape. A deleted row, a JSON array, a
  -- string: all mean somebody broke the policy, and the safe reading of that
  -- is "privileged roles are enforced", not "nobody is" and not "everybody
  -- is".
  IF policy IS NULL OR jsonb_typeof(policy) <> 'object' THEN
    RETURN '{"super_admin": null, "admin": null}'::jsonb;
  END IF;

  RETURN policy;
END
$$;

-- Has enforcement started for this role? Absent from the policy -> never.
-- Present with null -> always. Present with an unparseable date -> now,
-- matching the fail-closed reading above.
CREATE OR REPLACE FUNCTION public.mfa_role_enforced_now(_role text)
RETURNS boolean
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  policy jsonb := public.mfa_policy();
  starts timestamptz;
BEGIN
  IF NOT (policy ? _role) THEN
    RETURN false;
  END IF;

  IF jsonb_typeof(policy -> _role) = 'null' THEN
    RETURN true;
  END IF;

  BEGIN
    starts := (policy ->> _role)::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    RETURN true;
  END;

  RETURN now() >= starts;
END
$$;

-- Is this role in the policy at all, whether or not its date has arrived?
CREATE OR REPLACE FUNCTION public.mfa_role_in_policy(_role text)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public.mfa_policy() ? _role
$$;

-- The roles a user actually holds: their institution memberships, plus the
-- synthetic 'super_admin' for platform staff. Suspended memberships confer
-- nothing, so they are not enforced on either.
CREATE OR REPLACE FUNCTION public.mfa_user_roles(_user_id uuid)
RETURNS SETOF text
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT 'super_admin'::text
   WHERE public.super_admin_member(_user_id)
  UNION
  SELECT ui.role
    FROM public.user_institutions ui
   WHERE ui.user_id = _user_id
     AND NOT ui.is_suspended
$$;

-- Where this user stands: 'required' (enrol now or lose access),
-- 'recommended' (enforced for them, but not yet), or 'none'.
--
-- Most-strict-wins across their roles, and 'required' beats 'recommended' —
-- a user who is an admin in one institution and an instructor in another must
-- not be told "recommended" while an is_admin check already refuses them.
CREATE OR REPLACE FUNCTION public.mfa_role_state(_user_id uuid)
RETURNS text
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM public.mfa_user_roles(_user_id) r
       WHERE public.mfa_role_enforced_now(r)
    ) THEN 'required'
    WHEN EXISTS (
      SELECT 1 FROM public.mfa_user_roles(_user_id) r
       WHERE public.mfa_role_in_policy(r)
    ) THEN 'recommended'
    ELSE 'none'
  END
$$;

-- The earliest enforcement date among the user's roles that are in the policy
-- but not yet enforced — the date the nudge should name. Null when there is
-- nothing to count down to.
--
-- Compared as timestamptz rather than as text: ISO strings only sort
-- chronologically while they all carry the same offset, and an operator is
-- free to write "+02:00". Unparseable dates are skipped here because
-- mfa_role_enforced_now has already read them as "enforce now", so they are
-- not something to count down to either.
CREATE OR REPLACE FUNCTION public.mfa_user_deadline(_user_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  policy jsonb := public.mfa_policy();
  r text;
  parsed timestamptz;
  earliest timestamptz;
BEGIN
  FOR r IN SELECT * FROM public.mfa_user_roles(_user_id) LOOP
    CONTINUE WHEN NOT (policy ? r);
    CONTINUE WHEN jsonb_typeof(policy -> r) = 'null';

    BEGIN
      parsed := (policy ->> r)::timestamptz;
    EXCEPTION WHEN OTHERS THEN
      CONTINUE;
    END;

    CONTINUE WHEN now() >= parsed;  -- already enforced; not a countdown
    IF earliest IS NULL OR parsed < earliest THEN
      earliest := parsed;
    END IF;
  END LOOP;

  IF earliest IS NULL THEN
    RETURN NULL;
  END IF;

  -- The shape the frontend already parses, and the shape an operator wrote.
  RETURN to_char(earliest AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
END
$$;

-- Kept as a shim: callers (the RLS suite, operator SQL) asked "is the admin
-- mandate live?" and that question still has an answer.
CREATE OR REPLACE FUNCTION public.admin_mfa_mandate_active()
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public.mfa_role_enforced_now('admin')
$$;

-- ── 3. Enforcement: the blanket restrictive policy's predicate ──────────────

-- Every RLS-enabled table carries a restrictive policy calling this
-- (20260914150000). Previously: aal2, or no verified factor. Now the
-- no-factor escape is withdrawn from anyone the policy requires — which is
-- what gives instructors, evaluators and students real enforcement, since
-- none of them has a privileged-helper function to gate.
--
-- Note the ordering: aal2 short-circuits, so an enrolled-and-challenged
-- session never pays for the policy lookup.
CREATE OR REPLACE FUNCTION public.mfa_satisfied()
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce((SELECT auth.jwt() ->> 'aal') = 'aal2', false)
      OR (
        NOT EXISTS (
          SELECT 1
          FROM auth.mfa_factors
          WHERE user_id = (SELECT auth.uid())
            AND status = 'verified'
        )
        -- An unenrolled user passes only while the policy does not require
        -- them to enrol. A missing/undecodable aal claim therefore still
        -- fails closed for enrolled users, as before.
        AND public.mfa_role_state((SELECT auth.uid())) <> 'required'
      )
$$;

-- ── 4. Privileged-role helpers, now policy-driven ──────────────────────────

-- Unchanged in spirit: super-admin authority needs an aal2 session outright
-- whenever the policy requires MFA of a super-admin. An operator who removes
-- super_admin from the policy gets the pre-mandate behaviour back, which is
-- their call to make and is now expressible.
CREATE OR REPLACE FUNCTION public.is_super_admin(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.super_admin_member(_user_id)
  AND (
    auth.uid() IS DISTINCT FROM _user_id
    OR (
      public.mfa_satisfied()
      AND (NOT public.mfa_role_enforced_now('super_admin')
           OR (auth.jwt() ->> 'aal') = 'aal2')
    )
  )
$$;

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
      -- A super_admins member is judged on the super-admin timeline even for
      -- an ordinary admin membership: no password-only side door into
      -- institution authority (the seam 20260914180000 closed).
      AND (NOT (public.mfa_role_enforced_now('admin')
                OR (public.super_admin_member(_user_id)
                    AND public.mfa_role_enforced_now('super_admin')))
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
      AND (NOT (public.mfa_role_enforced_now('admin')
                OR (public.super_admin_member(_user_id)
                    AND public.mfa_role_enforced_now('super_admin')))
           OR (auth.jwt() ->> 'aal') = 'aal2')
    )
  )
$$;

-- ── 5. What the frontend asks ───────────────────────────────────────────────

-- Reveals nothing about anyone but the caller. `required` hard-gates,
-- `recommended` nudges, and the two stay mutually exclusive.
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
      public.mfa_role_state((SELECT auth.uid())) AS state
  )
  SELECT jsonb_build_object(
    'required',    NOT enrolled AND state = 'required',
    'recommended', NOT enrolled AND state = 'recommended',
    'deadline',    public.mfa_user_deadline((SELECT auth.uid()))
  )
  FROM me
$$;

-- The live policy, for the operator's drift panel. Super-admins only: it is
-- not a secret worth much, but "which roles are gated" is reconnaissance, and
-- no ordinary user has a reason to read it.
CREATE OR REPLACE FUNCTION public.mfa_policy_effective()
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE
    WHEN public.is_super_admin((SELECT auth.uid())) THEN public.mfa_policy()
    ELSE NULL
  END
$$;

-- ── 6. Execute-privilege hygiene ────────────────────────────────────────────
--
-- Postgres grants EXECUTE to PUBLIC on new functions, which would let
-- anonymous clients call these SECURITY DEFINER helpers. The ones taking a
-- _user_id would also let any signed-in user probe other people's roles, so
-- those are service-role only; the argument-free ones that speak about the
-- caller are open to authenticated.

REVOKE EXECUTE ON FUNCTION public.mfa_policy() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mfa_policy() TO service_role;

REVOKE EXECUTE ON FUNCTION public.mfa_role_enforced_now(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mfa_role_enforced_now(text) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.mfa_role_in_policy(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mfa_role_in_policy(text) TO authenticated, service_role;

-- Would let any signed-in user enumerate another account's roles.
REVOKE EXECUTE ON FUNCTION public.mfa_user_roles(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mfa_user_roles(uuid) TO service_role;

-- Called from mfa_satisfied(), which RLS evaluates as the querying role, so
-- authenticated needs EXECUTE. It answers only 'required'/'recommended'/
-- 'none' and the caller must already know the uuid they are asking about.
REVOKE EXECUTE ON FUNCTION public.mfa_role_state(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mfa_role_state(uuid) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.mfa_user_deadline(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mfa_user_deadline(uuid) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.mfa_policy_effective() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mfa_policy_effective() TO authenticated, service_role;
