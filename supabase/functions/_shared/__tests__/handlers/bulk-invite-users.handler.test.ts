import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  createTestHarness,
  parseResponse,
  supabaseRoute,
  type MockRoute,
} from "../handler-harness.ts";
import { handler } from "../../../bulk-invite-users/handler.ts";

// ── Helpers ────────────────────────────────────────────────────────────

const TEST_CALLER_ID = "11111111-2222-3333-4444-555555555555";
const TEST_INSTITUTION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const TEST_CLASS_ID = "99999999-8888-7777-6666-555555555555";

function authRoute(callerId: string = TEST_CALLER_ID): MockRoute {
  return {
    match: (url) => url.includes("/auth/v1/user"),
    respond: () =>
      new Response(JSON.stringify({ id: callerId, email: "admin@test.com" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  };
}

function rpcRoute(name: string, result: unknown): MockRoute {
  return {
    match: (url, init) => {
      if (!url.includes(`/rest/v1/rpc/${name}`)) return false;
      return (init?.method ?? "POST").toUpperCase() === "POST";
    },
    respond: () =>
      new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  };
}

function buildAuthorizedRoutes(opts: {
  classesResponse?: unknown[];
  existingMembers?: Array<{ user_id: string; profiles: { email: string | null } | null }>;
  existingInvitations?: Array<{ email: string; status: string }>;
  invitationsInsertResponse?: unknown;
  gradeLevelsResponse?: unknown;
}): MockRoute[] {
  return [
    authRoute(),
    rpcRoute("is_super_admin", true),
    rpcRoute("is_institution_admin", true),
    {
      // grade_levels lookup for the dual-write resolve — return a matching row
      // by default so student invites can populate the FK.
      match: (url, init) =>
        url.includes("/rest/v1/grade_levels") &&
        (init?.method ?? "GET").toUpperCase() === "GET",
      respond: () =>
        new Response(
          JSON.stringify(
            opts.gradeLevelsResponse ?? { id: "gl-bulk-1" },
          ),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    },
    {
      // classes lookup
      match: (url, init) =>
        url.includes("/rest/v1/classes") && (init?.method ?? "GET").toUpperCase() === "GET",
      respond: () =>
        new Response(JSON.stringify(opts.classesResponse ?? []), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    },
    {
      // user_institutions list with profiles join
      match: (url, init) =>
        url.includes("/rest/v1/user_institutions") &&
        (init?.method ?? "GET").toUpperCase() === "GET",
      respond: () =>
        new Response(JSON.stringify(opts.existingMembers ?? []), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    },
    {
      // invitations list (status in ...)
      match: (url, init) =>
        url.includes("/rest/v1/invitations") &&
        (init?.method ?? "GET").toUpperCase() === "GET",
      respond: () =>
        new Response(JSON.stringify(opts.existingInvitations ?? []), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    },
    supabaseRoute(
      "/rest/v1/invitations",
      opts.invitationsInsertResponse ?? [{ id: "inv-new-123" }],
      { method: "POST" },
    ),
  ];
}

// ── Validation tests ───────────────────────────────────────────────────

Deno.test("bulk-invite-users: returns 400 when institutionId missing", async () => {
  const h = createTestHarness();
  try {
    const res = await h.invoke(handler, { role: "student", rows: [{ email: "a@b.com" }] });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 400);
    assertEquals(body.error, "institutionId is required");
  } finally {
    h.cleanup();
  }
});

Deno.test("bulk-invite-users: returns 400 when role is invalid", async () => {
  const h = createTestHarness();
  try {
    const res = await h.invoke(handler, {
      institutionId: TEST_INSTITUTION_ID,
      role: "admin",
      rows: [{ email: "a@b.com" }],
    });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 400);
    assertEquals(body.error, "role must be 'student' or 'instructor'");
  } finally {
    h.cleanup();
  }
});

Deno.test("bulk-invite-users: returns 400 when rows empty", async () => {
  const h = createTestHarness();
  try {
    const res = await h.invoke(handler, {
      institutionId: TEST_INSTITUTION_ID,
      role: "student",
      rows: [],
    });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 400);
    assertEquals(body.error, "rows must be a non-empty array");
  } finally {
    h.cleanup();
  }
});

Deno.test("bulk-invite-users: returns 400 when student grade level empty", async () => {
  const h = createTestHarness();
  try {
    const res = await h.invoke(handler, {
      institutionId: TEST_INSTITUTION_ID,
      role: "student",
      gradeLevel: "   ",
      sectionStrategy: "same",
      sharedSectionName: "Α",
      rows: [{ email: "a@b.com" }],
    });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 400);
    assertEquals(body.error, "Valid gradeLevel is required for student bulk import");
  } finally {
    h.cleanup();
  }
});

Deno.test("bulk-invite-users: returns 400 when student strategy 'same' but no sharedSectionName", async () => {
  const h = createTestHarness();
  try {
    const res = await h.invoke(handler, {
      institutionId: TEST_INSTITUTION_ID,
      role: "student",
      gradeLevel: "dimotiko_1",
      sectionStrategy: "same",
      rows: [{ email: "a@b.com" }],
    });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 400);
    assertEquals(
      body.error,
      "sharedSectionName is required when sectionStrategy is 'same'",
    );
  } finally {
    h.cleanup();
  }
});

// ── Auth tests ─────────────────────────────────────────────────────────

Deno.test("bulk-invite-users: returns 401 when no Authorization header", async () => {
  const h = createTestHarness();
  try {
    const res = await h.invoke(handler, {
      institutionId: TEST_INSTITUTION_ID,
      role: "instructor",
      rows: [{ email: "a@b.com" }],
    });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 401);
    assertEquals(body.error, "Unauthorized");
  } finally {
    h.cleanup();
  }
});

Deno.test("bulk-invite-users: returns 403 when caller is neither admin nor super admin", async () => {
  const h = createTestHarness({
    routes: [
      authRoute(),
      rpcRoute("is_super_admin", false),
      rpcRoute("is_institution_admin", false),
    ],
  });
  try {
    const res = await h.invoke(
      handler,
      {
        institutionId: TEST_INSTITUTION_ID,
        role: "instructor",
        rows: [{ email: "a@b.com" }],
      },
      { headers: { Authorization: "Bearer fake" } },
    );
    const { status, body } = await parseResponse(res);
    assertEquals(status, 403);
    assertEquals(
      body.error,
      "Only institution admins or super admins can bulk-invite users",
    );
  } finally {
    h.cleanup();
  }
});

// ── Successful student invite (same section) ───────────────────────────

Deno.test("bulk-invite-users: invites student rows when section resolves", async () => {
  const h = createTestHarness({
    routes: buildAuthorizedRoutes({
      classesResponse: [{ id: TEST_CLASS_ID, section_name: "Α" }],
      existingMembers: [],
      existingInvitations: [],
      invitationsInsertResponse: [{ id: "inv-1" }],
    }),
  });
  try {
    const res = await h.invoke(
      handler,
      {
        institutionId: TEST_INSTITUTION_ID,
        role: "student",
        gradeLevel: "dimotiko_1",
        sectionStrategy: "same",
        sharedSectionName: "Α",
        rows: [
          { email: "ada@example.com", firstName: "Ada", lastName: "Lovelace" },
        ],
        institutionName: "Test School",
        inviterName: "Admin",
      },
      { headers: { Authorization: "Bearer token" } },
    );
    const { status, body } = await parseResponse(res);
    assertEquals(status, 200);
    assertEquals(body.success, true);
    assertEquals(body.summary.invited, 1);
    assertEquals(body.summary.skipped, 0);
    assertEquals(body.summary.failed, 0);
    assertEquals(body.results[0].email, "ada@example.com");
    assertEquals(body.results[0].status, "invited");
  } finally {
    h.cleanup();
  }
});

// ── Dual-write grade_level_id (#796) ──────────────────────────────────

Deno.test("bulk-invite-users: student invitation insert dual-writes invited_grade_level_id", async () => {
  const h = createTestHarness({
    routes: buildAuthorizedRoutes({
      classesResponse: [{ id: TEST_CLASS_ID, section_name: "Α" }],
      existingMembers: [],
      existingInvitations: [],
      gradeLevelsResponse: { id: "gl-dimotiko-1" },
    }),
  });
  try {
    const res = await h.invoke(
      handler,
      {
        institutionId: TEST_INSTITUTION_ID,
        role: "student",
        gradeLevel: "dimotiko_1",
        sectionStrategy: "same",
        sharedSectionName: "Α",
        rows: [{ email: "grade-fk@example.com", firstName: "Ada" }],
        institutionName: "Test School",
        inviterName: "Admin",
      },
      { headers: { Authorization: "Bearer token" } },
    );
    const { status, body } = await parseResponse(res);
    assertEquals(status, 200);
    assertEquals(body.summary.invited, 1);

    const insertCall = h.fetchLog.find(
      (c) => c.url.includes("/rest/v1/invitations") && c.method === "POST",
    );
    assertEquals(insertCall !== undefined, true);
    const payload = JSON.parse(insertCall!.body!);
    assertEquals(payload.invited_grade_level, undefined);
    assertEquals(payload.invited_grade_level_id, "gl-dimotiko-1");
  } finally {
    h.cleanup();
  }
});

Deno.test("bulk-invite-users: instructor invitation writes null grade_level_id (no grade attached)", async () => {
  const h = createTestHarness({
    routes: buildAuthorizedRoutes({
      classesResponse: [],
      existingMembers: [],
      existingInvitations: [],
    }),
  });
  try {
    const res = await h.invoke(
      handler,
      {
        institutionId: TEST_INSTITUTION_ID,
        role: "instructor",
        rows: [{ email: "teacher@example.com" }],
        institutionName: "Test School",
        inviterName: "Admin",
      },
      { headers: { Authorization: "Bearer token" } },
    );
    const { status } = await parseResponse(res);
    assertEquals(status, 200);
    const insertCall = h.fetchLog.find(
      (c) => c.url.includes("/rest/v1/invitations") && c.method === "POST",
    );
    const payload = JSON.parse(insertCall!.body!);
    // Instructors don't carry a grade — the FK stays null.
    assertEquals(payload.invited_grade_level, undefined);
    assertEquals(payload.invited_grade_level_id, null);
  } finally {
    h.cleanup();
  }
});

// ── Skip existing members ──────────────────────────────────────────────

Deno.test("bulk-invite-users: skips emails already in the institution", async () => {
  const h = createTestHarness({
    routes: buildAuthorizedRoutes({
      classesResponse: [{ id: TEST_CLASS_ID, section_name: "Α" }],
      existingMembers: [{ user_id: "u1", profiles: { email: "existing@example.com" } }],
      existingInvitations: [],
    }),
  });
  try {
    const res = await h.invoke(
      handler,
      {
        institutionId: TEST_INSTITUTION_ID,
        role: "student",
        gradeLevel: "dimotiko_1",
        sectionStrategy: "same",
        sharedSectionName: "Α",
        rows: [
          { email: "existing@example.com" },
          { email: "new@example.com" },
        ],
        institutionName: "Test School",
        inviterName: "Admin",
      },
      { headers: { Authorization: "Bearer token" } },
    );
    const { status, body } = await parseResponse(res);
    assertEquals(status, 200);
    assertEquals(body.summary.skipped, 1);
    assertEquals(body.summary.invited, 1);
    const skipped = body.results.find((r: { email: string }) => r.email === "existing@example.com");
    assertEquals(skipped.status, "skipped");
    assertEquals(skipped.reason, "Already a member of this institution");
  } finally {
    h.cleanup();
  }
});

// ── Skip existing pending invitations ──────────────────────────────────

Deno.test("bulk-invite-users: skips emails with existing pending invitations", async () => {
  const h = createTestHarness({
    routes: buildAuthorizedRoutes({
      classesResponse: [{ id: TEST_CLASS_ID, section_name: "Α" }],
      existingMembers: [],
      existingInvitations: [{ email: "pending@example.com", status: "pending" }],
    }),
  });
  try {
    const res = await h.invoke(
      handler,
      {
        institutionId: TEST_INSTITUTION_ID,
        role: "student",
        gradeLevel: "dimotiko_1",
        sectionStrategy: "same",
        sharedSectionName: "Α",
        rows: [{ email: "pending@example.com" }],
        institutionName: "Test School",
        inviterName: "Admin",
      },
      { headers: { Authorization: "Bearer token" } },
    );
    const { body } = await parseResponse(res);
    assertEquals(body.results[0].status, "skipped");
    assertEquals(body.results[0].reason, "Existing invitation for this email");
  } finally {
    h.cleanup();
  }
});

// ── Unknown section fails the row ──────────────────────────────────────

Deno.test("bulk-invite-users: flags row with unknown section as failed", async () => {
  const h = createTestHarness({
    routes: buildAuthorizedRoutes({
      classesResponse: [{ id: TEST_CLASS_ID, section_name: "Α" }],
    }),
  });
  try {
    const res = await h.invoke(
      handler,
      {
        institutionId: TEST_INSTITUTION_ID,
        role: "student",
        gradeLevel: "dimotiko_1",
        sectionStrategy: "per-row",
        rows: [{ email: "lost@example.com", sectionName: "Ω" }],
        institutionName: "Test School",
        inviterName: "Admin",
      },
      { headers: { Authorization: "Bearer token" } },
    );
    const { body } = await parseResponse(res);
    assertEquals(body.summary.failed, 1);
    assertEquals(body.results[0].status, "failed");
    assertEquals(
      body.results[0].reason,
      'Unknown section "Ω" for the selected grade level',
    );
  } finally {
    h.cleanup();
  }
});

// ── Per-row missing section is flagged ─────────────────────────────────

Deno.test("bulk-invite-users: flags per-row row with missing section as failed", async () => {
  const h = createTestHarness({
    routes: buildAuthorizedRoutes({
      classesResponse: [{ id: TEST_CLASS_ID, section_name: "Α" }],
    }),
  });
  try {
    const res = await h.invoke(
      handler,
      {
        institutionId: TEST_INSTITUTION_ID,
        role: "student",
        gradeLevel: "dimotiko_1",
        sectionStrategy: "per-row",
        rows: [{ email: "missing@example.com" }],
        institutionName: "Test School",
        inviterName: "Admin",
      },
      { headers: { Authorization: "Bearer token" } },
    );
    const { body } = await parseResponse(res);
    assertEquals(body.results[0].status, "failed");
    assertEquals(body.results[0].reason, "Missing section_name for per-row mode");
  } finally {
    h.cleanup();
  }
});

// ── Bad email format ───────────────────────────────────────────────────

Deno.test("bulk-invite-users: flags rows with bad email format", async () => {
  const h = createTestHarness({
    routes: buildAuthorizedRoutes({
      classesResponse: [{ id: TEST_CLASS_ID, section_name: "Α" }],
    }),
  });
  try {
    const res = await h.invoke(
      handler,
      {
        institutionId: TEST_INSTITUTION_ID,
        role: "student",
        gradeLevel: "dimotiko_1",
        sectionStrategy: "same",
        sharedSectionName: "Α",
        rows: [{ email: "not-an-email" }],
        institutionName: "Test School",
        inviterName: "Admin",
      },
      { headers: { Authorization: "Bearer token" } },
    );
    const { body } = await parseResponse(res);
    assertEquals(body.results[0].status, "failed");
    assertEquals(body.results[0].reason, "Invalid email format");
  } finally {
    h.cleanup();
  }
});

// ── Instructor flow accepts rows without grade levels ──────────────────

Deno.test("bulk-invite-users: instructor row without grade_levels invites successfully", async () => {
  const h = createTestHarness({
    routes: buildAuthorizedRoutes({
      classesResponse: [],
      existingMembers: [],
      existingInvitations: [],
    }),
  });
  try {
    const res = await h.invoke(
      handler,
      {
        institutionId: TEST_INSTITUTION_ID,
        role: "instructor",
        rows: [{ email: "teacher@example.com" }],
        institutionName: "Test School",
        inviterName: "Admin",
      },
      { headers: { Authorization: "Bearer token" } },
    );
    const { status, body } = await parseResponse(res);
    assertEquals(status, 200);
    assertEquals(body.summary.invited, 1);
    assertEquals(body.results[0].status, "invited");
  } finally {
    h.cleanup();
  }
});

// ── Instructor with empty grade level fails ───────────────────────────

Deno.test("bulk-invite-users: instructor row with empty grade_level is flagged", async () => {
  const h = createTestHarness({
    routes: buildAuthorizedRoutes({
      classesResponse: [],
    }),
  });
  try {
    const res = await h.invoke(
      handler,
      {
        institutionId: TEST_INSTITUTION_ID,
        role: "instructor",
        rows: [{ email: "teacher@example.com", gradeLevels: ["   "] }],
        institutionName: "Test School",
        inviterName: "Admin",
      },
      { headers: { Authorization: "Bearer token" } },
    );
    const { body } = await parseResponse(res);
    assertEquals(body.results[0].status, "failed");
    assertEquals(body.results[0].reason, "Empty grade_levels are not allowed");
  } finally {
    h.cleanup();
  }
});

// ── Duplicate within batch ─────────────────────────────────────────────

Deno.test("bulk-invite-users: flags duplicate emails within the same batch", async () => {
  const h = createTestHarness({
    routes: buildAuthorizedRoutes({
      classesResponse: [{ id: TEST_CLASS_ID, section_name: "Α" }],
    }),
  });
  try {
    const res = await h.invoke(
      handler,
      {
        institutionId: TEST_INSTITUTION_ID,
        role: "student",
        gradeLevel: "dimotiko_1",
        sectionStrategy: "same",
        sharedSectionName: "Α",
        rows: [{ email: "dup@example.com" }, { email: "dup@example.com" }],
        institutionName: "Test School",
        inviterName: "Admin",
      },
      { headers: { Authorization: "Bearer token" } },
    );
    const { body } = await parseResponse(res);
    assertEquals(body.summary.invited, 1);
    assertEquals(body.summary.failed, 1);
    const second = body.results[1];
    assertEquals(second.status, "failed");
    assertEquals(second.reason, "Duplicate email within batch");
  } finally {
    h.cleanup();
  }
});

// ── CORS preflight ─────────────────────────────────────────────────────

Deno.test("bulk-invite-users: OPTIONS returns CORS headers", async () => {
  const h = createTestHarness();
  try {
    const req = new Request("http://localhost:54321/functions/v1/bulk-invite-users", {
      method: "OPTIONS",
    });
    const res = await handler(req);
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  } finally {
    h.cleanup();
  }
});
