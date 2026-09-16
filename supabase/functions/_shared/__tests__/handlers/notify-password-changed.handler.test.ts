import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  createTestHarness,
  FetchLogEntry,
  MockRoute,
  parseResponse,
  resendRoute,
  supabaseRoute,
} from "../handler-harness.ts";
import { handler } from "../../../notify-password-changed/handler.ts";

// A self-service password change goes straight from the browser to GoTrue, so
// nothing server-side sees it. This endpoint is how it becomes accountable:
// an email to the account holder and a durable `user.password_changed` row.
//
// The subject is the token's caller and nothing else — there is deliberately no
// id in the request body, so a signed-in user cannot mail a "your password was
// changed" alarm to another address or write an audit row naming someone else.

const CALLER_ID = "11111111-1111-1111-1111-111111111111";
const CALLER_EMAIL = "student@school.test";
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

const MEMBERSHIP = supabaseRoute(
  "/rest/v1/user_institutions",
  [{ institution_id: "inst-1", created_at: "2026-01-01T00:00:00Z" }],
  { method: "GET" },
);

const PROFILE = supabaseRoute("/rest/v1/profiles", { full_name: "Ada Lovelace" }, {
  method: "GET",
});

/** Accept the audit insert so the happy path can complete. */
const AUDIT_INSERT: MockRoute = {
  match: (url, init) => url.includes("/rest/v1/audit_logs") && init?.method === "POST",
  respond: () =>
    new Response(JSON.stringify([]), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    }),
};

function sentEmail(fetchLog: FetchLogEntry[]): boolean {
  return fetchLog.some((c) => c.url.includes("api.resend.com"));
}

function auditInsert(fetchLog: FetchLogEntry[]): Record<string, unknown> | undefined {
  const call = fetchLog.find(
    (c) => c.url.includes("/rest/v1/audit_logs") && c.method === "POST",
  );
  if (!call?.body) return undefined;
  const parsed = JSON.parse(call.body);
  return Array.isArray(parsed) ? parsed[0] : parsed;
}

const HAPPY_ROUTES = [
  authUserRoute({ id: CALLER_ID, email: CALLER_EMAIL }),
  MEMBERSHIP,
  PROFILE,
  resendRoute(),
  AUDIT_INSERT,
];

Deno.test("notify-password-changed: OPTIONS returns CORS headers", async () => {
  const h = createTestHarness();
  try {
    const req = new Request("http://localhost/functions/v1/notify-password-changed", {
      method: "OPTIONS",
    });
    const res = await handler(req);
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  } finally {
    h.cleanup();
  }
});

Deno.test("notify-password-changed: emails the caller and records the audit row", async () => {
  const h = createTestHarness({ routes: HAPPY_ROUTES });
  try {
    const res = await h.invoke(handler, {}, { headers: AUTH });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 200);
    assertEquals(body.success, true);
    assertEquals(body.emailNotified, true);

    assertEquals(sentEmail(h.fetchLog), true);

    const row = auditInsert(h.fetchLog);
    assertEquals(row?.action, "user.password_changed");
    assertEquals(row?.actor_user_id, CALLER_ID);
    assertEquals(row?.target_user_id, CALLER_ID);
    assertEquals(row?.institution_id, "inst-1");
    assertEquals((row?.metadata as Record<string, unknown>)?.email_notified, true);
  } finally {
    h.cleanup();
  }
});

Deno.test("notify-password-changed: the notice goes to the caller's own address", async () => {
  const h = createTestHarness({ routes: HAPPY_ROUTES });
  try {
    await h.invoke(handler, { email: "victim@elsewhere.test", userId: "other" }, { headers: AUTH });

    // Body fields are ignored entirely: the recipient and the audit subject
    // both come from the token.
    const emailCall = h.fetchLog.find((c) => c.url.includes("api.resend.com"));
    const payload = JSON.parse(String(emailCall?.body ?? "{}"));
    assertEquals(payload.to, [CALLER_EMAIL]);

    const row = auditInsert(h.fetchLog);
    assertEquals(row?.target_user_id, CALLER_ID);
  } finally {
    h.cleanup();
  }
});

Deno.test("notify-password-changed: a forged Origin cannot steer the email's link", async () => {
  // `Origin` is honest only from a browser; a direct HTTP call sets it to
  // anything. This is a security email, the message a user is most primed to
  // click, so its button is a constant rather than request metadata.
  const h = createTestHarness({ routes: HAPPY_ROUTES });
  try {
    await h.invoke(handler, {}, {
      headers: { ...AUTH, Origin: "https://noesis-phishing.test" },
    });

    const emailCall = h.fetchLog.find((c) => c.url.includes("api.resend.com"));
    const html = String(JSON.parse(String(emailCall?.body ?? "{}")).html ?? "");
    assertEquals(html.includes("noesis-phishing.test"), false);
    assertEquals(html.includes("https://dianoisis.net/auth"), true);
  } finally {
    h.cleanup();
  }
});

