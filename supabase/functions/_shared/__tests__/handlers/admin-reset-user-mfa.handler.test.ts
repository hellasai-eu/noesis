import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  createTestHarness,
  MockRoute,
  parseResponse,
  resendRoute,
  supabaseRoute,
} from "../handler-harness.ts";
import { handler } from "../../../admin-reset-user-mfa/handler.ts";

// UUID-format ids (the auth admin client validates UUID format).
const CALLER_ID = "11111111-1111-1111-1111-111111111111";
const TARGET_ID = "22222222-2222-2222-2222-222222222222";
const FACTOR_A = "33333333-3333-3333-3333-333333333333";
const FACTOR_B = "44444444-4444-4444-4444-444444444444";
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

// GoTrue admin factor endpoints for the target user.
// GET  /auth/v1/admin/users/{id}/factors            → raw factor array
// DELETE /auth/v1/admin/users/{id}/factors/{fid}    → {}
function listFactorsRoute(factors: unknown[], userId = TARGET_ID): MockRoute {
  return {
    match: (url, init) =>
      url.includes(`/auth/v1/admin/users/${userId}/factors`) &&
      (init?.method ?? "GET").toUpperCase() === "GET",
    respond: () =>
      new Response(JSON.stringify(factors), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  };
}

function deleteFactorRoute(userId = TARGET_ID, status = 200): MockRoute {
  return {
    match: (url, init) =>
      url.includes(`/auth/v1/admin/users/${userId}/factors/`) &&
      (init?.method ?? "GET").toUpperCase() === "DELETE",
    respond: () =>
      new Response(JSON.stringify(status === 200 ? {} : { error: "factor delete failed", msg: "factor delete failed" }), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  };
}

// GET /auth/v1/admin/users/{id} — the target's account record (for the notice).
function getUserByIdRoute(user: unknown, userId = TARGET_ID): MockRoute {
  return {
    match: (url, init) =>
      url.endsWith(`/auth/v1/admin/users/${userId}`) &&
      (init?.method ?? "GET").toUpperCase() === "GET",
    respond: () =>
      new Response(JSON.stringify(user), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  };
}

const twoFactors = [
  { id: FACTOR_A, status: "verified", factor_type: "totp" },
  { id: FACTOR_B, status: "unverified", factor_type: "totp" },
];

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

// Routes for the happy path as an authorized institution admin (pre-mandate:
// the deadline is in the future, so an aal1 admin session still passes).
function institutionAdminRoutes(): MockRoute[] {
  return [
    authUserRoute({ id: CALLER_ID, email: "admin@test.local" }),
    isSuperAdminRoute([]),
    supabaseRoute("/rest/v1/user_institutions", [{ institution_id: "inst-1" }], { method: "GET" }),
    supabaseRoute("/rest/v1/rpc/is_institution_admin", true, { method: "POST" }),
    securityPoliciesRoute(FUTURE_DEADLINE),
  ];
}

// ── Input validation ───────────────────────────────────────────────────

Deno.test("admin-reset-user-mfa: OPTIONS returns CORS headers", async () => {
  const h = createTestHarness();
  try {
    const req = new Request("http://localhost/functions/v1/admin-reset-user-mfa", {
      method: "OPTIONS",
    });
    const res = await handler(req);
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  } finally {
    h.cleanup();
  }
});

Deno.test("admin-reset-user-mfa: 400 when userId is missing", async () => {
  const h = createTestHarness();
  try {
    const res = await h.invoke(handler, {}, { headers: AUTH });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 400);
    assertEquals(body.error, "userId is required");
  } finally {
    h.cleanup();
  }
});

// ── Authentication ─────────────────────────────────────────────────────

Deno.test("admin-reset-user-mfa: 401 when no authorization header", async () => {
  const h = createTestHarness();
  try {
    const res = await h.invoke(handler, { userId: TARGET_ID });
    const { status } = await parseResponse(res);
    assertEquals(status, 401);
  } finally {
    h.cleanup();
  }
});

Deno.test("admin-reset-user-mfa: 401 when token is invalid", async () => {
  const h = createTestHarness({
    routes: [authUserRoute({ error: "bad jwt" }, 401)],
  });
  try {
    const res = await h.invoke(handler, { userId: TARGET_ID }, { headers: AUTH });
    const { status } = await parseResponse(res);
    assertEquals(status, 401);
  } finally {
    h.cleanup();
  }
});

// ── MFA assurance (require-aal2) ───────────────────────────────────────

// Access token whose payload carries the given aal claim. The signature is
// fake: the handler decodes the SAME token getUser validated, and getUser is
// mocked here, so only the payload matters.
function tokenWithAal(aal: string): { Authorization: string } {
  const payload = btoa(JSON.stringify({ aal }))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { Authorization: `Bearer eyJhbGciOiJIUzI1NiJ9.${payload}.sig` };
}

const VERIFIED_TOTP = [{ factor_type: "totp", status: "verified" }];

Deno.test("admin-reset-user-mfa: 403 when an enrolled caller presents an aal1 token", async () => {
  const h = createTestHarness({
    routes: [authUserRoute({ id: CALLER_ID, factors: VERIFIED_TOTP })],
  });
  try {
    const res = await h.invoke(handler, { userId: TARGET_ID }, { headers: tokenWithAal("aal1") });
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

Deno.test("admin-reset-user-mfa: 403 when an enrolled caller's token has no readable aal (fails closed)", async () => {
  const h = createTestHarness({
    routes: [authUserRoute({ id: CALLER_ID, factors: VERIFIED_TOTP })],
  });
  try {
    // AUTH's "test-token" has no decodable payload.
    const res = await h.invoke(handler, { userId: TARGET_ID }, { headers: AUTH });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 403);
    assertEquals(body.error, "Two-factor verification required");
  } finally {
    h.cleanup();
  }
});

Deno.test("admin-reset-user-mfa: an enrolled caller at aal2 passes the MFA gate", async () => {
  const h = createTestHarness({
    routes: [
      authUserRoute({ id: CALLER_ID, factors: VERIFIED_TOTP }),
      isSuperAdminRoute([]),
      supabaseRoute("/rest/v1/user_institutions", [], { method: "GET" }),
    ],
  });
  try {
    const res = await h.invoke(handler, { userId: TARGET_ID }, { headers: tokenWithAal("aal2") });
    const { status, body } = await parseResponse(res);
    // Reaches the authorization gate (and fails THERE) — the MFA gate let it through.
    assertEquals(status, 403);
    assertEquals(body.error, "You are not authorized to remove this user's two-factor authentication");
  } finally {
    h.cleanup();
  }
});

// ── MFA mandate (super-admin: always; admins: after the deadline) ──────

Deno.test("admin-reset-user-mfa: 403 for a super-admin caller below aal2 (mandate)", async () => {
  const h = createTestHarness({
    routes: [
      // Unenrolled super-admin: no factors, aal1 — enrollment is not optional
      // for super-admins, so this must be refused.
      authUserRoute({ id: CALLER_ID, email: "root@test.local" }),
      isSuperAdminRoute([CALLER_ID]),
    ],
  });
  try {
    const res = await h.invoke(handler, { userId: TARGET_ID }, { headers: tokenWithAal("aal1") });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 403);
    assertEquals(body.error, "Two-factor verification required");
    const factorCall = h.fetchLog.find((c) => c.url.includes("/factors"));
    assertEquals(factorCall, undefined);
  } finally {
    h.cleanup();
  }
});

Deno.test("admin-reset-user-mfa: 403 for an aal1 institution admin once the deadline has passed", async () => {
  const h = createTestHarness({
    routes: [
      authUserRoute({ id: CALLER_ID, email: "admin@test.local" }),
      isSuperAdminRoute([]),
      supabaseRoute("/rest/v1/user_institutions", [{ institution_id: "inst-1" }], { method: "GET" }),
      supabaseRoute("/rest/v1/rpc/is_institution_admin", true, { method: "POST" }),
      securityPoliciesRoute(PAST_DEADLINE),
    ],
  });
  try {
    const res = await h.invoke(handler, { userId: TARGET_ID }, { headers: tokenWithAal("aal1") });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 403);
    assertEquals(body.error, "Two-factor verification required");
  } finally {
    h.cleanup();
  }
});

Deno.test("admin-reset-user-mfa: a missing deadline row fails closed (mandate active)", async () => {
  const h = createTestHarness({
    routes: [
      authUserRoute({ id: CALLER_ID, email: "admin@test.local" }),
      isSuperAdminRoute([]),
      supabaseRoute("/rest/v1/user_institutions", [{ institution_id: "inst-1" }], { method: "GET" }),
      supabaseRoute("/rest/v1/rpc/is_institution_admin", true, { method: "POST" }),
      // No security_policies route: the read 404s, and the mandate check must
      // treat that as active rather than waving the caller through.
    ],
  });
  try {
    const res = await h.invoke(handler, { userId: TARGET_ID }, { headers: tokenWithAal("aal1") });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 403);
    assertEquals(body.error, "Two-factor verification required");
  } finally {
    h.cleanup();
  }
});

Deno.test("admin-reset-user-mfa: a caller with only an unverified factor passes the MFA gate", async () => {
  const h = createTestHarness({
    routes: [
      authUserRoute({ id: CALLER_ID, factors: [{ factor_type: "totp", status: "unverified" }] }),
      isSuperAdminRoute([]),
      supabaseRoute("/rest/v1/user_institutions", [], { method: "GET" }),
    ],
  });
  try {
    const res = await h.invoke(handler, { userId: TARGET_ID }, { headers: tokenWithAal("aal1") });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 403);
    assertEquals(body.error, "You are not authorized to remove this user's two-factor authentication");
  } finally {
    h.cleanup();
  }
});

