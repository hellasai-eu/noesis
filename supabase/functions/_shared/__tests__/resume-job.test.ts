/**
 * Tests for the `resume-job` edge function (#729).
 *
 * Mirrors the auth/payload/authz surface of `cancel-job.test.ts`. The happy
 * path differs in two ways:
 *   1. resume-job does NOT mutate the job row — the runner picks up the
 *      `processing` row as-is. So there's no PATCH to assert; we instead
 *      assert that the handler issued the fire-and-forget POST to
 *      `/functions/v1/run-jobs` with the service-role bearer.
 *   2. terminal jobs respond `noop` (matching cancel's idempotency shape).
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

const USER_ID = "user-1";
const JOB_ID = "job-1";
const COURSE_ID = "course-1";
const INSTITUTION_ID = "inst-1";

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

interface JobRowFixture {
  id: string;
  type?: string;
  status: string;
  created_by: string | null;
  institution_id: string;
  course_id: string | null;
}

function jobsRoutes(state: { row: JobRowFixture | null }): MockRoute {
  return {
    match: (url) => url.includes("/rest/v1/jobs"),
    respond: () =>
      new Response(JSON.stringify(state.row), {
        status: 200,
        headers: { "Content-Type": "application/vnd.pgrst.object+json" },
      }),
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

function userInstitutionsRoute(role: string | null): MockRoute {
  return {
    match: (url) => url.includes("/rest/v1/user_institutions"),
    respond: () =>
      new Response(
        JSON.stringify(role ? [{ role }] : []),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  };
}

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

function runJobsRoute(seen: { calls: number; lastAuth: string | null }): MockRoute {
  return {
    match: (url) => url.includes("/functions/v1/run-jobs"),
    respond: (_url, init) => {
      seen.calls++;
      const auth = init?.headers && typeof init.headers === "object"
        // deno-lint-ignore no-explicit-any
        ? (init.headers as any)["Authorization"] ?? (init.headers as any)["authorization"] ?? null
        : null;
      seen.lastAuth = typeof auth === "string" ? auth : null;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

Deno.test({
  name: "resume-job: 401 when authorization header is missing",
  ...OPTS,
  async fn() {
    const harness = createTestHarness({ routes: [] });
    try {
      const { handler } = await import("../../resume-job/handler.ts");
      const res = await harness.invoke(handler, { jobId: JOB_ID });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 401);
      assertEquals(body.error, "Missing authorization");
    } finally {
      harness.cleanup();
    }
  },
});

Deno.test({
  name: "resume-job: 401 when supabase.auth.getUser rejects",
  ...OPTS,
  async fn() {
    const harness = createTestHarness({
      routes: [authUserRoute({ ok: false })],
    });
    try {
      const { handler } = await import("../../resume-job/handler.ts");
      const res = await harness.invoke(handler, { jobId: JOB_ID }, {
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

Deno.test({
  name: "resume-job: 400 on missing jobId",
  ...OPTS,
  async fn() {
    const harness = createTestHarness({
      routes: [authUserRoute({ ok: true })],
    });
    try {
      const { handler } = await import("../../resume-job/handler.ts");
      const res = await harness.invoke(handler, {}, {
        headers: { Authorization: "Bearer tok" },
      });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 400);
      assertExists(body.error);
    } finally {
      harness.cleanup();
    }
  },
});

Deno.test({
  name: "resume-job: 404 when the job does not exist",
  ...OPTS,
  async fn() {
    const jobsState = { row: null };
    const harness = createTestHarness({
      routes: [authUserRoute({ ok: true }), jobsRoutes(jobsState)],
    });
    try {
      const { handler } = await import("../../resume-job/handler.ts");
      const res = await harness.invoke(handler, { jobId: JOB_ID }, {
        headers: { Authorization: "Bearer tok" },
      });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 404);
      assertEquals(body.error, "Job not found");
    } finally {
      harness.cleanup();
    }
  },
});

Deno.test({
  name: "resume-job: 403 when caller is not creator, instructor, admin, or super-admin",
  ...OPTS,
  async fn() {
    const jobsState = {
      row: {
        id: JOB_ID,
        type: "bulk_question_generation",
        status: "processing",
        created_by: "someone-else",
        institution_id: INSTITUTION_ID,
        course_id: COURSE_ID,
      } as JobRowFixture,
    };
    const runnerSeen = { calls: 0, lastAuth: null as string | null };
    const harness = createTestHarness({
      routes: [
        authUserRoute({ ok: true }),
        jobsRoutes(jobsState),
        isInstitutionAdminRoute(false),
        userInstitutionsRoute(null),
        courseInstructorsRoute(false),
        runJobsRoute(runnerSeen),
      ],
    });
    try {
      const { handler } = await import("../../resume-job/handler.ts");
      const res = await harness.invoke(handler, { jobId: JOB_ID }, {
        headers: { Authorization: "Bearer tok" },
      });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 403);
      assertEquals(body.error, "Not authorized to resume this job");
      // The runner was never poked on an unauthorized request.
      assertEquals(runnerSeen.calls, 0);
    } finally {
      harness.cleanup();
    }
  },
});

Deno.test({
  name: "resume-job: 200 + noop when job is already in a terminal state",
  ...OPTS,
  async fn() {
    const jobsState = {
      row: {
        id: JOB_ID,
        type: "bulk_question_generation",
        status: "completed",
        created_by: USER_ID,
        institution_id: INSTITUTION_ID,
        course_id: COURSE_ID,
      } as JobRowFixture,
    };
    const runnerSeen = { calls: 0, lastAuth: null as string | null };
    const harness = createTestHarness({
      routes: [
        authUserRoute({ ok: true }),
        jobsRoutes(jobsState),
        runJobsRoute(runnerSeen),
      ],
    });
    try {
      const { handler } = await import("../../resume-job/handler.ts");
      const res = await harness.invoke(handler, { jobId: JOB_ID }, {
        headers: { Authorization: "Bearer tok" },
      });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      assertEquals(body.status, "noop");
      assertEquals(body.jobStatus, "completed");
      // Don't poke the runner for a terminal job.
      assertEquals(runnerSeen.calls, 0);
    } finally {
      harness.cleanup();
    }
  },
});

Deno.test({
  name: "resume-job: 200 happy path — creator resumes, runner is poked",
  ...OPTS,
  async fn() {
    const jobsState = {
      row: {
        id: JOB_ID,
        type: "bulk_question_generation",
        status: "processing",
        created_by: USER_ID,
        institution_id: INSTITUTION_ID,
        course_id: COURSE_ID,
      } as JobRowFixture,
    };
    const runnerSeen = { calls: 0, lastAuth: null as string | null };
    const harness = createTestHarness({
      routes: [
        authUserRoute({ ok: true }),
        jobsRoutes(jobsState),
        runJobsRoute(runnerSeen),
      ],
    });
    try {
      const { handler } = await import("../../resume-job/handler.ts");
      const res = await harness.invoke(handler, { jobId: JOB_ID }, {
        headers: { Authorization: "Bearer tok" },
      });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      assertEquals(body.status, "resumed");
      assertEquals(body.jobStatus, "processing");
      // The fire-and-forget poke is async; give the microtask queue a tick.
      await new Promise((r) => setTimeout(r, 0));
      assertEquals(runnerSeen.calls, 1);
      // Bearer must be the service-role key from DEFAULT_ENV.
      assertEquals(runnerSeen.lastAuth, "Bearer test-service-role-key");
    } finally {
      harness.cleanup();
    }
  },
});

Deno.test({
  name: "resume-job: super-admin (non-creator) can resume",
  ...OPTS,
  async fn() {
    const jobsState = {
      row: {
        id: JOB_ID,
        type: "bulk_question_generation",
        status: "processing",
        created_by: "someone-else",
        institution_id: INSTITUTION_ID,
        course_id: COURSE_ID,
      } as JobRowFixture,
    };
    const runnerSeen = { calls: 0, lastAuth: null as string | null };
    const harness = createTestHarness({
      routes: [
        authUserRoute({ ok: true }),
        jobsRoutes(jobsState),
        isInstitutionAdminRoute(true),
        runJobsRoute(runnerSeen),
      ],
    });
    try {
      const { handler } = await import("../../resume-job/handler.ts");
      const res = await harness.invoke(handler, { jobId: JOB_ID }, {
        headers: { Authorization: "Bearer tok" },
      });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      assertEquals(body.status, "resumed");
      await new Promise((r) => setTimeout(r, 0));
      assertEquals(runnerSeen.calls, 1);
    } finally {
      harness.cleanup();
    }
  },
});
