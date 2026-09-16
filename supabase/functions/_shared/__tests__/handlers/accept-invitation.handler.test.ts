import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  createTestHarness,
  FetchLogEntry,
  MockRoute,
  parseResponse,
} from "../handler-harness.ts";
import { handler } from "../../../accept-invitation/handler.ts";

// ── Caller identity (#1135) ────────────────────────────────────────────
// The handler used to take `userId` straight from the request body and bind it
// to a body-supplied `invitationId`, with no caller identity at all — so an
// anonymous request could grant any account the role and institution of any
// invitation. It now derives the user from the bearer token, refuses to redeem
// an invitation issued to a different address, and claims the invitation with a
// compare-and-swap so it can only ever be spent once.

const CALLER_ID = "99999999-9999-9999-9999-999999999999";
const CALLER_EMAIL = "invited@school.test";
const INVITATION_ID = "11111111-1111-1111-1111-111111111111";
const INSTITUTION_ID = "22222222-2222-2222-2222-222222222222";
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

/** The invitation row the handler reads by id. */
function invitationRoute(overrides: Record<string, unknown> = {}): MockRoute {
  return {
    match: (url, init) =>
      url.includes("/rest/v1/invitations") && (init?.method ?? "GET") === "GET",
    respond: () =>
      new Response(
        JSON.stringify({
          id: INVITATION_ID,
          email: CALLER_EMAIL,
          institution_id: INSTITUTION_ID,
          role: "student",
          invited_class_id: null,
          invited_grade_level_id: null,
          status: "pending",
          ...overrides,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  };
}

/**
 * The compare-and-swap that claims the invitation.
 *
 * `won: true` returns the updated row — this request claimed it. `won: false`
 * returns an empty set, which is what Postgres gives when the `status = pending`
 * predicate matches nothing: already accepted, cancelled, or lost the race.
 */
function claimRoute(won: boolean): MockRoute {
  return {
    match: (url, init) =>
      url.includes("/rest/v1/invitations") && init?.method === "PATCH",
    respond: () =>
      new Response(JSON.stringify(won ? [{ id: INVITATION_ID }] : []), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  };
}

/**
 * Membership lookup: present or absent.
 *
 * Pass a list to answer successive reads differently — the handler reads
 * membership once before the claim and again in the branch that decides
 * between a confirmed success and a refusal. The last entry repeats.
 */
function membershipRoute(exists: boolean | boolean[]): MockRoute {
  const answers = Array.isArray(exists) ? exists : [exists];
  let call = 0;
  return {
    match: (url, init) =>
      url.includes("/rest/v1/user_institutions") && (init?.method ?? "GET") === "GET",
    respond: () => {
      const present = answers[Math.min(call, answers.length - 1)];
      call++;
      return new Response(JSON.stringify(present ? { id: "membership-1" } : null), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  };
}

/** Accept the membership insert. */
const MEMBERSHIP_INSERT: MockRoute = {
  match: (url, init) =>
    url.includes("/rest/v1/user_institutions") && init?.method === "POST",
  respond: () =>
    new Response(JSON.stringify([{ id: "membership-1" }]), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    }),
};

/** An authenticated caller who owns the invited address. */
const RIGHTFUL_CALLER = authUserRoute({ id: CALLER_ID, email: CALLER_EMAIL });

/** The full set of routes for a first-time, uncontested acceptance. */
const HAPPY_PATH: MockRoute[] = [
  RIGHTFUL_CALLER,
  invitationRoute(),
  claimRoute(true),
  membershipRoute(false),
  MEMBERSHIP_INSERT,
];

/** Did the handler grant institution membership? */
function grantedMembership(fetchLog: FetchLogEntry[]): boolean {
  return fetchLog.some(
    (c) => c.url.includes("/rest/v1/user_institutions") && c.method === "POST",
  );
}

/** Did the handler attempt to claim the invitation? */
function attemptedClaim(fetchLog: FetchLogEntry[]): boolean {
  return fetchLog.some(
    (c) => c.url.includes("/rest/v1/invitations") && c.method === "PATCH",
  );
}

// ── Authentication ─────────────────────────────────────────────────────

Deno.test("accept-invitation: 401 without an Authorization header, and grants nothing", async () => {
  const h = createTestHarness({ routes: HAPPY_PATH });
  try {
    const res = await h.invoke(handler, { invitationId: INVITATION_ID });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 401);
    assertEquals(body.error, "Unauthorized");
    assertEquals(grantedMembership(h.fetchLog), false);
    assertEquals(attemptedClaim(h.fetchLog), false);
  } finally {
    h.cleanup();
  }
});

Deno.test("accept-invitation: 401 when the token does not resolve to a user", async () => {
  const h = createTestHarness({
    routes: [
      authUserRoute({ error: "bad jwt" }, 401),
      invitationRoute(),
      claimRoute(true),
      membershipRoute(false),
      MEMBERSHIP_INSERT,
    ],
  });
  try {
    const res = await h.invoke(handler, { invitationId: INVITATION_ID }, { headers: AUTH });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 401);
    assertEquals(body.error, "Unauthorized");
    assertEquals(grantedMembership(h.fetchLog), false);
  } finally {
    h.cleanup();
  }
});

Deno.test("accept-invitation: a body userId cannot stand in for a token", async () => {
  // The exact shape of the old exploit: name the victim in the body, send no
  // credential. It must not reach the invitation lookup, let alone a write.
  const h = createTestHarness({ routes: HAPPY_PATH });
  try {
    const res = await h.invoke(handler, {
      invitationId: INVITATION_ID,
      userId: "victim-user-id",
    });
    const { status } = await parseResponse(res);
    assertEquals(status, 401);
    assertEquals(grantedMembership(h.fetchLog), false);
  } finally {
    h.cleanup();
  }
});

// ── Authorization ──────────────────────────────────────────────────────

Deno.test("accept-invitation: 403 when the invitation was issued to another address", async () => {
  const h = createTestHarness({
    routes: [
      authUserRoute({ id: CALLER_ID, email: "someone.else@school.test" }),
      invitationRoute(),
      claimRoute(true),
      membershipRoute(false),
      MEMBERSHIP_INSERT,
    ],
  });
  try {
    const res = await h.invoke(handler, { invitationId: INVITATION_ID }, { headers: AUTH });
    const { status } = await parseResponse(res);
    assertEquals(status, 403);
    assertEquals(grantedMembership(h.fetchLog), false);
    assertEquals(attemptedClaim(h.fetchLog), false);
  } finally {
    h.cleanup();
  }
});

Deno.test("accept-invitation: the email match ignores case and surrounding space", async () => {
  const h = createTestHarness({
    routes: [
      authUserRoute({ id: CALLER_ID, email: "  INVITED@School.Test " }),
      invitationRoute(),
      claimRoute(true),
      membershipRoute(false),
      MEMBERSHIP_INSERT,
    ],
  });
  try {
    const res = await h.invoke(handler, { invitationId: INVITATION_ID }, { headers: AUTH });
    const { status } = await parseResponse(res);
    assertEquals(status, 200);
    assertEquals(grantedMembership(h.fetchLog), true);
  } finally {
    h.cleanup();
  }
});

Deno.test("accept-invitation: 404 when the invitation does not exist", async () => {
  const h = createTestHarness({
    routes: [
      RIGHTFUL_CALLER,
      {
        match: (url, init) =>
          url.includes("/rest/v1/invitations") && (init?.method ?? "GET") === "GET",
        respond: () =>
          new Response(JSON.stringify({ message: "not found" }), {
            status: 406,
            headers: { "Content-Type": "application/json" },
          }),
      },
      claimRoute(true),
      membershipRoute(false),
      MEMBERSHIP_INSERT,
    ],
  });
  try {
    const res = await h.invoke(handler, { invitationId: INVITATION_ID }, { headers: AUTH });
    const { status } = await parseResponse(res);
    assertEquals(status, 404);
    assertEquals(grantedMembership(h.fetchLog), false);
  } finally {
    h.cleanup();
  }
});

Deno.test("accept-invitation: 400 without an invitationId", async () => {
  const h = createTestHarness({ routes: [RIGHTFUL_CALLER] });
  try {
    const res = await h.invoke(handler, {}, { headers: AUTH });
    const { status } = await parseResponse(res);
    assertEquals(status, 400);
  } finally {
    h.cleanup();
  }
});

// ── Spend-once (greptile, #1147) ───────────────────────────────────────
// An accepted invitation must not be replayable into a fresh grant. Removing a
// member deletes the membership and the invitation in two separate statements,
// and skips the second entirely when the profile has no email — so the handler
// cannot assume a surviving invitation means the access is still meant to hold.

Deno.test("accept-invitation: a spent invitation cannot restore access an admin removed", async () => {
  const h = createTestHarness({
    routes: [
      RIGHTFUL_CALLER,
      invitationRoute({ status: "accepted" }),
      claimRoute(false), // status is no longer `pending`, so the CAS matches nothing
      membershipRoute(false), // ... and the membership it created has been removed
      MEMBERSHIP_INSERT,
    ],
  });
  try {
    const res = await h.invoke(handler, { invitationId: INVITATION_ID }, { headers: AUTH });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 409);
    assertEquals(body.error, "This invitation is no longer valid");
    assertEquals(grantedMembership(h.fetchLog), false);
  } finally {
    h.cleanup();
  }
});

Deno.test("accept-invitation: a cancelled invitation grants nothing", async () => {
  // Cancelling deletes the row in production, so this is the belt-and-braces
  // path: whatever leaves `status` other than `pending` loses the CAS.
  const h = createTestHarness({
    routes: [
      RIGHTFUL_CALLER,
      invitationRoute({ status: "cancelled" }),
      claimRoute(false),
      membershipRoute(false),
      MEMBERSHIP_INSERT,
    ],
  });
  try {
    const res = await h.invoke(handler, { invitationId: INVITATION_ID }, { headers: AUTH });
    const { status } = await parseResponse(res);
    assertEquals(status, 409);
    assertEquals(grantedMembership(h.fetchLog), false);
  } finally {
    h.cleanup();
  }
});

Deno.test("accept-invitation: losing the claim race grants nothing twice", async () => {
  // The invitation was still `pending` when this request read it, but another
  // request claimed it in between. The read is stale; the CAS is authoritative.
  const h = createTestHarness({
    routes: [
      RIGHTFUL_CALLER,
      invitationRoute({ status: "pending" }),
      claimRoute(false),
      membershipRoute(false),
      MEMBERSHIP_INSERT,
    ],
  });
  try {
    const res = await h.invoke(handler, { invitationId: INVITATION_ID }, { headers: AUTH });
    const { status } = await parseResponse(res);
    assertEquals(status, 409);
    assertEquals(grantedMembership(h.fetchLog), false);
  } finally {
    h.cleanup();
  }
});

Deno.test("accept-invitation: a double submit stays green once membership stands", async () => {
  // Idempotency: the claim is lost because this invitation was already spent,
  // but the membership it created is still there, so the caller gets a success
  // rather than a spurious error — and nothing is written.
  const h = createTestHarness({
    routes: [
      RIGHTFUL_CALLER,
      invitationRoute({ status: "accepted" }),
      claimRoute(false),
      membershipRoute(true),
      MEMBERSHIP_INSERT,
    ],
  });
  try {
    const res = await h.invoke(handler, { invitationId: INVITATION_ID }, { headers: AUTH });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 200);
    assertEquals(body.success, true);
    assertEquals(body.membership.institution_id, INSTITUTION_ID);
    assertEquals(grantedMembership(h.fetchLog), false);
  } finally {
    h.cleanup();
  }
});

Deno.test("accept-invitation: a membership removed mid-flight is not reported as success", async () => {
  // The membership read before the claim said yes; by the time the claim came
  // back empty, an admin had removed it. Answering from that stale snapshot
  // would hand the caller a 200 it acts on — navigating into an institution it
  // no longer belongs to.
  const h = createTestHarness({
    routes: [
      RIGHTFUL_CALLER,
      invitationRoute({ status: "accepted" }),
      claimRoute(false),
      membershipRoute([true, false]),
      MEMBERSHIP_INSERT,
    ],
  });
  try {
    const res = await h.invoke(handler, { invitationId: INVITATION_ID }, { headers: AUTH });
    const { status } = await parseResponse(res);
    assertEquals(status, 409);
    assertEquals(grantedMembership(h.fetchLog), false);
  } finally {
    h.cleanup();
  }
});

// ── Happy path ─────────────────────────────────────────────────────────

Deno.test("accept-invitation: the rightful owner is granted membership", async () => {
  const h = createTestHarness({ routes: HAPPY_PATH });
  try {
    const res = await h.invoke(handler, { invitationId: INVITATION_ID }, { headers: AUTH });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 200);
    assertEquals(body.success, true);
    assertEquals(body.membership.institution_id, INSTITUTION_ID);
    assertEquals(grantedMembership(h.fetchLog), true);
    assertEquals(attemptedClaim(h.fetchLog), true);
  } finally {
    h.cleanup();
  }
});

