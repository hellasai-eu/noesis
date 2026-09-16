import { execFileSync } from 'node:child_process';

/**
 * Direct-to-Postgres SQL runner for DB-level tests that reach objects the
 * supabase-js/PostgREST client can't touch — postgres-owned system schemas
 * (`vault.*`, `cron.*`, `net._http_response`) and RLS-with-no-policy tables
 * (`public.run_jobs_tick`).
 *
 * Connects as the local `postgres` superuser via the `psql` binary, so no new
 * npm dependency is needed. Used by the pg_cron job-driver / health suite
 * (issue #869); the rest of the RLS harness talks to the API through
 * supabase-js and does not need this.
 *
 * Connection: `SUPABASE_DB_URL`, defaulting to the standard local Supabase
 * DSN. Deliberately does NOT fall back to the generic `DATABASE_URL` — that
 * var may point at a developer's or CI job's non-local database, and this
 * helper runs destructive setup/teardown SQL that must never touch anything
 * but the local test instance.
 *
 * Even `SUPABASE_DB_URL` itself is guarded below: if it's set to a non-local
 * host, we refuse to run rather than risk deleting `vault.secrets` /
 * `cron.*` rows on a shared staging database. Set `ALLOW_REMOTE_DB_TESTS=1`
 * to explicitly opt in (e.g. a disposable ephemeral DB in CI).
 */
export const DB_URL =
  process.env.SUPABASE_DB_URL ??
  'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

const LOCAL_DB_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function assertLocalDbTarget(url: string): void {
  if (process.env.ALLOW_REMOTE_DB_TESTS === '1') return;

  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(
      `sql.ts: SUPABASE_DB_URL is not a valid URL, refusing to run destructive test SQL against it.\n` +
        `Set ALLOW_REMOTE_DB_TESTS=1 to override.`
    );
  }

  if (!LOCAL_DB_HOSTS.has(host)) {
    throw new Error(
      `sql.ts: refusing to run destructive test SQL against non-local host "${host}".\n` +
        `This suite deletes vault.secrets / cron.* rows and must only ever target the local Supabase instance.\n` +
        `Set ALLOW_REMOTE_DB_TESTS=1 to explicitly opt in.`
    );
  }
}

assertLocalDbTarget(DB_URL);

function psql(sql: string, opts: { redact?: boolean } = {}): string {
  try {
    return execFileSync(
      'psql',
      [DB_URL, '-v', 'ON_ERROR_STOP=1', '-tAX', '-c', sql],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    if (opts.redact) {
      throw new Error('psql failed: [redacted — sql carries a secret value]');
    }
    throw new Error(`psql failed: ${e.stderr?.trim() || e.message}\n  SQL: ${sql}`);
  }
}

/**
 * Escape a value for embedding in a single-quoted SQL string literal.
 * Needed anywhere a value (not a literal we wrote ourselves) is interpolated
 * into a `psql -c` statement, since there's no parameterized-query path here.
 */
export function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Run a statement (or batch) for its side effects.
 * Pass `{ redact: true }` when the SQL embeds a secret value, so a failure
 * doesn't echo the secret into the thrown error / test logs.
 */
export function execSql(sql: string, opts: { redact?: boolean } = {}): void {
  psql(sql, opts);
}

/** Return the single value of a one-row / one-column query as trimmed text. */
export function queryScalar(sql: string): string {
  return psql(sql).trim();
}

/** JSON shape returned by `public.get_jobs_cron_health()`. */
export interface CronHealthSnapshot {
  secrets_seeded: boolean;
  last_tick_at: string | null;
  last_tick_status: string | null;
  last_tick_http_status: number | null;
  last_success_at: string | null;
  minutes_since_success: number | null;
  is_healthy: boolean;
  now: string;
}

/** Call the health RPC directly in-DB and return the parsed snapshot. */
export function getCronHealth(): CronHealthSnapshot {
  return JSON.parse(queryScalar('SELECT public.get_jobs_cron_health();'));
}
