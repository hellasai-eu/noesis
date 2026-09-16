// DB-level tests for complete user erasure (issue #932, epic #931).
//
// Objects under test (migration 20260726000000_complete_user_erasure.sql):
//   * public.user_reference_map()    — the inventory of user-referencing columns
//   * public.user_data_footprint()   — the sweep that proves an erasure landed
//   * the foreign keys the migration repairs
//
// The first test is the regression net that matters most: it walks the map and
// asserts the live schema agrees with it. A future migration that recreates a
// table without its foreign key — which is exactly how `login_history` and
// `profiles` lost theirs (20251206101851) — fails here rather than silently
// leaving a user's data behind on the next erasure request.
//
// Seeding reaches RLS-protected tables and `auth.users`, so like
// data-retention.test.ts these run raw SQL as the local `postgres` superuser.
// The account itself is created and deleted through the admin API, so the test
// exercises the same `auth.admin.deleteUser` cascade the edge function relies on.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SupabaseClient } from '@supabase/supabase-js';
import { getAdminClient } from '../helpers/auth';
import { execSql, queryScalar, escapeSqlLiteral } from '../helpers/sql';
import { ROOT_SPECS, NOT_SUBJECT_DATA } from '../../../functions/export-data/user-export';

const SUBJECT_EMAIL = `erasure-subject-${Date.now()}@test.local`;
/** Marker on rows that must survive the erasure with their attribution dropped. */
const FIXTURE_FN = '__erasure_fixture__';

let admin: SupabaseClient;
let userId: string;

/** Rows the footprint still finds for the subject, as "table.column=count". */
function footprint(id: string, email: string | null): string[] {
  const emailArg = email === null ? 'NULL' : `'${escapeSqlLiteral(email)}'`;
  const out = queryScalar(
    `SELECT coalesce(string_agg(source_table || '.' || source_column || '=' || row_count, ' '), '')
       FROM public.user_data_footprint('${id}', ${emailArg})
      WHERE row_count > 0;`
  );
  return out === '' ? [] : out.split(' ');
}

beforeAll(async () => {
  admin = getAdminClient();
  const { data, error } = await admin.auth.admin.createUser({
    email: SUBJECT_EMAIL,
    password: 'testpass123',
    email_confirm: true,
  });
  if (error) throw new Error(`createUser: ${error.message}`);
  userId = data.user.id;
});

afterAll(async () => {
  // The account is deleted by the test below; this only catches an early failure.
  if (admin && userId) await admin.auth.admin.deleteUser(userId).catch(() => undefined);
  execSql(`DELETE FROM public.ai_usage_logs WHERE function_name = '${FIXTURE_FN}';`);
});

describe('user_reference_map', () => {
  it('matches the live schema: every mapped foreign key exists with the mapped rule', () => {
    const mismatches = queryScalar(`
      WITH m AS (SELECT * FROM public.user_reference_map() WHERE fk_action IS NOT NULL),
      live AS (
        SELECT cl.relname::text  AS tbl,
               a.attname::text   AS col,
               c.confdeltype     AS deltype
          FROM pg_constraint c
          JOIN pg_class cl     ON cl.oid = c.conrelid
          JOIN pg_namespace n  ON n.oid = cl.relnamespace
          JOIN pg_attribute a  ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
         WHERE c.confrelid = 'auth.users'::regclass
           AND c.contype = 'f'
           AND array_length(c.conkey, 1) = 1
           AND n.nspname = 'public'
      )
      SELECT coalesce(string_agg(m.tbl || '.' || m.col || ' -> ' || coalesce(l.deltype::text, 'missing'), ', '), '')
        FROM m
        LEFT JOIN live l ON l.tbl = m.tbl AND l.col = m.col
       WHERE l.deltype IS DISTINCT FROM (CASE m.fk_action WHEN 'CASCADE' THEN 'c' ELSE 'n' END)::"char"
         AND to_regclass('public.' || quote_ident(m.tbl)) IS NOT NULL;
    `);

    expect(mismatches).toBe('');
  });

  it('covers every table the per-user export reads', () => {
    // The export (supabase/functions/export-data/user-export.ts) and this map
    // are the two halves of the same inventory: whatever can be exported about
    // a person must also be erasable. Checked here as table presence — the
    // export's own column rules are covered by its unit tests.
    //
    // Derived from ROOT_SPECS rather than restated. This was a hand-copied
    // array of 49 table names, which is the drift this whole issue is about:
    // it had already fallen behind the export it claims to mirror, and this
    // test was red on main because `failed_login_attempts` reached the export
    // but never reached the map (backfilled in 20260824150000).
    //
    // Root specs only. CHILD_SPECS tables are reached through a parent and are
    // erased by cascading from it, so the map records the parent and says so in
    // its note ("quiz_session_questions cascades from it") rather than listing
    // the child. NOT_SUBJECT_DATA tables are deliberately not exported at all.
    const exported = ROOT_SPECS.map((s) => s.table).filter((t) => !NOT_SUBJECT_DATA.has(t));

    const missing = queryScalar(`
      SELECT coalesce(string_agg(t, ', '), '')
        FROM unnest(ARRAY[${exported.map((t) => `'${t}'`).join(',')}]) AS t
       WHERE t NOT IN (SELECT tbl FROM public.user_reference_map());
    `);

    expect(missing).toBe('');
  });
});

