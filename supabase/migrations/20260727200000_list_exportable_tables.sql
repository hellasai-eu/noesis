-- Source of truth for "every table in the database", for the super-admin
-- whole-database export (issue #947, finding 2).
--
-- `EXPORTABLE_TABLES` in supabase/functions/export-data/handler.ts was a
-- hand-maintained array presented in the UI as a full dump. It had drifted to
-- 42 entries against 94 real tables, two of which (`student_competency_mastery`,
-- `competency_mastery_history`) no longer existed and reported -1 row counts.
-- Any hand-maintained list of tables drifts the moment someone adds a table
-- without knowing this one exists, so the list is now derived at call time.
--
-- Not SECURITY DEFINER: `pg_class` / `pg_namespace` are world-readable, so the
-- caller's own privileges suffice and there is no reason to take on definer
-- rights. EXECUTE is still narrowed to `service_role` — only the export edge
-- function, which already gates on `is_super_admin()`, has any use for it.
--
-- `relkind IN ('r', 'p')` is ordinary tables plus partitioned parents; views
-- (`question_vote_stats`), materialised views and foreign tables are not
-- dumpable row stores and stay out. `NOT relispartition` drops the individual
-- partitions, so a partitioned table is exported once through its parent —
-- which reads as the whole logical table — rather than once per partition.
-- Nothing in `public` is partitioned today; the predicate is written this way
-- so that the first table that is does not silently vanish from the export.

CREATE OR REPLACE FUNCTION public.list_exportable_tables()
RETURNS SETOF text
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT c.relname::text
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p')
    AND NOT c.relispartition
  ORDER BY 1;
$$;

REVOKE ALL ON FUNCTION public.list_exportable_tables() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_exportable_tables() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_exportable_tables() TO service_role;

COMMENT ON FUNCTION public.list_exportable_tables() IS
  'Every base table in the public schema, for the super-admin whole-database '
  'export (export-data edge function). Derived from the catalogue so the export '
  'cannot silently omit a newly added table. service_role only.';