// ── Authorization boundary ─────────────────────────────────────────────

Deno.test("admin-reset-user-mfa: 403 when caller is neither super-admin nor institution-admin", async () => {
  const h = createTestHarness({
    routes: [
      authUserRoute({ id: CALLER_ID }),
      isSuperAdminRoute([]),
      supabaseRoute("/rest/v1/user_institutions", [{ institution_id: "inst-1" }], { method: "GET" }),
      supabaseRoute("/rest/v1/rpc/is_institution_admin", false, { method: "POST" }),
    ],
  });
  try {
    const res = await h.invoke(handler, { userId: TARGET_ID }, { headers: AUTH });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 403);
    assertEquals(body.error, "You are not authorized to remove this user's two-factor authentication");
    // No factor was listed or deleted.
    const factorCall = h.fetchLog.find((c) => c.url.includes("/factors"));
    assertEquals(factorCall, undefined);
  } finally {
    h.cleanup();
  }
});

Deno.test("admin-reset-user-mfa: 500 when the target super-admin check errors (fails closed)", async () => {
  const h = createTestHarness({
    routes: [
      authUserRoute({ id: CALLER_ID }),
      // Caller's is_super_admin resolves false; the TARGET's check errors.
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
    const res = await h.invoke(handler, { userId: TARGET_ID }, { headers: AUTH });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 500);
    assertEquals(body.error, "Failed to verify authorization");
    // The caller was NOT waved through to the institution-admin path.
    const factorCall = h.fetchLog.find((c) => c.url.includes("/factors"));
    assertEquals(factorCall, undefined);
  } finally {
    h.cleanup();
  }
});

Deno.test("admin-reset-user-mfa: 403 when an institution admin targets a super-admin", async () => {
  const h = createTestHarness({
    routes: [
      authUserRoute({ id: CALLER_ID }),
      isSuperAdminRoute([TARGET_ID]), // target is super-admin, caller is not
    ],
  });
  try {
    const res = await h.invoke(handler, { userId: TARGET_ID }, { headers: AUTH });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 403);
    assertEquals(
      body.error,
      "Only a super-admin can remove another super-admin's two-factor authentication",
    );
    const factorCall = h.fetchLog.find((c) => c.url.includes("/factors"));
    assertEquals(factorCall, undefined);
  } finally {
    h.cleanup();
  }
});