describe('erase_user_unlinked_data', () => {
  it('matches emails case-insensitively without widening on underscores', () => {
    // Invitations are stored with whatever case the admin typed
    // (UserManagement.tsx) while the auth record is lowercased, so an exact
    // match left `First_Last@…` behind. The near-miss address is the reason
    // this runs in SQL: PostgREST's `ilike` has no escape, so `first_last@…`
    // as a pattern would have deleted `firstXlast@…` too.
    const subject = 'first_last@erasure-test.local';
    const nearMiss = 'firstXlast@erasure-test.local';
    execSql(`
      INSERT INTO public.invitations (email, institution_id, role)
        SELECT 'First_Last@Erasure-Test.Local', id, 'student' FROM public.institutions LIMIT 1;
      INSERT INTO public.invitations (email, institution_id, role)
        SELECT '${nearMiss}', id, 'student' FROM public.institutions LIMIT 1;
    `);

    const seeded = queryScalar(
      `SELECT count(*) FROM public.invitations WHERE email ILIKE '%erasure-test.local';`
    );
    // Skip rather than fail if the local DB has no institution to hang an
    // invitation off — the seed, not the behaviour, is what is missing.
    if (Number(seeded) !== 2) return;

    execSql(`SELECT public.erase_user_unlinked_data('${userId}', '${subject}');`);

    const left = queryScalar(
      `SELECT coalesce(string_agg(email, ','), '') FROM public.invitations
        WHERE email ILIKE '%erasure-test.local';`
    );
    expect(left).toBe(nearMiss);

    execSql(`DELETE FROM public.invitations WHERE email ILIKE '%erasure-test.local';`);
  });

  it('never hands back the attachments of a live user who once held the address', () => {
    // Addresses get reassigned: someone changes their email, and the subject
    // later registers the one they gave up. The old reports still carry the
    // stale `reporter_email`, and the caller deletes every path this function
    // returns with the service role — so returning them would delete a live
    // user's screenshots.
    const reused = `reused-${Date.now()}@erasure-test.local`;
    execSql(`
      INSERT INTO public.bug_reports (reporter_id, reporter_email, title, description, screenshot_paths)
        VALUES ('${userId}', '${reused}', 'Still-owned report', 'x', ARRAY['${userId}/keep.png']);
      INSERT INTO public.bug_reports (reporter_id, reporter_email, title, description, screenshot_paths)
        VALUES (NULL, '${reused.toUpperCase()}', 'Orphaned report', 'x', ARRAY['old-account/gone.png']);
    `);

    // Erase a *different* subject who now holds that address.
    const paths = queryScalar(`
      SELECT public.erase_user_unlinked_data(gen_random_uuid(), '${reused}') ->> 'screenshot_paths';
    `);
    expect(paths).toContain('old-account/gone.png');
    expect(paths).not.toContain('keep.png');

    // The live user keeps their screenshots and loses only the stale address.
    const kept = queryScalar(
      `SELECT count(*) FROM public.bug_reports
        WHERE title = 'Still-owned report'
          AND reporter_email IS NULL
          AND screenshot_paths = ARRAY['${userId}/keep.png'];`
    );
    expect(Number(kept)).toBe(1);

    execSql(
      `DELETE FROM public.bug_reports WHERE title IN ('Still-owned report', 'Orphaned report');`
    );
  });
});

