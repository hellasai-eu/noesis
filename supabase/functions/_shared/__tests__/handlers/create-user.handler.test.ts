import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  createTestHarness,
  FetchLogEntry,
  MockRoute,
  supabaseAuthRoute,
  supabaseRoute,
  parseResponse,
} from "../handler-harness.ts";
import { handler } from "../../../create-user/handler.ts";

// ── Caller identity (#926) ─────────────────────────────────────────────
// The handler authenticates the caller and requires them to be an admin of the
// target institution, so every test that expects to get past the gate has to
// present a bearer token AND mock the two calls the gate makes.

const CALLER_ID = "99999999-9999-9999-9999-999999999999";
const AUTH = { Authorization: "Bearer test-token" };

/** GoTrue's `/auth/v1/user` — what `auth.getUser(token)` resolves. */
function authUserRoute(user: unknown, status = 200): MockRoute {
  return {
    match: (url) => url.includes("/auth/v1/user"),
    respond: () =>
      new Response(JSON.stringify(user), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  };
}

/** The `is_institution_admin` RPC behind `isInstitutionAdmin()`. */
function institutionAdminRoute(allow: boolean): MockRoute {
  return {
    match: (url) => url.includes("/rest/v1/rpc/is_institution_admin"),
    respond: () =>
      new Response(JSON.stringify(allow), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  };
}

/** An authenticated institution admin of the target institution. */
const ADMIN_CALLER: MockRoute[] = [
  authUserRoute({ id: CALLER_ID, email: "admin@test.com" }),
  institutionAdminRoute(true),
];

/** Did the handler reach `auth.admin.createUser`? */
function createdAuthUser(fetchLog: FetchLogEntry[]): boolean {
  return fetchLog.some(
    (c) => c.url.includes("/auth/v1/admin/users") && c.method === "POST",
  );
}

// ── Authentication and authorization (#926) ────────────────────────────

Deno.test("create-user: 401 without an Authorization header, and creates nothing", async () => {
  const h = createTestHarness({ routes: ADMIN_CALLER });
  try {
    const res = await h.invoke(handler, {
      email: "attacker@test.com",
      password: "password123",
      institutionId: "inst-1",
      role: "admin",
    });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 401);
    assertEquals(body.error, "Unauthorized");
    assertEquals(createdAuthUser(h.fetchLog), false);
  } finally {
    h.cleanup();
  }
});

Deno.test("create-user: 401 when the token does not resolve to a user", async () => {
  const h = createTestHarness({
    routes: [authUserRoute({ error: "bad jwt" }, 401), institutionAdminRoute(true)],
  });
  try {
    const res = await h.invoke(handler, {
      email: "attacker@test.com",
      password: "password123",
      institutionId: "inst-1",
      role: "admin",
    }, { headers: AUTH });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 401);
    assertEquals(body.error, "Unauthorized");
    assertEquals(createdAuthUser(h.fetchLog), false);
  } finally {
    h.cleanup();
  }
});

Deno.test("create-user: 403 when the caller is not an admin of the target institution", async () => {
  const h = createTestHarness({
    routes: [
      authUserRoute({ id: CALLER_ID, email: "student@test.com" }),
      institutionAdminRoute(false),
      // Deliberately reachable: if the gate leaked, creation would succeed and
      // the assertion below would catch it.
      supabaseAuthRoute("users", { users: [] }, { method: "GET" }),
      supabaseAuthRoute(
        "users",
        { user: { id: "11111111-1111-1111-1111-111111111111", email: "escalate@test.com" } },
        { method: "POST" },
      ),
      supabaseRoute("/rest/v1/user_institutions", {}, { method: "POST" }),
    ],
  });
  try {
    const res = await h.invoke(handler, {
      email: "escalate@test.com",
      password: "password123",
      institutionId: "other-inst",
      role: "admin",
    }, { headers: AUTH });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 403);
    assertEquals(body.error, "You are not authorized to create users in this institution");
    assertEquals(createdAuthUser(h.fetchLog), false);
  } finally {
    h.cleanup();
  }
});

