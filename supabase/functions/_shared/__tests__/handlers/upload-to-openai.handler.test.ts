import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { createTestHarness, parseResponse, supabaseRoute } from "../handler-harness.ts";
import type { MockRoute } from "../handler-harness.ts";
import { handler } from "../../../upload-to-openai/handler.ts";

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

/** Storage download of the object being uploaded. */
const STORAGE: MockRoute = {
  match: (url: string) => url.includes("/storage/v1/object"),
  respond: () => new Response("file bytes", { status: 200 }),
};

const OPENAI_UPLOAD: MockRoute = {
  match: (url, init) => url.endsWith("/v1/files") && init?.method === "POST",
  respond: () =>
    new Response(
      JSON.stringify({ id: "file-new", filename: "notes.md", bytes: 10, purpose: "assistants" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
};

/** Course → institution → store, for a caller who manages the course. */
const MANAGED_COURSE: MockRoute[] = [
  CALLER,
  supabaseRoute("/rest/v1/rpc/is_institution_admin", true),
  supabaseRoute("/rest/v1/courses", {
    id: "course-1",
    title: "History",
    institution_id: "inst-1",
  }),
  supabaseRoute("/rest/v1/institutions", { vector_store_id: "vs-1" }),
];

/**
 * A file that reached OpenAI but not the vector store used to be reported as
 * `success: true, addedToVectorStore: false` — which no caller reads (#1108).
 * It is worse than no file at all: no search can find it, no attribute
 * identifies it, and the import rollback cannot prove it is ours to delete
 * (#1222 review). So the upload is undone and the call fails.
 */
Deno.test({
  name: "upload-to-openai: undoes the upload and fails when indexing fails",
  ...OPTS,
  async fn() {
    let deletedFile: string | null = null;
    const h = createTestHarness({
      routes: [
        ...MANAGED_COURSE,
        STORAGE,
        OPENAI_UPLOAD,
        {
          match: (url, init) => url.includes("/vector_stores/vs-1/files") && init?.method === "POST",
          respond: () => new Response("store is unavailable", { status: 503 }),
        },
        {
          match: (url, init) => url.includes("/v1/files/file-new") && init?.method === "DELETE",
          respond: (url) => {
            deletedFile = url;
            return new Response(JSON.stringify({ deleted: true }), { status: 200 });
          },
        },
      ],
    });
    try {
      const res = await h.invoke(
        handler,
        { courseId: "course-1", filePath: "course-1/notes.md", fileName: "notes.md" },
        { headers: AUTH },
      );
      const { status, body } = await parseResponse(res);

      assertEquals(status, 502);
      assertEquals(body.error.includes("indexed"), true);
      // No file id is handed back, so no caller can build a material on it.
      assertEquals(body.openaiFileId, undefined);
      // And the file itself is gone rather than left dangling in the account.
      assertEquals(deletedFile !== null, true);
      // Nothing was left behind, so nothing to escalate.
      assertEquals(body.orphanedOpenAIFileId, undefined);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "upload-to-openai: names the leftover file when the compensating delete also fails",
  ...OPTS,
  async fn() {
    // Double failure. The id cannot help the caller DELETE the file — an
    // unindexed file has no `course_id` stamp, so `delete-orphan` refuses it by
    // design — but it gives the instructor something specific to hand an
    // administrator instead of "something went wrong".
    const h = createTestHarness({
      routes: [
        ...MANAGED_COURSE,
        STORAGE,
        OPENAI_UPLOAD,
        {
          match: (url, init) => url.includes("/vector_stores/vs-1/files") && init?.method === "POST",
          respond: () => new Response("store is unavailable", { status: 503 }),
        },
        {
          match: (url, init) => url.includes("/v1/files/file-new") && init?.method === "DELETE",
          respond: () => new Response("still unavailable", { status: 503 }),
        },
      ],
    });
    try {
      const res = await h.invoke(
        handler,
        { courseId: "course-1", filePath: "course-1/notes.md", fileName: "notes.md" },
        { headers: AUTH },
      );
      const { status, body } = await parseResponse(res);

      assertEquals(status, 502);
      assertEquals(body.orphanedOpenAIFileId, "file-new");
      // In the message too, so it reaches the person on the screen.
      assertEquals(body.error.includes("file-new"), true);
      // Still no `openaiFileId`: nothing may build a material on this file.
      assertEquals(body.openaiFileId, undefined);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "upload-to-openai: an institution with no vector store still uploads",
  ...OPTS,
  async fn() {
    // Nothing to attach to is a configuration, not a fault: these uploads must
    // keep working, which is why the failure above is scoped to a store that
    // exists and refused the file.
    const h = createTestHarness({
      routes: [
        CALLER,
        supabaseRoute("/rest/v1/rpc/is_institution_admin", true),
        supabaseRoute("/rest/v1/courses", {
          id: "course-1",
          title: "History",
          institution_id: "inst-1",
        }),
        supabaseRoute("/rest/v1/institutions", { vector_store_id: null }),
        STORAGE,
        OPENAI_UPLOAD,
      ],
    });
    try {
      const res = await h.invoke(
        handler,
        { courseId: "course-1", filePath: "course-1/notes.md", fileName: "notes.md" },
        { headers: AUTH },
      );
      const { status, body } = await parseResponse(res);

      assertEquals(status, 200);
      assertEquals(body.openaiFileId, "file-new");
      assertEquals(body.addedToVectorStore, false);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "upload-to-openai: indexing succeeds and the file id comes back",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        ...MANAGED_COURSE,
        STORAGE,
        OPENAI_UPLOAD,
        {
          match: (url, init) => url.includes("/vector_stores/vs-1/files") && init?.method === "POST",
          respond: () => new Response(JSON.stringify({ status: "completed" }), { status: 200 }),
        },
      ],
    });
    try {
      const res = await h.invoke(
        handler,
        { courseId: "course-1", filePath: "course-1/notes.md", fileName: "notes.md" },
        { headers: AUTH },
      );
      const { status, body } = await parseResponse(res);

      assertEquals(status, 200);
      assertEquals(body.openaiFileId, "file-new");
      assertEquals(body.addedToVectorStore, true);
      // The stamp the rollback path attributes against.
      const indexCall = h.fetchLog.find((entry) =>
        entry.url.includes("/vector_stores/vs-1/files") && entry.method === "POST"
      );
      assertEquals(JSON.parse(indexCall?.body ?? "{}").attributes.course_id, "course-1");
    } finally {
      h.cleanup();
    }
  },
});
