import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { createTestHarness, MockRoute, parseResponse } from "../handler-harness.ts";
import { checkActiveCourseInstructor, checkInstitutionAdmin } from "../../institution-authz.ts";
import { authorizeCourseManager, authorizeCourseReader } from "../../course-authz.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handler as academicYearRollover } from "../../../academic-year-rollover/handler.ts";

// ── A failed check is not a denial (#1155) ─────────────────────────────
// The helpers used to discard their query error and return `false`, so a
// database, PostgREST or network fault was indistinguishable from "not
// authorized". It failed closed, so it was never a hole — what it produced was
// a wrong diagnosis: 403 for what was actually a 500, and a log line naming a
// real admin as a non-admin.
//
// These assert the distinction at both levels: the helpers themselves, and a
// handler that consumes them.

const OPTS = { sanitizeOps: false, sanitizeResources: false };

const USER_ID = "99999999-9999-9999-9999-999999999999";
const COURSE_ID = "33333333-3333-3333-3333-333333333333";
const INSTITUTION_ID = "22222222-2222-2222-2222-222222222222";

function client() {
  return createClient("http://localhost:54321", "test-service-role-key", {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function failing(pattern: string): MockRoute {
  return {
    match: (url) => url.includes(pattern),
    respond: () =>
      new Response(JSON.stringify({ message: "connection reset" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }),
  };
}

function ok(pattern: string, body: unknown): MockRoute {
  return {
    match: (url) => url.includes(pattern),
    respond: () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  };
}

// ── The helpers ────────────────────────────────────────────────────────

Deno.test("checkInstitutionAdmin: a failed RPC is reported, not answered", async () => {
  const h = createTestHarness({ routes: [failing("/rest/v1/rpc/is_institution_admin")] });
  try {
    const result = await checkInstitutionAdmin(client(), USER_ID, INSTITUTION_ID);
    assertEquals(result.ok, false);
  } finally {
    h.cleanup();
  }
});

Deno.test("checkInstitutionAdmin: a clear no is still a clear no", async () => {
  const h = createTestHarness({ routes: [ok("/rest/v1/rpc/is_institution_admin", false)] });
  try {
    const result = await checkInstitutionAdmin(client(), USER_ID, INSTITUTION_ID);
    assertEquals(result.ok, true);
    if (result.ok) assertEquals(result.allowed, false);
  } finally {
    h.cleanup();
  }
});

Deno.test("checkActiveCourseInstructor: a failed membership read propagates", async () => {
  // The membership check runs first, so its failure must not be swallowed by
  // the assignment lookup that follows.
  const h = createTestHarness({ routes: [failing("/rest/v1/user_institutions")] });
  try {
    const result = await checkActiveCourseInstructor(
      client(),
      USER_ID,
      COURSE_ID,
      INSTITUTION_ID,
    );
    assertEquals(result.ok, false);
  } finally {
    h.cleanup();
  }
});

Deno.test("checkActiveCourseInstructor: a failed assignment read propagates", async () => {
  const h = createTestHarness({
    routes: [
      ok("/rest/v1/user_institutions", { is_suspended: false }),
      failing("/rest/v1/course_instructors"),
    ],
  });
  try {
    const result = await checkActiveCourseInstructor(
      client(),
      USER_ID,
      COURSE_ID,
      INSTITUTION_ID,
    );
    assertEquals(result.ok, false);
  } finally {
    h.cleanup();
  }
});

// ── The consumers ──────────────────────────────────────────────────────

Deno.test("authorizeCourseManager: 500 when the admin check fails, not 403", async () => {
  const h = createTestHarness({
    routes: [
      ok("/rest/v1/courses", { institution_id: INSTITUTION_ID }),
      failing("/rest/v1/rpc/is_institution_admin"),
    ],
  });
  try {
    const result = await authorizeCourseManager(client(), USER_ID, COURSE_ID);
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.status, 500);
  } finally {
    h.cleanup();
  }
});

Deno.test("authorizeCourseReader: 500 when the membership check fails, not 403", async () => {
  const h = createTestHarness({
    routes: [
      ok("/rest/v1/courses", { institution_id: INSTITUTION_ID }),
      ok("/rest/v1/rpc/is_institution_admin", false),
      failing("/rest/v1/user_institutions"),
      ok("/rest/v1/course_instructors", null),
    ],
  });
  try {
    const result = await authorizeCourseReader(client(), USER_ID, COURSE_ID);
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.status, 500);
  } finally {
    h.cleanup();
  }
});

// ── End to end through a handler ───────────────────────────────────────

Deno.test({
  name: "academic-year-rollover: a failed admin check is 500, not 403",
  ...OPTS,
  async fn() {
    // The difference that matters operationally: whoever reads this during an
    // incident is told the server failed, not that a valid admin was refused.
    const h = createTestHarness({
      routes: [
        ok("/auth/v1/user", { id: USER_ID, email: "admin@school.test" }),
        failing("/rest/v1/rpc/is_institution_admin"),
      ],
    });
    try {
      const res = await h.invoke(academicYearRollover, {
        institution_id: INSTITUTION_ID,
        new_academic_period: "2026-2027",
      }, { headers: { authorization: "Bearer valid-token" } });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 500);
      assertEquals(body.error, "Failed to check authorization");
    } finally {
      h.cleanup();
    }
  },
});


Deno.test("authorizeCourseReader: a failed MANAGER check is not masked by the student path", async () => {
  // The reader path falls back to enrollment when the caller is not a manager.
  // It must not do that when the manager check could not be performed — the
  // fallback would then answer 403 for a fault, re-creating one layer up the
  // conflation this change removes.
  //
  // Here the admin RPC fails and the student path would otherwise succeed, so a
  // masked failure would surface as a cheerful 200.
  const h = createTestHarness({
    routes: [
      ok("/rest/v1/courses", { institution_id: INSTITUTION_ID }),
      failing("/rest/v1/rpc/is_institution_admin"),
      ok("/rest/v1/user_institutions", { is_suspended: false }),
      ok("/rest/v1/offerings", [{ class_id: "class-1" }]),
      ok("/rest/v1/class_enrollments", [{ class_id: "class-1" }]),
    ],
  });
  try {
    const result = await authorizeCourseReader(client(), USER_ID, COURSE_ID);
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.status, 500);
  } finally {
    h.cleanup();
  }
});
