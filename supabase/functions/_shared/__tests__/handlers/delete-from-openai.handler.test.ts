import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { createTestHarness, parseResponse, supabaseRoute } from "../handler-harness.ts";
import type { MockRoute } from "../handler-harness.ts";
import { handler } from "../../../delete-from-openai/handler.ts";

const OPTS = { sanitizeOps: false, sanitizeResources: false };
const AUTH = { Authorization: "Bearer test-token" };

const CALLER: MockRoute = {
  match: (url: string) => url.includes("/auth/v1/user"),
  respond: () =>
    new Response(JSON.stringify({ id: "user-1", email: "instructor@test.local" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
};

Deno.test("delete-from-openai: OPTIONS returns CORS headers", async () => {
  const h = createTestHarness();
  try {
    const req = new Request("http://localhost/functions/v1/delete-from-openai", { method: "OPTIONS" });
    const res = await handler(req);
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  } finally { h.cleanup(); }
});

Deno.test("delete-from-openai: returns 400 when openaiFileId is missing", async () => {
  const h = createTestHarness();
  try {
    const res = await h.invoke(handler, {});
    const { status, body } = await parseResponse(res);
    assertEquals(status, 400);
    assertEquals(body.error.includes("openaiFileId"), true);
  } finally { h.cleanup(); }
});

Deno.test("delete-from-openai: an unauthenticated caller is refused before the config is consulted", async () => {
  // This used to answer 500 "OPENAI_API_KEY not configured" to anyone who
  // asked, which both skipped the caller check and reported how the deployment
  // is set up. The gate (#1135) now runs first, so the same request is a 401.
  const h = createTestHarness({ envVars: { OPENAI_API_KEY: "" } });
  try {
    const res = await h.invoke(handler, { openaiFileId: "file-123" });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 401);
    assertEquals(body.error, "Unauthorized");
  } finally { h.cleanup(); }
});

/**
 * The rollback path (#1222): a file uploaded to OpenAI for a material row that
 * then failed to be inserted. The ordinary path refuses a file no material
 * owns — which is exactly the file a rollback has to remove — so the ownership
 * rule is inverted here rather than dropped.
 */
/** The vector-store entry `upload-to-openai` stamps with the owning course. */
function attributedTo(courseId: string): MockRoute {
  return {
    match: (url, init) =>
      url.includes("/vector_stores/vs-1/files/file-123") && (init?.method ?? "GET") === "GET",
    respond: () =>
      new Response(JSON.stringify({ id: "file-123", attributes: { course_id: courseId } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  };
}

Deno.test({
  name: "delete-from-openai: delete-orphan removes a file no material owns",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        CALLER,
        // Nothing owns the file; the course exists and the caller is an admin.
        supabaseRoute("/rest/v1/course_materials", null),
        supabaseRoute("/rest/v1/material_chapters", null),
        supabaseRoute("/rest/v1/courses", { institution_id: "inst-1" }),
        supabaseRoute("/rest/v1/rpc/is_institution_admin", true),
        supabaseRoute("/rest/v1/institutions", { vector_store_id: "vs-1" }),
        attributedTo("course-1"),
        {
          match: (url, init) =>
            url.includes("/vector_stores/vs-1/files/file-123") && init?.method === "DELETE",
          respond: () => new Response(JSON.stringify({ deleted: true }), { status: 200 }),
        },
        {
          match: (url, init) => url.includes("/v1/files/file-123") && init?.method === "DELETE",
          respond: () => new Response(JSON.stringify({ deleted: true }), { status: 200 }),
        },
      ],
    });
    try {
      const res = await h.invoke(
        handler,
        { action: "delete-orphan", openaiFileId: "file-123", courseId: "course-1" },
        { headers: AUTH },
      );
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      assertEquals(body.success, true);
      // Detached from the store before the global delete, or the store keeps
      // pointing at a file that no longer exists.
      assertEquals(body.removedFromVectorStore, true);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "delete-from-openai: delete-orphan refuses a file that a material owns",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        CALLER,
        // Naming a course you manage must not license deleting another
        // course's file, so the owner check runs before authorization.
        supabaseRoute("/rest/v1/course_materials", { course_id: "someone-elses-course" }),
        supabaseRoute("/rest/v1/courses", { institution_id: "inst-1" }),
        supabaseRoute("/rest/v1/rpc/is_institution_admin", true),
      ],
    });
    try {
      const res = await h.invoke(
        handler,
        { action: "delete-orphan", openaiFileId: "file-123", courseId: "course-1" },
        { headers: AUTH },
      );
      const { status, body } = await parseResponse(res);
      assertEquals(status, 409);
      assertEquals(body.error.includes("belongs to a material"), true);
      assertEquals(h.fetchLog.some((entry) => entry.url.includes("api.openai.com")), false);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "delete-from-openai: delete-orphan needs a courseId to authorize against",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [CALLER, supabaseRoute("/rest/v1/course_materials", null)],
    });
    try {
      const res = await h.invoke(
        handler,
        { action: "delete-orphan", openaiFileId: "file-123" },
        { headers: AUTH },
      );
      const { status, body } = await parseResponse(res);
      assertEquals(status, 400);
      assertEquals(body.error.includes("courseId"), true);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "delete-from-openai: delete-orphan refuses a caller who does not manage the course",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        CALLER,
        supabaseRoute("/rest/v1/course_materials", null),
        supabaseRoute("/rest/v1/material_chapters", null),
        supabaseRoute("/rest/v1/courses", { institution_id: "inst-1" }),
        supabaseRoute("/rest/v1/rpc/is_institution_admin", false),
        supabaseRoute("/rest/v1/user_institutions", null),
      ],
    });
    try {
      const res = await h.invoke(
        handler,
        { action: "delete-orphan", openaiFileId: "file-123", courseId: "course-1" },
        { headers: AUTH },
      );
      const { status } = await parseResponse(res);
      assertEquals(status, 403);
      assertEquals(h.fetchLog.some((entry) => entry.url.includes("api.openai.com")), false);
    } finally {
      h.cleanup();
    }
  },
});