Deno.test("create-user: authorization is checked against the institution in the request body", async () => {
  const h = createTestHarness({
    routes: [
      ...ADMIN_CALLER,
      supabaseAuthRoute("users", { users: [] }, { method: "GET" }),
      supabaseAuthRoute(
        "users",
        { user: { id: "12121212-1212-1212-1212-121212121212", email: "ok@test.com" } },
        { method: "POST" },
      ),
      supabaseRoute("/rest/v1/user_institutions", {}, { method: "POST" }),
    ],
  });
  try {
    const res = await h.invoke(handler, {
      email: "ok@test.com",
      password: "password123",
      institutionId: "inst-42",
      role: "instructor",
    }, { headers: AUTH });
    const { status } = await parseResponse(res);
    assertEquals(status, 200);

    const rpcCall = h.fetchLog.find((c) => c.url.includes("/rest/v1/rpc/is_institution_admin"));
    assertEquals(rpcCall !== undefined, true);
    const payload = JSON.parse(rpcCall!.body!);
    assertEquals(payload._user_id, CALLER_ID);
    assertEquals(payload._institution_id, "inst-42");
  } finally {
    h.cleanup();
  }
});

Deno.test("create-user: 400 for a role outside the assignable set, and creates nothing", async () => {
  const h = createTestHarness({ routes: ADMIN_CALLER });
  try {
    const res = await h.invoke(handler, {
      email: "root@test.com",
      password: "password123",
      institutionId: "inst-1",
      role: "super_admin",
    }, { headers: AUTH });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 400);
    assertEquals(body.error, "Invalid role");
    assertEquals(createdAuthUser(h.fetchLog), false);
  } finally {
    h.cleanup();
  }
});

Deno.test("create-user: 400 when classId belongs to another institution, and creates nothing", async () => {
  const h = createTestHarness({
    routes: [
      ...ADMIN_CALLER,
      // Ownership lookup finds no class with that id in this institution.
      supabaseRoute("/rest/v1/classes", null, { method: "GET" }),
      supabaseAuthRoute("users", { users: [] }, { method: "GET" }),
      supabaseAuthRoute(
        "users",
        { user: { id: "13131313-1313-1313-1313-131313131313", email: "x@test.com" } },
        { method: "POST" },
      ),
    ],
  });
  try {
    const res = await h.invoke(handler, {
      email: "x@test.com",
      password: "password123",
      institutionId: "inst-1",
      classId: "class-in-other-inst",
    }, { headers: AUTH });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 400);
    assertEquals(body.error, "The selected class does not belong to this institution");
    assertEquals(createdAuthUser(h.fetchLog), false);
  } finally {
    h.cleanup();
  }
});

// ── Input validation ───────────────────────────────────────────────────

Deno.test("create-user: returns 400 when email is missing", async () => {
  const h = createTestHarness({ routes: ADMIN_CALLER });
  try {
    const res = await h.invoke(
      handler,
      { password: "12345678", institutionId: "inst-1" },
      { headers: AUTH },
    );
    const { status, body } = await parseResponse(res);
    assertEquals(status, 400);
    assertEquals(body.error, "Email, password, and institutionId are required");
  } finally {
    h.cleanup();
  }
});

Deno.test("create-user: returns 400 when password is missing", async () => {
  const h = createTestHarness({ routes: ADMIN_CALLER });
  try {
    const res = await h.invoke(
      handler,
      { email: "a@b.com", institutionId: "inst-1" },
      { headers: AUTH },
    );
    const { status, body } = await parseResponse(res);
    assertEquals(status, 400);
    assertEquals(body.error, "Email, password, and institutionId are required");
  } finally {
    h.cleanup();
  }
});