Deno.test("notify-password-changed: 401 without an Authorization header, and sends nothing", async () => {
  const h = createTestHarness({ routes: HAPPY_ROUTES });
  try {
    const res = await h.invoke(handler, {});
    const { status, body } = await parseResponse(res);
    assertEquals(status, 401);
    assertEquals(body.error, "Unauthorized");
    assertEquals(sentEmail(h.fetchLog), false);
    assertEquals(auditInsert(h.fetchLog), undefined);
  } finally {
    h.cleanup();
  }
});

Deno.test("notify-password-changed: 401 when the token does not resolve to a user", async () => {
  const h = createTestHarness({
    routes: [
      authUserRoute({ msg: "invalid token" }, 401),
      MEMBERSHIP,
      PROFILE,
      resendRoute(),
      AUDIT_INSERT,
    ],
  });
  try {
    const res = await h.invoke(handler, {}, { headers: AUTH });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 401);
    assertEquals(body.error, "Unauthorized");
    assertEquals(sentEmail(h.fetchLog), false);
  } finally {
    h.cleanup();
  }
});

Deno.test("notify-password-changed: still audits when the email fails to send", async () => {
  // The password is already changed by the time this runs. A failed notice must
  // not swallow the audit row — the trail records that the user was NOT told.
  const h = createTestHarness({
    routes: [
      authUserRoute({ id: CALLER_ID, email: CALLER_EMAIL }),
      MEMBERSHIP,
      PROFILE,
      resendRoute({ name: "validation_error", message: "domain not verified" }, { status: 422 }),
      AUDIT_INSERT,
    ],
  });
  try {
    const res = await h.invoke(handler, {}, { headers: AUTH });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 200);
    assertEquals(body.emailNotified, false);

    const row = auditInsert(h.fetchLog);
    assertEquals(row?.action, "user.password_changed");
    assertEquals((row?.metadata as Record<string, unknown>)?.email_notified, false);
  } finally {
    h.cleanup();
  }
});

Deno.test("notify-password-changed: scopes a multi-institution user deterministically", async () => {
  // An unordered `limit(1)` let Postgres pick a different institution run to
  // run, scattering one user's security events across tenants at random. The
  // query is ordered now, and the mock returns them in that order: the row is
  // scoped to the earliest membership, and every membership is kept in the
  // metadata so a super-admin still sees the full picture.
  const h = createTestHarness({
    routes: [
      authUserRoute({ id: CALLER_ID, email: CALLER_EMAIL }),
      supabaseRoute(
        "/rest/v1/user_institutions",
        [
          { institution_id: "inst-early", created_at: "2025-01-01T00:00:00Z" },
          { institution_id: "inst-late", created_at: "2026-01-01T00:00:00Z" },
        ],
        { method: "GET" },
      ),
      PROFILE,
      resendRoute(),
      AUDIT_INSERT,
    ],
  });
  try {
    const res = await h.invoke(handler, {}, { headers: AUTH });
    assertEquals(res.status, 200);

    const row = auditInsert(h.fetchLog);
    assertEquals(row?.institution_id, "inst-early");
    assertEquals(
      (row?.metadata as Record<string, unknown>)?.institution_ids,
      ["inst-early", "inst-late"],
    );

    // The ordering must be asked of the database, not hoped for.
    const query = h.fetchLog.find((c) => c.url.includes("/rest/v1/user_institutions"));
    assertEquals(query?.url.includes("order="), true);
  } finally {
    h.cleanup();
  }
});

Deno.test("notify-password-changed: audits unscoped when the caller has no institution", async () => {
  const h = createTestHarness({
    routes: [
      authUserRoute({ id: CALLER_ID, email: CALLER_EMAIL }),
      supabaseRoute("/rest/v1/user_institutions", [], { method: "GET" }),
      PROFILE,
      resendRoute(),
      AUDIT_INSERT,
    ],
  });
  try {
    const res = await h.invoke(handler, {}, { headers: AUTH });
    assertEquals(res.status, 200);

    // No institution to scope to, so the row is super-admin-readable only —
    // still a row, never a silent drop.
    const row = auditInsert(h.fetchLog);
    assertEquals(row?.action, "user.password_changed");
    assertEquals(row?.institution_id, null);
  } finally {
    h.cleanup();
  }
});
