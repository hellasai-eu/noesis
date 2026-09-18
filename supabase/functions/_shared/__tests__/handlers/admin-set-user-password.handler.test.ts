import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  createTestHarness,
  DEFAULT_ENV,
  FetchLogEntry,
  MockRoute,
  parseResponse,
  resendRoute,
  supabaseAuthRoute,
  supabaseRoute,
} from "../handler-harness.ts";
import { handler } from "../../../admin-set-user-password/handler.ts";

// UUID-format ids (Supabase auth admin client validates UUID format).
const CALLER_ID = "11111111-1111-1111-1111-111111111111";
const TARGET_ID = "22222222-2222-2222-2222-222222222222";
const AUTH = { Authorization: "Bearer test-token" };

// Return the caller user object from GoTrue's /auth/v1/user endpoint.
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

// is_super_admin RPC — resolves per _user_id so caller and target can differ.
function isSuperAdminRoute(superAdminIds: string[]): MockRoute {
  return {
    match: (url) => url.includes("/rest/v1/rpc/is_super_admin"),
    respond: (_url, init) => {
      let uid = "";
      try {
        uid = JSON.parse(String(init?.body ?? "{}"))._user_id;
      } catch { /* ignore */ }
      return new Response(JSON.stringify(superAdminIds.includes(uid)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  };
}

// Access token whose payload carries the given aal claim. The signature is
// fake: the handler decodes the SAME token getUser validated, and getUser is
// mocked here, so only the payload matters.
function tokenWithAal(aal: string): { Authorization: string } {
  const payload = btoa(JSON.stringify({ aal }))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { Authorization: `Bearer eyJhbGciOiJIUzI1NiJ9.${payload}.sig` };
}

const VERIFIED_TOTP = [{ factor_type: "totp", status: "verified" }];

// security_policies.admin_mfa_deadline as the handler's mandate check reads
// it. Future = admins only RECOMMENDED to have MFA (today's state); past =
// mandate active.
function securityPoliciesRoute(deadline: string): MockRoute {
  return {
    match: (url, init) =>
      url.includes("/rest/v1/security_policies") &&
      (init?.method ?? "GET").toUpperCase() === "GET",
    respond: () =>
      new Response(JSON.stringify({ value: deadline }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  };
}

const FUTURE_DEADLINE = "2099-01-01T00:00:00Z";
const PAST_DEADLINE = "2020-01-01T00:00:00Z";

// ── Input validation ───────────────────────────────────────────────────

Deno.test("admin-set-user-password: OPTIONS returns CORS headers", async () => {
  const h = createTestHarness();
  try {
    const req = new Request("http://localhost/functions/v1/admin-set-user-password", {
      method: "OPTIONS",
    });
    const res = await handler(req);
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  } finally {
    h.cleanup();
  }
});

Deno.test("admin-set-user-password: 400 when userId is missing", async () => {
  const h = createTestHarness();
  try {
    const res = await h.invoke(handler, { newPassword: "password123" }, { headers: AUTH });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 400);
    assertEquals(body.error, "userId and newPassword are required");
  } finally {
    h.cleanup();
  }
});

Deno.test("admin-set-user-password: 400 when newPassword is missing", async () => {
  const h = createTestHarness();
  try {
    const res = await h.invoke(handler, { userId: TARGET_ID }, { headers: AUTH });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 400);
    assertEquals(body.error, "userId and newPassword are required");
  } finally {
    h.cleanup();
  }
});

Deno.test("admin-set-user-password: 400 when password is too short", async () => {
  const h = createTestHarness();
  try {
    const res = await h.invoke(handler, { userId: TARGET_ID, newPassword: "short" }, { headers: AUTH });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 400);
    assertEquals(body.error, "Password must be at least 8 characters");
  } finally {
    h.cleanup();
  }
});

// ── Authentication ─────────────────────────────────────────────────────

Deno.test("admin-set-user-password: 401 when no authorization header", async () => {
  const h = createTestHarness();
  try {
    const res = await h.invoke(handler, { userId: TARGET_ID, newPassword: "password123" });
    const { status } = await parseResponse(res);
    assertEquals(status, 401);
  } finally {
    h.cleanup();
  }
});

Deno.test("admin-set-user-password: 401 when token is invalid", async () => {
  const h = createTestHarness({
    routes: [authUserRoute({ error: "bad jwt" }, 401)],
  });
  try {
    const res = await h.invoke(handler, { userId: TARGET_ID, newPassword: "password123" }, { headers: AUTH });
    const { status } = await parseResponse(res);
    assertEquals(status, 401);
  } finally {
    h.cleanup();
  }
});

// ── Authorization boundary ─────────────────────────────────────────────

// ── MFA assurance (require-aal2) ───────────────────────────────────────

Deno.test("admin-set-user-password: 403 when an enrolled caller presents an aal1 token", async () => {
  const h = createTestHarness({
    routes: [authUserRoute({ id: CALLER_ID, factors: VERIFIED_TOTP })],
  });
  try {
    const res = await h.invoke(
      handler,
      { userId: TARGET_ID, newPassword: "password123" },
      { headers: tokenWithAal("aal1") },
    );
    const { status, body } = await parseResponse(res);
    assertEquals(status, 403);
    assertEquals(body.error, "Two-factor verification required");
    // Refused before any authorization work.
    const rpcCall = h.fetchLog.find((c) => c.url.includes("/rest/v1/rpc/is_super_admin"));
    assertEquals(rpcCall, undefined);
  } finally {
    h.cleanup();
  }
});

Deno.test("admin-set-user-password: an enrolled caller at aal2 passes the MFA gate", async () => {
  const h = createTestHarness({
    routes: [
      authUserRoute({ id: CALLER_ID, factors: VERIFIED_TOTP }),
      isSuperAdminRoute([]),
      supabaseRoute("/rest/v1/user_institutions", [], { method: "GET" }),
    ],
  });
  try {
    const res = await h.invoke(
      handler,
      { userId: TARGET_ID, newPassword: "password123" },
      { headers: tokenWithAal("aal2") },
    );
    const { status, body } = await parseResponse(res);
    // Reaches the authorization gate (and fails THERE) — the MFA gate let it through.
    assertEquals(status, 403);
    assertEquals(body.error, "You are not authorized to reset this user's password");
  } finally {
    h.cleanup();
  }
});

Deno.test("admin-set-user-password: 403 for a super-admin caller below aal2 (mandate)", async () => {
  const h = createTestHarness({
    routes: [
      // Unenrolled super-admin: no factors, aal1 — enrollment is not optional
      // for super-admins, so this must be refused.
      authUserRoute({ id: CALLER_ID }),
      isSuperAdminRoute([CALLER_ID]),
    ],
  });
  try {
    const res = await h.invoke(
      handler,
      { userId: TARGET_ID, newPassword: "password123" },
      { headers: tokenWithAal("aal1") },
    );
    const { status, body } = await parseResponse(res);
    assertEquals(status, 403);
    assertEquals(body.error, "Two-factor verification required");
    const updateCall = h.fetchLog.find(
      (c) => c.url.includes("/auth/v1/admin/users/") && c.method === "PUT",
    );
    assertEquals(updateCall, undefined);
  } finally {
    h.cleanup();
  }
});

Deno.test("admin-set-user-password: 403 for an aal1 institution admin once the deadline has passed", async () => {
  const h = createTestHarness({
    routes: [
      authUserRoute({ id: CALLER_ID }),
      isSuperAdminRoute([]),
      supabaseRoute("/rest/v1/user_institutions", [{ institution_id: "inst-1" }], { method: "GET" }),
      supabaseRoute("/rest/v1/rpc/is_institution_admin", true, { method: "POST" }),
      securityPoliciesRoute(PAST_DEADLINE),
    ],
  });
  try {
    const res = await h.invoke(
      handler,
      { userId: TARGET_ID, newPassword: "password123" },
      { headers: tokenWithAal("aal1") },
    );
    const { status, body } = await parseResponse(res);
    assertEquals(status, 403);
    assertEquals(body.error, "Two-factor verification required");
  } finally {
    h.cleanup();
  }
});

Deno.test("admin-set-user-password: 500 when the target super-admin check errors (fails closed)", async () => {
  const h = createTestHarness({
    routes: [
      authUserRoute({ id: CALLER_ID }),
      // Caller's is_super_admin resolves false; the TARGET's check errors. An
      // error must not read as "not a super-admin" — the institution-admin
      // path could then authorize the caller, since super-admins hold ordinary
      // institution memberships too.
      {
        match: (url) => url.includes("/rest/v1/rpc/is_super_admin"),
        respond: (_url, init) => {
          let uid = "";
          try {
            uid = JSON.parse(String(init?.body ?? "{}"))._user_id;
          } catch { /* ignore */ }
          if (uid === TARGET_ID) {
            return new Response(JSON.stringify({ message: "rpc unavailable" }), {
              status: 500,
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response("false", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      },
      supabaseRoute("/rest/v1/user_institutions", [{ institution_id: "inst-1" }], { method: "GET" }),
      supabaseRoute("/rest/v1/rpc/is_institution_admin", true, { method: "POST" }),
    ],
  });
  try {
    const res = await h.invoke(handler, { userId: TARGET_ID, newPassword: "password123" }, { headers: AUTH });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 500);
    assertEquals(body.error, "Failed to verify authorization");
    // No password update was attempted.
    const updateCall = h.fetchLog.find(
      (c) => c.url.includes("/auth/v1/admin/users/") && c.method === "PUT",
    );
    assertEquals(updateCall, undefined);
  } finally {
    h.cleanup();
  }
});

Deno.test("admin-set-user-password: 403 when caller is neither super-admin nor institution-admin", async () => {
  const h = createTestHarness({
    routes: [
      authUserRoute({ id: CALLER_ID }),
      isSuperAdminRoute([]), // neither caller nor target is super-admin
      supabaseRoute("/rest/v1/user_institutions", [{ institution_id: "inst-1" }], { method: "GET" }),
      supabaseRoute("/rest/v1/rpc/is_institution_admin", false, { method: "POST" }),
    ],
  });
  try {
    const res = await h.invoke(handler, { userId: TARGET_ID, newPassword: "password123" }, { headers: AUTH });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 403);
    assertEquals(body.error, "You are not authorized to reset this user's password");
    // No password update was attempted.
    const updateCall = h.fetchLog.find(
      (c) => c.url.includes("/auth/v1/admin/users/") && c.method === "PUT",
    );
    assertEquals(updateCall, undefined);
  } finally {
    h.cleanup();
  }
});

Deno.test("admin-set-user-password: 403 when institution-admin targets a super-admin", async () => {
  const h = createTestHarness({
    routes: [
      authUserRoute({ id: CALLER_ID }),
      // caller is not super-admin, target IS super-admin
      isSuperAdminRoute([TARGET_ID]),
    ],
  });
  try {
    const res = await h.invoke(handler, { userId: TARGET_ID, newPassword: "password123" }, { headers: AUTH });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 403);
    assertEquals(body.error, "Only a super-admin can reset another super-admin's password");
  } finally {
    h.cleanup();
  }
});

Deno.test("admin-set-user-password: 200 when caller is super-admin", async () => {
  const h = createTestHarness({
    routes: [
      authUserRoute({ id: CALLER_ID }),
      isSuperAdminRoute([CALLER_ID]),
      supabaseAuthRoute(`users/${TARGET_ID}`, { id: TARGET_ID }, { method: "PUT" }),
    ],
  });
  try {
    // Super-admin callers are mandated to be aal2 — see the mandate tests.
    const res = await h.invoke(handler, { userId: TARGET_ID, newPassword: "password123" }, { headers: tokenWithAal("aal2") });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 200);
    assertEquals(body.success, true);
    // The password update was issued via the admin API.
    const updateCall = h.fetchLog.find(
      (c) => c.url.includes(`/auth/v1/admin/users/${TARGET_ID}`) && c.method === "PUT",
    );
    assertEquals(updateCall !== undefined, true);
  } finally {
    h.cleanup();
  }
});

// ── Notification + audit ───────────────────────────────────────────────
// An admin reset locks the user out of their own account until they are told,
// and from the inside it is indistinguishable from a takeover. The notice goes
// to the TARGET, and the audit row records whether it was delivered.

const TARGET_EMAIL = "student@school.test";

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

const AUDIT_INSERT: MockRoute = {
  match: (url, init) => url.includes("/rest/v1/audit_logs") && init?.method === "POST",
  respond: () =>
    new Response(JSON.stringify([]), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    }),
};

Deno.test("admin-set-user-password: notifies the target and audits the delivery", async () => {
  const h = createTestHarness({
    routes: [
      authUserRoute({ id: CALLER_ID, email: "admin@school.test" }),
      isSuperAdminRoute([CALLER_ID]),
      supabaseAuthRoute(
        `users/${TARGET_ID}`,
        { id: TARGET_ID, email: TARGET_EMAIL, user_metadata: { full_name: "Ada Lovelace" } },
        { method: "PUT" },
      ),
      resendRoute(),
      AUDIT_INSERT,
    ],
  });
  try {
    const res = await h.invoke(
      handler,
      { userId: TARGET_ID, newPassword: "password123" },
      { headers: tokenWithAal("aal2") },
    );
    assertEquals(res.status, 200);

    // The notice goes to the account holder, not the acting admin.
    const emailCall = h.fetchLog.find((c) => c.url.includes("api.resend.com"));
    const payload = JSON.parse(String(emailCall?.body ?? "{}"));
    assertEquals(payload.to, [TARGET_EMAIL]);
    // Never any password material in the message.
    assertEquals(String(emailCall?.body ?? "").includes("password123"), false);

    const row = auditInsert(h.fetchLog);
    assertEquals(row?.action, "user.password_reset");
    assertEquals((row?.metadata as Record<string, unknown>)?.email_notified, true);
  } finally {
    h.cleanup();
  }
});

Deno.test("admin-set-user-password: a forged Origin cannot steer the email's link", async () => {
  // The recipient here is the TARGET, not the caller. Building the button from
  // the request's `Origin` would let an institution admin mail a genuine,
  // correctly-branded security notice to any of their members with the link
  // pointing wherever they liked. It comes from BRAND_APP_URL instead, which
  // only whoever deploys the project can set.
  const h = createTestHarness({
    routes: [
      authUserRoute({ id: CALLER_ID, email: "admin@school.test" }),
      isSuperAdminRoute([CALLER_ID]),
      supabaseAuthRoute(`users/${TARGET_ID}`, { id: TARGET_ID, email: TARGET_EMAIL }, {
        method: "PUT",
      }),
      resendRoute(),
      AUDIT_INSERT,
    ],
  });
  try {
    await h.invoke(
      handler,
      { userId: TARGET_ID, newPassword: "password123" },
      { headers: { ...tokenWithAal("aal2"), Origin: "https://phishing.test" } },
    );

    const emailCall = h.fetchLog.find((c) => c.url.includes("api.resend.com"));
    const html = String(JSON.parse(String(emailCall?.body ?? "{}")).html ?? "");
    assertEquals(html.includes("phishing.test"), false);
    assertEquals(html.includes(`${DEFAULT_ENV.BRAND_APP_URL}/auth`), true);
  } finally {
    h.cleanup();
  }
});

Deno.test("admin-set-user-password: a failed notice still resets and audits", async () => {
  // The password is already changed when the send fails. Returning an error
  // would report a completed change as a failure; the trail records instead
  // that the user was not told.
  const h = createTestHarness({
    routes: [
      authUserRoute({ id: CALLER_ID, email: "admin@school.test" }),
      isSuperAdminRoute([CALLER_ID]),
      supabaseAuthRoute(`users/${TARGET_ID}`, { id: TARGET_ID, email: TARGET_EMAIL }, {
        method: "PUT",
      }),
      resendRoute({ name: "validation_error", message: "domain not verified" }, { status: 422 }),
      AUDIT_INSERT,
    ],
  });
  try {
    const res = await h.invoke(
      handler,
      { userId: TARGET_ID, newPassword: "password123" },
      { headers: tokenWithAal("aal2") },
    );
    const { status, body } = await parseResponse(res);
    assertEquals(status, 200);
    assertEquals(body.success, true);

    const row = auditInsert(h.fetchLog);
    assertEquals(row?.action, "user.password_reset");
    assertEquals((row?.metadata as Record<string, unknown>)?.email_notified, false);
  } finally {
    h.cleanup();
  }
});

Deno.test("admin-set-user-password: an unauthorized caller sends no notice", async () => {
  // The notice is branded mail from the platform's own domain. It must not be
  // reachable by a caller who could not reset the password in the first place.
  const h = createTestHarness({
    routes: [
      authUserRoute({ id: CALLER_ID, email: "nobody@school.test" }),
      isSuperAdminRoute([]),
      supabaseRoute("/rest/v1/user_institutions", [{ institution_id: "inst-1" }], { method: "GET" }),
      supabaseRoute("/rest/v1/rpc/is_institution_admin", false, { method: "POST" }),
      resendRoute(),
      AUDIT_INSERT,
    ],
  });
  try {
    const res = await h.invoke(
      handler,
      { userId: TARGET_ID, newPassword: "password123" },
      { headers: AUTH },
    );
    assertEquals(res.status, 403);
    assertEquals(sentEmail(h.fetchLog), false);
  } finally {
    h.cleanup();
  }
});

Deno.test("admin-set-user-password: 200 when institution-admin shares an institution with the target", async () => {
  const h = createTestHarness({
    routes: [
      authUserRoute({ id: CALLER_ID }),
      isSuperAdminRoute([]), // neither is super-admin
      supabaseRoute("/rest/v1/user_institutions", [{ institution_id: "inst-1" }], { method: "GET" }),
      supabaseRoute("/rest/v1/rpc/is_institution_admin", true, { method: "POST" }),
      securityPoliciesRoute(FUTURE_DEADLINE),
      supabaseAuthRoute(`users/${TARGET_ID}`, { id: TARGET_ID }, { method: "PUT" }),
    ],
  });
  try {
    const res = await h.invoke(handler, { userId: TARGET_ID, newPassword: "password123" }, { headers: AUTH });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 200);
    assertEquals(body.success, true);
    const updateCall = h.fetchLog.find(
      (c) => c.url.includes(`/auth/v1/admin/users/${TARGET_ID}`) && c.method === "PUT",
    );
    assertEquals(updateCall !== undefined, true);
  } finally {
    h.cleanup();
  }
});