describe('find_erasure_name_matches (20260913080000)', () => {
  // The erasure "manual step": instructor-typed names in
  // graded_tests.student_name / student_evaluations.student_name. The tool
  // automates the SEARCH only — matches are returned for review, never
  // cleared, because a typed name is not a key and may belong to a same-named
  // other student. These tests pin the matcher's promises: case-, accent- and
  // punctuation-insensitivity, token reordering, two-way prefixes (initials),
  // NO over-match on merely similar names, and the unusable-name error.
  //
  // The surname carries a per-run uid (hex survives normalisation), so a run
  // that dies before its afterAll cannot make the counts below ambiguous for
  // the next run.
  const NAME_UID = crypto.randomUUID().slice(0, 8);
  const SURNAME = `Ονοματεστου${NAME_UID}`;
  const SUBJECT_NAME = `Γιώργος ${SURNAME}`;
  const G_MARKER = `__name_sweep_${NAME_UID}__`;
  let nameCourseId: string | null = null;

  beforeAll(() => {
    // Skip-seed rather than fail when the local DB has no course to hang rows
    // off — the seed, not the behaviour, is what is missing (same rule as the
    // invitations test above). Each test guards on nameCourseId so no test
    // depends on another test having run.
    nameCourseId = queryScalar(`SELECT id FROM public.courses LIMIT 1;`) || null;
    if (!nameCourseId) return;

    execSql(`
      INSERT INTO public.graded_tests (course_id, file_type, original_file_name, original_file_url, title, student_id, student_name)
        VALUES ('${nameCourseId}', 'pdf', 'x.pdf', 'x', '${G_MARKER}', NULL, '${SURNAME.toUpperCase()} Γιωργος'),
               ('${nameCourseId}', 'pdf', 'x.pdf', 'x', '${G_MARKER}', NULL, 'Γ. ${SURNAME}'),
               ('${nameCourseId}', 'pdf', 'x.pdf', 'x', '${G_MARKER}', NULL, 'Γεωργία ${SURNAME}');
      INSERT INTO public.student_evaluations (course_id, user_id, student_name)
        VALUES ('${nameCourseId}', '${userId}', '${escapeSqlLiteral(SUBJECT_NAME)}');
    `);
  });

  afterAll(() => {
    // This DB suite cleans its fixtures like the rest of the file does (see
    // the invitations and bug_reports tests above) — the "no cleanup" policy
    // is about browser runs against disposable environments, not service-role
    // DB tests against a local stack. The per-run uid above is what makes
    // reruns safe even if this afterAll never executes.
    if (!nameCourseId) return;
    execSql(`
      DELETE FROM public.graded_tests WHERE title = '${G_MARKER}';
      DELETE FROM public.student_evaluations
       WHERE user_id = '${userId}' AND student_name = '${escapeSqlLiteral(SUBJECT_NAME)}';
    `);
  });

  it('finds reordered, unaccented and initialed variants, but not a similar other name', () => {
    if (!nameCourseId) return;

    const matches = queryScalar(`
      SELECT coalesce(string_agg(source_table || ':' || student_name, ' | ' ORDER BY student_name), '')
        FROM public.find_erasure_name_matches('${escapeSqlLiteral(SUBJECT_NAME)}');
    `);

    // Uppercase+unaccented+reordered matches, the initial matches, the exact
    // name matches — and «Γεωργία», a different person, does not.
    expect(matches).toContain(`${SURNAME.toUpperCase()} Γιωργος`);
    expect(matches).toContain(`Γ. ${SURNAME}`);
    expect(matches).toContain(SUBJECT_NAME);
    expect(matches).not.toContain('Γεωργία');
  });

  it('reports the linked account on rows attached to a (different, live) user', () => {
    if (!nameCourseId) return;

    // student_evaluations.user_id cascades, so after a real erasure every
    // surviving match there belongs to another account — the review UI keys
    // "leave it alone" off this field being set.
    const linked = queryScalar(`
      SELECT linked_user_id::text
        FROM public.find_erasure_name_matches('${escapeSqlLiteral(SUBJECT_NAME)}')
       WHERE source_table = 'student_evaluations'
         AND student_name = '${escapeSqlLiteral(SUBJECT_NAME)}';
    `);
    expect(linked).toBe(userId);
  });

  it('feeds the footprint: counted with a name, -1 without one', () => {
    if (!nameCourseId) return;

    // A random uuid: the name argument alone drives the name-kind rows.
    const counted = queryScalar(`
      SELECT coalesce(string_agg(source_table || '=' || row_count, ' ' ORDER BY source_table), '')
        FROM public.user_data_footprint(gen_random_uuid(), NULL, '${escapeSqlLiteral(SUBJECT_NAME)}')
       WHERE match_kind = 'name';
    `);
    expect(counted).toBe('graded_tests=2 student_evaluations=1');

    const unchecked = queryScalar(`
      SELECT count(*) FROM public.user_data_footprint('${userId}')
       WHERE match_kind = 'name' AND row_count = -1;
    `);
    expect(Number(unchecked)).toBe(2);
  });

  it('treats a degenerate name as "not checked", never as a clean sweep', () => {
    // "Γ. Π." normalises to two one-character tokens — nothing searchable.
    // find_erasure_name_matches raises 22023 for it, and the footprint maps
    // that to -1 on both name rows: the same contract as a missing email,
    // and the fix for a profile name of initials silently reporting zero.
    const unusable = queryScalar(`
      SELECT count(*) FROM public.user_data_footprint(gen_random_uuid(), NULL, 'Γ. Π.')
       WHERE match_kind = 'name' AND row_count = -1;
    `);
    expect(Number(unusable)).toBe(2);
  });
});

