#!/usr/bin/env bash
# Grant the PostgREST API roles (anon / authenticated / service_role) the table
# privileges they need on `public`, for a LOCAL Supabase database.
#
# Why this exists
# ---------------
# Recent supabase CLI / postgres images create the local database without DML
# default privileges for the API roles: the default ACL for tables created by
# `postgres` in `public` grants them only `Dxtm` (TRUNCATE / REFERENCES /
# TRIGGER / MAINTAIN), not `arwd` (INSERT / SELECT / UPDATE / DELETE). Every
# request through PostgREST then fails with
#
#   42501  permission denied for table institutions
#
# before RLS is ever consulted, so `npm run test:rls` dies in the first
# `beforeAll` of every suite.
#
# This was originally a local-stack-only gap ("hosted Supabase is unaffected"),
# but as of 2026-09 freshly provisioned PREVIEW BRANCHES come up with the same
# missing ACLs (verified on PR #1379: classes/courses/user_institutions all
# 42501 on two independent branches). Migration
# 20260912130000_api_role_grants_for_fresh_environments.sql now carries the
# table/sequence grants for every replayed environment; this script remains for
# databases created BEFORE that migration runs (`supabase start` pulls up the
# stack before any migration).
#
# Like the migration, this script grants NO function EXECUTE: functions are
# executable by PUBLIC by default, and CI runs this script after migrations
# replay, so a blanket GRANT EXECUTE would undo the per-function REVOKEs on
# privileged SECURITY DEFINER RPCs (record_quiz_answers, persist_chat_turn,
# user_reference_map, ...). The RLS suites now assert those REVOKEs hold.
#
# Privileges, not policies: this grants table access to the API roles exactly as
# a hosted Supabase project does. RLS still decides every row. Running it does
# not weaken what the RLS suite is testing.
#
# Usage:
#   ./scripts/local-db-grants.sh              # local default DSN
#   SUPABASE_DB_URL=... ./scripts/local-db-grants.sh
#
# Idempotent — safe to re-run, and it must be re-run against every freshly
# created database (`supabase start`, `supabase db reset`).

set -euo pipefail

DB_URL="${SUPABASE_DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"

# Same guard as supabase/tests/rls/helpers/sql.ts: refuse to touch anything that
# is not obviously a local database. Granting on a shared or hosted instance is
# not this script's job.
host=$(printf '%s' "$DB_URL" | sed -E 's#^[^/]*//([^@]*@)?([^:/?]+).*#\2#')
case "$host" in
  127.0.0.1 | localhost | ::1 | '[::1]') ;;
  *)
    echo "::error::refusing to grant on non-local host \"$host\" ($DB_URL)" >&2
    echo "This script is for local Supabase stacks only." >&2
    exit 1
    ;;
esac

if ! command -v psql >/dev/null 2>&1; then
  echo "::error::psql not found on PATH." >&2
  echo "  macOS:  brew install libpq  (keg-only — add \$(brew --prefix libpq)/bin to PATH)" >&2
  echo "  Debian: apt-get install postgresql-client" >&2
  exit 1
fi

psql "$DB_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- Existing objects. No function grants: EXECUTE defaults to PUBLIC, and a
-- blanket grant would re-expose the SECURITY DEFINER RPCs whose client
-- execution the migrations deliberately REVOKE (this script runs after them).
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;

-- Objects created later (e.g. by a migration applied after this ran)
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
SQL

echo "Granted public schema access to anon, authenticated, service_role on $host."
