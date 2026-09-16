-- Make run-jobs-tick health reflect the ACTUAL HTTP result of the POST to
-- run-jobs — not merely that `tick_run_jobs()` returned (issue: jobs stall
-- silently while the cron driver reports healthy).
--
-- Root cause: `net.http_post()` is fire-and-forget. It enqueues the request
-- and returns a request id immediately, so `cron.job_run_details.status`
-- flips to 'succeeded' the instant the POST is *queued* — even if run-jobs
-- later rejects it (401 on a stale/rotated service_role_key, 500 on an
-- error). `get_jobs_cron_health()` derived `last_success_at` from that cron
-- row, so it stayed green while zero work ran. That false-green did double
-- damage: it hid the operator banner (JobsCronHealthBanner) AND disabled
-- run-jobs' fallback chain (which only engages when is_healthy = false),
-- producing a completely silent stall.
--
-- Fix: record each tick's pg_net request id, then correlate to
-- `net._http_response.status_code` so "last successful tick" means the POST
-- to run-jobs genuinely returned 2xx. Also surface `last_tick_http_status`
-- so the UI can distinguish "cron isn't firing" from "cron fires but
-- run-jobs rejects it (bad key)".
--
-- Expected transient on deploy: the `run_jobs_tick` ledger starts empty, so
-- `last_success_at` is null and `is_healthy` reads false until the first
-- post-migration tick lands a 2xx response (~1 cron interval, i.e. up to a
-- minute). The banner may briefly show "hasn't ticked yet" on an otherwise
-- healthy system right after deploy — this self-clears on the next tick and
-- does NOT indicate an incident.
--
-- Dependency note: both health queries JOIN `net._http_response`, an internal
-- (underscore-prefixed) pg_net table, not a documented public API. Verified
-- against pg_net 0.14.0 (Supabase platform, 2026-07). If a future pg_net
-- release renames/restructures/access-gates it, the JOIN silently returns no
-- rows and `is_healthy` pins false — re-point these queries if that happens.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Per-tick request-id ledger
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.run_jobs_tick (
  request_id bigint      PRIMARY KEY,
  ticked_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.run_jobs_tick IS
  'One row per run-jobs-tick pg_cron POST, keyed by the pg_net request id, so get_jobs_cron_health() can look up the real HTTP status of each tick via net._http_response. Pruned to the last hour by tick_run_jobs().';

CREATE INDEX IF NOT EXISTS idx_run_jobs_tick_ticked_at
  ON public.run_jobs_tick(ticked_at DESC);

-- Written only by tick_run_jobs() and read only by get_jobs_cron_health(),
-- both SECURITY DEFINER (run as owner, bypass RLS). Enable RLS with NO
-- policies so there is no direct client access path.
ALTER TABLE public.run_jobs_tick ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.run_jobs_tick FROM PUBLIC;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Record the request id on each tick (+ prune)
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

  -- Remember this request id so the health snapshot can look up its real
  -- HTTP status once pg_net delivers the response asynchronously.
  IF v_request_id IS NOT NULL THEN
    INSERT INTO public.run_jobs_tick(request_id) VALUES (v_request_id)
      ON CONFLICT (request_id) DO NOTHING;
    -- Bound the ledger — health only ever looks at the last few minutes.
    DELETE FROM public.run_jobs_tick
      WHERE ticked_at < now() - interval '1 hour';
  END IF;

  RETURN v_request_id;
END;
$$;

REVOKE ALL   ON FUNCTION public.tick_run_jobs() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tick_run_jobs() TO postgres;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. Health snapshot keyed off the real run-jobs HTTP response
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_jobs_cron_health()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, cron, net, extensions
AS $$
DECLARE
  v_secrets_seeded         boolean;
  v_last_tick_at           timestamptz;
  v_last_tick_status       text;
  v_last_tick_http_status  int;
  v_last_success_at        timestamptz;
  v_minutes_since_success  numeric;
  v_is_healthy             boolean;
BEGIN
  -- Are both vault secrets present? Without them, `tick_run_jobs()` is a
  -- silent no-op (RAISE WARNING + RETURN NULL). Still the first thing to
  -- check — it pins the most common misconfiguration.
  SELECT
    EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'project_url')
    AND
    EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'service_role_key')
  INTO v_secrets_seeded;

  -- Most recent tick of any cron status — detects "cron itself stopped"
  -- (extension disabled, schedule removed). NOTE: this is 'succeeded' even
  -- when the POST later fails, which is exactly why it is NOT the health
  -- signal — only a liveness signal for the cron scheduler.
  SELECT start_time, status
    INTO v_last_tick_at, v_last_tick_status
    FROM cron.job_run_details
    WHERE jobname = 'run-jobs-tick'
    ORDER BY start_time DESC
    LIMIT 1;

  -- The honest signal: the most recent tick whose POST to run-jobs actually
  -- returned 2xx, correlated via the pg_net request id we recorded. A stale
  -- service_role_key (401) or a run-jobs error (500) never sets this, so a
  -- silently-failing driver now reads as unhealthy.
  SELECT max(t.ticked_at)
    INTO v_last_success_at
    FROM public.run_jobs_tick t
    JOIN net._http_response r ON r.id = t.request_id
    WHERE r.status_code BETWEEN 200 AND 299;

  -- HTTP status of the most recent tick that has a delivered response —
  -- lets the UI say "driver fires but run-jobs rejects it (check the key)"
  -- instead of a generic "stalled".
  SELECT r.status_code
    INTO v_last_tick_http_status
    FROM public.run_jobs_tick t
    JOIN net._http_response r ON r.id = t.request_id
    ORDER BY t.ticked_at DESC
    LIMIT 1;

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
  'Returns a snapshot of run-jobs-tick health. last_success_at/is_healthy are derived from the REAL HTTP status of the tick POST to run-jobs (via net._http_response), not merely that the cron row fired — so a stale service_role_key or a rejecting run-jobs reads as unhealthy instead of false-green. Depends on the internal net._http_response table (pg_net 0.14.0, verified 2026-07); if a future pg_net release changes that table, this JOIN silently pins is_healthy false and must be re-pointed.';
