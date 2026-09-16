-- Server-side MFA enforcement (auth hardening, workstream 1).
--
-- Until now the aal claim was only ever read client-side (src/lib/mfa.ts):
-- the login challenge was React state, and a session minted directly against
-- the API with password alone had the full authority of its owner even when
-- that owner had enrolled a TOTP factor. This migration makes the data layer
-- itself demand aal2:
--
--   1. public.mfa_satisfied() — true when the calling session either belongs
--      to a user with no verified MFA factor, or presents an aal2 token.
--   2. A RESTRICTIVE policy `mfa_enforced` on every RLS-enabled table in
--      every non-system schema (public, but also e.g. private — the
--      security_invoker views over private.profiles_private resolve RLS
--      against the base table), and on storage.objects, scoped
--      TO authenticated. Restrictive policies AND with the existing
--      permissive ones, so this denies an enrolled-but-unchallenged (aal1)
--      session everywhere at once without touching any existing policy.
--      anon is unaffected (no session, no factors) and service_role
--      bypasses RLS as before.
--   3. The core admin/management authz helpers — is_super_admin,
--      is_institution_admin, is_admin, can_manage_offering — additionally
--      require mfa_satisfied() when they are authorizing the calling session
--      itself. This matters beyond defense in depth: SECURITY DEFINER RPCs
--      (delete_study_guide, update_question_content, ...) bypass (2) exactly
--      like the service-role client does, and these helpers are the gate
--      those RPCs authorize through (same cascade trick as the is_suspended
--      check in 20260323000000).
--
-- Tables created by FUTURE migrations do NOT inherit the policy. The RLS
-- suite (supabase/tests/rls/__tests__/mfa-aal2-enforcement.test.ts) asserts
-- coverage and names any RLS-enabled table missing `mfa_enforced`; when it
-- fails, add to the new table's migration:
--
--   CREATE POLICY mfa_enforced ON public.<table> AS RESTRICTIVE
--     FOR ALL TO authenticated
--     USING (public.mfa_satisfied())
--     WITH CHECK (public.mfa_satisfied());
--
-- The call is deliberately NOT wrapped in (SELECT ...): a SubLink inside a
-- policy qual re-enters the row-security expansion machinery, and combined
-- with the existing policies that inline-query other RLS tables (e.g.
-- user_institutions ⇄ institutions) it trips "infinite recursion detected
-- in policy". A direct call to the SECURITY DEFINER function does not.

CREATE OR REPLACE FUNCTION public.mfa_satisfied()
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  -- aal2 always passes; otherwise pass only when no verified factor exists.
  -- A missing/undecodable aal claim therefore fails CLOSED for enrolled
  -- users and open for everyone else (matching what enrollment promises).
  SELECT coalesce((SELECT auth.jwt() ->> 'aal') = 'aal2', false)
      OR NOT EXISTS (
        SELECT 1
        FROM auth.mfa_factors
        WHERE user_id = (SELECT auth.uid())
          AND status = 'verified'
      )
$$;

-- Blanket restrictive policy on every RLS-enabled table.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT n.nspname AS schemaname, c.relname AS tablename
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relrowsecurity
      AND c.relkind IN ('r', 'p')
      AND (
        (n.nspname NOT IN ('auth', 'storage', 'realtime', 'supabase_functions',
                           'net', 'cron', 'vault', 'pgsodium', 'graphql',
                           'graphql_public', 'extensions', 'supabase_migrations',
                           'information_schema')
         AND n.nspname NOT LIKE 'pg\_%')
        OR (n.nspname = 'storage' AND c.relname = 'objects')
      )
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS mfa_enforced ON %I.%I',
                   t.schemaname, t.tablename);
    EXECUTE format(
      'CREATE POLICY mfa_enforced ON %I.%I AS RESTRICTIVE FOR ALL TO authenticated'
      || ' USING (public.mfa_satisfied())'
      || ' WITH CHECK (public.mfa_satisfied())',
      t.schemaname, t.tablename
    );
  END LOOP;
END $$;

-- Role helpers: refuse admin authority to an enrolled-but-unchallenged
-- session. The `auth.uid() IS DISTINCT FROM _user_id` arm keeps the gate off
-- the paths where these functions are asked about SOMEONE ELSE — notably
-- service-role RPC calls from edge handlers checking a caller or target
-- (auth.uid() is NULL there, and those handlers enforce aal themselves via
-- _shared/require-aal2.ts). In every RLS policy these are called with
-- auth.uid() as _user_id, so the gate is always live where it matters.
-- Bodies otherwise unchanged from 20251206101851 / 20260323000000.

CREATE OR REPLACE FUNCTION public.is_super_admin(_user_id uuid)
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
  AND (auth.uid() IS DISTINCT FROM _user_id OR public.mfa_satisfied())
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
  AND (auth.uid() IS DISTINCT FROM _user_id OR public.mfa_satisfied())
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
  AND (auth.uid() IS DISTINCT FROM _user_id OR public.mfa_satisfied())
$$;

-- can_manage_offering always authorizes auth.uid() itself, so the gate is
-- unconditional. Service-role and anon sessions have no uid and no factors,
-- so mfa_satisfied() is true for them and nothing changes on those paths.
CREATE OR REPLACE FUNCTION public.can_manage_offering(_offering_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM offerings o
    JOIN classes c ON o.class_id = c.id
    WHERE o.id = _offering_id
    AND (
      is_super_admin(auth.uid())
      OR is_institution_admin(auth.uid(), c.institution_id)
      OR (
        is_course_instructor(o.course_id, auth.uid())
        AND instructor_can_access_section(o.course_id, o.class_id, auth.uid())
      )
    )
  )
  AND public.mfa_satisfied()
$$;
