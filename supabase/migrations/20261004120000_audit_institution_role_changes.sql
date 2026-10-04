-- Audit institution role grants, changes, revocations and suspensions.
--
-- A member's role in an institution lives on `user_institutions`, and
-- `UserManagement.tsx` writes it straight from the browser: role changes,
-- removals and suspensions are plain PostgREST UPDATE/DELETEs authorised by
-- the "Institution admins can … memberships" policies. No edge function sees
-- them, so `recordAudit` never runs, and `audit_logs.action` had no value for
-- them. Promoting someone to institution admin — the role that unlocks every
-- pupil record in the school, administrative notes and tutor conversations
-- included — was the most privilege-relevant action an admin can take and the
-- one the audit trail was silent about.
--
-- The record is written by a trigger, not by a new edge function. Anyone with
-- an admin JWT can call PostgREST directly, so a function the SPA happens to
-- route through would audit the polite path and miss the other one. A trigger
-- on the table sees every write — browser, edge function (service role), SQL
-- console — which is also why grants made by the invitation and create-user
-- functions are recorded here as well as under their own actions.
--
-- Actions added:
--   user.role_change  INSERT (from_role NULL), UPDATE of role, DELETE
--                     (to_role NULL). A removal is a revocation of the role.
--   user.suspend      is_suspended false -> true
--   user.reactivate   is_suspended true  -> false
--
-- Actor is `auth.uid()` / the JWT's email claim: the admin for browser writes,
-- NULL for service-role and direct-SQL writes (`metadata.via` says which).
-- Metadata is non-identifying (roles only), so an erasure that cascades
-- through `user_institutions` leaves nothing in the trail it must undo.
--
-- The CHECK is replaced wholesale, found by definition, exactly as in
-- 20260914120000_audit_mfa_reset.sql — keep `AuditAction` in
-- `supabase/functions/_shared/audit.ts` in step.

DO $$
DECLARE
  action_attnum smallint;
  constraint_name text;
BEGIN
  SELECT attnum INTO STRICT action_attnum
  FROM pg_attribute
  WHERE attrelid = 'public.audit_logs'::regclass AND attname = 'action';

  FOR constraint_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.audit_logs'::regclass
      AND contype = 'c'
      AND conkey = ARRAY[action_attnum]
      AND pg_get_constraintdef(oid) LIKE '%user.password_reset%'
  LOOP
    EXECUTE format('ALTER TABLE public.audit_logs DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;

ALTER TABLE public.audit_logs
  ADD CONSTRAINT audit_logs_action_check CHECK (action IN (
    'user.create',
    'user.delete',
    'user.password_reset',
    'user.password_changed',
    'user.mfa_reset',
    'user.role_change',
    'user.suspend',
    'user.reactivate',
    'user.bulk_invite',
    'user.invite',
    'data.export',
    'data.preview'
  ));

-- SECURITY DEFINER: audit_logs has no client write policy, by design, so the
-- insert must run as the table owner. The function takes no arguments and is
-- reachable only as a trigger, so it cannot be used to forge a row.
CREATE OR REPLACE FUNCTION public.audit_user_institution_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _row public.user_institutions;
  _actor uuid := auth.uid();
  _actor_email text := auth.jwt() ->> 'email';
  _via text := coalesce(auth.role(), 'sql');
BEGIN
  _row := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;

  IF TG_OP = 'INSERT'
     OR TG_OP = 'DELETE'
     OR OLD.role IS DISTINCT FROM NEW.role THEN
    INSERT INTO public.audit_logs (
      action, actor_user_id, actor_email, target_user_id,
      target_entity_type, target_entity_id, institution_id, metadata
    ) VALUES (
      'user.role_change', _actor, _actor_email, _row.user_id,
      'user_institution', _row.id::text, _row.institution_id,
      jsonb_build_object(
        'from_role', CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.role END,
        'to_role',   CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.role END,
        'via', _via
      )
    );
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.is_suspended IS DISTINCT FROM NEW.is_suspended THEN
    INSERT INTO public.audit_logs (
      action, actor_user_id, actor_email, target_user_id,
      target_entity_type, target_entity_id, institution_id, metadata
    ) VALUES (
      CASE WHEN NEW.is_suspended THEN 'user.suspend' ELSE 'user.reactivate' END,
      _actor, _actor_email, NEW.user_id,
      'user_institution', NEW.id::text, NEW.institution_id,
      jsonb_build_object('role', NEW.role, 'via', _via)
    );
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.audit_user_institution_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS audit_user_institution_change ON public.user_institutions;
CREATE TRIGGER audit_user_institution_change
  AFTER INSERT OR DELETE OR UPDATE OF role, is_suspended
  ON public.user_institutions
  FOR EACH ROW
  EXECUTE FUNCTION public.audit_user_institution_change();
