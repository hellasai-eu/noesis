// DB-level tests for the pg_cron background-job driver + health SQL (issue #869).
//
// Objects under test:
//   * public.tick_run_jobs()        — the 1-minute cron tick that POSTs run-jobs
//   * public.get_jobs_cron_health() — the snapshot the jobs UI + run-jobs read
//   * public.run_jobs_tick          — per-tick request-id ledger (RLS, no policy)
//
// Migrations:
//   * 20260628300000_pg_cron_run_jobs.sql               (tick_run_jobs, #762)
//   * 20260628500000_jobs_cron_health.sql               (get_jobs_cron_health, #780)
//   * 20260711000000_run_jobs_tick_http_status_health.sql (net._http_response correlation, #813)
//   * 20260712000000_fix_get_jobs_cron_health_jobname.sql (jobid resolution, #815)
//   * 20260713000000_run_jobs_no_auth.sql               (keyless: only project_url matters)
//
// Two prod incidents shipped here with zero test cover:
//   * #813 false-green health — cron reports "succeeded" the instant the POST
//     is queued, so health stayed green while run-jobs rejected every tick.
//   * #815 the 42703 "column jobname does not exist" 400 — the health function
//     queried a column cron.job_run_details doesn't have, so the RPC 400'd.
//
// These reach postgres-owned system schemas (vault.*, cron.*, net._http_response)
// and an RLS-no-policy table, none of which supabase-js can seed — so the suite
// drives raw SQL as the local `postgres` superuser via helpers/sql.ts, while
// still running under the `test:rls` vitest harness.
//
// NOTE (#713): run-jobs is now keyless. `secrets_seeded` / the tick's no-op
// guard depend on `project_url` ALONE — a missing `service_role_key` is fine.

import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { getAdminClient } from '../helpers/auth';
import { execSql, escapeSqlLiteral, queryScalar, getCronHealth } from '../helpers/sql';

// Out-of-band ids well above anything pg_net's live sequence will reach, so
// our fixtures never collide with (or get mistaken for) real tick responses.
const FAKE_REQ_BASE = 9_990_000_000;
const FAKE_RUNID = 9_990_000_000;
const LOCAL_URL = 'http://127.0.0.1:54321';

/** Seed a fully-delivered tick: a ledger row + its correlated pg_net response. */
function seedTick(reqId: number, httpStatus: number, minutesAgo = 0): void {
  execSql(
    `INSERT INTO net._http_response(id, status_code, created)
       VALUES (${reqId}, ${httpStatus}, now() - make_interval(mins => ${minutesAgo}));`
  );
  execSql(
    `INSERT INTO public.run_jobs_tick(request_id, ticked_at)
       VALUES (${reqId}, now() - make_interval(mins => ${minutesAgo}));`
  );
}

function setProjectUrl(url: string): void {
  execSql(`SELECT public.upsert_vault_secret('project_url', '${escapeSqlLiteral(url)}');`);
}

function clearTestSecrets(): void {
  execSql(`DELETE FROM vault.secrets WHERE name IN ('project_url', 'service_role_key');`);
}

/** Wipe everything a test may have seeded, leaving real (id < base) rows alone. */
function clearFixtures(): void {
  execSql(`DELETE FROM public.run_jobs_tick WHERE request_id >= ${FAKE_REQ_BASE};`);
  execSql(`DELETE FROM net._http_response WHERE id >= ${FAKE_REQ_BASE};`);
  execSql(`DELETE FROM cron.job_run_details WHERE runid = ${FAKE_RUNID};`);
}