Deno.test("create-user: returns 400 when institutionId is missing", async () => {
  const h = createTestHarness({ routes: ADMIN_CALLER });
  try {
    const res = await h.invoke(
      handler,
      { email: "a@b.com", password: "12345678" },
      { headers: AUTH },
    );
    const { status, body } = await parseResponse(res);
    assertEquals(status, 400);
    assertEquals(body.error, "Email, password, and institutionId are required");
  } finally {
    h.cleanup();
  }
});

Deno.test("create-user: returns 400 when password is too short", async () => {
  const h = createTestHarness({ routes: ADMIN_CALLER });
  try {
    const res = await h.invoke(
      handler,
      { email: "a@b.com", password: "short", institutionId: "inst-1" },
      { headers: AUTH },
    );
    const { status, body } = await parseResponse(res);
    assertEquals(status, 400);
    assertEquals(body.error, "Password must be at least 8 characters");
  } finally {
    h.cleanup();
  }
});

// ── User already exists ────────────────────────────────────────────────

Deno.test("create-user: returns 400 when user already exists", async () => {
  const h = createTestHarness({
    routes: [
      ...ADMIN_CALLER,
      // listUsers returns existing user
      supabaseAuthRoute("users", {
        users: [{ id: "e5f6a7b8-c9d0-1234-efab-345678901234", email: "existing@test.com" }],
      }),
    ],
  });
  try {
    const res = await h.invoke(handler, {
      email: "existing@test.com",
      password: "password123",
      institutionId: "inst-1",
    }, { headers: AUTH });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 400);
    assertEquals(body.error, "A user with this email already exists");
  } finally {
    h.cleanup();
  }
});

// ── createUser error ───────────────────────────────────────────────────

Deno.test("create-user: returns 400 when auth.admin.createUser fails", async () => {
  const h = createTestHarness({
    routes: [
      ...ADMIN_CALLER,
      // listUsers — no existing users (GET)
      supabaseAuthRoute("users", { users: [] }, { method: "GET" }),
      // createUser — fails (POST)
      supabaseAuthRoute("users", { message: "Email rate limit exceeded" }, { status: 422, method: "POST" }),
    ],
  });
  try {
    const res = await h.invoke(handler, {
      email: "new@test.com",
      password: "password123",
      institutionId: "inst-1",
    }, { headers: AUTH });
    const { status } = await parseResponse(res);
    // The Supabase client will surface this as a createError
    // Since the mock returns a non-2xx, the client wraps it as an error
    assertEquals(status !== 200, true);
  } finally {
    h.cleanup();
  }
});

// ── Successful creation ────────────────────────────────────────────────

Deno.test("create-user: successful creation returns user data", async () => {
  const h = createTestHarness({
    routes: [
      ...ADMIN_CALLER,
      // listUsers — empty
      supabaseAuthRoute("users", { users: [] }, { method: "GET" }),
      // createUser — success
      supabaseAuthRoute("users", { user: { id: "b2c3d4e5-f6a7-8901-bcde-f12345678901", email: "new@test.com" } }, { method: "POST" }),
      // insert membership — success
      supabaseRoute("/rest/v1/user_institutions", {}, { method: "POST" }),
    ],
  });
  try {
    const res = await h.invoke(handler, {
      email: "new@test.com",
      password: "password123",
      fullName: "Test User",
      institutionId: "inst-1",
    }, { headers: AUTH });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 200);
    assertEquals(body.success, true);
    assertEquals(body.user.id, "b2c3d4e5-f6a7-8901-bcde-f12345678901");
    assertEquals(body.user.email, "new@test.com");
    assertEquals(body.user.full_name, "Test User");
  } finally {
    h.cleanup();
  }
});

// ── Membership failure triggers cleanup ────────────────────────────────

