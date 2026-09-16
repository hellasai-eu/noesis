import {
  assert,
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  buildUserExport,
  CHILD_SPECS,
  ROOT_SPECS,
  type ExportDb,
  type FetchOpts,
  type Row,
} from "../../export-data/user-export.ts";

const SUBJECT = "11111111-1111-1111-1111-111111111111";
const INST_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const INST_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const COURSE_A = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const COURSE_B = "dddddddd-dddd-dddd-dddd-dddddddddddd";

interface FakeDbOptions {
  /** Tables absent from this map behave as empty tables. */
  tables: Record<string, Row[]>;
  /** Tables that error on every read, mapped to the error message. */
  failing?: Record<string, string>;
  authUser?: Row | null;
}

function createFakeDb(options: FakeDbOptions) {
  const calls: FetchOpts[] = [];

  const db: ExportDb = {
    fetch(opts) {
      calls.push(opts);
      const failure = options.failing?.[opts.table];
      if (failure) return Promise.resolve({ data: [], error: failure });

      const rows = options.tables[opts.table] ?? [];
      const matched = rows.filter((row) =>
        opts.op === "eq"
          ? row[opts.column] === opts.value
          : (opts.values ?? []).includes(row[opts.column] as string)
      );
      // Deep-copy so a test can never observe the fixture being mutated.
      return Promise.resolve({ data: matched.map((row) => ({ ...row })) });
    },
    getAuthUser: () => Promise.resolve(options.authUser ?? null),
  };

  return { db, calls };
}

/** Baseline fixture: the subject studies at institution A and B. */
function baseTables(): Record<string, Row[]> {
  return {
    profiles: [
      { id: "p1", user_id: SUBJECT, email: "student@example.com", full_name: "Test Student" },
    ],
    institutions: [
      { id: INST_A, name: "School A", slug: "school-a", country: "GR" },
      { id: INST_B, name: "School B", slug: "school-b", country: "GR" },
    ],
    courses: [
      { id: COURSE_A, institution_id: INST_A },
      { id: COURSE_B, institution_id: INST_B },
    ],
    user_institutions: [
      { id: "ui1", user_id: SUBJECT, institution_id: INST_A, role: "student" },
      { id: "ui2", user_id: SUBJECT, institution_id: INST_B, role: "student" },
    ],
  };
}

function institutionSection(result: Awaited<ReturnType<typeof buildUserExport>>, id: string) {
  return result.by_institution.find((entry) => entry.institution.id === id);
}

const OPTS = { userId: SUBJECT, exportedBy: "admin@example.com", exportedAt: "2026-07-25T00:00:00.000Z" };

Deno.test("user-export: groups course-scoped rows under the owning institution", async () => {
  const tables = baseTables();
  tables.quiz_answers = [
    { id: "qa1", user_id: SUBJECT, course_id: COURSE_A, selected_answer: "A" },
    { id: "qa2", user_id: SUBJECT, course_id: COURSE_B, selected_answer: "B" },
  ];

  const { db } = createFakeDb({ tables });
  const result = await buildUserExport(db, OPTS);

  const a = institutionSection(result, INST_A);
  const b = institutionSection(result, INST_B);
  assertEquals(a?.institution.name, "School A");
  assertEquals(a?.data.quiz_answers.map((r) => r.id), ["qa1"]);
  assertEquals(b?.data.quiz_answers.map((r) => r.id), ["qa2"]);
  // One school's section must never contain the other school's rows.
  assertEquals(a?.data.quiz_answers.length, 1);
  assertEquals(result.unattributed.quiz_answers, undefined);
});

Deno.test("user-export: account-level tables stay out of the institution sections", async () => {
  const tables = baseTables();
  tables.login_history = [{ id: "l1", user_id: SUBJECT, ip_address: "10.0.0.1" }];
  tables.notifications = [{ id: "n1", user_id: SUBJECT, title: "Welcome" }];

  const { db } = createFakeDb({ tables });
  const result = await buildUserExport(db, OPTS);

  assertEquals(result.account.login_history.map((r) => r.id), ["l1"]);
  assertEquals(result.account.notifications.map((r) => r.id), ["n1"]);
  for (const entry of result.by_institution) {
    assertEquals(entry.data.login_history, undefined);
    assertEquals(entry.data.notifications, undefined);
  }
});

