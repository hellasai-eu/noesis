-- Operational hardening for the pg_cron job driver (issue #780, epic #761).
--
-- Two helpers that close the silent-no-op gap left by #762:
--
--  1. `public.upsert_vault_secret(name, secret)` — idempotent vault upsert that
--     the deploy script (`push_to_prod.sh` / `push_to_qa.sh`) calls right after
--     `supabase db push`. A fresh environment that ran the deploy is now
--     driven by default; no manual `vault.create_secret` step.
--
--  2. `public.get_jobs_cron_health()` — surfaces the state of the
--     `run-jobs-tick` cron job to the frontend so a silent no-op becomes
--     visible. Returns the minimal facts needed to decide "is the driver
--     alive?" — `secrets_seeded`, the timestamp of the last *successful*
--     tick, the elapsed minutes since, and a derived `is_healthy` flag.
--
-- Both functions are SECURITY DEFINER because the underlying schemas
-- (`vault.*`, `cron.job_run_details`) are postgres-owned. The vault upsert
-- is restricted to `service_role` (sensitive write); the health view is
-- exposed to `authenticated` callers (jobs UI is RLS-scoped and the payload
-- is non-sensitive).

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Idempotent vault upsert
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.upsert_vault_secret(
  p_name   text,
  p_secret text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, extensions
AS $$
DECLARE
  v_secret_id uuid;
BEGIN
  IF p_name IS NULL OR length(p_name) = 0 THEN
    RAISE EXCEPTION 'upsert_vault_secret: name must be non-empty';
  END IF;
  IF p_secret IS NULL OR length(p_secret) = 0 THEN
    RAISE EXCEPTION 'upsert_vault_secret: secret must be non-empty';
  END IF;

  SELECT id INTO v_secret_id
    FROM vault.secrets
    WHERE name = p_name
    LIMIT 1;

  IF v_secret_id IS NULL THEN
    BEGIN
      SELECT vault.create_secret(p_secret, p_name) INTO v_secret_id;
    EXCEPTION WHEN unique_violation THEN
      -- Concurrent caller won the race; fetch the id they created and update.
      SELECT id INTO v_secret_id
        FROM vault.secrets
        WHERE name = p_name
        LIMIT 1;
      PERFORM vault.update_secret(v_secret_id, p_secret, p_name);
    END;
  ELSE
    PERFORM vault.update_secret(v_secret_id, p_secret, p_name);
  END IF;

  RETURN v_secret_id;
END;
$$;

REVOKE ALL    ON FUNCTION public.upsert_vault_secret(text, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.upsert_vault_secret(text, text) TO service_role;

COMMENT ON FUNCTION public.upsert_vault_secret(text, text) IS
  'Idempotent vault.secrets upsert. Called by deploy scripts to seed project_url + service_role_key for the run-jobs-tick cron driver (#762). Restricted to service_role.';

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Cron-health snapshot for the jobs UI
-- ─────────────────────────────────────────────────────────────────────────

-- A "healthy" cron tick must have *succeeded* within this many minutes.
-- The tick fires every minute, so 5 minutes of silence is the threshold
-- at which we tell the user "something's wrong" — short enough to catch
-- a missing-secrets no-op promptly, long enough to ride out a single
-- missed tick or a brief transient.
CREATE OR REPLACE FUNCTION public.get_jobs_cron_health()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, cron, extensions
AS $$
DECLARE
  v_secrets_seeded         boolean;
  v_last_tick_at           timestamptz;
  v_last_tick_status       text;
  v_last_success_at        timestamptz;
  v_minutes_since_success  numeric;
  v_is_healthy             boolean;
BEGIN
  -- Are both vault secrets present? Without them, `tick_run_jobs()` is a
  -- silent no-op (RAISE WARNING + RETURN NULL) even though cron itself
  -- reports `succeeded`. This is the *primary* health signal — it pins
  -- the exact misconfiguration this function exists to surface.
  SELECT
    EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'project_url')
    AND
    EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'service_role_key')
  INTO v_secrets_seeded;

  -- Most recent tick of any status — used to detect "cron itself stopped
  -- running" (extension disabled, schedule removed, etc.).
  SELECT start_time, status
    INTO v_last_tick_at, v_last_tick_status
    FROM cron.job_run_details
    WHERE jobname = 'run-jobs-tick'
    ORDER BY start_time DESC
    LIMIT 1;

  -- Most recent *successful* tick — when secrets are missing, the tick
  -- still reports `succeeded` (it logs WARNING + returns NULL), so this
  -- alone isn't enough to declare health. But a long gap here means cron
  -- is fully dead.
  SELECT start_time
    INTO v_last_success_at
    FROM cron.job_run_details
    WHERE jobname = 'run-jobs-tick'
      AND status = 'succeeded'
    ORDER BY start_time DESC
    LIMIT 1;

  IF v_last_success_at IS NOT NULL THEN
    v_minutes_since_success := EXTRACT(EPOCH FROM (now() - v_last_success_at)) / 60.0;
  END IF;

  -- Healthy = secrets are seeded AND cron succeeded within the last 5 min.
  v_is_healthy := v_secrets_seeded
                  AND v_last_success_at IS NOT NULL
                  AND v_minutes_since_success <= 5;

  RETURN jsonb_build_object(
    'secrets_seeded',         v_secrets_seeded,
    'last_tick_at',           v_last_tick_at,
    'last_tick_status',       v_last_tick_status,
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
  'Returns a snapshot of run-jobs-tick health (secrets seeded, last success, derived is_healthy) for the jobs UI. Issue #780.';
