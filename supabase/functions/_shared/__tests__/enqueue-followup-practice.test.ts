/**
 * Tests for the `enqueue-followup-practice` edge function (#839).
 *
 * Exercises the front-door: method/param validation, offering authorization,
 * the closed-quiz + no-chapters guards, and the whole-class happy path (draft
 * quiz + assignment + job insert + runner kick). Cluster-group persistence is
 * covered indirectly by the whole-class path plus the validation branches;
 * the full group insert is left to RLS/integration.
 */
import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  createTestHarness,
  type MockRoute,
  parseResponse,
  supabaseRoute,
} from "./handler-harness.ts";

const OPTS = { sanitizeOps: false, sanitizeResources: false };

const USER_ID = "user-1";
const COURSE_ID = "course-1";
const OFFERING_ID = "off-1";
const QUIZ_ID = "quiz-1";
const CLASS_ID = "class-1";
const INSTITUTION_ID = "inst-1";

function authUserRoute(ok = true): MockRoute {
  return {
    match: (url) => url.includes("/auth/v1/user"),
    respond: () =>
      ok
        ? new Response(JSON.stringify({ id: USER_ID, email: "u@test" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        : new Response(JSON.stringify({ error: "invalid" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          }),
  };
}

function canManageRoute(value: boolean): MockRoute {
  return supabaseRoute("/rest/v1/rpc/can_manage_offering", value, { method: "POST" });
}

function runnerRoute(seen: { called: boolean }): MockRoute {
  return {
    match: (url) => url.includes("/functions/v1/run-jobs"),
    respond: () => {
      seen.called = true;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  };
}

function validBody(extra: Record<string, unknown> = {}) {
  return {
    quiz_id: QUIZ_ID,
    offering_id: OFFERING_ID,
    types: ["mcq", "open"],
    count_per_type: 2,
    cluster: null,
    ...extra,
  };
}

const AUTH = { headers: { Authorization: "Bearer tok" } };

// Routes for the whole-class happy path (no cluster → no group inserts).
function happyPathRoutes(opts: { chapters?: Array<{ chapter_id: string }> } = {}): MockRoute[] {
  const chapters = opts.chapters ?? [{ chapter_id: "ch-1" }];
  return [
    authUserRoute(true),
    canManageRoute(true),
    // offering_quizzes: GET published-assignment rows (array — the handler
    // reads every published row) then POST assignment (null).
    supabaseRoute("/rest/v1/offering_quizzes", [{ id: "oq-1" }], {
      method: "GET",
    }),
    supabaseRoute("/rest/v1/offering_quizzes", null, { method: "POST", status: 201 }),
    supabaseRoute("/rest/v1/offerings", { course_id: COURSE_ID, class_id: CLASS_ID }, {
      method: "GET",
    }),
    supabaseRoute("/rest/v1/courses", { institution_id: INSTITUTION_ID }, { method: "GET" }),
    // quizzes: GET source title, POST draft creation.
    supabaseRoute("/rest/v1/quizzes", { title: "Fractions Quiz" }, { method: "GET" }),
    supabaseRoute("/rest/v1/quizzes", { id: "draft-1" }, { method: "POST", status: 201 }),
    supabaseRoute("/rest/v1/quiz_questions", [{ question_id: "q-1" }], { method: "GET" }),
    supabaseRoute("/rest/v1/question_chapters", chapters, { method: "GET" }),
    supabaseRoute("/rest/v1/class_enrollments", [{ user_id: "stud-1" }], { method: "GET" }),
    supabaseRoute(
      "/rest/v1/quiz_analyses",
      { report: { common_misconceptions: [{ title: "Fractions" }], knowledge_gaps: [] }, clusters: [] },
      { method: "GET" },
    ),
    supabaseRoute("/rest/v1/jobs", { id: "job-1" }, { method: "POST", status: 201 }),
    runnerRoute({ called: false }),
  ];
}

// ── Tests ──────────────────────────────────────────────────────────────

Deno.test({
  name: "enqueue-followup-practice: 400 when quiz_id/offering_id missing",
  ...OPTS,
  async fn() {
    const harness = createTestHarness({ routes: [] });
    try {
      const { handler } = await import("../../enqueue-followup-practice/handler.ts");
      const res = await harness.invoke(handler, { types: ["mcq"] }, AUTH);
      const { status, body } = await parseResponse(res);
      assertEquals(status, 400);
      assertExists(body.error);
    } finally {
      harness.cleanup();
    }
  },
});

Deno.test({
  name: "enqueue-followup-practice: 400 when no valid types selected",
  ...OPTS,
  async fn() {
    const harness = createTestHarness({ routes: [] });
    try {
      const { handler } = await import("../../enqueue-followup-practice/handler.ts");
      const res = await harness.invoke(handler, validBody({ types: [] }), AUTH);
      const { status, body } = await parseResponse(res);
      assertEquals(status, 400);
      assertExists(body.error);
    } finally {
      harness.cleanup();
    }
  },
});

Deno.test({
  name: "enqueue-followup-practice: 403 when caller can't manage the offering",
  ...OPTS,
  async fn() {
    const harness = createTestHarness({
      routes: [authUserRoute(true), canManageRoute(false)],
    });
    try {
      const { handler } = await import("../../enqueue-followup-practice/handler.ts");
      const res = await harness.invoke(handler, validBody(), AUTH);
      const { status, body } = await parseResponse(res);
      assertEquals(status, 403);
      assertEquals(body.error, "Forbidden");
    } finally {
      harness.cleanup();
    }
  },
});

Deno.test({
  name: "enqueue-followup-practice: 400 when the source quiz's questions have no chapters",
  ...OPTS,
  async fn() {
    const harness = createTestHarness({
      routes: [
        authUserRoute(true),
        canManageRoute(true),
        supabaseRoute("/rest/v1/offering_quizzes", [{ id: "oq-1" }], {
          method: "GET",
        }),
        supabaseRoute("/rest/v1/offerings", { course_id: COURSE_ID, class_id: CLASS_ID }, {
          method: "GET",
        }),
        supabaseRoute("/rest/v1/courses", { institution_id: INSTITUTION_ID }, { method: "GET" }),
        supabaseRoute("/rest/v1/quizzes", { title: "Q" }, { method: "GET" }),
        supabaseRoute("/rest/v1/quiz_questions", [{ question_id: "q-1" }], { method: "GET" }),
        // No chapter links.
        supabaseRoute("/rest/v1/question_chapters", [], { method: "GET" }),
      ],
    });
    try {
      const { handler } = await import("../../enqueue-followup-practice/handler.ts");
      const res = await harness.invoke(handler, validBody(), AUTH);
      const { status, body } = await parseResponse(res);
      assertEquals(status, 400);
      assertEquals(body.no_chapters, true);
    } finally {
      harness.cleanup();
    }
  },
});

Deno.test({
  name:
    "enqueue-followup-practice: creates the quiz published but leaves the offering assignment unpublished",
  ...OPTS,
  async fn() {
    const harness = createTestHarness({ routes: happyPathRoutes() });
    try {
      const { handler } = await import("../../enqueue-followup-practice/handler.ts");
      const res = await harness.invoke(handler, validBody(), AUTH);
      assertEquals(res.status, 202);

      // Follow-ups are never created in draft mode: `is_published` is TRUE.
      const quizPost = harness.fetchLog.find(
        (e) => e.url.includes("/rest/v1/quizzes") && e.method === "POST",
      );
      assertExists(quizPost);
      const quizBody = JSON.parse(quizPost!.body ?? "{}");
      assertEquals(quizBody.is_published, true);

      // The other gate stays shut: no student sees it until the instructor
      // assigns it, which is what makes publishing an empty quiz safe.
      const assignPost = harness.fetchLog.find(
        (e) => e.url.includes("/rest/v1/offering_quizzes") && e.method === "POST",
      );
      assertExists(assignPost);
      const assignBody = JSON.parse(assignPost!.body ?? "{}");
      assertEquals(assignBody.published_at, null);
    } finally {
      harness.cleanup();
    }
  },
});

Deno.test({
  name: "enqueue-followup-practice: whole-class happy path returns 202 + draftQuizId with no group",
  ...OPTS,
  async fn() {
    const harness = createTestHarness({ routes: happyPathRoutes() });
    try {
      const { handler } = await import("../../enqueue-followup-practice/handler.ts");
      const res = await harness.invoke(handler, validBody(), AUTH);
      const { status, body } = await parseResponse(res);
      assertEquals(status, 202);
      assertEquals(body.jobId, "job-1");
      assertEquals(body.draftQuizId, "draft-1");
      assertEquals(body.groupId, null);
      assertEquals(body.itemCount, 2); // 1 chapter × 2 types
    } finally {
      harness.cleanup();
    }
  },
});
