/**
 * Handler-level tests for the run-jobs worker (#695).
 *
 * Focuses on the worker's outer shell — CORS preflight and the service-role
 * auth gate. The runner's per-item logic (claim, slice, reschedule decision,
 * partial-failure, notify, idempotent finalize) is covered end-to-end in
 * `job-runner.test.ts` against an in-memory Supabase fake.
 */
import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { createTestHarness, parseResponse } from "../handler-harness.ts";
import { handler } from "../../../run-jobs/handler.ts";

const OPTS = { sanitizeOps: false, sanitizeResources: false };

Deno.test({
  name: "run-jobs: OPTIONS returns CORS headers",
  ...OPTS,
  async fn() {
    const h = createTestHarness();
    try {
      const req = new Request("http://localhost/functions/v1/run-jobs", {
        method: "OPTIONS",
      });
      const res = await handler(req);
      assertEquals(res.status, 200);
      assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "run-jobs: runs unauthenticated — no bearer required (keyless internal driver)",
  ...OPTS,
  async fn() {
    // run-jobs no longer gates on a service-role bearer; the pg_cron tick and
    // best-effort pokes call it without a matching key. With an empty queue the
    // slice no-ops and returns 200 instead of the old 401.
    const h = createTestHarness({ routes: [emptyQueueRoute()] });
    try {
      const res = await h.invoke(handler, { trigger: "pg_cron" });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      assertEquals(body.ok, true);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "run-jobs: a non-matching bearer is accepted, not rejected",
  ...OPTS,
  async fn() {
    const h = createTestHarness({ routes: [emptyQueueRoute()] });
    try {
      const res = await h.invoke(handler, { trigger: "test" }, {
        headers: { authorization: "Bearer wrong-key" },
      });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      assertEquals(body.ok, true);
    } finally {
      h.cleanup();
    }
  },
});

// ── Bounded fallback chain (#780) ───────────────────────────────────────
//
// The runner now self-chains when the pg_cron driver is unhealthy, capped
// at `MAX_FALLBACK_CHAIN`. These tests don't exercise the slice itself
// (covered in `job-runner.test.ts`); they pin the chain counter parsing
// and the response shape so callers and pg_cron retain a stable contract.

// Mock just enough of /rest/v1/jobs to make `claimNextJob` return null —
// the slice exits with moreWork=false, which keeps the fallback gate
// short-circuited so we can isolate the counter logic.
function emptyQueueRoute() {
  return {
    match: (url: string) => url.includes("/rest/v1/jobs"),
    respond: () =>
      new Response("[]", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  };
}

Deno.test({
  name: "run-jobs: response echoes the chain counter from the request body",
  ...OPTS,
  async fn() {
    const h = createTestHarness({ routes: [emptyQueueRoute()] });
    try {
      const res = await h.invoke(handler, { trigger: "fallback-chain", chain: 3 }, {
        headers: { authorization: "Bearer test-service-role-key" },
      });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      assertEquals(body.chain, 3);
      // moreWork=false from the empty queue → no chain regardless of counter.
      assertEquals(body.chained, false);
      assertEquals(body.moreWork, false);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "run-jobs: out-of-range chain counter is clamped to 0",
  ...OPTS,
  async fn() {
    const h = createTestHarness({ routes: [emptyQueueRoute()] });
    try {
      // A caller forging `chain: 999` would otherwise bypass the cap. The
      // parser pins it back to a fresh chain so MAX_FALLBACK_CHAIN holds.
      const res = await h.invoke(handler, { trigger: "test", chain: 999 }, {
        headers: { authorization: "Bearer test-service-role-key" },
      });
      const { body } = await parseResponse(res);
      assertEquals(body.chain, 0);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "run-jobs: non-numeric chain counter falls back to 0",
  ...OPTS,
  async fn() {
    const h = createTestHarness({ routes: [emptyQueueRoute()] });
    try {
      const res = await h.invoke(handler, { trigger: "test", chain: "not-a-number" }, {
        headers: { authorization: "Bearer test-service-role-key" },
      });
      const { body } = await parseResponse(res);
      assertEquals(body.chain, 0);
    } finally {
      h.cleanup();
    }
  },
});
