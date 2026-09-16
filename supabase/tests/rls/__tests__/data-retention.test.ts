// DB-level tests for the operational-log retention purge (issue #935, epic #931).
//
// Objects under test (migration 20260725120000_data_retention_purge.sql):
//   * public.get_retention_months(text)           — window resolution + fallbacks
//   * public.purge_expired_operational_logs(int)  — the purge itself
//   * public.retention_purge_runs                 — the evidence ledger
//   * the `data-retention-purge` cron row
//
// These reach SECURITY DEFINER functions and RLS-protected log tables that
// supabase-js cannot seed, so the suite drives raw SQL as the local `postgres`
// superuser via helpers/sql.ts, matching jobs-cron-driver.test.ts.
//
// The stakes here are asymmetric: a purge that deletes too little is a policy
// gap, but a purge that deletes too much is unrecoverable. The tests below
// lean on proving that rows INSIDE the window survive.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { execSql, queryScalar } from '../helpers/sql';
import { getAdminClient } from '../helpers/auth';

/** Marker used to find and remove only rows this suite created. */
const FIXTURE_IP = '203.0.113.199';
const FIXTURE_FN = '__retention_fixture__';
const FIXTURE_AUDIT_EMAIL = '__retention_fixture__@test.local';

/**
 * login_history.user_id gained `fk_login_history_user_id_auth_users`
 * (ON DELETE CASCADE) with the account-erasure work (#932), so the fixture
 * needs a real auth user rather than a bare gen_random_uuid().
 */
const FIXTURE_EMAIL = `retention-fixture-${crypto.randomUUID().slice(0, 8)}@test.local`;
let fixtureUserId: string;

/**
 * Restore the INSTALLED value so one test's config cannot leak into another —
 * and so the suite cannot leak either: this must match what the migrations
 * install (20260913120000 + 20260913140000), or running the suite would strip
 * the real overrides from the database it runs against.
 */
function resetConfig(): void {
  execSql(
    `UPDATE public.system_config
        SET value = '{"default_months": 12, "tables": {"agent_interaction_logs": 3, "audit_logs": 24}}'::jsonb
      WHERE key = 'data_retention';`
  );
}

function setConfig(json: string): void {
  execSql(
    `UPDATE public.system_config
        SET value = '${json}'::jsonb
      WHERE key = 'data_retention';`
  );
}

/** Seed a login_history row `monthsAgo` in the past. */
function seedLogin(monthsAgo: number): void {
  execSql(
    `INSERT INTO public.login_history (user_id, ip_address, login_at)
       VALUES ('${fixtureUserId}', '${FIXTURE_IP}',
               now() - make_interval(months => ${monthsAgo}));`
  );
}

/** Seed an ai_usage_logs row `monthsAgo` in the past. */
function seedUsage(monthsAgo: number): void {
  execSql(
    `INSERT INTO public.ai_usage_logs (function_name, model, status, created_at)
       VALUES ('${FIXTURE_FN}', 'test-model', 'success',
               now() - make_interval(months => ${monthsAgo}));`
  );
}

function countLogins(): number {
  return Number(
    queryScalar(
      `SELECT count(*) FROM public.login_history WHERE ip_address = '${FIXTURE_IP}';`
    )
  );
}

function countUsage(): number {
  return Number(
    queryScalar(
      `SELECT count(*) FROM public.ai_usage_logs WHERE function_name = '${FIXTURE_FN}';`
    )
  );
}

/** The `backlog_remaining` flag from this run's ledger row, as 't' / 'f'. */
function backlogFlag(table: string): string {
  return queryScalar(
    `SELECT backlog_remaining FROM public.retention_purge_runs
      WHERE table_name = '${table}' AND ran_at > now() - interval '1 minute'
      ORDER BY ran_at DESC LIMIT 1;`
  );
}

function purge(batchCap?: number): void {
  execSql(
    batchCap === undefined
      ? `SELECT * FROM public.purge_expired_operational_logs();`
      : `SELECT * FROM public.purge_expired_operational_logs(${batchCap});`
  );
}

function clearFixtures(): void {
  execSql(`DELETE FROM public.login_history WHERE ip_address = '${FIXTURE_IP}';`);
  execSql(`DELETE FROM public.ai_usage_logs WHERE function_name = '${FIXTURE_FN}';`);
  execSql(`DELETE FROM public.audit_logs WHERE actor_email = '${FIXTURE_AUDIT_EMAIL}';`);
  execSql(`DELETE FROM public.retention_purge_runs WHERE ran_at > now() - interval '1 hour';`);
}

beforeAll(async () => {
  const { data, error } = await getAdminClient().auth.admin.createUser({
    email: FIXTURE_EMAIL,
    password: 'testpass123',
    email_confirm: true,
  });
  if (error) throw new Error(`data-retention fixture user: ${error.message}`);
  fixtureUserId = data.user.id;
});

