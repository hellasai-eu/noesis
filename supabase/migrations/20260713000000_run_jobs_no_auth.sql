-- Make the pg_cron job driver keyless (companion to run-jobs dropping its
-- service-role bearer check).
--
-- Background: run-jobs is now unauthenticated — the shared-secret gate that
-- required the tick to present the service_role key is gone. That secret was
-- the whole source of the operational pain: it had to be seeded into Vault
-- and kept in sync with Supabase's service-role key, and the legacy→new
-- API-key migration kept breaking that sync (tick POSTs a stale/mismatched
-- key ⟶ 401 ⟶ silent stall).
--
-- Two changes here:
--   1. tick_run_jobs() no longer requires `service_role_key`. It needs only
--      `project_url` (a non-secret — just the POST target). The Authorization
--      header is sent only if a key happens to be in Vault (harmless; run-jobs
--      ignores it), so nothing breaks mid-rollout and no re-seed is needed.
--   2. get_jobs_cron_health()'s `secrets_seeded` / `is_healthy` no longer
--      depend on `service_role_key` — only `project_url` matters now. Without
--      this the banner would keep warning "not seeded" after an operator
--      (correctly) removes the now-unused service_role_key from Vault.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Keyless tick: require only project_url
-- ─────────────────────────────────────────────────────────────────────────

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

  -- Optional now — run-jobs no longer checks the bearer. Kept only so the
  -- POST still carries an Authorization header when one is present, avoiding
  -- any surprise from a gateway/proxy that expects one.
  SELECT decrypted_secret INTO v_key
    FROM vault.decrypted_secrets
    WHERE name = 'service_role_key'
    LIMIT 1;

  IF v_url IS NULL THEN
    RAISE WARNING
      'tick_run_jobs: vault secret project_url not set — skipping tick';
    RETURN NULL;
  END IF;

  SELECT net.http_post(
    url     := v_url || '/functions/v1/run-jobs',
    headers := CASE
      WHEN v_key IS NOT NULL THEN
        jsonb_build_object(
          'Authorization', 'Bearer ' || v_key,
          'Content-Type',  'application/json'
        )
      ELSE
        jsonb_build_object('Content-Type', 'application/json')
    END,
    body    := jsonb_build_object('trigger', 'pg_cron')
  )
  INTO v_request_id;

  IF v_request_id IS NOT NULL THEN
    INSERT INTO public.run_jobs_tick(request_id) VALUES (v_request_id)
      ON CONFLICT (request_id) DO NOTHING;
    DELETE FROM public.run_jobs_tick
      WHERE ticked_at < now() - interval '1 hour';
  END IF;

  RETURN v_request_id;
END;
$$;

REVOKE ALL   ON FUNCTION public.tick_run_jobs() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tick_run_jobs() TO postgres;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Health no longer depends on service_role_key
-- ─────────────────────────────────────────────────────────────────────────

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
  -- The tick now needs only project_url (run-jobs is keyless). `secrets_seeded`
  -- therefore tracks project_url alone — a missing/removed service_role_key is
  -- no longer a problem to surface.
  BEGIN
    SELECT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'project_url')
    INTO v_secrets_seeded;
  EXCEPTION WHEN OTHERS THEN
    v_secrets_seeded := false;
  END;

  -- Liveness of the cron scheduler. cron.job_run_details has no `jobname`
  -- column — resolve the jobid from cron.job first, then key off jobid.
  BEGIN
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

  -- Honest signal: most recent tick whose POST to run-jobs returned 2xx.
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

  -- Healthy = project_url present AND run-jobs returned 2xx within 5 min.
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
  'Snapshot of run-jobs-tick health. run-jobs is keyless, so secrets_seeded/is_healthy depend only on project_url + a real 2xx from run-jobs (via net._http_response). Resolves the cron jobid from cron.job (cron.job_run_details has no jobname column). All catalog/pg_net reads are guarded so the probe never raises.';
