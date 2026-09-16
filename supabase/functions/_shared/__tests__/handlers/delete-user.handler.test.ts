import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { createTestHarness, parseResponse, type MockRoute } from "../handler-harness.ts";
import { handler } from "../../../delete-user/handler.ts";

Deno.test("delete-user: OPTIONS returns CORS headers", async () => {
  const h = createTestHarness();
  try {
    const req = new Request("http://localhost/functions/v1/delete-user", { method: "OPTIONS" });
    const res = await handler(req);
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  } finally { h.cleanup(); }
});

Deno.test("delete-user: returns 400 when userId is missing", async () => {
  const h = createTestHarness();
  try {
    const res = await h.invoke(handler, {});
    const { status, body } = await parseResponse(res);
    assertEquals(status, 400);
    assertEquals(body.error.includes("userId") || body.error.includes("required"), true);
  } finally { h.cleanup(); }
});

Deno.test("delete-user: returns 401 when no authorization header", async () => {
  const h = createTestHarness();
  try {
    const res = await h.invoke(handler, { userId: "user-1" });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 401);
  } finally { h.cleanup(); }
});

// ── Complete erasure (issue #932) ──────────────────────────────────────
//
// The foreign keys added in 20260726000000 are what erase the user-id-keyed
// tables, and they are covered by the DB suite
// (supabase/tests/rls/__tests__/user-erasure.test.ts). What these tests pin
// down is the part no foreign key can reach and that therefore lives in the
// handler: storage objects, email-keyed rows, and the moderation payload.

const TARGET = "11111111-1111-4111-8111-111111111111";
const CALLER = "22222222-2222-4222-8222-222222222222";
const TARGET_EMAIL = "erased@test.local";
const TARGET_NAME = "Γιώργος Παπαδόπουλος";

/** Routes for an authorized super admin deleting TARGET, with nothing to erase. */
function baseRoutes(overrides: MockRoute[] = []): MockRoute[] {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  return [
    ...overrides,
    // Caller identity + privilege
    { match: (u) => u.includes("/auth/v1/user"), respond: () => json({ id: CALLER, email: "root@test.local" }) },
    { match: (u) => u.includes("/rest/v1/rpc/is_super_admin"), respond: () => json(true) },
    // Subject's auth record (for the email-keyed sweep) and its deletion
    {
      match: (u, init) => u.includes(`/auth/v1/admin/users/${TARGET}`) && (init?.method ?? "GET") === "GET",
      respond: () => json({ id: TARGET, email: TARGET_EMAIL }),
    },
    {
      match: (u, init) => u.includes("/auth/v1/admin/users/") && init?.method === "DELETE",
      respond: () => json({}),
    },
    // Subject's display name (read before the profile row cascades) and the
    // post-deletion sweep of instructor-typed names, which finds nothing.
    {
      match: (u, init) => u.includes("/rest/v1/profiles") && (init?.method ?? "GET") === "GET",
      respond: () => json({ full_name: TARGET_NAME }),
    },
    { match: (u) => u.includes("/rest/v1/rpc/find_erasure_name_matches"), respond: () => json([]) },
    // Storage: no objects under the user's prefix, and removals succeed
    { match: (u) => u.includes("/storage/v1/object/list/"), respond: () => json([]) },
    {
      match: (u, init) => u.includes("/storage/v1/object/") && init?.method === "DELETE",
      respond: () => json([]),
    },
    // Every remaining REST call (selects, deletes, audit insert)
    { match: (u) => u.includes("/rest/v1/"), respond: () => json([]) },
  ];
}

function invokeAsSuperAdmin(h: ReturnType<typeof createTestHarness>) {
  return h.invoke(handler, { userId: TARGET }, { headers: { Authorization: "Bearer caller-token" } });
}

/** Calls matching a path fragment, optionally filtered by method. */
function calls(h: ReturnType<typeof createTestHarness>, fragment: string, method?: string) {
  return h.fetchLog.filter(
    (c) => c.url.includes(fragment) && (method === undefined || c.method === method),
  );
}