/**
 * "Nothing owns it" is not "it is yours" (#1222 review).
 *
 * The ordinary path gets ownership from the material row. A rollback has no
 * row, so unowned-ness was standing in for ownership — and it does not: a
 * manager who learns the id of an orphan from ANOTHER institution's failed
 * import could name their own course and have us delete that file globally.
 * `upload-to-openai` stamps `course_id` onto the vector-store entry, so the
 * store is the record of which course a file was uploaded for.
 */
Deno.test({
  name: "delete-from-openai: delete-orphan refuses a file stamped for another course",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        CALLER,
        supabaseRoute("/rest/v1/course_materials", null),
        supabaseRoute("/rest/v1/material_chapters", null),
        supabaseRoute("/rest/v1/courses", { institution_id: "inst-1" }),
        supabaseRoute("/rest/v1/rpc/is_institution_admin", true),
        supabaseRoute("/rest/v1/institutions", { vector_store_id: "vs-1" }),
        attributedTo("someone-elses-course"),
      ],
    });
    try {
      const res = await h.invoke(
        handler,
        { action: "delete-orphan", openaiFileId: "file-123", courseId: "course-1" },
        { headers: AUTH },
      );
      const { status, body } = await parseResponse(res);
      assertEquals(status, 403);
      assertEquals(body.error.includes("cannot be attributed"), true);
      // Nothing was deleted anywhere.
      assertEquals(
        h.fetchLog.some((entry) => entry.method === "DELETE"),
        false,
      );
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "delete-from-openai: delete-orphan refuses a file that is not in the course's store",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        CALLER,
        supabaseRoute("/rest/v1/course_materials", null),
        supabaseRoute("/rest/v1/material_chapters", null),
        supabaseRoute("/rest/v1/courses", { institution_id: "inst-1" }),
        supabaseRoute("/rest/v1/rpc/is_institution_admin", true),
        supabaseRoute("/rest/v1/institutions", { vector_store_id: "vs-1" }),
        {
          match: (url, init) =>
            url.includes("/vector_stores/vs-1/files/file-123") && (init?.method ?? "GET") === "GET",
          respond: () => new Response(JSON.stringify({ error: "not found" }), { status: 404 }),
        },
      ],
    });
    try {
      const res = await h.invoke(
        handler,
        { action: "delete-orphan", openaiFileId: "file-123", courseId: "course-1" },
        { headers: AUTH },
      );
      const { status } = await parseResponse(res);
      assertEquals(status, 403);
      assertEquals(h.fetchLog.some((entry) => entry.method === "DELETE"), false);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "delete-from-openai: delete-orphan refuses a file a chapter owns",
  ...OPTS,
  async fn() {
    // `material_chapters` carries its own `openai_file_id` (split-chapters
    // uploads one per chapter), so a material-only check would call another
    // institution's chapter source an orphan.
    const h = createTestHarness({
      routes: [
        CALLER,
        supabaseRoute("/rest/v1/course_materials", null),
        supabaseRoute("/rest/v1/material_chapters", { id: "chapter-9" }),
        supabaseRoute("/rest/v1/courses", { institution_id: "inst-1" }),
        supabaseRoute("/rest/v1/rpc/is_institution_admin", true),
      ],
    });
    try {
      const res = await h.invoke(
        handler,
        { action: "delete-orphan", openaiFileId: "file-123", courseId: "course-1" },
        { headers: AUTH },
      );
      const { status, body } = await parseResponse(res);
      assertEquals(status, 409);
      assertEquals(body.error.includes("chapter"), true);
      assertEquals(h.fetchLog.some((entry) => entry.url.includes("api.openai.com")), false);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "delete-from-openai: delete-orphan refuses when the institution has no store to attribute from",
  ...OPTS,
  async fn() {
    // No store means no `course_id` stamp to check, and an unattributable file
    // is one this handler declines to touch — the same rule the ordinary path
    // states.
    const h = createTestHarness({
      routes: [
        CALLER,
        supabaseRoute("/rest/v1/course_materials", null),
        supabaseRoute("/rest/v1/material_chapters", null),
        supabaseRoute("/rest/v1/courses", { institution_id: "inst-1" }),
        supabaseRoute("/rest/v1/rpc/is_institution_admin", true),
        supabaseRoute("/rest/v1/institutions", { vector_store_id: null }),
      ],
    });
    try {
      const res = await h.invoke(
        handler,
        { action: "delete-orphan", openaiFileId: "file-123", courseId: "course-1" },
        { headers: AUTH },
      );
      const { status } = await parseResponse(res);
      assertEquals(status, 403);
      assertEquals(h.fetchLog.some((entry) => entry.method === "DELETE"), false);
    } finally {
      h.cleanup();
    }
  },
});