// ── Happy paths ────────────────────────────────────────────────────────

Deno.test("admin-reset-user-mfa: super-admin removes every factor, notice + audit recorded", async () => {
  const h = createTestHarness({
    routes: [
      authUserRoute({ id: CALLER_ID, email: "root@test.local" }),
      isSuperAdminRoute([CALLER_ID]),
      deleteFactorRoute(),
      listFactorsRoute(twoFactors),
      getUserByIdRoute({ id: TARGET_ID, email: "target@test.local", user_metadata: { full_name: "Target User" } }),
      resendRoute(),
      supabaseRoute("/rest/v1/audit_logs", {}, { method: "POST" }),
    ],
  });
  try {
    // Super-admin callers are mandated to be aal2 — see the mandate tests.
    const res = await h.invoke(handler, { userId: TARGET_ID }, { headers: tokenWithAal("aal2") });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 200);
    assertEquals(body, { success: true, removed: 2 });

    // Both factors were deleted.
    const deletes = h.fetchLog.filter(
      (c) => c.method === "DELETE" && c.url.includes("/factors/"),
    );
    assertEquals(deletes.length, 2);
    assertEquals(deletes[0].url.endsWith(FACTOR_A), true);
    assertEquals(deletes[1].url.endsWith(FACTOR_B), true);

    // The notice went to the target.
    const resendCall = h.fetchLog.find((c) => c.url.includes("api.resend.com"));
    assertEquals(resendCall !== undefined, true);
    assertEquals(resendCall!.body!.includes("target@test.local"), true);

    // The audit row names the action, actor and target.
    const auditCall = h.fetchLog.find((c) => c.url.includes("/rest/v1/audit_logs"));
    assertEquals(auditCall !== undefined, true);
    const audit = JSON.parse(auditCall!.body!);
    assertEquals(audit.action, "user.mfa_reset");
    assertEquals(audit.actor_user_id, CALLER_ID);
    assertEquals(audit.target_user_id, TARGET_ID);
    assertEquals(audit.institution_id, null);
    assertEquals(audit.metadata.via, "super_admin");
    assertEquals(audit.metadata.factors_removed, 2);
    assertEquals(audit.metadata.email_notified, true);
  } finally {
    h.cleanup();
  }
});