Deno.test("create-user: membership failure triggers user deletion cleanup", async () => {
  // Must use UUID-format IDs — Supabase auth client validates UUID format
  const mockUserId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
  const h = createTestHarness({
    routes: [
      ...ADMIN_CALLER,
      // listUsers — empty
      supabaseAuthRoute("users", { users: [] }, { method: "GET" }),
      // createUser — success
      supabaseAuthRoute("users", { user: { id: mockUserId, email: "new@test.com" } }, { method: "POST" }),
      // insert membership — fails
      supabaseRoute("/rest/v1/user_institutions", { message: "violates foreign key" }, { status: 400, method: "POST" }),
      // deleteUser cleanup
      supabaseAuthRoute(`users/${mockUserId}`, {}, { method: "DELETE" }),
    ],
  });
  try {
    const res = await h.invoke(handler, {
      email: "new@test.com",
      password: "password123",
      institutionId: "inst-1",
    }, { headers: AUTH });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 500);
    assertEquals(body.error, "Failed to add user to institution");

    // Verify cleanup delete was attempted
    const deleteCall = h.fetchLog.find(
      (c) => c.url.includes("/auth/v1/admin/users/") && c.method === "DELETE"
    );
    assertEquals(deleteCall !== undefined, true);
  } finally {
    h.cleanup();
  }
});

// ── Dual-write grade_level_id (#796) ──────────────────────────────────

Deno.test("create-user: writes grade_level_id when gradeLevel is provided (existing grade_levels row)", async () => {
  const h = createTestHarness({
    routes: [
      ...ADMIN_CALLER,
      supabaseAuthRoute("users", { users: [] }, { method: "GET" }),
      supabaseAuthRoute(
        "users",
        { user: { id: "c1d2e3f4-a5b6-7890-cdef-234567890123", email: "grade@test.com" } },
        { method: "POST" },
      ),
      // grade_levels lookup — row already exists (no insert needed)
      supabaseRoute(
        "/rest/v1/grade_levels",
        { id: "gl-existing-1" },
        { method: "GET" },
      ),
      // user_institutions insert — return empty for the response
      supabaseRoute("/rest/v1/user_institutions", {}, { method: "POST" }),
    ],
  });
  try {
    const res = await h.invoke(handler, {
      email: "grade@test.com",
      password: "password123",
      institutionId: "inst-1",
      gradeLevel: "dimotiko_1",
    }, { headers: AUTH });
    const { status } = await parseResponse(res);
    assertEquals(status, 200);

    const membershipCall = h.fetchLog.find(
      (c) => c.url.includes("/rest/v1/user_institutions") && c.method === "POST",
    );
    assertEquals(membershipCall !== undefined, true);
    const payload = JSON.parse(membershipCall!.body!);
    assertEquals(payload.grade_level_id, "gl-existing-1");
    assertEquals(payload.grade_level, undefined);
  } finally {
    h.cleanup();
  }
});

Deno.test("create-user: fails when grade_level_id resolution fails and deletes the created auth user", async () => {
  const h = createTestHarness({
    routes: [
      ...ADMIN_CALLER,
      supabaseAuthRoute("users", { users: [] }, { method: "GET" }),
      supabaseAuthRoute(
        "users",
        { user: { id: "d2e3f4a5-b6c7-8901-defa-345678901234", email: "fallback@test.com" } },
        { method: "POST" },
      ),
      // grade_levels select fails
      supabaseRoute(
        "/rest/v1/grade_levels",
        { message: "boom" },
        { status: 500, method: "GET" },
      ),
      // The auth-admin deleteUser cleanup call after resolution fails.
      supabaseAuthRoute(
        "users/d2e3f4a5-b6c7-8901-defa-345678901234",
        {},
        { method: "DELETE" },
      ),
    ],
  });
  try {
    const res = await h.invoke(handler, {
      email: "fallback@test.com",
      password: "password123",
      institutionId: "inst-1",
      gradeLevel: "dimotiko_1",
    }, { headers: AUTH });
    const { status } = await parseResponse(res);
    // #799 dropped the TEXT column, so a failed FK resolve is now fatal.
    assertEquals(status, 500);
    // No membership row should have been inserted at all.
    const membershipCall = h.fetchLog.find(
      (c) => c.url.includes("/rest/v1/user_institutions") && c.method === "POST",
    );
    assertEquals(membershipCall, undefined);
  } finally {
    h.cleanup();
  }
});

