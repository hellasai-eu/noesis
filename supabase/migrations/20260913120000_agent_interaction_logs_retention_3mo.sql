-- Install the shorter retention window for agent_interaction_logs: 3 months.
--
-- The purge machinery (20260725120000_data_retention_purge.sql) shipped with
-- `{"default_months": 12, "tables": {}}` — no overrides — so the full tutor
-- interaction traces, which hold the pupil's own words, were kept 12 months
-- like every other operational log. governance/dpia.md §6 recommends a
-- shorter window for exactly this table; governance/open-items.md tracked the
-- fact that nobody had set one. This installs it, at 3 months.
--
-- 3 months is enough for its only use: agent_interaction_logs is a diagnostic
-- log written solely by _shared/chat-turn.ts when system_config's
-- `agent_verbose_logging` is enabled (it is off by default and fails closed),
-- and read only by the super-admin log viewer and the user-data export
-- (export-data/user-export.ts, which returns whatever rows exist at export
-- time and is unaffected by the window). No pedagogical surface depends on it.
--
-- The existing backlog drains via the nightly `data-retention-purge` job at
-- 50,000 rows per run — no one-off delete here.
--
-- Numbers must match docs/compliance/data-retention.md and the published
-- Privacy Policy §7 (el + en) / Pack §7.7 — updated in the same commit.

INSERT INTO public.system_config (key, value, description)
VALUES (
  'data_retention',
  '{"default_months": 12, "tables": {"agent_interaction_logs": 3}}'::jsonb,
  'Retention windows for operational logs, in months. "default_months" applies to every purged table; "tables" overrides individual ones. See docs/compliance/data-retention.md.'
)
ON CONFLICT (key) DO UPDATE
SET value = jsonb_set(
  -- Ensure a "tables" object exists before setting the key inside it:
  -- jsonb_set does not create missing intermediate paths, and a malformed
  -- (non-object) "tables" would make the outer jsonb_set a silent no-op.
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
  '{tables,agent_interaction_logs}',
  '3'::jsonb,
  true
);
