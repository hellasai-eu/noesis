import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createTestHarness, FetchLogEntry, MockRoute } from "./handler-harness.ts";
import {
  checkActiveCourseInstructor,
  checkActiveMembership,
  checkInstitutionAdmin,
} from "../institution-authz.ts";

// ── institution-authz, tested directly (#1099) ─────────────────────────
// This module is the single authorization boundary for the service-role
// handlers changed in #1086 — the thing that decides whether a suspended
// administrator can still act. Until now it was asserted only by proxy, through
// the handler tests of its consumers, and `authz-check-failure.handler.test.ts`
// covers just one axis of it: that a check which could not be PERFORMED is
// reported rather than answered (#1155).
//
// What follows is the other axis — the contract itself, including the three
// edges that the handler tests exercise only incidentally:
//
//   * `checkInstitutionAdmin` folds in `is_super_admin`, which is why callers
//     drop their own super-admin branch;
//   * `checkActiveCourseInstructor` checks membership FIRST and skips the
//     assignment lookup when it fails, which is what closes the
//     `course_instructors`-has-no-suspension-column hole;
//   * `checkActiveMembership` treats "no membership row" and "suspended
//     membership" identically, and both differently from `is_suspended: false`.

const OPTS = { sanitizeOps: false, sanitizeResources: false };

const USER_ID = "99999999-9999-9999-9999-999999999999";
const COURSE_ID = "33333333-3333-3333-3333-333333333333";
const INSTITUTION_ID = "22222222-2222-2222-2222-222222222222";

