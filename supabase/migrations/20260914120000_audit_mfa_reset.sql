-- Audit admin removals of a user's MFA factors.
--
-- `admin-reset-user-mfa` is the recovery path for a member who lost their
-- authenticator: an institution admin (or super-admin) strips the account's
-- factors so the holder can sign in with their password again. Removing the
-- second factor weakens the account — it is the first move of a takeover as
-- much as of a rescue — so the action must leave a durable trace alongside
-- `user.password_reset`.
--
-- Adds `user.mfa_reset` to the documented action set. As in
-- 20260831170000_audit_password_changed.sql, the CHECK is replaced wholesale
-- so the constraint keeps naming the complete set, and the old constraint is
-- found by its DEFINITION (single-column CHECK on `action`), not by a guessed
-- name — a wrong-name DROP IF EXISTS would no-op silently and leave the old,
-- stricter CHECK rejecting the new value.

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
    'user.bulk_invite',
    'user.invite',
    'data.export',
    'data.preview'
  ));