Deno.test("accept-invitation: the grant waits for the claim to resolve", async () => {
  // Ordering is the whole point of the CAS: a cancellation landing mid-flight
  // must lose, which it can only do if nothing is granted until the claim has
  // come back.
  //
  // Comparing positions in the fetch log is too weak to state that — issuing
  // both writes together under a `Promise.all` would still log the claim first
  // and pass. So the claim resolves on a timer and flips a flag only once it
  // has actually returned; the grant records what it saw. A parallelising
  // refactor reaches the grant while the flag is still false.
  let claimResolved = false;
  let claimResolvedWhenGranted: boolean | null = null;

  const h = createTestHarness({
    routes: [
      RIGHTFUL_CALLER,
      invitationRoute(),
      {
        match: (url, init) =>
          url.includes("/rest/v1/invitations") && init?.method === "PATCH",
        respond: async () => {
          await new Promise((r) => setTimeout(r, 10));
          claimResolved = true;
          return new Response(JSON.stringify([{ id: INVITATION_ID }]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      },
      membershipRoute(false),
      {
        match: (url, init) =>
          url.includes("/rest/v1/user_institutions") && init?.method === "POST",
        respond: () => {
          claimResolvedWhenGranted = claimResolved;
          return new Response(JSON.stringify([{ id: "membership-1" }]), {
            status: 201,
            headers: { "Content-Type": "application/json" },
          });
        },
      },
    ],
  });
  try {
    const res = await h.invoke(handler, { invitationId: INVITATION_ID }, { headers: AUTH });
    assertEquals((await parseResponse(res)).status, 200);
    assertEquals(claimResolvedWhenGranted, true);
  } finally {
    h.cleanup();
  }
});

Deno.test("accept-invitation: membership is granted to the token's user, not the body's", async () => {
  const h = createTestHarness({ routes: HAPPY_PATH });
  try {
    await h.invoke(handler, {
      invitationId: INVITATION_ID,
      userId: "victim-user-id",
    }, { headers: AUTH });

    const insert = h.fetchLog.find(
      (c) => c.url.includes("/rest/v1/user_institutions") && c.method === "POST",
    );
    assertEquals(insert?.body?.includes(CALLER_ID), true);
    assertEquals(insert?.body?.includes("victim-user-id"), false);
  } finally {
    h.cleanup();
  }
});

Deno.test("accept-invitation: an insert lost to a concurrent writer keeps the claim spent", async () => {
  // `user_institutions` is UNIQUE(user_id, institution_id), so another writer
  // creating the membership between the lookup and the insert surfaces as a
  // failed insert — even though the invitation has in fact been fulfilled.
  // Releasing the claim there would re-open a spent invitation, which is the
  // replay-after-removal the claim exists to prevent.
  const h = createTestHarness({
    routes: [
      RIGHTFUL_CALLER,
      invitationRoute(),
      claimRoute(true),
      membershipRoute([false, true]), // absent at lookup, present once the insert fails
      {
        match: (url, init) =>
          url.includes("/rest/v1/user_institutions") && init?.method === "POST",
        respond: () =>
          new Response(JSON.stringify({ message: "duplicate key value" }), {
            status: 409,
            headers: { "Content-Type": "application/json" },
          }),
      },
    ],
  });
  try {
    const res = await h.invoke(handler, { invitationId: INVITATION_ID }, { headers: AUTH });
    const { status } = await parseResponse(res);
    assertEquals(status, 200);

    const patches = h.fetchLog.filter(
      (c) => c.url.includes("/rest/v1/invitations") && c.method === "PATCH",
    );
    // The claim, and nothing releasing it.
    assertEquals(patches.length, 1);
  } finally {
    h.cleanup();
  }
});

Deno.test("accept-invitation: a failed grant releases the claim", async () => {
  // The claim is the only record that the invitation was spent. If it bought
  // nothing, it has to go back, or the invitee is stranded with no membership
  // and no way to retry.
  const h = createTestHarness({
    routes: [
      RIGHTFUL_CALLER,
      invitationRoute(),
      claimRoute(true),
      membershipRoute(false),
      {
        match: (url, init) =>
          url.includes("/rest/v1/user_institutions") && init?.method === "POST",
        respond: () =>
          new Response(JSON.stringify({ message: "insert failed" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          }),
      },
    ],
  });
  try {
    const res = await h.invoke(handler, { invitationId: INVITATION_ID }, { headers: AUTH });
    const { status } = await parseResponse(res);
    assertEquals(status, 500);

    const patches = h.fetchLog.filter(
      (c) => c.url.includes("/rest/v1/invitations") && c.method === "PATCH",
    );
    // One to claim, one to release.
    assertEquals(patches.length, 2);
    assertEquals(patches[1].body?.includes("pending"), true);
  } finally {
    h.cleanup();
  }
});
