-- Fix get_jobs_cron_health() throwing 42703 "column \"jobname\" does not exist".
--
-- Both the original health function (#780) and its #813 successor queried
-- `cron.job_run_details WHERE jobname = 'run-jobs-tick'`. But pg_cron's
-- run-history table has NO `jobname` column — the name lives in `cron.job`,
-- and `cron.job_run_details` rows key off `jobid`. So every call to the RPC
-- 400'd. That silently broke the two things that were supposed to surface a
-- dead driver:
--   * JobsCronHealthBanner swallows the RPC error and hides — so the
--     "driver not seeded" banner NEVER appeared, even while tick_run_jobs()
--     was no-opping.
--   * run-jobs' readCronHealth() fails open to healthy on RPC error — so the
--     fallback self-chain never engaged either.
--
-- Fixes:
--   1. Resolve the jobid from `cron.job` by name, then filter
--      `cron.job_run_details` by `jobid`.
--   2. Wrap every system-catalog / pg_net read in its own exception block so
--      the probe ALWAYS returns a JSON snapshot. A health function that
--      raises is worse than one that reports degraded: on any internal read
--      failure we fall back to nulls ⟶ is_healthy = false, which correctly
--      shows the banner and arms the fallback rather than 400ing.
--
-- Shape of the returned JSON is unchanged (same keys as #813), so the banner
-- and run-jobs' CronHealth reader keep working untouched.

CREATE OR REPLACE FUNCTION public.get_jobs_cron_health()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, cron, net, extensions
AS $$
DECLARE
  v_secrets_seeded         boolean := false;
  v_jobid                  bigint;
  v_last_tick_at           timestamptz;
  v_last_tick_status       text;
  v_last_tick_http_status  int;
  v_last_success_at        timestamptz;
  v_minutes_since_success  numeric;
  v_is_healthy             boolean;
BEGIN
  -- Both vault secrets present? Without them tick_run_jobs() no-ops.
  BEGIN
    SELECT
      EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'project_url')
      AND
      EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'service_role_key')
    INTO v_secrets_seeded;
  EXCEPTION WHEN OTHERS THEN
    v_secrets_seeded := false;
  END;

  -- Liveness of the cron scheduler itself. `cron.job_run_details` has no
  -- `jobname` column — resolve the jobid from `cron.job` first, then key the
  -- run-history lookup off `jobid`. (This is the 42703 bug being fixed.)
  BEGIN
    -- ORDER BY jobid DESC: cron.job has no unique constraint on jobname, so if
    -- an operator accidentally registered the tick twice, pick the most
    -- recently registered one deterministically instead of an arbitrary row.
    SELECT jobid INTO v_jobid
      FROM cron.job
      WHERE jobname = 'run-jobs-tick'
      ORDER BY jobid DESC
      LIMIT 1;

    IF v_jobid IS NOT NULL THEN
      SELECT start_time, status
        INTO v_last_tick_at, v_last_tick_status
        FROM cron.job_run_details
        WHERE jobid = v_jobid
        ORDER BY start_time DESC
        LIMIT 1;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_last_tick_at := NULL;
    v_last_tick_status := NULL;
  END;

  -- The honest signal: most recent tick whose POST to run-jobs actually
  -- returned 2xx, correlated via the pg_net request id we recorded. A stale
  -- key (401) or a run-jobs error (500) never sets this. Also grab the HTTP
  -- status of the latest delivered response so the UI can distinguish "cron
  -- not firing" from "cron fires but run-jobs rejects it".
  -- Two independent reads, each in its own exception block: a failure of the
  -- second (latest HTTP status) must not null out a v_last_success_at the first
  -- already populated — that would spuriously flip is_healthy to false.
  BEGIN
    SELECT max(t.ticked_at)
      INTO v_last_success_at
      FROM public.run_jobs_tick t
      JOIN net._http_response r ON r.id = t.request_id
      WHERE r.status_code BETWEEN 200 AND 299;
  EXCEPTION WHEN OTHERS THEN
    v_last_success_at := NULL;
  END;

  BEGIN
    SELECT r.status_code
      INTO v_last_tick_http_status
      FROM public.run_jobs_tick t
      JOIN net._http_response r ON r.id = t.request_id
      ORDER BY t.ticked_at DESC
      LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    v_last_tick_http_status := NULL;
  END;

  IF v_last_success_at IS NOT NULL THEN
    v_minutes_since_success := EXTRACT(EPOCH FROM (now() - v_last_success_at)) / 60.0;
  END IF;

  -- Healthy = secrets seeded AND run-jobs returned 2xx within the last 5 min.
  v_is_healthy := v_secrets_seeded
                  AND v_last_success_at IS NOT NULL
                  AND v_minutes_since_success <= 5;

  RETURN jsonb_build_object(
    'secrets_seeded',         v_secrets_seeded,
    'last_tick_at',           v_last_tick_at,
    'last_tick_status',       v_last_tick_status,
    'last_tick_http_status',  v_last_tick_http_status,
    'last_success_at',        v_last_success_at,
    'minutes_since_success',  v_minutes_since_success,
    'is_healthy',             v_is_healthy,
    'now',                    now()
  );
END;
$$;

REVOKE ALL    ON FUNCTION public.get_jobs_cron_health() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_jobs_cron_health() TO authenticated, service_role;

COMMENT ON FUNCTION public.get_jobs_cron_health() IS
  'Snapshot of run-jobs-tick health. Resolves the cron jobid from cron.job (cron.job_run_details has no jobname column). last_success_at/is_healthy derive from the real HTTP status of the tick POST via net._http_response. All catalog/pg_net reads are guarded so the probe never raises — it degrades to is_healthy=false instead of 400ing.';
