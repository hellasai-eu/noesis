-- Grant the PostgREST API roles their standard table privileges, durably.
--
-- NOTE: main independently landed the same fix as
-- 20260912130000_api_role_grants_for_fresh_environments.sql (#1380) while
-- this PR was in review. This file stays because this PR's preview branch
-- already recorded it in migration history (deleting an applied migration
-- breaks the branch's history check); every statement is idempotent, so
-- replaying both is a harmless no-op.
--
-- Supabase project provisioning normally grants anon / authenticated /
-- service_role DML on `public` and sets matching default privileges. Recent
-- postgres images stopped doing so for locally-created databases (see
-- scripts/local-db-grants.sh), and as of 2026-09-12 the same regression
-- reached PR preview branches: branches provisioned after ~08:00 UTC reject
-- every API request with `42501 permission denied for table ...` before RLS
-- is consulted, which fails the whole E2E smoke suite (first seen on this
-- date's CI runs; branches provisioned earlier the same morning were fine).
--
-- Making the grants a migration fixes every environment that replays
-- migrations — preview branches, `supabase db reset`, fresh local stacks —
-- and is a no-op on production, where provisioning already granted all of
-- this. Privileges, not policies: RLS still decides every row, so nothing
-- the RLS suite tests is weakened.

-- Deliberately NO function grants: Postgres already grants EXECUTE on
-- functions to PUBLIC by default (the regression broke table ACLs only), and
-- a blanket GRANT EXECUTE here would re-expose the privileged SECURITY
-- DEFINER RPCs that earlier migrations explicitly REVOKE from client roles
-- (persist_chat_turn, record_quiz_answers, submit_study_guide_piece_answers,
-- …) because this migration replays after them.

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- Existing objects
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;

-- Objects created by later migrations
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
