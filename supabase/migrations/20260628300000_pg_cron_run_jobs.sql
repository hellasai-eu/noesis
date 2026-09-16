-- Drive the run-jobs worker with pg_cron (issue #762, epic #761).
--
-- Replaces the in-process self-reschedule chain that previously lived in
-- `supabase/functions/_shared/job-runner.ts` (`selfReschedule`). A 1-minute
-- pg_cron tick POSTs the `run-jobs` edge function with the service-role
-- bearer; a single lost invocation can no longer leave jobs stalled — the
-- next tick (≤60s later) resumes them via `claimNextJob`'s existing
-- processing-row resume path. With a 150s slice budget and a 60s cadence,
-- up to ~3 workers may run concurrently; atomic claim on `job_items` keeps
-- their work distinct.
--
-- Auth: the cron job reads the project URL and service-role key from
-- Supabase Vault and signs the call with `Authorization: Bearer <key>` —
-- the same gate `run-jobs/handler.ts` already enforces. The secrets are
-- NEVER committed in this migration; an operator must seed them once per
-- environment after this migration is applied:
--
--   SELECT vault.create_secret('https://<proj>.supabase.co', 'project_url');
--   SELECT vault.create_secret('<service-role-key>',          'service_role_key');
--
-- `tick_run_jobs` logs a WARNING and no-ops when either secret is missing,
-- so this migration is safe to apply before secrets are seeded.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Tick helper. SECURITY DEFINER so the cron worker (running as `postgres`)
-- can read the vault without owning a grant on `vault.decrypted_secrets`.
-- A `RETURN NULL` on missing-secrets keeps the cron row green and lets an
-- operator seed the vault later without re-running the migration.
CREATE OR REPLACE FUNCTION public.tick_run_jobs()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, extensions, net
AS $$
DECLARE
  v_url         text;
  v_key         text;
  v_request_id  bigint;
BEGIN
  SELECT decrypted_secret INTO v_url
    FROM vault.decrypted_secrets
    WHERE name = 'project_url'
    LIMIT 1;

  SELECT decrypted_secret INTO v_key
    FROM vault.decrypted_secrets
    WHERE name = 'service_role_key'
    LIMIT 1;

  IF v_url IS NULL OR v_key IS NULL THEN
    RAISE WARNING
      'tick_run_jobs: vault secret(s) project_url/service_role_key not set — skipping tick';
    RETURN NULL;
  END IF;

  SELECT net.http_post(
    url     := v_url || '/functions/v1/run-jobs',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_key,
      'Content-Type',  'application/json'
    ),
    body    := jsonb_build_object('trigger', 'pg_cron')
  )
  INTO v_request_id;

  RETURN v_request_id;
END;
$$;

REVOKE ALL ON FUNCTION public.tick_run_jobs() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.tick_run_jobs() TO postgres;

-- Idempotent (re-)schedule: re-running the migration after editing the SQL
-- above must not duplicate the cron row.
DO $$
DECLARE
  v_jobid bigint;
BEGIN
  SELECT jobid INTO v_jobid
    FROM cron.job
    WHERE jobname = 'run-jobs-tick';
  IF v_jobid IS NOT NULL THEN
    PERFORM cron.unschedule(v_jobid);
  END IF;
  PERFORM cron.schedule(
    'run-jobs-tick',
    '* * * * *',
    $cron$SELECT public.tick_run_jobs();$cron$
  );
END $$;