beforeEach(() => {
  clearFixtures();
  resetConfig();
});

afterAll(async () => {
  clearFixtures();
  resetConfig();
  if (fixtureUserId) {
    // Cascades away any login_history row the purge left behind.
    await getAdminClient().auth.admin.deleteUser(fixtureUserId);
  }
});

describe('get_retention_months', () => {
  it('returns the global default when no override is set', () => {
    expect(queryScalar(`SELECT public.get_retention_months('login_history');`)).toBe('12');
  });

  it('prefers a per-table override over the default', () => {
    setConfig('{"default_months": 12, "tables": {"agent_interaction_logs": 6}}');
    expect(queryScalar(`SELECT public.get_retention_months('agent_interaction_logs');`)).toBe('6');
    // Other tables keep the default.
    expect(queryScalar(`SELECT public.get_retention_months('login_history');`)).toBe('12');
  });

  it('honours a non-default global window', () => {
    setConfig('{"default_months": 24, "tables": {}}');
    expect(queryScalar(`SELECT public.get_retention_months('login_history');`)).toBe('24');
  });

  // Every malformed case must fall back to 12 rather than raise or return a
  // window so short it deletes live data. Failing safe here means keeping data
  // longer than intended, never deleting more.
  it.each([
    ['a string where a number belongs', '{"default_months": "twelve", "tables": {}}'],
    ['an object where a number belongs', '{"default_months": {"months": 6}, "tables": {}}'],
    ['a zero window', '{"default_months": 0, "tables": {}}'],
    ['a negative window', '{"default_months": -5, "tables": {}}'],
    ['a missing default', '{"tables": {}}'],
    ['an empty object', '{}'],
    ['a per-table override of the wrong type', '{"default_months": 12, "tables": {"login_history": "six"}}'],
  ])('falls back to 12 months given %s', (_label, json) => {
    setConfig(json);
    expect(queryScalar(`SELECT public.get_retention_months('login_history');`)).toBe('12');
  });

  // A malformed override is not the same as an absent one. Absent means "use
  // the global default"; malformed means the operator meant something about
  // this table and mistyped it, so falling through to a shorter global default
  // would delete data they intended to keep. These cases only bite when the
  // global default is below the 12-month safe fallback, which is why the
  // generic malformed cases above (global = 12) cannot distinguish them.
  it.each([
    ['a string', '{"default_months": 3, "tables": {"login_history": "six"}}'],
    ['an object', '{"default_months": 3, "tables": {"login_history": {"months": 6}}}'],
    ['null', '{"default_months": 3, "tables": {"login_history": null}}'],
    ['a boolean', '{"default_months": 3, "tables": {"login_history": true}}'],
    ['zero', '{"default_months": 3, "tables": {"login_history": 0}}'],
    ['a negative number', '{"default_months": 3, "tables": {"login_history": -6}}'],
  ])(
    'takes the 12-month safe fallback, not the shorter global default, when an override is %s',
    (_label, json) => {
      setConfig(json);
      expect(queryScalar(`SELECT public.get_retention_months('login_history');`)).toBe('12');
      // A table with no override still legitimately uses the global default.
      expect(queryScalar(`SELECT public.get_retention_months('ai_usage_logs');`)).toBe('3');
    }
  );

  it('honours a global default below 12 for tables without an override', () => {
    setConfig('{"default_months": 3, "tables": {}}');
    expect(queryScalar(`SELECT public.get_retention_months('login_history');`)).toBe('3');
  });

  // A JSON number can exceed int4. Casting straight to integer would raise and
  // abort the caller's entire purge run — the precise failure this function is
  // supposed to absorb — so out-of-range values take the safe fallback.
  it.each([
    ['beyond int4', '{"default_months": 1e100, "tables": {}}'],
    ['just past the century bound', '{"default_months": 1201, "tables": {}}'],
    ['beyond int4 as an override', '{"default_months": 12, "tables": {"login_history": 99999999999}}'],
  ])('falls back to 12 months for a window %s', (_label, json) => {
    setConfig(json);
    expect(queryScalar(`SELECT public.get_retention_months('login_history');`)).toBe('12');
  });

  it('accepts a fractional window by flooring it', () => {
    setConfig('{"default_months": 6.9, "tables": {}}');
    expect(queryScalar(`SELECT public.get_retention_months('login_history');`)).toBe('6');
  });

  it('accepts the century bound itself', () => {
    setConfig('{"default_months": 1200, "tables": {}}');
    expect(queryScalar(`SELECT public.get_retention_months('login_history');`)).toBe('1200');
  });

  it('falls back to 12 months when the config row is absent', () => {
    execSql(`DELETE FROM public.system_config WHERE key = 'data_retention';`);
    try {
      expect(queryScalar(`SELECT public.get_retention_months('login_history');`)).toBe('12');
    } finally {
      execSql(
        `INSERT INTO public.system_config (key, value, description)
           VALUES ('data_retention', '{"default_months": 12, "tables": {}}'::jsonb, 'restored by test')
           ON CONFLICT (key) DO NOTHING;`
      );
    }
  });
});