Deno.test("admin-reset-user-mfa: institution admin of the target's institution succeeds", async () => {
  const h = createTestHarness({
    routes: [
      ...institutionAdminRoutes(),
      deleteFactorRoute(),
      listFactorsRoute([twoFactors[0]]),
      getUserByIdRoute({ id: TARGET_ID, email: "target@test.local" }),
      resendRoute(),
      supabaseRoute("/rest/v1/audit_logs", {}, { method: "POST" }),
    ],
  });
  try {
    const res = await h.invoke(handler, { userId: TARGET_ID }, { headers: AUTH });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 200);
    assertEquals(body, { success: true, removed: 1 });

    const auditCall = h.fetchLog.find((c) => c.url.includes("/rest/v1/audit_logs"));
    const audit = JSON.parse(auditCall!.body!);
    assertEquals(audit.institution_id, "inst-1");
    assertEquals(audit.metadata.via, "institution_admin");
  } finally {
    h.cleanup();
  }
});

Deno.test("admin-reset-user-mfa: an admin may target their own account", async () => {
  const h = createTestHarness({
    routes: [
      authUserRoute({ id: CALLER_ID, email: "admin@test.local" }),
      isSuperAdminRoute([]),
      supabaseRoute("/rest/v1/user_institutions", [{ institution_id: "inst-1" }], { method: "GET" }),
      supabaseRoute("/rest/v1/rpc/is_institution_admin", true, { method: "POST" }),
      securityPoliciesRoute(FUTURE_DEADLINE),
      deleteFactorRoute(CALLER_ID),
      listFactorsRoute([{ id: FACTOR_A, status: "verified", factor_type: "totp" }], CALLER_ID),
      getUserByIdRoute({ id: CALLER_ID, email: "admin@test.local" }, CALLER_ID),
      resendRoute(),
      supabaseRoute("/rest/v1/audit_logs", {}, { method: "POST" }),
    ],
  });
  try {
    const res = await h.invoke(handler, { userId: CALLER_ID }, { headers: AUTH });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 200);
    assertEquals(body, { success: true, removed: 1 });
  } finally {
    h.cleanup();
  }
});

