-- Stale-processing job recovery: lease/heartbeat + per-item max-attempts
-- (issue #763, epic #761; builds on the cron driver from #762).
--
-- A worker that dies mid-slice currently leaves its job stuck in
-- `processing` forever. This migration adds a lease so the next pg_cron
-- tick (#762) can detect "lease expired ⇒ worker died ⇒ reclaim", without
-- stealing the row from a live worker that's still heartbeating. It also
-- caps per-item attempts so a poisoned item can't loop forever across
-- successive reclaims.
--
-- Design choices:
--   * `locked_until` is `NOT NULL DEFAULT '1970-01-01T00:00:00Z'` so
--     pre-existing rows are already "expired" the moment this migration
--     applies — the runner's first tick treats them as reclaimable, which
--     is exactly the desired post-deploy recovery story. No backfill.
--   * Default expires at the Unix epoch (not `-infinity`) because the
--     supabase JS client serializes timestamps as ISO 8601 strings, and a
--     finite ISO timestamp is easier to assert on in unit tests and read in
--     logs than `-infinity::timestamptz`.
--   * `last_heartbeat` is informational (operator visibility, future
--     dashboards in #764). The reclaim predicate keys off `locked_until`
--     alone — one column, one race guard.
--   * Indexes are partial on `status='processing'` because that's the only
--     bucket the reclaim query scans. Pending rows are picked up via the
--     existing `(status, created_at)` index.

ALTER TABLE public.jobs
  ADD COLUMN locked_until   timestamptz NOT NULL DEFAULT '1970-01-01T00:00:00Z'::timestamptz,
  ADD COLUMN last_heartbeat timestamptz NULL;

ALTER TABLE public.job_items
  ADD COLUMN locked_until   timestamptz NOT NULL DEFAULT '1970-01-01T00:00:00Z'::timestamptz,
  ADD COLUMN last_heartbeat timestamptz NULL,
  ADD COLUMN max_attempts   int         NOT NULL DEFAULT 3;

COMMENT ON COLUMN public.jobs.locked_until IS
  'Lease expiry. A processing row whose locked_until is in the past is reclaimable by the next runner tick.';
COMMENT ON COLUMN public.jobs.last_heartbeat IS
  'Most recent timestamp the runner refreshed the lease. Informational.';
COMMENT ON COLUMN public.job_items.locked_until IS
  'Lease expiry. A processing item whose locked_until is in the past is reclaimable by the next runner tick.';
COMMENT ON COLUMN public.job_items.last_heartbeat IS
  'Most recent timestamp the runner refreshed the lease. Informational.';
COMMENT ON COLUMN public.job_items.max_attempts IS
  'Per-item retry cap. When attempts + 1 would exceed this, the item is marked failed instead of re-claimed.';

-- Reclaim hot path: "stalled processing rows in lease order". Partial on
-- status='processing' keeps the index small — completed/failed/cancelled
-- rows never participate in reclaim.
CREATE INDEX idx_jobs_processing_lease
  ON public.jobs(locked_until)
  WHERE status = 'processing';

CREATE INDEX idx_job_items_job_processing_lease
  ON public.job_items(job_id, locked_until)
  WHERE status = 'processing';