Deno.test("delete-user: erases the rows the FKs cannot reach, keyed by id and email", async () => {
  const h = createTestHarness({ routes: baseRoutes() });
  try {
    const { status, body } = await parseResponse(await invokeAsSuperAdmin(h));
    assertEquals(status, 200);
    assertEquals(body.success, true);
    assertEquals(body.warnings, []);

    // Email-keyed rows and the flagged_content payload are erased in SQL, so
    // the match is case-insensitive and cannot be widened by an underscore in
    // the address. Both identifiers have to reach the function.
    const rpc = calls(h, "/rest/v1/rpc/erase_user_unlinked_data", "POST");
    assertEquals(rpc.length, 1);
    assertEquals(JSON.parse(rpc[0].body ?? "{}"), { _user_id: TARGET, _email: TARGET_EMAIL });
  } finally { h.cleanup(); }
});

Deno.test("delete-user: warns when the subject has no email to match on", async () => {
  const h = createTestHarness({
    routes: baseRoutes([
      {
        match: (u, init) => u.includes(`/auth/v1/admin/users/${TARGET}`) && (init?.method ?? "GET") === "GET",
        respond: () =>
          new Response(JSON.stringify({ id: TARGET }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      },
      {
        match: (u) => u.includes("/rest/v1/rpc/erase_user_unlinked_data"),
        respond: () =>
          new Response(JSON.stringify({ email_checked: false, screenshot_paths: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      },
    ]),
  });
  try {
    const { status, body } = await parseResponse(await invokeAsSuperAdmin(h));
    assertEquals(status, 200);
    assertEquals(body.warnings.map((w: { source: string }) => w.source), ["email"]);
  } finally { h.cleanup(); }
});

Deno.test("delete-user: removes the storage objects behind the anonymised bug reports", async () => {
  const screenshot = `${TARGET}/9f0-shot.png`;
  const h = createTestHarness({
    routes: baseRoutes([
      {
        match: (u) => u.includes("/rest/v1/rpc/erase_user_unlinked_data"),
        respond: () =>
          new Response(
            JSON.stringify({ email_checked: true, bug_reports: 1, screenshot_paths: [screenshot] }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      },
      {
        match: (u) => u.includes("/storage/v1/object/list/bug-reports"),
        respond: () =>
          new Response(JSON.stringify([{ name: "9f0-shot.png", id: "obj-1" }]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      },
    ]),
  });
  try {
    const { status, body } = await parseResponse(await invokeAsSuperAdmin(h));
    assertEquals(status, 200);
    assertEquals(body.warnings, []);
    assertEquals(body.storageObjectsRemoved, 1);

    const removals = calls(h, "/storage/v1/object/bug-reports", "DELETE");
    assertEquals(removals.length, 1);
    assertEquals(removals[0].body?.includes(screenshot), true);
  } finally { h.cleanup(); }
});

Deno.test("delete-user: a failed erasure step warns but still deletes the account", async () => {
  const h = createTestHarness({
    routes: baseRoutes([
      {
        match: (u) => u.includes("/storage/v1/object/list/bug-reports"),
        respond: () =>
          new Response(JSON.stringify({ message: "bucket not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          }),
      },
    ]),
  });
  try {
    const { status, body } = await parseResponse(await invokeAsSuperAdmin(h));
    assertEquals(status, 200);
    assertEquals(body.success, true);
    assertEquals(body.warnings.length, 1);
    assertEquals(body.warnings[0].source, "storage:bug-reports");

    // The account still went, and the audit row records the gap.
    assertEquals(calls(h, "/auth/v1/admin/users/", "DELETE").length, 1);
    const audit = calls(h, "/rest/v1/audit_logs", "POST");
    assertEquals(audit.length >= 1, true);
    assertEquals(
      JSON.parse(audit[0].body ?? "{}").metadata.erasure_warnings,
      ["storage:bug-reports"],
    );
  } finally { h.cleanup(); }
});

Deno.test("delete-user: surviving typed-name rows come back for review, as a count in the audit", async () => {
  // The sweep runs AFTER auth deletion with the name read from the profile
  // beforehand; what it finds reaches the caller in full (the admin must see
  // the rows to review them) but the audit row gets only a count — the
  // candidate rows quote the typed name itself, which the audit must outlive.
  const candidate = {
    source_table: "graded_tests",
    row_id: "33333333-3333-4333-8333-333333333333",
    student_name: TARGET_NAME,
    linked_user_id: null,
    course_id: "44444444-4444-4444-8444-444444444444",
    created_at: "2026-01-01T00:00:00Z",
  };
  const h = createTestHarness({
    routes: baseRoutes([
      {
        match: (u) => u.includes("/rest/v1/rpc/find_erasure_name_matches"),
        respond: () =>
          new Response(JSON.stringify([candidate]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      },
    ]),
  });
  try {
    const { status, body } = await parseResponse(await invokeAsSuperAdmin(h));
    assertEquals(status, 200);
    assertEquals(body.warnings, []);
    assertEquals(body.nameReviewCandidates.length, 1);
    assertEquals(body.nameReviewCandidates[0].source, "graded_tests");
    assertEquals(body.nameReviewCandidates[0].studentName, TARGET_NAME);
    assertEquals(body.nameReviewCandidates[0].linkedUserId, null);

    // The sweep was keyed on the profile's display name.
    const rpc = calls(h, "/rest/v1/rpc/find_erasure_name_matches", "POST");
    assertEquals(rpc.length, 1);
    assertEquals(JSON.parse(rpc[0].body ?? "{}"), { _name: TARGET_NAME });

    // Count in the audit, never the name.
    const audit = calls(h, "/rest/v1/audit_logs", "POST");
    assertEquals(audit.length >= 1, true);
    assertEquals(JSON.parse(audit[0].body ?? "{}").metadata.name_review_candidates, 1);
    for (const call of audit) {
      assertEquals(call.body?.includes(TARGET_NAME), false);
    }
  } finally { h.cleanup(); }
});

Deno.test("delete-user: warns when the subject has no profile name to sweep on", async () => {
  const h = createTestHarness({
    routes: baseRoutes([
      {
        match: (u, init) => u.includes("/rest/v1/profiles") && (init?.method ?? "GET") === "GET",
        respond: () =>
          new Response(JSON.stringify(null), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      },
    ]),
  });
  try {
    const { status, body } = await parseResponse(await invokeAsSuperAdmin(h));
    assertEquals(status, 200);
    // Same contract as the missing-email warning: the admin must know the
    // typed-name columns were never checked, or they will confirm a complete
    // erasure on the strength of a sweep that did not run.
    assertEquals(body.warnings.map((w: { source: string }) => w.source), ["name"]);
    assertEquals(calls(h, "/rest/v1/rpc/find_erasure_name_matches").length, 0);
  } finally { h.cleanup(); }
});

Deno.test("delete-user: a degenerate profile name warns instead of reporting a clean sweep", async () => {
  // "Γ. Π." yields no searchable token; the SQL function raises 22023 and the
  // handler must surface the same `name` warning as a missing name — an empty
  // candidate list here would read as "searched, found nothing".
  const h = createTestHarness({
    routes: baseRoutes([
      {
        match: (u) => u.includes("/rest/v1/rpc/find_erasure_name_matches"),
        respond: () =>
          new Response(
            JSON.stringify({
              code: "22023",
              message: "name yields no usable tokens (2+ characters): free-text name columns cannot be searched",
            }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          ),
      },
    ]),
  });
  try {
    const { status, body } = await parseResponse(await invokeAsSuperAdmin(h));
    assertEquals(status, 200);
    assertEquals(body.warnings.map((w: { source: string }) => w.source), ["name"]);
    assertEquals(body.nameReviewCandidates, []);
  } finally { h.cleanup(); }
});

Deno.test("delete-user: audit metadata never carries the erased user's email", async () => {
  const h = createTestHarness({ routes: baseRoutes() });
  try {
    await invokeAsSuperAdmin(h);
    for (const call of calls(h, "/rest/v1/audit_logs", "POST")) {
      assertEquals(call.body?.includes(TARGET_EMAIL), false);
    }
  } finally { h.cleanup(); }
});
