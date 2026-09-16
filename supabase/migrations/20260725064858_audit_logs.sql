-- Durable audit logging for sensitive admin actions (issue #934).
--
-- Admin actions on personal data (user create/delete, password resets, bulk
-- invites, single invites, data exports) were only logged to the console via
-- `_shared/logger.ts`. This adds a durable, queryable, tamper-resistant record
-- so administrative access to personal data is accountable (GDPR Art. 30/32).
--
-- Design notes:
--   * Writes are SERVICE-ROLE ONLY. There are deliberately NO client
--     INSERT/UPDATE/DELETE policies, mirroring `student_admin_notes_audit`
--     (20260603200000). Service-role bypasses RLS, so the shared helper
--     `_shared/audit.ts` can insert while no authenticated client can forge,
--     alter, or erase a row.
--   * `actor_user_id` / `target_user_id` are plain uuid columns with NO foreign
--     key to auth.users ON PURPOSE. The audit trail must survive user deletion:
--     the `delete-user` flow inserts its audit row *after* the auth user is
--     gone, so an FK would reject the insert, and ON DELETE SET NULL/CASCADE
--     would let an erasure silently destroy the very record that proves it
--     happened. The bare uuid is a non-identifying reference, not PII.
--   * `institution_id` keeps an FK (ON DELETE SET NULL) to match
--     `prompt_audit_log` precedent and to scope institution-admin reads.

CREATE TABLE public.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),

  -- Who performed the action (the acting admin). Non-identifying uuid plus the
  -- actor's own email for a human-readable accountability trail.
  actor_user_id uuid,
  actor_email text,

  -- What was done. Constrained to a documented set; extend the CHECK when new
  -- sensitive actions are wired in.
  action text NOT NULL CHECK (action IN (
    'user.create',
    'user.delete',
    'user.password_reset',
    'user.bulk_invite',
    'user.invite',
    'data.export',
    'data.preview'
  )),

  -- Who / what was acted upon. `target_user_id` is a bare, non-identifying uuid
  -- (see design notes). `target_entity_*` captures a generic (type, id) pair for
  -- non-user targets (e.g. an exported table name, an invitation).
  target_user_id uuid,
  target_entity_type text,
  target_entity_id text,

  institution_id uuid REFERENCES public.institutions(id) ON DELETE SET NULL,

  -- Free-form, NON-IDENTIFYING context. For deletion actions this MUST NOT
  -- contain the deleted user's name/email/PII — erasure must not be undone by
  -- the audit trail (issue #934). Enforced by convention in `_shared/audit.ts`
  -- callers, not by a DB constraint.
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- Indexes for the admin-scoped reads: institution admins page by institution +
-- recency; super-admins page globally by recency and by actor.
CREATE INDEX idx_audit_logs_institution_created
  ON public.audit_logs (institution_id, created_at DESC);
CREATE INDEX idx_audit_logs_created
  ON public.audit_logs (created_at DESC);
CREATE INDEX idx_audit_logs_actor_created
  ON public.audit_logs (actor_user_id, created_at DESC);
CREATE INDEX idx_audit_logs_target_user
  ON public.audit_logs (target_user_id);

ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

-- SELECT: super-admins read every row.
CREATE POLICY "Super admins can read all audit logs"
  ON public.audit_logs
  FOR SELECT
  USING (public.is_super_admin(auth.uid()));

-- SELECT: institution admins read only rows scoped to an institution they
-- administer. Rows with a NULL institution_id (e.g. global exports, or an
-- institution later deleted) are visible to super-admins only.
CREATE POLICY "Institution admins can read their institution audit logs"
  ON public.audit_logs
  FOR SELECT
  USING (
    institution_id IS NOT NULL
    AND public.is_institution_admin(auth.uid(), institution_id)
  );

-- NO INSERT / UPDATE / DELETE policies: all direct client DML is rejected.
-- Audit rows arrive solely via the service-role helper `_shared/audit.ts`.