Deno.test("user-export: rows whose institution cannot be derived land in unattributed", async () => {
  const tables = baseTables();
  // Course row is gone, so the hop resolves to nothing.
  tables.quiz_answers = [{ id: "qa1", user_id: SUBJECT, course_id: "99999999-9999-9999-9999-999999999999" }];

  const { db } = createFakeDb({ tables });
  const result = await buildUserExport(db, OPTS);

  assertEquals(result.unattributed.quiz_answers.map((r) => r.id), ["qa1"]);
  assertEquals(result.export_metadata.row_counts.quiz_answers, 1);
});

Deno.test("user-export: child rows inherit their parent's institution", async () => {
  const tables = baseTables();
  tables.student_evaluations = [{ id: "ev1", user_id: SUBJECT, course_id: COURSE_B }];
  tables.evaluation_competency_scores = [
    { id: "sc1", evaluation_id: "ev1", score: 4 },
    { id: "sc2", evaluation_id: "ev1", score: 5 },
  ];

  const { db } = createFakeDb({ tables });
  const result = await buildUserExport(db, OPTS);

  const b = institutionSection(result, INST_B);
  assertEquals(b?.data.evaluation_competency_scores.map((r) => r.id), ["sc1", "sc2"]);
  // The scores follow the evaluation's course, not the subject's other membership.
  assertEquals(institutionSection(result, INST_A)?.data.evaluation_competency_scores, undefined);
  assertEquals(result.unattributed.evaluation_competency_scores, undefined);
});

Deno.test("user-export: email-keyed tables match on the subject's profile email", async () => {
  const tables = baseTables();
  tables.invitations = [
    { id: "inv1", email: "student@example.com", institution_id: INST_A },
    { id: "inv2", email: "someone-else@example.com", institution_id: INST_A },
  ];

  const { db } = createFakeDb({ tables });
  const result = await buildUserExport(db, OPTS);

  assertEquals(institutionSection(result, INST_A)?.data.invitations.map((r) => r.id), ["inv1"]);
});

Deno.test("user-export: a row matching several identifiers is exported once", async () => {
  const tables = baseTables();
  // The subject is both the student and the grader on this test.
  tables.graded_tests = [
    { id: "gt1", student_id: SUBJECT, graded_by: SUBJECT, created_by: SUBJECT, course_id: COURSE_A },
  ];

  const { db } = createFakeDb({ tables });
  const result = await buildUserExport(db, OPTS);

  assertEquals(institutionSection(result, INST_A)?.data.graded_tests.length, 1);
  assertEquals(result.export_metadata.row_counts.graded_tests, 1);
});

Deno.test("user-export: an unreadable table is reported without aborting the export", async () => {
  const tables = baseTables();
  tables.quiz_answers = [{ id: "qa1", user_id: SUBJECT, course_id: COURSE_A }];

  const { db } = createFakeDb({ tables, failing: { login_history: "permission denied" } });
  const result = await buildUserExport(db, OPTS);

  assertEquals(result.errors?.login_history, "permission denied");
  assertEquals(result.account.login_history, undefined);
  // The rest of the document is still complete.
  assertEquals(institutionSection(result, INST_A)?.data.quiz_answers.length, 1);
});

Deno.test("user-export: a failed institution lookup is reported, not silently unattributed", async () => {
  const tables = baseTables();
  tables.quiz_answers = [{ id: "qa1", user_id: SUBJECT, course_id: COURSE_A }];

  // The rows are readable but the hop to their institution is not.
  const { db } = createFakeDb({ tables, failing: { courses: "connection reset" } });
  const result = await buildUserExport(db, OPTS);

  // Without this the operator would hand a school an empty section and believe
  // the export was complete.
  assertEquals(result.errors?.["courses (institution lookup)"], "connection reset");
  assertEquals(result.unattributed.quiz_answers.map((r) => r.id), ["qa1"]);
  assertEquals(institutionSection(result, INST_A)?.data.quiz_answers, undefined);
});

