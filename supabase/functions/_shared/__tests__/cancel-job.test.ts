/**
 * Tests for the `cancel-job` edge function (#723).
 *
 * Cancellation is the only client-callable WRITE on `public.jobs` besides the
 * enqueue path, so the test surface mirrors `enqueue-bulk-generation.test.ts`:
 *
 *   1. auth gating (no header / bad token → 401)
 *   2. payload validation (missing or non-string jobId → 400)
 *   3. job lookup (missing row → 404)
 *   4. authorization (non-instructor / non-admin / non-creator → 403)
 *   5. idempotency on already-terminal job (200 + noop)
 *   6. happy path: status flipped, pending items flipped, notification inserted
 */
import {
  assertEquals,
  assertExists,
  assertStringIncludes,
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

/**
 * Routes against `/rest/v1/jobs`:
 *   - GET  → return state.row (either the initial fixture or a later snapshot)
 *   - PATCH → mutate state.row, append to state.updates, return either an
 *             array (no row matched the predicate) or a single object (matched)
 */
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
          // No row matched the .in(status, ['pending','processing']) predicate.
          // PostgREST returns the empty selection.
          return new Response("null", {
            status: 200,
            headers: { "Content-Type": "application/vnd.pgrst.object+json" },
          });
        }
        // Merge updates into state.row so a subsequent SELECT (notification
        // tally path) sees the new state.
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
      // GET — maybeSingle uses ?limit=1 in PostgREST 9+. The handler also
      // does a `.maybeSingle()` so it accepts either array or object.
      return new Response(JSON.stringify(state.row), {
        status: 200,
        headers: { "Content-Type": "application/vnd.pgrst.object+json" },
      });
    },
  };
}

function jobItemsRoutes(state: {
  tallies: Array<{ status: string }>;
  itemsUpdated: boolean;
  lastPatchUrl?: string;
}): MockRoute {
  return {
    match: (url) => url.includes("/rest/v1/job_items"),
    respond: (url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "PATCH") {
        state.itemsUpdated = true;
        state.lastPatchUrl = url;
        return new Response("[]", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(state.tallies), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  };
}

function notificationsRoute(seen: { count: number; payloads: Array<Record<string, unknown>> }): MockRoute {
  return {
    match: (url) => url.includes("/rest/v1/notifications"),
    respond: (_url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST") {
        seen.count++;
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        seen.payloads.push(body);
        return new Response(JSON.stringify(body), {
          status: 201,
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

// ── Tests ──────────────────────────────────────────────────────────────

Deno.test({
  name: "cancel-job: 401 when authorization header is missing",
  ...OPTS,
  async fn() {
    const harness = createTestHarness({ routes: [] });
    try {
      const { handler } = await import("../../cancel-job/handler.ts");
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
  name: "cancel-job: 401 when supabase.auth.getUser rejects",
  ...OPTS,
  async fn() {
    const harness = createTestHarness({
      routes: [authUserRoute({ ok: false })],
    });
    try {
      const { handler } = await import("../../cancel-job/handler.ts");
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
  name: "cancel-job: 400 on missing jobId",
  ...OPTS,
  async fn() {
    const harness = createTestHarness({
      routes: [authUserRoute({ ok: true })],
    });
    try {
      const { handler } = await import("../../cancel-job/handler.ts");
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
  name: "cancel-job: 404 when the job does not exist",
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
      const { handler } = await import("../../cancel-job/handler.ts");
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
  name: "cancel-job: 403 when caller is not creator, instructor, admin, or super-admin",
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
      const { handler } = await import("../../cancel-job/handler.ts");
      const res = await harness.invoke(handler, { jobId: JOB_ID }, {
        headers: { Authorization: "Bearer tok" },
      });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 403);
      assertEquals(body.error, "Not authorized to cancel this job");
      // No update should have run.
      assertEquals(jobsState.updates.length, 0);
    } finally {
      harness.cleanup();
    }
  },
});

Deno.test({
  name: "cancel-job: 200 + noop when job is already in a terminal state",
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
      updates: [] as Array<Record<string, unknown>>,
      updateMatch: false,
    };
    const harness = createTestHarness({
      routes: [authUserRoute({ ok: true }), jobsRoutes(jobsState)],
    });
    try {
      const { handler } = await import("../../cancel-job/handler.ts");
      const res = await harness.invoke(handler, { jobId: JOB_ID }, {
        headers: { Authorization: "Bearer tok" },
      });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      assertEquals(body.status, "noop");
      assertEquals(body.jobStatus, "completed");
      // No mutation.
      assertEquals(jobsState.updates.length, 0);
    } finally {
      harness.cleanup();
    }
  },
});

Deno.test({
  name: "cancel-job: 200 happy path — creator cancels, items flipped, notification inserted",
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
      updates: [] as Array<Record<string, unknown>>,
      updateMatch: true,
    };
    const itemsState = {
      // After cancel: 1 completed before stop, 2 cancelled.
      tallies: [
        { status: "completed" },
        { status: "cancelled" },
        { status: "cancelled" },
      ],
      itemsUpdated: false,
      lastPatchUrl: undefined as string | undefined,
    };
    const notifSeen = { count: 0, payloads: [] as Array<Record<string, unknown>> };
    const harness = createTestHarness({
      routes: [
        authUserRoute({ ok: true }),
        jobsRoutes(jobsState),
        jobItemsRoutes(itemsState),
        notificationsRoute(notifSeen),
      ],
    });
    try {
      const { handler } = await import("../../cancel-job/handler.ts");
      const res = await harness.invoke(handler, { jobId: JOB_ID }, {
        headers: { Authorization: "Bearer tok" },
      });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      assertEquals(body.status, "cancelled");

      // The status flip carries `ended_at`.
      assertEquals(jobsState.updates.length, 1);
      assertEquals(jobsState.updates[0].status, "cancelled");
      assertExists(jobsState.updates[0].ended_at);

      // Both pending AND in-flight (processing) items are swept to cancelled —
      // otherwise a mid-flight batch stays `processing` forever under a
      // cancelled job (the "Running under Cancelled" bug).
      assertEquals(itemsState.itemsUpdated, true);
      assertStringIncludes(
        decodeURIComponent(itemsState.lastPatchUrl ?? ""),
        "status=in.(pending,processing)",
      );

      // Exactly one job.cancelled notification went to the creator.
      assertEquals(notifSeen.count, 1);
      const payload = notifSeen.payloads[0];
      assertEquals(payload.user_id, USER_ID);
      assertEquals(payload.job_id, JOB_ID);
      assertEquals(payload.type, "job.cancelled");
    } finally {
      harness.cleanup();
    }
  },
});

Deno.test({
  name: "cancel-job: super-admin (non-creator) can cancel",
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
      updates: [] as Array<Record<string, unknown>>,
      updateMatch: true,
    };
    const itemsState = { tallies: [], itemsUpdated: false };
    const notifSeen = { count: 0, payloads: [] as Array<Record<string, unknown>> };
    const harness = createTestHarness({
      routes: [
        authUserRoute({ ok: true }),
        jobsRoutes(jobsState),
        jobItemsRoutes(itemsState),
        notificationsRoute(notifSeen),
        isInstitutionAdminRoute(true),
      ],
    });
    try {
      const { handler } = await import("../../cancel-job/handler.ts");
      const res = await harness.invoke(handler, { jobId: JOB_ID }, {
        headers: { Authorization: "Bearer tok" },
      });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      assertEquals(body.status, "cancelled");
      assertEquals(jobsState.updates.length, 1);
    } finally {
      harness.cleanup();
    }
  },
});
