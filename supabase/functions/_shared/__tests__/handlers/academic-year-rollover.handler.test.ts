import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { createTestHarness, supabaseRoute, supabaseAuthRoute, parseResponse } from "../handler-harness.ts";
import { handler } from "../../../academic-year-rollover/handler.ts";

Deno.test("academic-year-rollover: OPTIONS returns CORS headers", async () => {
  const h = createTestHarness();
  try {
    const req = new Request("http://localhost/functions/v1/academic-year-rollover", { method: "OPTIONS" });
    const res = await handler(req);
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  } finally { h.cleanup(); }
});

Deno.test("academic-year-rollover: returns 400 when institution_id is missing", async () => {
  const h = createTestHarness();
  try {
    const res = await h.invoke(handler, { new_academic_period: "2026-2027" });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 400);
    assertEquals(body.error.includes("institution_id") || body.error.includes("required"), true);
  } finally { h.cleanup(); }
});

Deno.test("academic-year-rollover: returns 400 when new_academic_period is missing", async () => {
  const h = createTestHarness();
  try {
    const res = await h.invoke(handler, { institution_id: "inst-1" });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 400);
    assertEquals(body.error.includes("new_academic_period") || body.error.includes("required"), true);
  } finally { h.cleanup(); }
});

// ── Auth paths (need sanitizer opts due to Supabase client intervals) ──

const OPTS = { sanitizeOps: false, sanitizeResources: false };

Deno.test({
  name: "academic-year-rollover: returns 401 when no authorization header",
  ...OPTS,
  async fn() {
    const h = createTestHarness();
    try {
      const res = await h.invoke(handler, {
        institution_id: "inst-1",
        new_academic_period: "2026-2027",
      });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 401);
      assertEquals(body.error, "Authorization required");
    } finally { h.cleanup(); }
  },
});

Deno.test({
  name: "academic-year-rollover: returns 401 when token is invalid",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        supabaseRoute("/auth/v1/user", { message: "invalid token" }, { status: 401 }),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        institution_id: "inst-1",
        new_academic_period: "2026-2027",
      }, {
        headers: { authorization: "Bearer bad-token" },
      });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 401);
      assertEquals(body.error, "Invalid authentication");
    } finally { h.cleanup(); }
  },
});

Deno.test({
  name: "academic-year-rollover: returns 403 when caller is not admin",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        // auth getUser returns a valid user
        supabaseRoute("/auth/v1/user", { id: "user-1", email: "teacher@test.com" }),
        // The admin check answers a clear no. Before #1155 this route was
        // absent and the RPC 404'd, so the test asserted 403 while actually
        // exercising "the check failed" — the exact conflation #1155 removes.
        supabaseRoute("/rest/v1/rpc/is_institution_admin", false),
        supabaseRoute("/rest/v1/user_institutions", { role: "instructor" }),
        supabaseRoute("/rest/v1/profiles", { is_super_admin: false }),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        institution_id: "inst-1",
        new_academic_period: "2026-2027",
      }, {
        headers: { authorization: "Bearer valid-token" },
      });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 403);
      assertEquals(body.error, "Admin access required");
    } finally { h.cleanup(); }
  },
});

// ── Dual-write grade_level_id (#796) ──────────────────────────────────

Deno.test({
  name: "academic-year-rollover: recreated sections carry grade_level_id forward",
  ...OPTS,
  async fn() {
    // Stateful stub — track which /rest/v1/classes response to serve. First
    // GET is the active-sections read, then two writes (archive PATCH + new
    // INSERT), then a GET for offerings.
    let classesGetCount = 0;
    const activeSection = {
      id: "cls-old-1",
      name: "Section A",
      grade_level_id: "gl-dimotiko-1",
      section_name: "Α",
      category: null,
      allow_self_enrollment: false,
      academic_period: "2025-2026",
    };
    const h = createTestHarness({
      routes: [
        supabaseRoute("/auth/v1/user", { id: "admin-1", email: "admin@test.com" }),
        // #1082 — the admin decision moved to the is_institution_admin RPC,
        // which honours is_suspended. A direct role read no longer authorizes.
        supabaseRoute("/rest/v1/rpc/is_institution_admin", true, { method: "POST" }),
        {
          // institution update PATCH
          match: (url, init) =>
            url.includes("/rest/v1/institutions") &&
            (init?.method ?? "GET").toUpperCase() === "PATCH",
          respond: () =>
            new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }),
        },
        {
          match: (url, init) =>
            url.includes("/rest/v1/classes") &&
            (init?.method ?? "GET").toUpperCase() === "GET",
          respond: () => {
            classesGetCount += 1;
            const body = classesGetCount === 1 ? [activeSection] : [];
            return new Response(JSON.stringify(body), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          },
        },
        {
          // archive PATCH
          match: (url, init) =>
            url.includes("/rest/v1/classes") &&
            (init?.method ?? "GET").toUpperCase() === "PATCH",
          respond: () =>
            new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }),
        },
        {
          // create-new POST — return one row with same grade info
          match: (url, init) =>
            url.includes("/rest/v1/classes") &&
            (init?.method ?? "GET").toUpperCase() === "POST",
          respond: () =>
            new Response(
              JSON.stringify([
                {
                  id: "cls-new-1",
                  grade_level_id: "gl-dimotiko-1",
                  section_name: "Α",
                  category: null,
                },
              ]),
              { status: 201, headers: { "Content-Type": "application/json" } },
            ),
        },
        // No offerings to copy in this test
        {
          match: (url, init) =>
            url.includes("/rest/v1/offerings") &&
            (init?.method ?? "GET").toUpperCase() === "GET",
          respond: () =>
            new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }),
        },
      ],
    });
    try {
      const res = await h.invoke(handler, {
        institution_id: "inst-1",
        new_academic_period: "2026-2027",
      }, {
        headers: { authorization: "Bearer valid-token" },
      });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      assertEquals(body.success, true);

      // The new-section POST body must include grade_level_id from the archived row.
      const createCall = h.fetchLog.find(
        (c) =>
          c.url.includes("/rest/v1/classes") &&
          c.method === "POST" &&
          !!c.body,
      );
      assertEquals(createCall !== undefined, true);
      const payloadRaw = JSON.parse(createCall!.body!);
      // Supabase-js may or may not wrap single-row inserts in an array; handle both.
      const payload = Array.isArray(payloadRaw) ? payloadRaw[0] : payloadRaw;
      assertEquals(payload.grade_level, undefined);
      assertEquals(payload.grade_level_id, "gl-dimotiko-1");
    } finally { h.cleanup(); }
  },
});