Deno.test("user-export: a hop failure is keyed apart from the table's own read failure", async () => {
  const tables = baseTables();
  tables.quiz_answers = [{ id: "qa1", user_id: SUBJECT, course_id: COURSE_A }];
  tables.courses = [{ id: COURSE_A, institution_id: INST_A, created_by: SUBJECT }];

  // `courses` is both a hop target and an exported table; one failure must not
  // be mistaken for the other.
  const { db } = createFakeDb({ tables, failing: { courses: "permission denied" } });
  const result = await buildUserExport(db, OPTS);

  assertEquals(result.errors?.["courses"], "permission denied");
  assertEquals(result.errors?.["courses (institution lookup)"], "permission denied");
});

Deno.test("user-export: authorship tables are limited to the attribution columns", async () => {
  const tables = baseTables();
  tables.questions = [{ id: "q1", created_by: SUBJECT, course_id: COURSE_A }];

  const { db, calls } = createFakeDb({ tables });
  await buildUserExport(db, OPTS);

  const questionCall = calls.find((c) => c.table === "questions" && c.column === "created_by");
  assertExists(questionCall);
  assertEquals(questionCall.columns, "id,course_id,type,created_by,created_at");
  // The question text and answer key are never requested.
  assert(!questionCall.columns!.includes("payload"));
  assert(!questionCall.columns!.includes("answer_key"));
});

Deno.test("user-export: metadata names every institution the export touches", async () => {
  const tables = baseTables();
  tables.quiz_answers = [{ id: "qa1", user_id: SUBJECT, course_id: COURSE_A }];

  const { db } = createFakeDb({ tables, authUser: { id: SUBJECT, email: "student@example.com", created_at: "2026-01-01T00:00:00.000Z" } });
  const result = await buildUserExport(db, OPTS);

  const meta = result.export_metadata;
  assertEquals(meta.subject.email, "student@example.com");
  assertEquals(meta.subject.full_name, "Test Student");
  assertEquals(meta.exported_by, "admin@example.com");
  assertEquals(meta.exported_at, "2026-07-25T00:00:00.000Z");
  assertEquals(meta.institutions.map((i) => i.name).sort(), ["School A", "School B"]);
  assert(meta.notes.length > 0);
});

Deno.test("user-export: an empty subject produces a well-formed empty document", async () => {
  const { db } = createFakeDb({ tables: {} });
  const result = await buildUserExport(db, { ...OPTS, userId: "22222222-2222-2222-2222-222222222222" });

  assertEquals(result.by_institution, []);
  assertEquals(result.account, {});
  assertEquals(result.unattributed, {});
  assertEquals(result.export_metadata.subject.email, null);
});

Deno.test("user-export: specs are internally consistent", () => {
  const rootTables = new Set(ROOT_SPECS.map((s) => s.table));
  assertEquals(rootTables.size, ROOT_SPECS.length, "duplicate root table spec");

  for (const child of CHILD_SPECS) {
    assert(rootTables.has(child.parentTable), `child ${child.table} has no root parent`);
    assert(!rootTables.has(child.table), `${child.table} is declared as both root and child`);
  }

  for (const spec of ROOT_SPECS) {
    assert(spec.match.length > 0, `${spec.table} has no match rules`);
    const columns = spec.match.map((m) => m.column);
    assertEquals(new Set(columns).size, columns.length, `${spec.table} has duplicate match columns`);
    // Column allowlists must keep `id`, which the child lookups and de-duplication rely on.
    if (spec.columns) {
      assert(spec.columns.split(",").includes("id"), `${spec.table} allowlist drops id`);
    }
  }
});
