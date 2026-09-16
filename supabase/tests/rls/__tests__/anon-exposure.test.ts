// What an unauthenticated caller can read (#1173).
//
// `public.invitations` carried a policy named "Pending invitations can be
// viewed by email" whose predicate was `status = 'pending'` — no email, and no
// TO clause, so it applied to PUBLIC and therefore to `anon`. One request
// carrying only the anon key that ships in the frontend bundle returned every
// pending invitation in the database: invitee address, full name, role,
// institution and course, across every tenant.
//
// The first test here is the guard that would have caught it. It is a sweep
// rather than a case: the bug was not that someone wrote a bad policy for
// `invitations` specifically, it was that nothing anywhere asserted the general
// property, so a policy missing its TO clause was invisible until an audit went
// looking. `getAnonClient`'s own docstring said asserting table by table had
// "little point" because `auth.uid()` is null for anon — true of every policy
// that consults `auth.uid()`, and the one that did not was the one that leaked.
//
// Goes through PostgREST with the anon key rather than `SET ROLE anon` in SQL,
// because that is the path an attacker actually has: it exercises the grants,
// PostgREST's own exposure rules and RLS together.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SupabaseClient } from '@supabase/supabase-js';
import { getAnonClient, getAdminClient } from '../helpers/auth';
import { execSql, queryScalar } from '../helpers/sql';

const anon = getAnonClient();

/** Every public base table, from the catalogue rather than a hand-kept list. */
const publicTables: string[] = JSON.parse(
  queryScalar(`
    SELECT coalesce(json_agg(c.relname::text ORDER BY c.relname), '[]'::json)::text
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
  `)
);

// The seeded invitation (supabase/seed.sql). Read rather than hardcoded so this
// does not become another list that drifts.
const seeded = JSON.parse(
  queryScalar(`
    SELECT coalesce(json_agg(row_to_json(t))::text, '[]') FROM (
      SELECT id, institution_id, email FROM public.invitations
      WHERE status = 'pending' ORDER BY created_at LIMIT 1
    ) t
  `)
)[0] as { id: string; institution_id: string; email: string } | undefined;

// A second pending invitation in the SAME institution, so the token below names
// more than one row. If the function ever widened from "the row this link names"
// to "rows matching this token", this is the row that would come back with it.
const OTHER_ID = '00000000-0000-0000-0aa0-000000001173';
const OTHER_EMAIL = 'anon-exposure-neighbour@test.local';

let admin: SupabaseClient;

beforeAll(() => {
  admin = getAdminClient();
  if (!seeded) return;
  execSql(`
    INSERT INTO public.invitations (id, institution_id, email, role, invited_name, status)
    VALUES ('${OTHER_ID}', '${seeded.institution_id}', '${OTHER_EMAIL}',
            'student', 'Neighbour', 'pending')
    ON CONFLICT (id) DO NOTHING;
  `);
});

afterAll(() => {
  execSql(`DELETE FROM public.invitations WHERE id = '${OTHER_ID}';`);
});

describe('unauthenticated exposure', () => {
  it('returns no row from any public table', async () => {
    expect(publicTables.length).toBeGreaterThan(50); // catalogue query works

    const leaked: string[] = [];
    const unverified: string[] = [];

    for (const table of publicTables) {
      const { data, error } = await anon.from(table).select('*').limit(1);
      // An error means the probe did not run, so this table was not checked.
      // Collected rather than ignored: a guard that counts "no rows came back"
      // as safe when the request itself failed reports success for work it
      // never did, which is worse than no guard at all.
      //
      // Notably a permission error is NOT treated as a pass here even though
      // anon being denied at the grant level is itself secure. On this project
      // anon holds table grants — hosted Supabase issues them, and locally
      // scripts/local-db-grants.sh does — so 42501 means the environment is
      // misconfigured and the whole sweep is vacuous. That is the failure mode
      // worth shouting about: without those grants every table looks locked
      // down and the suite goes green having proved nothing.
      if (error) {
        unverified.push(`${table}: ${error.code ?? '?'} ${error.message}`);
        continue;
      }
      if (Array.isArray(data) && data.length > 0) leaked.push(table);
    }

    expect(
      unverified,
      `These tables could not be probed, so this test verified nothing about ` +
        `them. A 42501 means the API roles are missing their table grants — run ` +
        `scripts/local-db-grants.sh against this database and re-run.`
    ).toEqual([]);

    expect(
      leaked,
      `These tables returned rows to a caller holding only the anon key — the ` +
        `key that ships in the frontend bundle. Either a policy is missing its ` +
        `TO clause, or its predicate never consults auth.uid(). See #1173.`
    ).toEqual([]);
  });

  // Worth stating separately from the sweep: the sweep can only see tables that
  // happen to hold rows in a freshly seeded database, and `invitations` is the
  // one we know did leak.
  it('returns no invitation to an unauthenticated caller', async () => {
    const { data } = await anon.from('invitations').select('id, email, role');
    expect(data ?? []).toEqual([]);
  });
});

describe('get_pending_invitation', () => {
  const call = (token: string, email: string) =>
    anon.rpc('get_pending_invitation', { _token: token, _email: email });

  it('resolves the invitation an institution-id link names', async () => {
    if (!seeded) return expect.unreachable('seed.sql has no pending invitation');
    const { data, error } = await call(seeded.institution_id, seeded.email);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0].id).toBe(seeded.id);
    // The institution name is why this is SECURITY DEFINER: `institutions` is
    // not anon-readable, so the old embedded `institutions(name)` select
    // silently returned null and the signup screen said "Institution".
    expect(data![0].institution_name).toBeTruthy();
  });

  // bulk-invite-users puts the invitation id in the link where send-invitation
  // puts the institution id. Auth.tsx only ever matched on institution_id, so
  // links from the bulk sender have never resolved.
  it('resolves the invitation an invitation-id link names', async () => {
    if (!seeded) return expect.unreachable('seed.sql has no pending invitation');
    const { data } = await call(seeded.id, seeded.email);
    expect(data).toHaveLength(1);
    expect(data![0].id).toBe(seeded.id);
  });

  it('matches the address case-insensitively', async () => {
    if (!seeded) return expect.unreachable('seed.sql has no pending invitation');
    const { data } = await call(seeded.institution_id, seeded.email.toUpperCase());
    expect(data).toHaveLength(1);
  });

  it('returns nothing for an address that was not invited', async () => {
    if (!seeded) return expect.unreachable('seed.sql has no pending invitation');
    const { data } = await call(seeded.institution_id, 'not-invited@example.com');
    expect(data ?? []).toEqual([]);
  });

  it('returns nothing when the token names another institution', async () => {
    if (!seeded) return expect.unreachable('seed.sql has no pending invitation');
    const { data } = await call('00000000-0000-0000-0000-0000000009f9', seeded.email);
    expect(data ?? []).toEqual([]);
  });

  // The property that makes this a lookup rather than the old table scan: the
  // token alone names two pending rows here, and supplying it returns only the
  // one whose address the caller already knew.
  it('never returns a second invitation sharing the token', async () => {
    if (!seeded) return expect.unreachable('seed.sql has no pending invitation');
    const neighbours = queryScalar(
      `SELECT count(*)::text FROM public.invitations
        WHERE institution_id = '${seeded.institution_id}' AND status = 'pending'`
    );
    expect(Number(neighbours)).toBeGreaterThan(1);

    const { data } = await call(seeded.institution_id, seeded.email);
    expect(data).toHaveLength(1);
    expect(data![0].email).not.toBe(OTHER_EMAIL);
  });
});
