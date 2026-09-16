-- Generic background jobs + notifications schema (issue #694, epic #693).
--
-- Foundation for a polymorphic background-work model. Bulk question generation
-- (#697) is just the first `jobs.type`. The runner (#695) and any handler are
-- separate issues; this migration is pure schema.
--
-- Design choices:
--   * Workers run with the service role and bypass RLS, so these tables have
--     NO INSERT/UPDATE/DELETE policies for end users. SELECT-only for jobs and
--     job_items; SELECT + UPDATE-own for notifications (so a user can mark
--     their own as read).
--   * `institution_id` lives on `jobs` directly to enforce institutional
--     isolation at the row level without joining through `courses` (which is
--     nullable for cross-course / institution-wide jobs in the future).
--   * `(status, created_at)` is indexed so the runner's "claim next runnable"
--     query is index-driven, not a sequential scan.
--   * Realtime publication is enabled for all three so #699's progress UI and
--     notification bell can subscribe via `postgres_changes`. RLS still
--     applies to realtime subscribers.

-- ──────────────────────────────────────────────────────────────────────────
-- 1. jobs — one row per background job
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE public.jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type            text NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','completed','partially_completed','failed','cancelled')),
  params          jsonb NOT NULL DEFAULT '{}'::jsonb,
  progress        jsonb NOT NULL DEFAULT '{}'::jsonb,
  result          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by      uuid NULL     REFERENCES auth.users(id) ON DELETE SET NULL,
  institution_id  uuid NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
  course_id       uuid NULL     REFERENCES public.courses(id) ON DELETE CASCADE,
  error           text NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz NULL,
  ended_at        timestamptz NULL
);

-- Runner: claim "next runnable" without scanning history.
CREATE INDEX idx_jobs_status_created_at ON public.jobs(status, created_at);
-- Per-type queues (e.g. ask only for 'bulk_question_generation' rows).
CREATE INDEX idx_jobs_type_status ON public.jobs(type, status);
-- RLS / list-view supporting lookups.
CREATE INDEX idx_jobs_created_by ON public.jobs(created_by);
CREATE INDEX idx_jobs_course ON public.jobs(course_id);
CREATE INDEX idx_jobs_institution ON public.jobs(institution_id);

ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;

-- Visible to the creator, to course managers of the scoped course, to
-- institution admins of the scoping institution, and to super-admins.
-- No write policies: writes go through service-role workers (#695).
CREATE POLICY "Job visibility for creator and course managers"
  ON public.jobs FOR SELECT
  USING (
    (created_by IS NOT NULL AND created_by = auth.uid())
    OR public.is_super_admin(auth.uid())
    OR public.is_institution_admin(auth.uid(), institution_id)
    OR (course_id IS NOT NULL AND public.is_course_instructor(course_id, auth.uid()))
  );

-- ──────────────────────────────────────────────────────────────────────────
-- 2. job_items — divisible, independently-resumable units of a job
-- ──────────────────────────────────────────────────────────────────────────
-- A job is non-transactional: one item failing must not abort the rest, and
-- the runner must be able to resume after the edge-function timeout. Each
-- item carries its own status, payload, result, error, and attempt count.
CREATE TABLE public.job_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  item_key    text NOT NULL,
  item_type   text NULL,
  status      text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','completed','failed','cancelled')),
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  result      jsonb NOT NULL DEFAULT '{}'::jsonb,
  error       text NULL,
  attempts    int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT job_items_job_item_key_unique UNIQUE (job_id, item_key)
);

-- "Next runnable item in this job" — the dispatcher's hottest query.
CREATE INDEX idx_job_items_job_status ON public.job_items(job_id, status);
-- Cross-job dispatch ("find any pending item, oldest first").
CREATE INDEX idx_job_items_status_created_at ON public.job_items(status, created_at);

CREATE TRIGGER update_job_items_updated_at
  BEFORE UPDATE ON public.job_items
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.job_items ENABLE ROW LEVEL SECURITY;

-- Visibility is derived from the parent job: anyone who can see the job can
-- see its items. Mirrors the jobs policy via EXISTS join.
CREATE POLICY "Job item visibility derives from parent job"
  ON public.job_items FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.jobs j
      WHERE j.id = job_items.job_id
        AND (
          (j.created_by IS NOT NULL AND j.created_by = auth.uid())
          OR public.is_super_admin(auth.uid())
          OR public.is_institution_admin(auth.uid(), j.institution_id)
          OR (j.course_id IS NOT NULL AND public.is_course_instructor(j.course_id, auth.uid()))
        )
    )
  );

-- ──────────────────────────────────────────────────────────────────────────
-- 3. notifications — generic per-user in-app notifications
-- ──────────────────────────────────────────────────────────────────────────
-- `job_id` is nullable so the table can host notifications unrelated to jobs
-- in the future (mentions, invites, etc.). ON DELETE SET NULL keeps the
-- notification history when a job is purged.
CREATE TABLE public.notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  job_id      uuid NULL     REFERENCES public.jobs(id) ON DELETE SET NULL,
  type        text NOT NULL,
  title       text NOT NULL,
  body        text NULL,
  read_at     timestamptz NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Inbox listing (newest first).
CREATE INDEX idx_notifications_user_created_at
  ON public.notifications(user_id, created_at DESC);
-- Unread badge count — partial index keeps it tiny.
CREATE INDEX idx_notifications_user_unread
  ON public.notifications(user_id)
  WHERE read_at IS NULL;

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

-- Owner reads their own.
CREATE POLICY "Users can read their own notifications"
  ON public.notifications FOR SELECT
  USING (user_id = auth.uid());

-- Owner can mark their own as read (or unread). WITH CHECK pins user_id so
-- the row can never be re-owned. Column-level grants below further restrict
-- the authenticated role to updating only `read_at`, preventing users from
-- mutating title, body, type, job_id, or created_at.
CREATE POLICY "Users can update their own notifications"
  ON public.notifications FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Revoke the broad UPDATE grant and re-grant only the `read_at` column so
-- the DB enforces the column restriction independently of the RLS policy.
REVOKE UPDATE ON TABLE public.notifications FROM authenticated;
GRANT UPDATE (read_at) ON TABLE public.notifications TO authenticated;

-- No INSERT/DELETE policies: the service-role worker (#695) is the sole
-- inserter; deletion (if ever needed) goes through an admin path.

-- ──────────────────────────────────────────────────────────────────────────
-- 4. Realtime publication — #699 subscribes via postgres_changes
-- ──────────────────────────────────────────────────────────────────────────
ALTER PUBLICATION supabase_realtime ADD TABLE public.jobs;
ALTER PUBLICATION supabase_realtime ADD TABLE public.job_items;
ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;