describe('purge_expired_operational_logs', () => {
  it('deletes rows older than the window and keeps everything inside it', () => {
    seedLogin(18); // expired
    seedLogin(13); // expired
    seedLogin(11); // inside the window
    seedLogin(0); // today
    expect(countLogins()).toBe(4);

    purge();

    expect(countLogins()).toBe(2);
  });

  it('does not delete a row sitting just inside the boundary', () => {
    // 11 months and 29 days old — expired at 11 months, retained at 12.
    execSql(
      `INSERT INTO public.login_history (user_id, ip_address, login_at)
         VALUES ('${fixtureUserId}', '${FIXTURE_IP}',
                 now() - interval '12 months' + interval '1 day');`
    );

    purge();

    expect(countLogins()).toBe(1);
  });

  it('applies a per-table override rather than the default', () => {
    seedUsage(9);
    seedUsage(3);
    setConfig('{"default_months": 12, "tables": {"ai_usage_logs": 6}}');

    purge();

    // The 9-month row is expired under the 6-month override but would have
    // survived the 12-month default.
    expect(countUsage()).toBe(1);
  });

  it('purges each configured table independently', () => {
    seedLogin(18);
    seedUsage(18);
    setConfig('{"default_months": 12, "tables": {"ai_usage_logs": 24}}');

    purge();

    expect(countLogins()).toBe(0); // expired at 12 months
    expect(countUsage()).toBe(1); // retained under its 24-month override
  });

  it('records no error on a healthy run', () => {
    purge();

    const failed = queryScalar(
      `SELECT count(*) FROM public.retention_purge_runs
        WHERE ran_at > now() - interval '1 minute' AND error IS NOT NULL;`
    );
    expect(Number(failed)).toBe(0);
  });

  it('keeps purging the remaining tables when one fails', () => {
    seedLogin(18);

    // Break a single target: a BEFORE DELETE trigger that always raises.
    // Without per-table subtransactions this would roll back the whole run,
    // and a table that failed every night would block every other table.
    execSql(`
      CREATE OR REPLACE FUNCTION public.__retention_test_boom()
      RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        RAISE EXCEPTION 'simulated purge failure';
      END;
      $fn$;
      CREATE TRIGGER __retention_test_boom
        BEFORE DELETE ON public.ai_usage_logs
        FOR EACH STATEMENT EXECUTE FUNCTION public.__retention_test_boom();
    `);

    try {
      purge();

      // The healthy table was still purged.
      expect(countLogins()).toBe(0);

      // And the broken one is recorded as failed, not as a clean run.
      const err = queryScalar(
        `SELECT coalesce(error, '') FROM public.retention_purge_runs
          WHERE table_name = 'ai_usage_logs' AND ran_at > now() - interval '1 minute'
          ORDER BY ran_at DESC LIMIT 1;`
      );
      expect(err).toContain('simulated purge failure');

      const healthy = queryScalar(
        `SELECT coalesce(error, '') FROM public.retention_purge_runs
          WHERE table_name = 'login_history' AND ran_at > now() - interval '1 minute'
          ORDER BY ran_at DESC LIMIT 1;`
      );
      expect(healthy).toBe('');
    } finally {
      execSql(`DROP TRIGGER IF EXISTS __retention_test_boom ON public.ai_usage_logs;`);
      execSql(`DROP FUNCTION IF EXISTS public.__retention_test_boom();`);
    }
  });

  it('records one ledger row per table per run', () => {
    seedLogin(18);

    purge();

    const tables = queryScalar(
      `SELECT count(DISTINCT table_name) FROM public.retention_purge_runs
        WHERE ran_at > now() - interval '1 minute';`
    );
    // Nine since `audit_logs` joined the target list (20260913140000), after
    // the unified `chat_state_history` (whose two predecessors stay until
    // their tables are dropped). Kept as a literal rather than derived from
    // the function, so that adding a target is a deliberate edit here too.
    expect(Number(tables)).toBe(9);

    const deleted = queryScalar(
      `SELECT rows_deleted FROM public.retention_purge_runs
        WHERE table_name = 'login_history' AND ran_at > now() - interval '1 minute'
        ORDER BY ran_at DESC LIMIT 1;`
    );
    expect(Number(deleted)).toBe(1);
  });

  it('caps work per run and flags the unfinished table', () => {
    seedLogin(18);
    seedLogin(19);
    seedLogin(20);

    purge(2);

    // Cap reached, so one expired row is left for the next tick.
    expect(countLogins()).toBe(1);
    expect(backlogFlag('login_history')).toBe('t');

    // The next run drains the remainder and clears the flag.
    purge(2);
    expect(countLogins()).toBe(0);
    expect(backlogFlag('login_history')).toBe('f');
  });

  // `backlog_remaining` must mean "expired rows are still there", not "the
  // delete count happened to equal the cap". A table holding exactly `cap`
  // expired rows is fully drained; flagging it would have the compliance
  // ledger report a backlog that does not exist.
  it('does not report a backlog when the table is drained in exactly one capped batch', () => {
    seedLogin(18);
    seedLogin(19);

    purge(2); // cap == number of expired rows

    expect(countLogins()).toBe(0);
    expect(backlogFlag('login_history')).toBe('f');
  });

  it('does not report a backlog for rows that are merely inside the window', () => {
    seedLogin(18); // expired
    seedLogin(2); // retained, must not count as backlog

    purge();

    expect(countLogins()).toBe(1);
    expect(backlogFlag('login_history')).toBe('f');
  });

  it('does not report a clean run when given a non-positive cap', () => {
    seedLogin(18);

    // A cap of 0 must not silently delete nothing and log success — it is
    // clamped to at least 1 so the run makes progress.
    purge(0);

    expect(countLogins()).toBe(0);
  });

  // audit_logs joined the purge with a LONGER window than the global default
  // (24 months, 20260913140000). The 18-month row is the discriminating case:
  // it survives only if the override governs — under the 12-month default it
  // would be deleted, silently shortening the accountability record.
  it('purges audit_logs at 24 months, not the 12-month default', () => {
    execSql(
      `INSERT INTO public.audit_logs (action, actor_email, created_at)
       VALUES ('user.create', '${FIXTURE_AUDIT_EMAIL}', now() - make_interval(months => 25)),
              ('user.create', '${FIXTURE_AUDIT_EMAIL}', now() - make_interval(months => 18));`
    );

    purge();

    // Only the 18-month row remains, and it is inside the 24-month window.
    expect(
      Number(
        queryScalar(
          `SELECT count(*) FROM public.audit_logs WHERE actor_email = '${FIXTURE_AUDIT_EMAIL}';`
        )
      )
    ).toBe(1);
    expect(
      queryScalar(
        `SELECT (created_at > now() - interval '24 months')::text
           FROM public.audit_logs WHERE actor_email = '${FIXTURE_AUDIT_EMAIL}';`
      )
    ).toBe('true');
  });

  // The purge touches exactly these tables and nothing else. Asserting the
  // whole set (rather than spot-checking absences) is what stops a future
  // edit from quietly adding a pedagogical table — grades, evaluations, quiz
  // answers and the user-visible chat tables are the school's learning record
  // and must never be auto-deleted.
  it('purges exactly the nine operational-log tables', () => {
    purge();

    const purged = queryScalar(
      `SELECT string_agg(DISTINCT table_name, ',' ORDER BY table_name)
         FROM public.retention_purge_runs
        WHERE ran_at > now() - interval '1 minute';`
    ).split(',');

    expect(purged).toEqual([
      'agent_interaction_logs',
      'ai_rate_limit_events',
      'ai_usage_logs',
      'audit_logs',
      // The unified state history. Its two predecessors stay listed until
      // their tables are dropped in the follow-up.
      'chat_state_history',
      'failed_login_attempts',
      'login_history',
      'socratic_state_history',
      'study_tutor_state_history',
    ]);
  });
});