describe('user_data_footprint', () => {
  it('reports -1 for email-keyed sources when called without an email', () => {
    const unchecked = queryScalar(
      `SELECT count(*) FROM public.user_data_footprint('${userId}') WHERE row_count = -1;`
    );
    expect(Number(unchecked)).toBeGreaterThan(0);
  });

  it('finds seeded rows, and nothing at all once the account is deleted', async () => {
    // Three shapes at once: a row that must be deleted (login_history — the
    // hole this issue opened on), one that must survive anonymised
    // (ai_usage_logs), and one carrying the subject's own words
    // (agent_interaction_logs).
    execSql(`
      INSERT INTO public.login_history (user_id, ip_address, user_agent)
        VALUES ('${userId}', '203.0.113.42', 'erasure-fixture');
      INSERT INTO public.ai_usage_logs (user_id, function_name, model, status)
        VALUES ('${userId}', '${FIXTURE_FN}', 'test-model', 'success');
      INSERT INTO public.agent_interaction_logs (user_id, function_name, user_message)
        VALUES ('${userId}', '${FIXTURE_FN}', 'something the student typed');
      INSERT INTO public.notifications (user_id, type, title)
        VALUES ('${userId}', 'test', 'Erasure fixture');
      INSERT INTO public.bug_reports (reporter_id, reporter_email, title, description)
        VALUES ('${userId}', '${escapeSqlLiteral(SUBJECT_EMAIL)}', 'Fixture', 'Fixture report');
    `);

    const before = footprint(userId, SUBJECT_EMAIL);
    expect(before).toContain('login_history.user_id=1');
    expect(before).toContain('agent_interaction_logs.user_id=1');
    expect(before).toContain('notifications.user_id=1');

    const { error } = await admin.auth.admin.deleteUser(userId);
    expect(error).toBeNull();

    // Everything keyed by the user id is gone by cascade. `bug_reports` and
    // `invitations` are keyed by email and are the edge function's job, so they
    // are asserted separately below rather than expected to be zero here.
    const after = footprint(userId, null);
    expect(after).toEqual([]);

    // The usage log survives with its attribution dropped: token counts stay
    // countable, the person does not.
    const usage = queryScalar(
      `SELECT count(*) FROM public.ai_usage_logs
        WHERE function_name = '${FIXTURE_FN}' AND user_id IS NULL;`
    );
    expect(Number(usage)).toBe(1);

    // The bug report survives too, but its reporter link is severed. The email
    // copy is cleared by delete-user, not by the FK, so it is still set here.
    const report = queryScalar(
      `SELECT count(*) FROM public.bug_reports
        WHERE title = 'Fixture' AND reporter_id IS NULL;`
    );
    expect(Number(report)).toBe(1);
    execSql(`DELETE FROM public.bug_reports WHERE title = 'Fixture';`);

    // The chat trace, which SET NULL would have left readable, is gone.
    const traces = queryScalar(
      `SELECT count(*) FROM public.agent_interaction_logs WHERE function_name = '${FIXTURE_FN}';`
    );
    expect(Number(traces)).toBe(0);
  });
});