// ── Class enrollment ───────────────────────────────────────────────────

Deno.test("create-user: enrolls user in class when classId provided", async () => {
  const h = createTestHarness({
    routes: [
      ...ADMIN_CALLER,
      // Ownership lookup — the class belongs to the target institution.
      supabaseRoute("/rest/v1/classes", { id: "class-1" }, { method: "GET" }),
      supabaseAuthRoute("users", { users: [] }, { method: "GET" }),
      supabaseAuthRoute("users", { user: { id: "c3d4e5f6-a7b8-9012-cdef-123456789012", email: "student@test.com" } }, { method: "POST" }),
      supabaseRoute("/rest/v1/user_institutions", {}, { method: "POST" }),
      supabaseRoute("/rest/v1/class_enrollments", {}, { method: "POST" }),
    ],
  });
  try {
    const res = await h.invoke(handler, {
      email: "student@test.com",
      password: "password123",
      institutionId: "inst-1",
      classId: "class-1",
    }, { headers: AUTH });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 200);
    assertEquals(body.success, true);

    // Verify class enrollment was attempted
    const enrollCall = h.fetchLog.find((c) => c.url.includes("class_enrollments"));
    assertEquals(enrollCall !== undefined, true);
  } finally {
    h.cleanup();
  }
});

// ── Profile update with warning ────────────────────────────────────────

Deno.test("create-user: profile update failure returns warning but still succeeds", async () => {
  const h = createTestHarness({
    routes: [
      ...ADMIN_CALLER,
      supabaseAuthRoute("users", { users: [] }, { method: "GET" }),
      supabaseAuthRoute("users", { user: { id: "d4e5f6a7-b8c9-0123-defa-234567890123", email: "new@test.com" } }, { method: "POST" }),
      supabaseRoute("/rest/v1/user_institutions", {}, { method: "POST" }),
      // profile update fails
      supabaseRoute("/rest/v1/profiles", { message: "column not found" }, { status: 400, method: "PATCH" }),
    ],
  });
  try {
    const res = await h.invoke(handler, {
      email: "new@test.com",
      password: "password123",
      institutionId: "inst-1",
      fatherName: "Father Name",
    }, { headers: AUTH });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 200);
    assertEquals(body.success, true);
    assertEquals(typeof body.warning, "string");
    assertEquals(body.warning.includes("father's name"), true);
  } finally {
    h.cleanup();
  }
});

// ── Evaluator course scoping ───────────────────────────────────────────

Deno.test("create-user: evaluator with courseIds assigns course_evaluators", async () => {
  const mockUserId = "f6a7b8c9-d0e1-2345-fabc-456789012345";
  const h = createTestHarness({
    routes: [
      ...ADMIN_CALLER,
      supabaseAuthRoute("users", { users: [] }, { method: "GET" }),
      supabaseAuthRoute("users", { user: { id: mockUserId, email: "eval@test.com" } }, { method: "POST" }),
      supabaseRoute("/rest/v1/user_institutions", {}, { method: "POST" }),
      // Course ownership check returns both submitted ids
      supabaseRoute("/rest/v1/courses", [{ id: "course-1" }, { id: "course-2" }], { method: "GET" }),
      supabaseRoute("/rest/v1/course_evaluators", {}, { method: "POST" }),
    ],
  });
  try {
    const res = await h.invoke(handler, {
      email: "eval@test.com",
      password: "password123",
      institutionId: "inst-1",
      role: "evaluator",
      courseIds: ["course-1", "course-2"],
    }, { headers: AUTH });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 200);
    assertEquals(body.success, true);

    // Course scope was written.
    const evalCall = h.fetchLog.find(
      (c) => c.url.includes("course_evaluators") && c.method === "POST"
    );
    assertEquals(evalCall !== undefined, true);
  } finally {
    h.cleanup();
  }
});

