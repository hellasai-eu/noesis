import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  createTestHarness,
  type MockRoute,
  supabaseRoute,
  parseResponse,
} from "../handler-harness.ts";
import { handler } from "../../../validate-questions/handler.ts";

// Tests that hit the Supabase client need sanitizers disabled because
// createClient starts internal intervals (auth token refresh).
const OPTS = { sanitizeOps: false, sanitizeResources: false };

const USER_ID = "user-1";
const COURSE_ID = "course-1";
const INSTITUTION_ID = "inst-1";
const AUTH = { Authorization: "Bearer tok" };

/** Resolve (or reject) the bearer token the handler passes to auth.getUser. */
function authUserRoute(opts: { ok: boolean }): MockRoute {
  return {
    match: (url) => url.includes("/auth/v1/user"),
    respond: () =>
      opts.ok
        ? new Response(JSON.stringify({ id: USER_ID, email: "u@test" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        : new Response(JSON.stringify({ error: "invalid token" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          }),
  };
}

/** One MCQ row owned by COURSE_ID, as returned by the questions select. */
function mcqRow(over: Record<string, unknown> = {}) {
  return {
    id: "q-1",
    type: "mcq",
    question: "2 + 2?",
    payload: { options: ["3", "4"] },
    answer_key: { correct_index: 1 },
    explanation: null,
    course_id: COURSE_ID,
    ...over,
  };
}

/** Routes that make the caller a course instructor for COURSE_ID. */
function authorizedManagerRoutes(): MockRoute[] {
  return [
    supabaseRoute("/rest/v1/courses", [{ institution_id: INSTITUTION_ID }]),
    supabaseRoute("/rest/v1/rpc/is_institution_admin", false, { method: "POST" }),
    supabaseRoute("/rest/v1/user_institutions", [{ is_suspended: false }]),
    supabaseRoute("/rest/v1/course_instructors", [{ user_id: USER_ID }]),
  ];
}

// ── Input validation ───────────────────────────────────────────────────

Deno.test("validate-questions: returns 400 when questionIds is missing", async () => {
  const h = createTestHarness();
  try {
    const res = await h.invoke(handler, {});
    const { status, body } = await parseResponse(res);
    assertEquals(status, 400);
    assertEquals(body.error, "questionIds array is required");
  } finally {
    h.cleanup();
  }
});

Deno.test("validate-questions: returns 400 when questionIds is not an array", async () => {
  const h = createTestHarness();
  try {
    const res = await h.invoke(handler, { questionIds: "not-an-array" });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 400);
    assertEquals(body.error, "questionIds array is required");
  } finally {
    h.cleanup();
  }
});

Deno.test("validate-questions: returns 400 when questionIds is empty", async () => {
  const h = createTestHarness();
  try {
    const res = await h.invoke(handler, { questionIds: [] });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 400);
    assertEquals(body.error, "questionIds array is required");
  } finally {
    h.cleanup();
  }
});

// ── Authorization (#1081) ──────────────────────────────────────────────
//
// The handler runs on the service-role key and updates rows chosen purely by
// caller-supplied ids, and `verify_jwt = false` means Supabase does not gate
// it. These four tests are the whole guard against anyone overwriting any
// question's validation verdict in any institution.

Deno.test({
  name: "validate-questions: returns 401 without an Authorization header",
  ...OPTS,
  async fn() {
    const h = createTestHarness();
    try {
      const res = await h.invoke(handler, { questionIds: ["q-1"] });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 401);
      assertEquals(body.error, "Missing authorization");
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "validate-questions: returns 401 when the token does not resolve",
  ...OPTS,
  async fn() {
    const h = createTestHarness({ routes: [authUserRoute({ ok: false })] });
    try {
      const res = await h.invoke(handler, { questionIds: ["q-1"] }, { headers: AUTH });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 401);
      assertEquals(body.error, "Invalid authorization");
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "validate-questions: returns 403 for a course the caller does not manage",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        authUserRoute({ ok: true }),
        supabaseRoute("/rest/v1/questions", [mcqRow()]),
        supabaseRoute("/rest/v1/courses", [{ institution_id: INSTITUTION_ID }]),
        supabaseRoute("/rest/v1/rpc/is_institution_admin", false, { method: "POST" }),
        // Not an institution admin, and not an instructor of the course.
        supabaseRoute("/rest/v1/user_institutions", [{ is_suspended: false }]),
        supabaseRoute("/rest/v1/course_instructors", []),
      ],
    });
    try {
      const res = await h.invoke(handler, { questionIds: ["q-1"] }, { headers: AUTH });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 403);
      assertEquals(body.error, "Not authorized for these questions");
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "validate-questions: rejects a batch that reaches beyond the caller's courses",
  ...OPTS,
  async fn() {
    // Two rows, two courses. `courses` resolves for both, but the caller is
    // neither institution admin nor an assigned instructor, so a course fails
    // the check and the WHOLE batch is refused rather than partially applied.
    const h = createTestHarness({
      routes: [
        authUserRoute({ ok: true }),
        supabaseRoute("/rest/v1/questions", [
          mcqRow({ id: "q-1", course_id: COURSE_ID }),
          mcqRow({ id: "q-2", course_id: "course-other" }),
        ]),
        supabaseRoute("/rest/v1/courses", [{ institution_id: INSTITUTION_ID }]),
        supabaseRoute("/rest/v1/rpc/is_institution_admin", false, { method: "POST" }),
        supabaseRoute("/rest/v1/user_institutions", [{ is_suspended: false }]),
        supabaseRoute("/rest/v1/course_instructors", []),
      ],
    });
    try {
      const res = await h.invoke(
        handler,
        { questionIds: ["q-1", "q-2"] },
        { headers: AUTH },
      );
      const { status } = await parseResponse(res);
      assertEquals(status, 403);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "validate-questions: returns 403 for a SUSPENDED institution admin",
  ...OPTS,
  async fn() {
    // `is_institution_admin` requires NOT is_suspended
    // (20260323000000_add_is_suspended.sql:19-32), so a suspended admin's
    // membership row still says role='admin' but the boundary says no. Going
    // through the RPC rather than reading `role` directly is what keeps this
    // handler on the same side of that line as every RLS policy.
    const h = createTestHarness({
      routes: [
        authUserRoute({ ok: true }),
        supabaseRoute("/rest/v1/questions", [mcqRow()]),
        supabaseRoute("/rest/v1/courses", [{ institution_id: INSTITUTION_ID }]),
        supabaseRoute("/rest/v1/rpc/is_institution_admin", false, { method: "POST" }),
        supabaseRoute("/rest/v1/user_institutions", [{ is_suspended: true }]),
        // Not an instructor either — suspension is the only thing under test.
        supabaseRoute("/rest/v1/course_instructors", []),
      ],
    });
    try {
      const res = await h.invoke(handler, { questionIds: ["q-1"] }, { headers: AUTH });
      const { status } = await parseResponse(res);
      assertEquals(status, 403);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "validate-questions: returns 403 for a SUSPENDED course instructor",
  ...OPTS,
  async fn() {
    // `course_instructors` carries no suspension column, so a suspended user
    // keeps their course assignment. Without the membership check the row
    // below would authorize them.
    const h = createTestHarness({
      routes: [
        authUserRoute({ ok: true }),
        supabaseRoute("/rest/v1/questions", [mcqRow()]),
        supabaseRoute("/rest/v1/courses", [{ institution_id: INSTITUTION_ID }]),
        supabaseRoute("/rest/v1/rpc/is_institution_admin", false, { method: "POST" }),
        supabaseRoute("/rest/v1/user_institutions", [{ is_suspended: true }]),
        supabaseRoute("/rest/v1/course_instructors", [{ user_id: USER_ID }]),
      ],
    });
    try {
      const res = await h.invoke(handler, { questionIds: ["q-1"] }, { headers: AUTH });
      const { status } = await parseResponse(res);
      assertEquals(status, 403);
    } finally {
      h.cleanup();
    }
  },
});

// ── Unsupported types (#1081) ──────────────────────────────────────────

Deno.test({
  name: "validate-questions: returns 422, not 404, when the ids exist but are not MCQ",
  ...OPTS,
  async fn() {
    // Previously the `.eq("type","mcq")` filter ran in the fetch, so an
    // ordering question came back as "No questions found with the provided
    // IDs" — indistinguishable from a bad id.
    const h = createTestHarness({
      routes: [
        authUserRoute({ ok: true }),
        supabaseRoute("/rest/v1/questions", [mcqRow({ id: "q-ord", type: "ordering" })]),
        ...authorizedManagerRoutes(),
      ],
    });
    try {
      const res = await h.invoke(handler, { questionIds: ["q-ord"] }, { headers: AUTH });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 422);
      assertEquals(body.unsupported_type, true);
    } finally {
      h.cleanup();
    }
  },
});

// ── No questions found ─────────────────────────────────────────────────

Deno.test({
  name: "validate-questions: returns 404 when no questions match IDs",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        authUserRoute({ ok: true }),
        supabaseRoute("/rest/v1/questions", []),
      ],
    });
    try {
      const res = await h.invoke(
        handler,
        { questionIds: ["nonexistent-id"] },
        { headers: AUTH },
      );
      const { status, body } = await parseResponse(res);
      assertEquals(status, 404);
      assertEquals(body.error, "No questions found with the provided IDs");
    } finally {
      h.cleanup();
    }
  },
});

// ── Database fetch error ───────────────────────────────────────────────

Deno.test({
  name: "validate-questions: returns 500 when question fetch fails",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        authUserRoute({ ok: true }),
        supabaseRoute("/rest/v1/questions", { message: "relation does not exist" }, { status: 400 }),
      ],
    });
    try {
      const res = await h.invoke(handler, { questionIds: ["q-1"] }, { headers: AUTH });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 500);
      assertEquals(body.error, "Failed to fetch questions");
    } finally {
      h.cleanup();
    }
  },
});

// ── CORS preflight ─────────────────────────────────────────────────────

Deno.test("validate-questions: OPTIONS returns CORS headers", async () => {
  const h = createTestHarness();
  try {
    const req = new Request("http://localhost:54321/functions/v1/validate-questions", {
      method: "OPTIONS",
    });
    const res = await handler(req);
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  } finally {
    h.cleanup();
  }
});
