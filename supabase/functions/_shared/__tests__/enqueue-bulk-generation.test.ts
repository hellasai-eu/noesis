/**
 * Tests for the `enqueue-bulk-generation` edge function (#698).
 *
 * The handler is the only client-callable path that inserts a row into the
 * `jobs` table (no INSERT RLS — workers + this function write). We exercise:
 *
 *   1. auth + authorization (course instructor passes; outsider gets 403)
 *   2. param validation (forwarded to `parseBulkParams`)
 *   3. concurrent-job guard (409 when a pending/processing row exists)
 *   4. happy path: 202 + jobId + fire-and-forget runner POST
 *   5. fan-out cap (chapters × types > MAX_ITEMS_PER_JOB → 400)
 */
import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  createTestHarness,
  type MockRoute,
  parseResponse,
} from "./handler-harness.ts";

const OPTS = { sanitizeOps: false, sanitizeResources: false };

const COURSE_ID = "course-1";
const INSTITUTION_ID = "inst-1";
const USER_ID = "user-1";

// ── Route builders specific to this handler ────────────────────────────

/** Mock POST /auth/v1/user — supabase-js calls this in getUser(token). */
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

function coursesRoute(opts: { found: boolean }): MockRoute {
  return {
    match: (url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      return method === "GET" && url.includes("/rest/v1/courses");
    },
    respond: () =>
      new Response(
        JSON.stringify(
          opts.found
            ? [{ id: COURSE_ID, institution_id: INSTITUTION_ID }]
            : [],
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  };
}

function isInstitutionAdminRoute(value: boolean): MockRoute {
  return {
    match: (url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      return (
        method === "POST" && url.includes("/rest/v1/rpc/is_institution_admin")
      );
    },
    respond: () =>
      new Response(JSON.stringify(value), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  };
}

/**
 * The membership row. Since #1082 the handler reads `is_suspended` from here
 * rather than `role` — the admin decision moved to the `is_institution_admin`
 * RPC, and this row now gates the INSTRUCTOR branch, because
 * `course_instructors` has no suspension column of its own.
 *
 * `null` means "no membership at all", which is not the same as a live one:
 * an instructor with no membership row cannot be authorized.
 */
function userInstitutionsRoute(
  membership: { is_suspended: boolean; role?: string } | null,
): MockRoute {
  return {
    match: (url) => url.includes("/rest/v1/user_institutions"),
    respond: () =>
      new Response(
        JSON.stringify(membership ? [membership] : []),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  };
}

/** Shorthand for the common "member in good standing" case. */
const ACTIVE_MEMBER = { is_suspended: false };

function courseInstructorsRoute(isInstructor: boolean): MockRoute {
  return {
    match: (url) => url.includes("/rest/v1/course_instructors"),
    respond: () =>
      new Response(
        JSON.stringify(isInstructor ? [{ user_id: USER_ID }] : []),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  };
}

/**
 * Two routes against /rest/v1/jobs:
 *   - GET (concurrency check) returns whatever `existing` says
 *   - POST (insert) returns a single-row response with the new id
 */
function jobsRoutes(state: {
  existing: Array<{ id: string; status: string }>;
  inserted: Array<Record<string, unknown>>;
}): MockRoute {
  return {
    match: (url) => url.includes("/rest/v1/jobs"),
    respond: (_url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST") {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        state.inserted.push(body);
        // `.insert(...).select("id").single()` sets
        // `Accept: application/vnd.pgrst.object+json`, so PostgREST returns
        // the inserted row as a single object — not an array.
        return new Response(
          JSON.stringify({ id: "job-new-1" }),
          {
            status: 201,
            headers: { "Content-Type": "application/vnd.pgrst.object+json" },
          },
        );
      }
      return new Response(JSON.stringify(state.existing), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  };
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

function validBody() {
  return {
    courseId: COURSE_ID,
    types: ["mcq", "open"],
    chapterIds: ["ch-1", "ch-2"],
    countPerType: 3,
    difficulty: "medium",
    startHidden: true,
    diagramMode: "off",
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

Deno.test({
  name: "enqueue-bulk-generation: 401 when authorization header is missing",
  ...OPTS,
  async fn() {
    const harness = createTestHarness({ routes: [] });
    try {
      const { handler } = await import("../../enqueue-bulk-generation/handler.ts");
      const res = await harness.invoke(handler, validBody());
      const { status, body } = await parseResponse(res);
      assertEquals(status, 401);
      assertEquals(body.error, "Missing authorization");
    } finally {
      harness.cleanup();
    }
  },
});

Deno.test({
  name: "enqueue-bulk-generation: 401 when supabase.auth.getUser rejects",
  ...OPTS,
  async fn() {
    const harness = createTestHarness({
      routes: [authUserRoute({ ok: false })],
    });
    try {
      const { handler } = await import("../../enqueue-bulk-generation/handler.ts");
      const res = await harness.invoke(handler, validBody(), {
        headers: { Authorization: "Bearer bad" },
      });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 401);
      assertEquals(body.error, "Invalid authorization");
    } finally {
      harness.cleanup();
    }
  },
});

// ── Suspension (#1082) ─────────────────────────────────────────────────
//
// `is_suspended` lives on user_institutions and nowhere else. Before #1082 the
// handler read `role` directly and never looked at it, so a suspended admin
// kept full access and a suspended instructor kept every course assignment.

Deno.test({
  name: "enqueue-bulk-generation: 403 for a suspended institution admin",
  ...OPTS,
  async fn() {
    // is_institution_admin requires NOT is_suspended, so the RPC itself says
    // no — that is the whole point of routing the decision through it.
    const harness = createTestHarness({
      routes: [
        authUserRoute({ ok: true }),
        coursesRoute({ found: true }),
        isInstitutionAdminRoute(false),
        // role STILL says admin — that is exactly what the old code read, and
        // why it let a suspended admin through. Only is_suspended differs.
        userInstitutionsRoute({ role: "admin", is_suspended: true }),
        courseInstructorsRoute(false),
      ],
    });
    try {
      const { handler } = await import("../../enqueue-bulk-generation/handler.ts");
      const res = await harness.invoke(handler, validBody(), {
        headers: { Authorization: "Bearer tok" },
      });
      const { status } = await parseResponse(res);
      assertEquals(status, 403);
    } finally {
      harness.cleanup();
    }
  },
});

Deno.test({
  name: "enqueue-bulk-generation: 403 for a suspended course instructor",
  ...OPTS,
  async fn() {
    // The course assignment is still there — course_instructors has no
    // suspension column — so only the membership check can catch this.
    const harness = createTestHarness({
      routes: [
        authUserRoute({ ok: true }),
        coursesRoute({ found: true }),
        isInstitutionAdminRoute(false),
        userInstitutionsRoute({ is_suspended: true }),
        courseInstructorsRoute(true),
      ],
    });
    try {
      const { handler } = await import("../../enqueue-bulk-generation/handler.ts");
      const res = await harness.invoke(handler, validBody(), {
        headers: { Authorization: "Bearer tok" },
      });
      const { status } = await parseResponse(res);
      assertEquals(status, 403);
    } finally {
      harness.cleanup();
    }
  },
});


Deno.test({
  name: "enqueue-bulk-generation: 400 on missing types",
  ...OPTS,
  async fn() {
    const harness = createTestHarness({
      routes: [authUserRoute({ ok: true })],
    });
    try {
      const { handler } = await import("../../enqueue-bulk-generation/handler.ts");
      const res = await harness.invoke(
        handler,
        { ...validBody(), types: [] },
        { headers: { Authorization: "Bearer tok" } },
      );
      const { status, body } = await parseResponse(res);
      assertEquals(status, 400);
      assertExists(body.error);
    } finally {
      harness.cleanup();
    }
  },
});

Deno.test({
  name: "enqueue-bulk-generation: 400 when chapters × types > MAX_ITEMS_PER_JOB",
  ...OPTS,
  async fn() {
    const harness = createTestHarness({
      routes: [authUserRoute({ ok: true })],
    });
    try {
      const { handler } = await import("../../enqueue-bulk-generation/handler.ts");
      // 151 chapters × 2 types = 302 > 300.
      const chapterIds = Array.from({ length: 151 }, (_, i) => `ch-${i}`);
      const res = await harness.invoke(
        handler,
        { ...validBody(), chapterIds },
        { headers: { Authorization: "Bearer tok" } },
      );
      const { status, body } = await parseResponse(res);
      assertEquals(status, 400);
      assertEquals(
        body.error.includes("exceeds the limit"),
        true,
        `Expected cap message, got: ${body.error}`,
      );
    } finally {
      harness.cleanup();
    }
  },
});

Deno.test({
  name: "enqueue-bulk-generation: 403 when caller is not a course manager",
  ...OPTS,
  async fn() {
    const harness = createTestHarness({
      routes: [
        authUserRoute({ ok: true }),
        coursesRoute({ found: true }),
        isInstitutionAdminRoute(false),
        userInstitutionsRoute(null),
        courseInstructorsRoute(false),
      ],
    });
    try {
      const { handler } = await import("../../enqueue-bulk-generation/handler.ts");
      const res = await harness.invoke(handler, validBody(), {
        headers: { Authorization: "Bearer tok" },
      });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 403);
      assertEquals(body.error, "Not authorized for this course");
    } finally {
      harness.cleanup();
    }
  },
});

Deno.test({
  name: "enqueue-bulk-generation: 409 when another bulk job is already running for the course",
  ...OPTS,
  async fn() {
    const jobsState = {
      existing: [{ id: "existing-job-1", status: "processing" }],
      inserted: [] as Array<Record<string, unknown>>,
    };
    const harness = createTestHarness({
      routes: [
        authUserRoute({ ok: true }),
        coursesRoute({ found: true }),
        isInstitutionAdminRoute(false),
        userInstitutionsRoute(ACTIVE_MEMBER),
        courseInstructorsRoute(true),
        jobsRoutes(jobsState),
      ],
    });
    try {
      const { handler } = await import("../../enqueue-bulk-generation/handler.ts");
      const res = await harness.invoke(handler, validBody(), {
        headers: { Authorization: "Bearer tok" },
      });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 409);
      assertEquals(body.existingJobId, "existing-job-1");
      // The insert path must NOT have run.
      assertEquals(jobsState.inserted.length, 0);
    } finally {
      harness.cleanup();
    }
  },
});

Deno.test({
  name: "enqueue-bulk-generation: 202 happy path inserts the job and fires the runner",
  ...OPTS,
  async fn() {
    const jobsState = {
      existing: [] as Array<{ id: string; status: string }>,
      inserted: [] as Array<Record<string, unknown>>,
    };
    const runnerSeen = { called: false };
    const harness = createTestHarness({
      routes: [
        authUserRoute({ ok: true }),
        coursesRoute({ found: true }),
        isInstitutionAdminRoute(false),
        userInstitutionsRoute(ACTIVE_MEMBER),
        courseInstructorsRoute(true),
        jobsRoutes(jobsState),
        runnerRoute(runnerSeen),
      ],
    });
    try {
      const { handler } = await import("../../enqueue-bulk-generation/handler.ts");
      const res = await harness.invoke(handler, validBody(), {
        headers: { Authorization: "Bearer tok" },
      });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 202);
      assertEquals(body.jobId, "job-new-1");
      assertEquals(body.itemCount, 4);

      // The insert payload should carry the parsed params verbatim + scope.
      assertEquals(jobsState.inserted.length, 1);
      const row = jobsState.inserted[0];
      assertEquals(row.type, "bulk_question_generation");
      assertEquals(row.status, "pending");
      assertEquals(row.course_id, COURSE_ID);
      assertEquals(row.institution_id, INSTITUTION_ID);
      assertEquals(row.created_by, USER_ID);
      const params = row.params as Record<string, unknown>;
      assertEquals(params.courseId, COURSE_ID);
      assertEquals(params.types, ["mcq", "open"]);
      assertEquals(params.chapterIds, ["ch-1", "ch-2"]);
      assertEquals(params.countPerType, 3);

      // The runner is fired fire-and-forget; assert it was called.
      // The promise may resolve before the fetch hits — give it a tick.
      await new Promise((resolve) => setTimeout(resolve, 5));
      assertEquals(runnerSeen.called, true);
    } finally {
      harness.cleanup();
    }
  },
});

/**
 * Regression test for #786. The Deno edge runtime can terminate the isolate
 * as soon as the response Promise resolves; a bare `fetch().catch()` to the
 * run-jobs worker is therefore at risk of being killed before the POST is
 * delivered. The fix wraps the fetch in `EdgeRuntime.waitUntil(...)` so the
 * runtime keeps the isolate alive until the kick-off completes. We stub
 * `EdgeRuntime` and assert `waitUntil` was invoked.
 */
Deno.test({
  name: "enqueue-bulk-generation: triggerRunner registers fetch with EdgeRuntime.waitUntil (#786)",
  ...OPTS,
  async fn() {
    const jobsState = {
      existing: [] as Array<{ id: string; status: string }>,
      inserted: [] as Array<Record<string, unknown>>,
    };
    const runnerSeen = { called: false };
    const harness = createTestHarness({
      routes: [
        authUserRoute({ ok: true }),
        coursesRoute({ found: true }),
        isInstitutionAdminRoute(false),
        userInstitutionsRoute(ACTIVE_MEMBER),
        courseInstructorsRoute(true),
        jobsRoutes(jobsState),
        runnerRoute(runnerSeen),
      ],
    });

    // Stub EdgeRuntime on globalThis so triggerRunner picks it up.
    const waitUntilCalls: unknown[] = [];
    // deno-lint-ignore no-explicit-any
    const g = globalThis as any;
    const savedEdgeRuntime = g.EdgeRuntime;
    g.EdgeRuntime = {
      waitUntil: (p: unknown) => {
        waitUntilCalls.push(p);
      },
    };

    try {
      const { handler } = await import("../../enqueue-bulk-generation/handler.ts");
      const res = await harness.invoke(handler, validBody(), {
        headers: { Authorization: "Bearer tok" },
      });
      const { status } = await parseResponse(res);
      assertEquals(status, 202);

      // The fix: EdgeRuntime.waitUntil must have been called with the
      // runner-POST promise so the isolate stays alive after the 202.
      assertEquals(waitUntilCalls.length, 1);
      // The registered value must be a Promise (the fetch chain).
      assertEquals(typeof (waitUntilCalls[0] as { then?: unknown })?.then, "function");

      // And the underlying POST must still arrive.
      await new Promise((resolve) => setTimeout(resolve, 5));
      assertEquals(runnerSeen.called, true);
    } finally {
      if (savedEdgeRuntime === undefined) {
        delete g.EdgeRuntime;
      } else {
        g.EdgeRuntime = savedEdgeRuntime;
      }
      harness.cleanup();
    }
  },
});
