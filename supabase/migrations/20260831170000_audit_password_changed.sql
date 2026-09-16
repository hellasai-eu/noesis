-- Audit self-service password changes.
--
-- `audit_logs` (20260725064858) already covers `user.password_reset` — an admin
-- setting someone else's password. The other way an account's password changes
-- is the holder changing it themselves, and that left no durable trace at all:
-- it goes straight from the browser to GoTrue, so neither the console logger
-- nor an edge function ever saw it. A password change is the event that hands
-- over an account, so both paths must be accountable, not just the one that
-- happens to pass through a function we wrote.
--
-- Adds `user.password_changed` to the documented action set. The CHECK is
-- replaced wholesale rather than relaxed, so the constraint keeps naming the
-- complete set — extend it here (and `AuditAction` in `_shared/audit.ts`) when
-- new sensitive actions are wired in.
--
-- The old constraint is found by its DEFINITION, not by a guessed name. It was
-- declared inline on the column, so its name is whatever Postgres generated;
-- a `DROP CONSTRAINT IF EXISTS <guess>` that guessed wrong would no-op
-- SILENTLY and leave two CHECKs in force — both must pass, so the stricter old
-- one would go on rejecting `user.password_changed` and the migration would
-- look applied while changing nothing.
--
-- The predicate is narrowed to CHECKs whose ONLY referenced column is `action`
-- (#1232 review). Matching on the definition text alone would also drop a
-- future multi-column invariant that merely mentions `user.password_reset` —
-- e.g. "deletion rows carry no actor_email" — and this migration restores only
-- the action allow-list, so that unrelated rule would vanish silently.

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
    'user.bulk_invite',
    'user.invite',
    'data.export',
    'data.preview'
  ));
