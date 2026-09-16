-- Scheduled data-retention purges for operational logs (issue #935, epic #931).
--
-- No personal-data table had a retention limit: login_history (IP + user
-- agent), ai_usage_logs, agent_interaction_logs (full student chat traces),
-- ai_rate_limit_events and the two tutor state-history tables grew forever.
-- This migration makes the published retention policy enforceable by code.
--
-- WHAT IS *NOT* PURGED: pedagogical records — grades, evaluations, quiz
-- answers, and the user-visible chat tables (open_question_chats,
-- study_session_messages). Those are the school's learning record; the school
-- is the controller for them and their retention is handled contractually via
-- the DPA, not auto-deleted here.
--
-- Scheduling follows `20260628300000_pg_cron_run_jobs.sql`: an idempotent
-- unschedule/reschedule block so re-running this migration cannot duplicate
-- the cron row.

CREATE EXTENSION IF NOT EXISTS pg_cron;

-- ---------------------------------------------------------------------------
-- Run ledger
-- ---------------------------------------------------------------------------

-- Evidence that the retention policy actually runs. A school's DPO asking
-- "prove you delete this data" is answered from here. Holds table names,
-- counts and cutoffs only — no personal data — so it is not itself purged.
-- One row per table per run is ~2k rows/year, which needs no retention limit.
CREATE TABLE IF NOT EXISTS public.retention_purge_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_name    text        NOT NULL,
  cutoff        timestamptz NOT NULL,
  retention_months integer  NOT NULL,
  rows_deleted  integer     NOT NULL,
  -- TRUE when expired rows still remain after this run — the batch cap cut it
  -- short, or the purge failed. Measured by re-checking the table, not
  -- inferred from `rows_deleted = cap`: a table holding exactly `cap` expired
  -- rows is fully drained, and reporting a backlog there would have the
  -- compliance ledger crying wolf.
  backlog_remaining boolean NOT NULL DEFAULT false,
  -- SQLSTATE + message when this table's purge failed; NULL on success. A
  -- failed table must be distinguishable from one that simply had nothing to
  -- delete, or the ledger would report a clean run for a control that is not
  -- running.
  error         text,
  ran_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_retention_purge_runs_ran_at
  ON public.retention_purge_runs(ran_at DESC);

ALTER TABLE public.retention_purge_runs ENABLE ROW LEVEL SECURITY;

-- Super admins read the purge history; nobody writes from a client. Rows
-- arrive solely from the SECURITY DEFINER function below.
DROP POLICY IF EXISTS "Super admins can read retention purge runs"
  ON public.retention_purge_runs;
CREATE POLICY "Super admins can read retention purge runs"
  ON public.retention_purge_runs
  FOR SELECT
  USING (public.is_super_admin(auth.uid()));

-- ---------------------------------------------------------------------------
-- Configuration
-- ---------------------------------------------------------------------------

-- One global key with optional per-table overrides. Documented in
-- docs/compliance/data-retention.md — the numbers there and here must match.
--
--   {
--     "default_months": 12,
--     "tables": { "agent_interaction_logs": 6 }
--   }
--
-- NOTE: only the *window* is configurable. The set of purgeable tables is
-- hardcoded in purge_expired_operational_logs() below, so editing
-- system_config can never be escalated into "delete from an arbitrary table".
INSERT INTO public.system_config (key, value, description)
VALUES (
  'data_retention',
  '{"default_months": 12, "tables": {}}'::jsonb,
  'Retention windows for operational logs, in months. "default_months" applies to every purged table; "tables" overrides individual ones. See docs/compliance/data-retention.md.'
)
ON CONFLICT (key) DO NOTHING;

-- Resolve the retention window for one table, in months.
--
-- Falls back to 12 whenever the config is missing, malformed, or not a
-- positive integer. A misconfigured value must never widen the blast radius:
-- the failure mode is "keep data longer than intended", never "delete more".
CREATE OR REPLACE FUNCTION public.get_retention_months(_table_name text)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_config    jsonb;
  v_override  jsonb;
  v_raw       numeric;
BEGIN
  SELECT value INTO v_config
    FROM public.system_config
    WHERE key = 'data_retention'
    LIMIT 1;

  IF v_config IS NULL THEN
    RETURN 12;
  END IF;

  v_override := v_config -> 'tables' -> _table_name;

  -- An ABSENT override means "use the global default" — that is what
  -- default_months is for. A PRESENT but malformed override is different: the
  -- operator meant to say something about this table and got it wrong, so
  -- falling through to the global default could delete data they intended to
  -- keep (global 3 months, intended override 6, typed "six"). A malformed
  -- override therefore takes the safe 12-month fallback, never the global.
  --
  -- jsonb_typeof guards every cast: `::integer` on a JSON string or object
  -- raises, which would abort the caller's purge run.
  IF v_override IS NOT NULL THEN
    IF jsonb_typeof(v_override) <> 'number' THEN
      RETURN 12;
    END IF;
    v_raw := (v_override #>> '{}')::numeric;
  ELSIF jsonb_typeof(v_config -> 'default_months') = 'number' THEN
    v_raw := (v_config -> 'default_months' #>> '{}')::numeric;
  END IF;

  -- Read as numeric, then range-check BEFORE narrowing to integer. Casting a
  -- JSON number straight to integer would raise on anything beyond int4 —
  -- `{"default_months": 1e100}` would abort the caller's entire purge run,
  -- which is exactly the "bad config breaks the job" failure this function
  -- exists to prevent. 1200 months is a century; anything past that is a typo.
  IF v_raw IS NULL OR v_raw < 1 OR v_raw > 1200 THEN
    RETURN 12;
  END IF;

  RETURN floor(v_raw)::integer;
END;
$$;

REVOKE ALL ON FUNCTION public.get_retention_months(text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_retention_months(text) TO postgres;

-- ---------------------------------------------------------------------------
-- Purge
-- ---------------------------------------------------------------------------

-- Delete rows older than the configured window from every operational-log
-- table, and record what was removed.
--
-- `_batch_cap` bounds the work per table per run so a first run against years
-- of accumulated logs cannot hold locks or bloat WAL indefinitely; the next
-- daily tick picks up the remainder. Deletes go through the timestamp index
-- each table already has.
--
-- SECURITY DEFINER because the cron worker runs as `postgres` and the target
-- tables are RLS-protected. The (table, column) pairs are a hardcoded
-- allowlist, and each is interpolated via format('%I') — no caller-supplied
-- identifier ever reaches the DELETE.
CREATE OR REPLACE FUNCTION public.purge_expired_operational_logs(
  _batch_cap integer DEFAULT 50000
)
-- OUT names are deliberately distinct from the ledger's column names: in
-- plpgsql a RETURNS TABLE column is a variable, and reusing `table_name` /
-- `cutoff` would shadow the columns it is written to.
RETURNS TABLE (purged_table text, deleted_count integer, cutoff_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- (table, timestamp column). Extending retention to a new table means
  -- adding it here AND to docs/compliance/data-retention.md.
  v_targets  text[][] := ARRAY[
    ['login_history',             'login_at'],
    ['ai_usage_logs',             'created_at'],
    ['agent_interaction_logs',    'created_at'],
    ['ai_rate_limit_events',      'created_at'],
    ['socratic_state_history',    'created_at'],
    ['study_tutor_state_history', 'created_at']
  ];
  v_table    text;
  v_column   text;
  v_months   integer;
  v_cutoff   timestamptz;
  v_deleted  integer;
  v_cap      integer;
  v_error    text;
  v_backlog  boolean;
BEGIN
  -- A non-positive cap would delete nothing while logging a clean run, which
  -- reads as "retention is working" when it is not.
  v_cap := GREATEST(COALESCE(_batch_cap, 50000), 1);

  FOR i IN 1 .. array_length(v_targets, 1) LOOP
    v_table  := v_targets[i][1];
    v_column := v_targets[i][2];
    v_months := public.get_retention_months(v_table);
    v_cutoff := now() - make_interval(months => v_months);

    -- Each table is purged in its own subtransaction. Without this the whole
    -- function is one transaction, so a lock or statement timeout on a large
    -- table would roll back the tables already purged in this run — and a
    -- table that times out every night would block every other table forever.
    -- The failure is written to the ledger rather than swallowed, so a
    -- persistently failing table is visible instead of looking untouched.
    BEGIN
      EXECUTE format(
        'DELETE FROM public.%I
           WHERE ctid IN (
             SELECT ctid FROM public.%I WHERE %I < $1 LIMIT $2
           )',
        v_table, v_table, v_column
      )
      USING v_cutoff, v_cap;

      GET DIAGNOSTICS v_deleted = ROW_COUNT;

      -- Ask the table whether anything expired is left rather than inferring
      -- it from the row count. Index-supported and bounded by EXISTS.
      EXECUTE format(
        'SELECT EXISTS (SELECT 1 FROM public.%I WHERE %I < $1)',
        v_table, v_column
      )
      INTO v_backlog
      USING v_cutoff;

      v_error := NULL;
    EXCEPTION WHEN OTHERS THEN
      v_deleted := 0;
      -- Nothing was purged, so by definition the backlog stands.
      v_backlog := true;
      v_error   := SQLSTATE || ': ' || SQLERRM;
      RAISE WARNING 'retention purge failed for %: %', v_table, v_error;
    END;

    INSERT INTO public.retention_purge_runs
      (table_name, cutoff, retention_months, rows_deleted, backlog_remaining, error)
    VALUES
      (v_table, v_cutoff, v_months, v_deleted, v_backlog, v_error);

    purged_table  := v_table;
    deleted_count := v_deleted;
    cutoff_at     := v_cutoff;
    RETURN NEXT;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_expired_operational_logs(integer) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.purge_expired_operational_logs(integer) TO postgres;

-- ---------------------------------------------------------------------------
-- Schedule
-- ---------------------------------------------------------------------------

-- Daily at 03:17 UTC — off the hour so it does not contend with whatever else
-- fires on the hour, and outside Greek school hours.
DO $$
DECLARE
  v_jobid bigint;
BEGIN
  SELECT jobid INTO v_jobid
    FROM cron.job
    WHERE jobname = 'data-retention-purge';
  IF v_jobid IS NOT NULL THEN
    PERFORM cron.unschedule(v_jobid);
  END IF;
  PERFORM cron.schedule(
    'data-retention-purge',
    '17 3 * * *',
    $cron$SELECT public.purge_expired_operational_logs();$cron$
  );
END $$;