Deno.test("admin-reset-user-mfa: no factors enrolled → removed: 0 and no notice", async () => {
  const h = createTestHarness({
    routes: [
      ...institutionAdminRoutes(),
      listFactorsRoute([]),
      supabaseRoute("/rest/v1/audit_logs", {}, { method: "POST" }),
    ],
  });
  try {
    const res = await h.invoke(handler, { userId: TARGET_ID }, { headers: AUTH });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 200);
    assertEquals(body, { success: true, removed: 0 });

    // No delete, no email — but the attempt is still audited.
    assertEquals(h.fetchLog.find((c) => c.method === "DELETE"), undefined);
    assertEquals(h.fetchLog.find((c) => c.url.includes("api.resend.com")), undefined);
    const auditCall = h.fetchLog.find((c) => c.url.includes("/rest/v1/audit_logs"));
    const audit = JSON.parse(auditCall!.body!);
    assertEquals(audit.metadata.factors_removed, 0);
    assertEquals(audit.metadata.email_notified, false);
  } finally {
    h.cleanup();
  }
});

Deno.test("admin-reset-user-mfa: failed notice still audits with email_notified=false", async () => {
  const h = createTestHarness({
    routes: [
      ...institutionAdminRoutes(),
      deleteFactorRoute(),
      listFactorsRoute([twoFactors[0]]),
      getUserByIdRoute({ id: TARGET_ID, email: "target@test.local" }),
      resendRoute({ name: "validation_error", message: "domain not verified" }, { status: 422 }),
      supabaseRoute("/rest/v1/audit_logs", {}, { method: "POST" }),
    ],
  });
  try {
    const res = await h.invoke(handler, { userId: TARGET_ID }, { headers: AUTH });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 200);
    assertEquals(body.success, true);

    const auditCall = h.fetchLog.find((c) => c.url.includes("/rest/v1/audit_logs"));
    const audit = JSON.parse(auditCall!.body!);
    assertEquals(audit.metadata.email_notified, false);
  } finally {
    h.cleanup();
  }
});

Deno.test("admin-reset-user-mfa: partial reset still notifies the target", async () => {
  const h = createTestHarness({
    routes: [
      ...institutionAdminRoutes(),
      // First factor deletes fine, second fails — the verified factor is
      // already gone (and the user signed out), so the notice must still go.
      {
        match: (url, init) =>
          url.endsWith(`/factors/${FACTOR_A}`) &&
          (init?.method ?? "GET").toUpperCase() === "DELETE",
        respond: () =>
          new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
      },
      deleteFactorRoute(TARGET_ID, 500),
      listFactorsRoute(twoFactors),
      getUserByIdRoute({ id: TARGET_ID, email: "target@test.local" }),
      resendRoute(),
      supabaseRoute("/rest/v1/audit_logs", {}, { method: "POST" }),
    ],
  });
  try {
    const res = await h.invoke(handler, { userId: TARGET_ID }, { headers: AUTH });
    const { status } = await parseResponse(res);
    assertEquals(status, 500);

    const resendCall = h.fetchLog.find((c) => c.url.includes("api.resend.com"));
    assertEquals(resendCall !== undefined, true);

    const auditCall = h.fetchLog.find((c) => c.url.includes("/rest/v1/audit_logs"));
    const audit = JSON.parse(auditCall!.body!);
    assertEquals(audit.metadata.partial, true);
    assertEquals(audit.metadata.factors_removed, 1);
    assertEquals(audit.metadata.email_notified, true);
  } finally {
    h.cleanup();
  }
});

Deno.test("admin-reset-user-mfa: mid-loop delete failure returns 500 and audits the partial state", async () => {
  const h = createTestHarness({
    routes: [
      ...institutionAdminRoutes(),
      deleteFactorRoute(TARGET_ID, 500),
      listFactorsRoute(twoFactors),
      supabaseRoute("/rest/v1/audit_logs", {}, { method: "POST" }),
    ],
  });
  try {
    const res = await h.invoke(handler, { userId: TARGET_ID }, { headers: AUTH });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 500);
    assertEquals(typeof body.error, "string");

    const auditCall = h.fetchLog.find((c) => c.url.includes("/rest/v1/audit_logs"));
    assertEquals(auditCall !== undefined, true);
    const audit = JSON.parse(auditCall!.body!);
    assertEquals(audit.metadata.partial, true);
    assertEquals(audit.metadata.factors_removed, 0);
  } finally {
    h.cleanup();
  }
});