function client() {
  return createClient("http://localhost:54321", "test-service-role-key", {
    auth: { autoRefreshToken: false, persistSession: false },
  });
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

const ADMIN_RPC = "/rest/v1/rpc/is_institution_admin";
const MEMBERSHIP = "/rest/v1/user_institutions";
const ASSIGNMENT = "/rest/v1/course_instructors";

function called(fetchLog: FetchLogEntry[], pattern: string): boolean {
  return fetchLog.some((c) => c.url.includes(pattern));
}

/** Run `fn` against a mocked PostgREST and hand back its answer plus the traffic. */
async function withRoutes<T>(
  routes: MockRoute[],
  fn: (supabase: ReturnType<typeof client>) => Promise<T>,
): Promise<{ result: T; fetchLog: FetchLogEntry[] }> {
  const h = createTestHarness({ routes });
  try {
    const result = await fn(client());
    return { result, fetchLog: [...h.fetchLog] };
  } finally {
    h.cleanup();
  }
}

// ── checkInstitutionAdmin ──────────────────────────────────────────────

Deno.test({
  name: "checkInstitutionAdmin: asks the database, and asks it about the right pair",
  ...OPTS,
  async fn() {
    // The whole point of #1086: the rule lives in `is_institution_admin`, so
    // suspension and super-admin cascade. A helper that read
    // `user_institutions.role` itself — or that passed the arguments the wrong
    // way round — would still return `true` here and look correct.
    const { result, fetchLog } = await withRoutes(
      [ok(ADMIN_RPC, true)],
      (s) => checkInstitutionAdmin(s, USER_ID, INSTITUTION_ID),
    );
    assertEquals(result, { ok: true, allowed: true });
    assertEquals(called(fetchLog, MEMBERSHIP), false);

    const rpc = fetchLog.find((c) => c.url.includes(ADMIN_RPC));
    assertEquals(JSON.parse(rpc?.body ?? "{}"), {
      _user_id: USER_ID,
      _institution_id: INSTITUTION_ID,
    });
  },
});

Deno.test({
  name: "checkInstitutionAdmin: a super-admin with no membership row is an admin",
  ...OPTS,
  async fn() {
    // `is_institution_admin` ORs in `is_super_admin`, which is global and has no
    // membership to suspend — so the RPC says yes while `user_institutions`
    // holds nothing. Callers rely on this to drop their own super-admin branch;
    // a helper that second-guessed the RPC with a membership read would deny.
    const { result, fetchLog } = await withRoutes(
      [ok(ADMIN_RPC, true), ok(MEMBERSHIP, null)],
      (s) => checkInstitutionAdmin(s, USER_ID, INSTITUTION_ID),
    );
    assertEquals(result, { ok: true, allowed: true });
    assertEquals(called(fetchLog, MEMBERSHIP), false);
  },
});

Deno.test({
  name: "checkInstitutionAdmin: only a literal true is a yes",
  ...OPTS,
  async fn() {
    // A null body is what a dropped or renamed RPC returns rather than an
    // error. `data === true` is deliberate: anything else fails closed.
    const { result } = await withRoutes(
      [ok(ADMIN_RPC, null)],
      (s) => checkInstitutionAdmin(s, USER_ID, INSTITUTION_ID),
    );
    assertEquals(result, { ok: true, allowed: false });
  },
});

// ── checkActiveMembership ──────────────────────────────────────────────

Deno.test({
  name: "checkActiveMembership: a live membership is the only yes",
  ...OPTS,
  async fn() {
    const { result } = await withRoutes(
      [ok(MEMBERSHIP, { is_suspended: false })],
      (s) => checkActiveMembership(s, USER_ID, INSTITUTION_ID),
    );
    assertEquals(result, { ok: true, allowed: true });
  },
});

Deno.test({
  name: "checkActiveMembership: a suspended member and a stranger are the same answer",
  ...OPTS,
  async fn() {
    // Not merely both false — deliberately indistinguishable, so no caller can
    // grow a "well, they at least have a row" branch. Both are still `ok`:
    // the question was answered, and the answer was no (#1155).
    const suspended = await withRoutes(
      [ok(MEMBERSHIP, { is_suspended: true })],
      (s) => checkActiveMembership(s, USER_ID, INSTITUTION_ID),
    );
    const stranger = await withRoutes(
      [ok(MEMBERSHIP, null)],
      (s) => checkActiveMembership(s, USER_ID, INSTITUTION_ID),
    );
    assertEquals(suspended.result, { ok: true, allowed: false });
    assertEquals(stranger.result, suspended.result);
  },
});

// ── checkActiveCourseInstructor ────────────────────────────────────────

Deno.test({
  name: "checkActiveCourseInstructor: an assigned instructor with a live membership",
  ...OPTS,
  async fn() {
    const { result, fetchLog } = await withRoutes(
      [ok(MEMBERSHIP, { is_suspended: false }), ok(ASSIGNMENT, { user_id: USER_ID })],
      (s) => checkActiveCourseInstructor(s, USER_ID, COURSE_ID, INSTITUTION_ID),
    );
    assertEquals(result, { ok: true, allowed: true });
    assertEquals(called(fetchLog, ASSIGNMENT), true);
  },
});

Deno.test({
  name: "checkActiveCourseInstructor: a live member who is not assigned is not an instructor",
  ...OPTS,
  async fn() {
    const { result } = await withRoutes(
      [ok(MEMBERSHIP, { is_suspended: false }), ok(ASSIGNMENT, null)],
      (s) => checkActiveCourseInstructor(s, USER_ID, COURSE_ID, INSTITUTION_ID),
    );
    assertEquals(result, { ok: true, allowed: false });
  },
});

Deno.test({
  name: "checkActiveCourseInstructor: suspension beats an assignment that still exists",
  ...OPTS,
  async fn() {
    // The hole this ordering closes: `course_instructors` carries no suspension
    // column, so suspending a user leaves every assignment they had intact.
    // Here the assignment route would happily say yes — the check must never
    // reach it. Asserting the *absence* of that request is the point; asserting
    // only `allowed: false` would pass just as well against a version that
    // looked the assignment up and then ANDed the two answers, which is a
    // different, more fragile rule.
    const { result, fetchLog } = await withRoutes(
      [ok(MEMBERSHIP, { is_suspended: true }), ok(ASSIGNMENT, { user_id: USER_ID })],
      (s) => checkActiveCourseInstructor(s, USER_ID, COURSE_ID, INSTITUTION_ID),
    );
    assertEquals(result, { ok: true, allowed: false });
    assertEquals(called(fetchLog, ASSIGNMENT), false);
  },
});

Deno.test({
  name: "checkActiveCourseInstructor: a former member's assignment is never consulted",
  ...OPTS,
  async fn() {
    // Same ordering, the other way a membership can be missing: the row is gone
    // entirely and the stale assignment survives it.
    const { result, fetchLog } = await withRoutes(
      [ok(MEMBERSHIP, null), ok(ASSIGNMENT, { user_id: USER_ID })],
      (s) => checkActiveCourseInstructor(s, USER_ID, COURSE_ID, INSTITUTION_ID),
    );
    assertEquals(result, { ok: true, allowed: false });
    assertEquals(called(fetchLog, ASSIGNMENT), false);
  },
});