describe('retention_purge_runs', () => {
  it('has RLS enabled with no client write policy', () => {
    expect(
      queryScalar(
        `SELECT relrowsecurity FROM pg_class WHERE oid = 'public.retention_purge_runs'::regclass;`
      )
    ).toBe('t');

    // Restrictive policies (the blanket mfa_enforced) only ever narrow
    // access — a write path needs a PERMISSIVE policy to exist.
    const writePolicies = queryScalar(
      `SELECT count(*) FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'retention_purge_runs'
          AND cmd <> 'SELECT' AND permissive = 'PERMISSIVE';`
    );
    expect(Number(writePolicies)).toBe(0);
  });
});

describe('cron registration', () => {
  it('registers exactly one data-retention-purge job', () => {
    const count = queryScalar(
      `SELECT count(*) FROM cron.job WHERE jobname = 'data-retention-purge';`
    );
    expect(Number(count)).toBe(1);
  });

  it('runs daily and calls the purge function', () => {
    const row = queryScalar(
      `SELECT schedule || '|' || command FROM cron.job
        WHERE jobname = 'data-retention-purge';`
    );
    const [schedule, command] = row.split('|');
    expect(schedule).toBe('17 3 * * *');
    expect(command).toContain('purge_expired_operational_logs');
  });
});
