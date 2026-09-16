/**
 * Tests for the `retry-job` edge function (#764).
 *
 * Mirrors the auth/payload/authz surface of `cancel-job.test.ts` /
 * `resume-job.test.ts`. The happy path differs by mutating two tables:
 *   * `jobs` — flip status back to `pending` + clear lease + timing fields.
 *   * `job_items` — flip `failed`/`cancelled` items back to `pending` with
 *     `attempts=0` so the runner's per-item retry cap doesn't immediately
 *     re-fail them.
 *
 * The active-lease guard (`processing` + `locked_until` in the future) is
 * the only behavior that returns a 4xx outside of auth / payload errors;
 * a dedicated test pins it at 409.
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

const PAST_LEASE = "1970-01-01T00:00:00.000Z";
const FUTURE_LEASE = new Date(Date.now() + 60_000).toISOString();

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
  locked_until: string;
  last_heartbeat?: string | null;
  error?: string | null;
  ended_at?: string | null;
  started_at?: string | null;
}

function jobsRoutes(state: {
  row: JobRowFixture | null;
  updates: Array<Record<string, unknown>>;
  updateMatch: boolean;
}): MockRoute {
  return {
    match: (url) => url.includes("/rest/v1/jobs"),
    respond: (_url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "PATCH") {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        state.updates.push(body);
        if (!state.updateMatch) {
          return new Response("null", {
            status: 200,
            headers: { "Content-Type": "application/vnd.pgrst.object+json" },
          });
        }
        if (state.row) {
          // deno-lint-ignore no-explicit-any
          const row = state.row as any;
          for (const [k, v] of Object.entries(body)) {
            row[k] = v;
          }
        }
        return new Response(JSON.stringify(state.row), {
          status: 200,
          headers: { "Content-Type": "application/vnd.pgrst.object+json" },
        });
      }
      return new Response(JSON.stringify(state.row), {
        status: 200,
        headers: { "Content-Type": "application/vnd.pgrst.object+json" },
      });
    },
  };
}

function jobItemsRoutes(state: { itemsUpdated: boolean; lastBody: Record<string, unknown> | null }): MockRoute {
  return {
    match: (url) => url.includes("/rest/v1/job_items"),
    respond: (_url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "PATCH") {
        state.itemsUpdated = true;
        state.lastBody = init?.body ? JSON.parse(String(init.body)) : null;
        return new Response("[]", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("[]", { status: 200 });
    },
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
  name: "retry-job: 401 when authorization header is missing",
  ...OPTS,
  async fn() {
    const harness = createTestHarness({ routes: [] });
    try {
      const { handler } = await import("../../retry-job/handler.ts");
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
  name: "retry-job: 401 when supabase.auth.getUser rejects",
  ...OPTS,
  async fn() {
    const harness = createTestHarness({
      routes: [authUserRoute({ ok: false })],
    });
    try {
      const { handler } = await import("../../retry-job/handler.ts");
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
  name: "retry-job: 400 on missing jobId",
  ...OPTS,
  async fn() {
    const harness = createTestHarness({
      routes: [authUserRoute({ ok: true })],
    });
    try {
      const { handler } = await import("../../retry-job/handler.ts");
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
  name: "retry-job: 404 when the job does not exist",
  ...OPTS,
  async fn() {
    const jobsState = {
      row: null,
      updates: [] as Array<Record<string, unknown>>,
      updateMatch: false,
    };
    const harness = createTestHarness({
      routes: [authUserRoute({ ok: true }), jobsRoutes(jobsState)],
    });
    try {
      const { handler } = await import("../../retry-job/handler.ts");
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
  name: "retry-job: 403 when caller is not creator, instructor, admin, or super-admin",
  ...OPTS,
  async fn() {
    const jobsState = {
      row: {
        id: JOB_ID,
        type: "bulk_question_generation",
        status: "failed",
        created_by: "someone-else",
        institution_id: INSTITUTION_ID,
        course_id: COURSE_ID,
        locked_until: PAST_LEASE,
      } as JobRowFixture,
      updates: [] as Array<Record<string, unknown>>,
      updateMatch: false,
    };
    const harness = createTestHarness({
      routes: [
        authUserRoute({ ok: true }),
        jobsRoutes(jobsState),
        isInstitutionAdminRoute(false),
        userInstitutionsRoute(null),
        courseInstructorsRoute(false),
      ],
    });
    try {
      const { handler } = await import("../../retry-job/handler.ts");
      const res = await harness.invoke(handler, { jobId: JOB_ID }, {
        headers: { Authorization: "Bearer tok" },
      });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 403);
      assertEquals(body.error, "Not authorized to retry this job");
      assertEquals(jobsState.updates.length, 0);
    } finally {
      harness.cleanup();
    }
  },
});

Deno.test({
  name: "retry-job: 200 + noop when job is already completed",
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
        locked_until: PAST_LEASE,
      } as JobRowFixture,
      updates: [] as Array<Record<string, unknown>>,
      updateMatch: false,
    };
    const harness = createTestHarness({
      routes: [authUserRoute({ ok: true }), jobsRoutes(jobsState)],
    });
    try {
      const { handler } = await import("../../retry-job/handler.ts");
      const res = await harness.invoke(handler, { jobId: JOB_ID }, {
        headers: { Authorization: "Bearer tok" },
      });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      assertEquals(body.status, "noop");
      assertEquals(body.jobStatus, "completed");
      assertEquals(jobsState.updates.length, 0);
    } finally {
      harness.cleanup();
    }
  },
});

Deno.test({
  name: "retry-job: 409 when processing job still has a live lease",
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
        locked_until: FUTURE_LEASE,
      } as JobRowFixture,
      updates: [] as Array<Record<string, unknown>>,
      updateMatch: false,
    };
    const harness = createTestHarness({
      routes: [authUserRoute({ ok: true }), jobsRoutes(jobsState)],
    });
    try {
      const { handler } = await import("../../retry-job/handler.ts");
      const res = await harness.invoke(handler, { jobId: JOB_ID }, {
        headers: { Authorization: "Bearer tok" },
      });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 409);
      assertExists(body.error);
      assertEquals(body.jobStatus, "processing");
      // No mutation when the lease is still live.
      assertEquals(jobsState.updates.length, 0);
    } finally {
      harness.cleanup();
    }
  },
});

Deno.test({
  name: "retry-job: 200 happy path — failed job is requeued, items reset",
  ...OPTS,
  async fn() {
    const jobsState = {
      row: {
        id: JOB_ID,
        type: "bulk_question_generation",
        status: "failed",
        created_by: USER_ID,
        institution_id: INSTITUTION_ID,
        course_id: COURSE_ID,
        locked_until: PAST_LEASE,
        error: "something blew up",
        ended_at: new Date().toISOString(),
      } as JobRowFixture,
      updates: [] as Array<Record<string, unknown>>,
      updateMatch: true,
    };
    const itemsState = { itemsUpdated: false, lastBody: null as Record<string, unknown> | null };
    const runnerSeen = { calls: 0, lastAuth: null as string | null };
    const harness = createTestHarness({
      routes: [
        authUserRoute({ ok: true }),
        jobsRoutes(jobsState),
        jobItemsRoutes(itemsState),
        runJobsRoute(runnerSeen),
      ],
    });
    try {
      const { handler } = await import("../../retry-job/handler.ts");
      const res = await harness.invoke(handler, { jobId: JOB_ID }, {
        headers: { Authorization: "Bearer tok" },
      });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      assertEquals(body.status, "retried");
      assertEquals(body.previousStatus, "failed");

      // Job flipped to pending, lease + timing cleared, error nulled.
      assertEquals(jobsState.updates.length, 1);
      const upd = jobsState.updates[0];
      assertEquals(upd.status, "pending");
      assertEquals(upd.error, null);
      assertEquals(upd.ended_at, null);
      assertEquals(upd.started_at, null);
      assertEquals(upd.last_heartbeat, null);
      assertExists(upd.locked_until);

      // Non-terminal items were reset.
      assertEquals(itemsState.itemsUpdated, true);
      assertExists(itemsState.lastBody);
      assertEquals(itemsState.lastBody!.status, "pending");
      assertEquals(itemsState.lastBody!.attempts, 0);
      assertEquals(itemsState.lastBody!.error, null);

      // Runner was poked.
      await new Promise((r) => setTimeout(r, 0));
      assertEquals(runnerSeen.calls, 1);
      assertEquals(runnerSeen.lastAuth, "Bearer test-service-role-key");
    } finally {
      harness.cleanup();
    }
  },
});

Deno.test({
  name: "retry-job: 200 happy path — processing job with expired lease is requeued",
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
        // Lease expired 10 min ago.
        locked_until: new Date(Date.now() - 10 * 60_000).toISOString(),
      } as JobRowFixture,
      updates: [] as Array<Record<string, unknown>>,
      updateMatch: true,
    };
    const itemsState = { itemsUpdated: false, lastBody: null as Record<string, unknown> | null };
    const runnerSeen = { calls: 0, lastAuth: null as string | null };
    const harness = createTestHarness({
      routes: [
        authUserRoute({ ok: true }),
        jobsRoutes(jobsState),
        jobItemsRoutes(itemsState),
        runJobsRoute(runnerSeen),
      ],
    });
    try {
      const { handler } = await import("../../retry-job/handler.ts");
      const res = await harness.invoke(handler, { jobId: JOB_ID }, {
        headers: { Authorization: "Bearer tok" },
      });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      assertEquals(body.status, "retried");
      assertEquals(body.previousStatus, "processing");
      assertEquals(jobsState.updates.length, 1);
      assertEquals(jobsState.updates[0].status, "pending");
    } finally {
      harness.cleanup();
    }
  },
});

Deno.test({
  name: "retry-job: super-admin (non-creator) can retry",
  ...OPTS,
  async fn() {
    const jobsState = {
      row: {
        id: JOB_ID,
        type: "bulk_question_generation",
        status: "failed",
        created_by: "someone-else",
        institution_id: INSTITUTION_ID,
        course_id: COURSE_ID,
        locked_until: PAST_LEASE,
      } as JobRowFixture,
      updates: [] as Array<Record<string, unknown>>,
      updateMatch: true,
    };
    const itemsState = { itemsUpdated: false, lastBody: null as Record<string, unknown> | null };
    const runnerSeen = { calls: 0, lastAuth: null as string | null };
    const harness = createTestHarness({
      routes: [
        authUserRoute({ ok: true }),
        jobsRoutes(jobsState),
        isInstitutionAdminRoute(true),
        jobItemsRoutes(itemsState),
        runJobsRoute(runnerSeen),
      ],
    });
    try {
      const { handler } = await import("../../retry-job/handler.ts");
      const res = await harness.invoke(handler, { jobId: JOB_ID }, {
        headers: { Authorization: "Bearer tok" },
      });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      assertEquals(body.status, "retried");
      assertEquals(jobsState.updates.length, 1);
    } finally {
      harness.cleanup();
    }
  },
});

Deno.test({
  name: "retry-job: 200 + noop when pending job is retried (still pokes runner)",
  ...OPTS,
  async fn() {
    const jobsState = {
      row: {
        id: JOB_ID,
        type: "bulk_question_generation",
        status: "pending",
        created_by: USER_ID,
        institution_id: INSTITUTION_ID,
        course_id: COURSE_ID,
        locked_until: PAST_LEASE,
      } as JobRowFixture,
      updates: [] as Array<Record<string, unknown>>,
      updateMatch: false,
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
      const { handler } = await import("../../retry-job/handler.ts");
      const res = await harness.invoke(handler, { jobId: JOB_ID }, {
        headers: { Authorization: "Bearer tok" },
      });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      assertEquals(body.status, "noop");
      assertEquals(body.jobStatus, "pending");
      // No mutation on pending — already waiting for runner.
      assertEquals(jobsState.updates.length, 0);
      // But we still poked the runner so the operator gets a kick now.
      await new Promise((r) => setTimeout(r, 0));
      assertEquals(runnerSeen.calls, 1);
    } finally {
      harness.cleanup();
    }
  },
});