describe('pg_cron job driver + health SQL (#869)', () => {
  const admin = getAdminClient();

  // Snapshot any operator-seeded vault secrets so we can restore them; a fresh
  // `supabase start` DB has none, but the deploy scripts seed them in QA/prod.
  let savedSecrets: { name: string; secret: string }[] = [];

  beforeAll(() => {
    // Also sweeps any fixture left behind by a prior run of this suite that
    // got interrupted before its own cleanup ran (e.g. the future-dated
    // cron.job_run_details sentinel in the #815 regression test below).
    clearFixtures();

    savedSecrets = JSON.parse(
      queryScalar(
        `SELECT coalesce(json_agg(json_build_object('name', name, 'secret', decrypted_secret)), '[]')
           FROM vault.decrypted_secrets
           WHERE name IN ('project_url', 'service_role_key');`
      )
    );
  });

  afterEach(() => {
    clearFixtures();
    clearTestSecrets();
  });

  afterAll(() => {
    clearFixtures();
    clearTestSecrets();
    for (const s of savedSecrets) {
      // { redact: true }: this SQL embeds a decrypted secret value, so on
      // failure the error must not echo the statement (and the secret) into
      // test logs. Escaping the literals also keeps a secret containing a
      // single quote from breaking the restore statement outright.
      execSql(
        `SELECT public.upsert_vault_secret('${escapeSqlLiteral(s.name)}', '${escapeSqlLiteral(s.secret)}');`,
        { redact: true }
      );
    }
  });

  // ── AC1: executes without error + full JSON shape (42703 jobname regression) ──
  it('get_jobs_cron_health() returns the full snapshot shape without raising', async () => {
    const health = getCronHealth();

    // Every documented key must be present — the pre-#815 function 400'd here
    // with 42703 before it ever returned.
    for (const key of [
      'secrets_seeded',
      'last_tick_at',
      'last_tick_status',
      'last_tick_http_status',
      'last_success_at',
      'minutes_since_success',
      'is_healthy',
      'now',
    ]) {
      expect(health).toHaveProperty(key);
    }
    expect(typeof health.secrets_seeded).toBe('boolean');
    expect(typeof health.is_healthy).toBe('boolean');

    // And the same path the frontend/edge actually use — the SECURITY DEFINER
    // RPC over PostgREST as the service role — must not error either.
    const { data, error } = await admin.rpc('get_jobs_cron_health');
    expect(error).toBeNull();
    expect(data).toHaveProperty('is_healthy');
  });

  // ── AC2: reports not-seeded / unhealthy when project_url is absent ──
  it('reports not-seeded and unhealthy when the project_url secret is missing', () => {
    clearTestSecrets();
    clearFixtures();

    const health = getCronHealth();
    expect(health.secrets_seeded).toBe(false);
    expect(health.is_healthy).toBe(false);
  });

  // ── AC2: false-green guard (#813) — a non-2xx tick is honestly unhealthy ──
  it('stays unhealthy when the latest tick returned a non-2xx status', () => {
    setProjectUrl(LOCAL_URL);
    clearFixtures();
    seedTick(FAKE_REQ_BASE + 1, 401, 0); // cron "succeeded" but run-jobs rejected it

    const health = getCronHealth();
    expect(health.secrets_seeded).toBe(true);
    expect(health.last_tick_http_status).toBe(401);
    expect(health.last_success_at).toBeNull();
    expect(health.is_healthy).toBe(false);
  });

  // ── AC2: healthy only when a recent tick actually returned 2xx ──
  it('is healthy when project_url is seeded and a recent tick returned 2xx', () => {
    setProjectUrl(LOCAL_URL);
    clearFixtures();
    seedTick(FAKE_REQ_BASE + 2, 200, 0);

    const health = getCronHealth();
    expect(health.secrets_seeded).toBe(true);
    expect(health.last_tick_http_status).toBe(200);
    expect(health.last_success_at).not.toBeNull();
    expect(health.minutes_since_success).not.toBeNull();
    expect(health.minutes_since_success!).toBeLessThanOrEqual(5);
    expect(health.is_healthy).toBe(true);
  });

  // ── AC2: a stale (>5 min) 2xx tick is past the freshness threshold ──
  it('is unhealthy when the last 2xx tick is older than the 5-minute threshold', () => {
    setProjectUrl(LOCAL_URL);
    clearFixtures();
    seedTick(FAKE_REQ_BASE + 3, 200, 10); // 10 minutes ago

    const health = getCronHealth();
    expect(health.last_success_at).not.toBeNull();
    expect(health.minutes_since_success!).toBeGreaterThan(5);
    expect(health.is_healthy).toBe(false);
  });

  // ── AC3: tick no-ops (RETURN NULL) + records no ledger row w/o project_url ──
  it('tick_run_jobs() returns NULL and records no ledger row when project_url is missing', () => {
    clearTestSecrets();
    clearFixtures();

    const before = Number(queryScalar('SELECT count(*) FROM public.run_jobs_tick;'));
    const isNull = queryScalar('SELECT public.tick_run_jobs() IS NULL;');
    const after = Number(queryScalar('SELECT count(*) FROM public.run_jobs_tick;'));

    expect(isNull).toBe('t');
    expect(after).toBe(before);
  });

  // ── AC3: tick posts + records a ledger row when project_url is seeded ──
  it('tick_run_jobs() records a run_jobs_tick row keyed by the pg_net request id when it posts', () => {
    setProjectUrl(LOCAL_URL);
    clearFixtures();

    const reqId = queryScalar('SELECT public.tick_run_jobs();');
    expect(reqId).toMatch(/^\d+$/); // a real pg_net request id, not NULL

    const rows = queryScalar(
      `SELECT count(*) FROM public.run_jobs_tick WHERE request_id = ${reqId};`
    );
    expect(rows).toBe('1');

    // Drop the real ledger row this test created (id < FAKE_REQ_BASE).
    execSql(`DELETE FROM public.run_jobs_tick WHERE request_id = ${reqId};`);
  });

  // ── #815 regression: liveness comes from jobid resolved via cron.job ──
  it('surfaces cron run history by resolving the jobid from cron.job (not a jobname column)', () => {
    const jobid = queryScalar(
      `SELECT jobid FROM cron.job WHERE jobname = 'run-jobs-tick' ORDER BY jobid DESC LIMIT 1;`
    );
    expect(jobid).toMatch(/^\d+$/);

    clearFixtures();
    // A guaranteed-latest run row, just far enough in the future (2m — well
    // past this test's runtime, but short-lived if cleanup below never runs)
    // that we read back our own sentinel regardless of any live tick the
    // scheduler fires meanwhile. Kept deliberately short rather than the
    // hour-plus margin a slower test would want: if the process is killed
    // between the INSERT and the `finally`, a stray "healthy" reading from
    // this sentinel self-resolves within minutes instead of lingering for an
    // hour, and the next `beforeAll` in this file sweeps it anyway.
    try {
      execSql(
        `INSERT INTO cron.job_run_details(runid, jobid, database, username, status, start_time, end_time)
           VALUES (${FAKE_RUNID}, ${jobid}, 'postgres', 'postgres', 'succeeded',
                   now() + interval '2 minutes', now() + interval '2 minutes');`
      );

      const health = getCronHealth();
      expect(health.last_tick_status).toBe('succeeded');
      expect(health.last_tick_at).not.toBeNull();
      expect(new Date(health.last_tick_at!).getTime()).toBeGreaterThan(Date.now());
    } finally {
      clearFixtures();
    }
  });
});
