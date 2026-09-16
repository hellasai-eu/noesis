-- Give audit_logs a retention window: 24 months.
--
-- The admin audit trail (20260725064858, issue #934) had no retention window
-- at all — data-retention.md deferred the decision and governance/open-items.md
-- tracked it. 24 months is the decision: long enough to answer "who deleted
-- this account and when" across two school years, bounded enough that a log of
-- administrative actions on minors' data does not accumulate forever.
--
-- Two coupled changes, config before function so no intermediate state can
-- purge audit_logs at the 12-month global default (migrations run in one
-- transaction, but belt and braces):
--
--   1. system_config.data_retention gains {"audit_logs": 24}. Without the
--      override, adding the table to the purge list would delete at 12 months
--      — more than decided, which is the failure direction this machinery is
--      designed to never take.
--   2. purge_expired_operational_logs() gains ['audit_logs', 'created_at'].
--      Sourced from 20260902110000 (the latest definition), NOT from the
--      original 20260725120000 — rebuilding from an older copy would silently
--      drop failed_login_attempts and chat_state_history from the purge.
--
-- Deletes ride idx_audit_logs_created (created_at DESC), which the table has
-- had since creation. The purge runs as SECURITY DEFINER; audit_logs has no
-- client DELETE path, and that stays true.
--
-- Numbers must match docs/compliance/data-retention.md and the published
-- documents (Privacy Policy §7, Pack §7.7, DPA template) — updated in the
-- same commit.

-- ---------------------------------------------------------------------------
-- 1. Config: audit_logs → 24 months
-- ---------------------------------------------------------------------------

INSERT INTO public.system_config (key, value, description)
VALUES (
  'data_retention',
  '{"default_months": 12, "tables": {"agent_interaction_logs": 3, "audit_logs": 24}}'::jsonb,
  'Retention windows for operational logs, in months. "default_months" applies to every purged table; "tables" overrides individual ones. See docs/compliance/data-retention.md.'
)
ON CONFLICT (key) DO UPDATE
SET value = jsonb_set(
  -- Same defensive shape as 20260913120000: ensure the value and its "tables"
  -- member are objects before setting the key, preserving sibling overrides.
  jsonb_set(
    CASE WHEN jsonb_typeof(system_config.value) = 'object'
         THEN system_config.value
         ELSE '{"default_months": 12}'::jsonb
    END,
    '{tables}',
    CASE WHEN jsonb_typeof(system_config.value -> 'tables') = 'object'
         THEN system_config.value -> 'tables'
         ELSE '{}'::jsonb
    END,
    true
  ),
  '{tables,audit_logs}',
  '24'::jsonb,
  true
);

-- ---------------------------------------------------------------------------
-- 2. Purge function: add audit_logs to the allowlist
-- ---------------------------------------------------------------------------

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
    ['failed_login_attempts',     'attempted_at'],
    ['ai_usage_logs',             'created_at'],
    ['agent_interaction_logs',    'created_at'],
    ['ai_rate_limit_events',      'created_at'],
    ['socratic_state_history',    'created_at'],
    ['study_tutor_state_history', 'created_at'],
    ['chat_state_history',        'created_at'],
    ['audit_logs',                'created_at']
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
