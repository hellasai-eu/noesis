import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  createTestHarness,
  type MockRoute,
  parseResponse,
  supabaseRoute,
} from "../handler-harness.ts";
import { handler } from "../../../export-data/handler.ts";

/** A super admin, past both the auth and the authorization gate. */
const SUPER_ADMIN_ROUTES: MockRoute[] = [
  supabaseRoute("/auth/v1/user", { id: "super-1", email: "super@test.local" }),
  supabaseRoute("/rest/v1/rpc/is_super_admin", true),
];

/** Counts every table as empty, so `list-tables` only exercises the table list. */
const EMPTY_TABLE_ROUTE: MockRoute = {
  match: (url) => url.includes("/rest/v1/") && !url.includes("/rpc/"),
  respond: () =>
    new Response(null, {
      status: 200,
      headers: { "Content-Range": "*/0", "Content-Type": "application/json" },
    }),
};

Deno.test("export-data: OPTIONS returns CORS headers", async () => {
  const h = createTestHarness();
  try {
    const req = new Request("http://localhost/functions/v1/export-data", { method: "OPTIONS" });
    const res = await handler(req);
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  } finally { h.cleanup(); }
});

Deno.test("export-data: returns 401 when no authorization header", async () => {
  const h = createTestHarness();
  try {
    const res = await h.invoke(handler, { action: "list-tables" });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 401);
  } finally { h.cleanup(); }
});

// ── Auth paths (need sanitizer opts due to Supabase client intervals) ──

const OPTS = { sanitizeOps: false, sanitizeResources: false };

// The table list used to be a hand-maintained array in this file's subject,
// which had drifted to 42 of 94 tables (issue #947). It now comes from
// `public.list_exportable_tables()`, so what the database says is what gets
// exported — including tables added after this code was written.
Deno.test({
  name: "export-data: list-tables reports the tables the database returns",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        ...SUPER_ADMIN_ROUTES,
        supabaseRoute("/rest/v1/rpc/list_exportable_tables", ["alpha", "beta", "gamma"]),
        EMPTY_TABLE_ROUTE,
      ],
    });
    try {
      const res = await h.invoke(handler, { action: "list-tables" }, {
        headers: { authorization: "Bearer valid-token" },
      });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      assertEquals(Object.keys(body.tables).sort(), ["alpha", "beta", "gamma"]);
    } finally { h.cleanup(); }
  },
});

// Failing loudly matters more than degrading gracefully here: this endpoint is
// presented to a super admin as a whole-database dump, and one that silently
// omits tables is worse than one that does not run.
Deno.test({
  name: "export-data: fails rather than exporting a partial list",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        ...SUPER_ADMIN_ROUTES,
        supabaseRoute("/rest/v1/rpc/list_exportable_tables", { message: "boom" }, { status: 500 }),
      ],
    });
    try {
      const res = await h.invoke(handler, { action: "export" }, {
        headers: { authorization: "Bearer valid-token" },
      });
      const { status } = await parseResponse(res);
      assertEquals(status, 500);
    } finally { h.cleanup(); }
  },
});
