-- Restore API-role table grants on freshly provisioned databases.
--
-- Fresh Supabase preview branches now come up with the same default-ACL gap
-- that scripts/local-db-grants.sh documents for local CLI images: tables
-- created by the migration runner grant anon / authenticated / service_role
-- only TRUNCATE / REFERENCES / TRIGGER / MAINTAIN — no INSERT / SELECT /
-- UPDATE / DELETE. Every PostgREST read then fails with 42501 before RLS is
-- ever consulted, which renders every page of the app blank on a preview
-- branch. Verified directly on PR #1379's branches (two independent ones,
-- one created from scratch): classes, courses, user_institutions — tables
-- that PR never touched — all returned "permission denied". This is the
-- likely root cause of the recurring "E2E failures on main — possible
-- infrastructure issue" reports (#1365, #1352, #1345, #1344, #1324, #1292).
--
-- local-db-grants.sh assumed "Hosted Supabase is unaffected — production and
-- the PR preview branches get these grants from Supabase's own project
-- provisioning". That stopped being true for branch provisioning, so the
-- grants move into a migration: idempotent, and a no-op on databases (like
-- production) where the grants already exist.
--
-- Privileges, not policies: this matches what hosted provisioning grants.
-- RLS still decides every row, and the anon-exposure RLS suite keeps
-- asserting that anon reads no rows from any table.
--
-- Deliberately narrower than local-db-grants.sh: no blanket GRANT EXECUTE
-- ON ALL FUNCTIONS. Functions are executable by PUBLIC by default in
-- Postgres, and several are deliberately REVOKEd down to service_role /
-- postgres (user_reference_map, user_data_footprint, list_exportable_tables)
-- — a blanket grant here would silently undo that hardening.

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- Existing objects
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;

-- Tables created by migrations that run after this one (fresh replays apply
-- the whole history in order, so later migrations' tables need the default
-- ACL fixed too). Applies to objects created by the role running migrations,
-- which is the same role executing this statement.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