Deno.test("create-user: evaluator with foreign-institution courseIds is rejected and rolled back", async () => {
  const mockUserId = "b8c9d0e1-f2a3-4567-bcde-678901234567";
  const h = createTestHarness({
    routes: [
      ...ADMIN_CALLER,
      supabaseAuthRoute("users", { users: [] }, { method: "GET" }),
      supabaseAuthRoute("users", { user: { id: mockUserId, email: "eval3@test.com" } }, { method: "POST" }),
      supabaseRoute("/rest/v1/user_institutions", {}, { method: "POST" }),
      // Ownership check returns only one of two submitted ids — the other
      // belongs to a different institution.
      supabaseRoute("/rest/v1/courses", [{ id: "course-1" }], { method: "GET" }),
      // rollback: membership delete + auth user delete
      supabaseRoute("/rest/v1/user_institutions", {}, { method: "DELETE" }),
      supabaseAuthRoute(`users/${mockUserId}`, {}, { method: "DELETE" }),
    ],
  });
  try {
    const res = await h.invoke(handler, {
      email: "eval3@test.com",
      password: "password123",
      institutionId: "inst-1",
      role: "evaluator",
      courseIds: ["course-1", "course-from-other-inst"],
    }, { headers: AUTH });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 400);
    assertEquals(body.error, "One or more courses do not belong to this institution");

    // No course_evaluators row was written.
    const evalCall = h.fetchLog.find(
      (c) => c.url.includes("course_evaluators") && c.method === "POST"
    );
    assertEquals(evalCall, undefined);

    // The created auth user was rolled back.
    const deleteCall = h.fetchLog.find(
      (c) => c.url.includes("/auth/v1/admin/users/") && c.method === "DELETE"
    );
    assertEquals(deleteCall !== undefined, true);
  } finally {
    h.cleanup();
  }
});

Deno.test("create-user: evaluator without courseIds is rejected and rolled back", async () => {
  const mockUserId = "a7b8c9d0-e1f2-3456-abcd-567890123456";
  const h = createTestHarness({
    routes: [
      ...ADMIN_CALLER,
      supabaseAuthRoute("users", { users: [] }, { method: "GET" }),
      supabaseAuthRoute("users", { user: { id: mockUserId, email: "eval2@test.com" } }, { method: "POST" }),
      supabaseRoute("/rest/v1/user_institutions", {}, { method: "POST" }),
      // rollback: membership delete + auth user delete
      supabaseRoute("/rest/v1/user_institutions", {}, { method: "DELETE" }),
      supabaseAuthRoute(`users/${mockUserId}`, {}, { method: "DELETE" }),
    ],
  });
  try {
    const res = await h.invoke(handler, {
      email: "eval2@test.com",
      password: "password123",
      institutionId: "inst-1",
      role: "evaluator",
      // courseIds intentionally omitted
    }, { headers: AUTH });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 400);
    assertEquals(body.error, "Evaluators must be assigned at least one course");

    // The created auth user was rolled back.
    const deleteCall = h.fetchLog.find(
      (c) => c.url.includes("/auth/v1/admin/users/") && c.method === "DELETE"
    );
    assertEquals(deleteCall !== undefined, true);
  } finally {
    h.cleanup();
  }
});

// ── CORS preflight ─────────────────────────────────────────────────────

Deno.test("create-user: OPTIONS returns CORS headers", async () => {
  const h = createTestHarness();
  try {
    const req = new Request("http://localhost:54321/functions/v1/create-user", {
      method: "OPTIONS",
    });
    const res = await handler(req);
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  } finally {
    h.cleanup();
  }
});
