import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  createTestHarness,
  FetchLogEntry,
  MockRoute,
  parseResponse,
  resendRoute,
} from "../handler-harness.ts";
import { handler } from "../../../send-invitation/handler.ts";

// ── Caller gate (#1136) ────────────────────────────────────────────────
// This handler resolved the caller and computed whether they were an admin —
// and then used that only to decide whether to write an audit row. The branded
// invitation went out either way, to any address, from the platform's own
// domain and against its Resend quota. Authenticating for the audit trail is
// not a gate; that is the shape of #926.

const CALLER_ID = "99999999-9999-9999-9999-999999999999";
const INSTITUTION_ID = "inst-1";
const AUTH = { Authorization: "Bearer test-token" };

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

function institutionAdminRoute(allow: boolean): MockRoute {
  return {
    match: (url) => url.includes("/rest/v1/rpc/is_institution_admin"),
    respond: () =>
      new Response(JSON.stringify(allow), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  };
}

/** Accept the audit insert so the happy path can complete. */
const AUDIT_INSERT: MockRoute = {
  match: (url, init) => url.includes("/rest/v1/") && init?.method === "POST",
  respond: () =>
    new Response(JSON.stringify([]), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    }),
};

/** Did an invitation email actually go out? */
function sentEmail(fetchLog: FetchLogEntry[]): boolean {
  return fetchLog.some((c) => c.url.includes("api.resend.com"));
}

const VALID_BODY = {
  email: "test@test.com",
  institutionId: INSTITUTION_ID,
  institutionName: "Test School",
  inviterName: "Admin",
};

Deno.test("send-invitation: OPTIONS returns CORS headers", async () => {
  const h = createTestHarness();
  try {
    const req = new Request("http://localhost/functions/v1/send-invitation", { method: "OPTIONS" });
    const res = await handler(req);
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  } finally { h.cleanup(); }
});

Deno.test("send-invitation: an institution admin sends the email", async () => {
  const h = createTestHarness({
    routes: [
      authUserRoute({ id: CALLER_ID, email: "admin@school.test" }),
      institutionAdminRoute(true),
      resendRoute(),
      AUDIT_INSERT,
    ],
  });
  try {
    const res = await h.invoke(handler, VALID_BODY, { headers: AUTH });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 200);
    assertEquals(body.success, true);
    assertEquals(sentEmail(h.fetchLog), true);
  } finally { h.cleanup(); }
});

Deno.test("send-invitation: 401 without an Authorization header, and sends nothing", async () => {
  // The old behaviour: this exact request sent a branded invitation to any
  // address it named.
  const h = createTestHarness({
    routes: [
      authUserRoute({ id: CALLER_ID, email: "admin@school.test" }),
      institutionAdminRoute(true),
      resendRoute(),
      AUDIT_INSERT,
    ],
  });
  try {
    const res = await h.invoke(handler, VALID_BODY);
    const { status, body } = await parseResponse(res);
    assertEquals(status, 401);
    assertEquals(body.error, "Unauthorized");
    assertEquals(sentEmail(h.fetchLog), false);
  } finally { h.cleanup(); }
});

Deno.test("send-invitation: 401 when the token does not resolve, and sends nothing", async () => {
  const h = createTestHarness({
    routes: [
      authUserRoute({ error: "bad jwt" }, 401),
      institutionAdminRoute(true),
      resendRoute(),
      AUDIT_INSERT,
    ],
  });
  try {
    const res = await h.invoke(handler, VALID_BODY, { headers: AUTH });
    const { status } = await parseResponse(res);
    assertEquals(status, 401);
    assertEquals(sentEmail(h.fetchLog), false);
  } finally { h.cleanup(); }
});

Deno.test("send-invitation: 403 for a signed-in non-admin, and sends nothing", async () => {
  // Being authenticated is not enough — any signed-in student could otherwise
  // send platform-branded mail to an arbitrary address.
  const h = createTestHarness({
    routes: [
      authUserRoute({ id: CALLER_ID, email: "student@school.test" }),
      institutionAdminRoute(false),
      resendRoute(),
      AUDIT_INSERT,
    ],
  });
  try {
    const res = await h.invoke(handler, VALID_BODY, { headers: AUTH });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 403);
    assertEquals(body.error, "Not authorized for this institution");
    assertEquals(sentEmail(h.fetchLog), false);
  } finally { h.cleanup(); }
});

Deno.test("send-invitation: the admin check names the institution from the body", async () => {
  // The one body value that legitimately drives authorization here: there is no
  // more authoritative source for which institution is inviting. It is safe
  // because the caller is checked against that same id — the defect is only
  // ever checking one id and acting on another.
  const h = createTestHarness({
    routes: [
      authUserRoute({ id: CALLER_ID, email: "admin@school.test" }),
      institutionAdminRoute(true),
      resendRoute(),
      AUDIT_INSERT,
    ],
  });
  try {
    await h.invoke(handler, VALID_BODY, { headers: AUTH });
    const rpc = h.fetchLog.find((c) => c.url.includes("/rest/v1/rpc/is_institution_admin"));
    assertEquals(rpc?.body?.includes(INSTITUTION_ID), true);
    assertEquals(rpc?.body?.includes(CALLER_ID), true);
  } finally { h.cleanup(); }
});

Deno.test("send-invitation: 400 without an institutionId, and sends nothing", async () => {
  // Without it there is nothing to authorize against, so it cannot be optional.
  const h = createTestHarness({
    routes: [
      authUserRoute({ id: CALLER_ID, email: "admin@school.test" }),
      institutionAdminRoute(true),
      resendRoute(),
      AUDIT_INSERT,
    ],
  });
  try {
    const res = await h.invoke(handler, {
      email: "test@test.com",
      institutionName: "Test School",
      inviterName: "Admin",
    }, { headers: AUTH });
    const { status } = await parseResponse(res);
    assertEquals(status, 400);
    assertEquals(sentEmail(h.fetchLog), false);
  } finally { h.cleanup(); }
});


Deno.test("send-invitation: an authorization check that FAILS is not a denial", async () => {
  // A database or network fault would otherwise be reported as 403 "Not
  // authorized" — misleading to the caller, and a log line accusing a real
  // admin of not being one. Still fails closed: no email either way.
  const h = createTestHarness({
    routes: [
      authUserRoute({ id: CALLER_ID, email: "admin@school.test" }),
      {
        match: (url) => url.includes("/rest/v1/rpc/is_institution_admin"),
        respond: () =>
          new Response(JSON.stringify({ message: "connection reset" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          }),
      },
      resendRoute(),
      AUDIT_INSERT,
    ],
  });
  try {
    const res = await h.invoke(handler, VALID_BODY, { headers: AUTH });
    const { status } = await parseResponse(res);
    assertEquals(status, 500);
    assertEquals(sentEmail(h.fetchLog), false);
  } finally { h.cleanup(); }
});
