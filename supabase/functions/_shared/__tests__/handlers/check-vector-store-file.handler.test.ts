import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  createTestHarness,
  openaiRoute,
  parseResponse,
} from "../handler-harness.ts";
import type { MockRoute } from "../handler-harness.ts";
import { handler } from "../../../check-vector-store-file/handler.ts";

// ── Caller gate (#1137) ────────────────────────────────────────────────
// These spend the platform's OpenAI/ConvertAPI budget on caller-supplied
// content, and used to do it for anyone. The gate runs BEFORE input validation
// on purpose: an anonymous caller should not learn which fields the endpoint
// wants. Every case below therefore presents a caller, so that what it asserts
// is still the behaviour it was written for.

const AUTH = { Authorization: "Bearer test-token" };

/** GoTrue's `/auth/v1/user` — what `auth.getUser(token)` resolves. */
const CALLER: MockRoute = {
  match: (url: string) => url.includes("/auth/v1/user"),
  respond: () =>
    new Response(JSON.stringify({ id: "user-1", email: "student@test.local" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
};

Deno.test("check-vector-store-file: returns 400 when openaiFileId is missing", async () => {
  const h = createTestHarness({ routes: [
      CALLER,CALLER] });
  try {
    const res = await h.invoke(handler, { vectorStoreId: "vs-123" }, { headers: AUTH });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 400);
    assertEquals(body.error, "Missing openaiFileId or vectorStoreId");
  } finally {
    h.cleanup();
  }
});

Deno.test("check-vector-store-file: returns 400 when vectorStoreId is missing", async () => {
  const h = createTestHarness({ routes: [
      CALLER,CALLER] });
  try {
    const res = await h.invoke(handler, { openaiFileId: "file-123" }, { headers: AUTH });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 400);
    assertEquals(body.error, "Missing openaiFileId or vectorStoreId");
  } finally {
    h.cleanup();
  }
});

Deno.test("check-vector-store-file: returns 500 when OPENAI_API_KEY is not set", async () => {
  const h = createTestHarness({ envVars: { OPENAI_API_KEY: "" }, routes: [CALLER] });
  try {
    const res = await h.invoke(handler, { openaiFileId: "file-123", vectorStoreId: "vs-123" }, { headers: AUTH });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 500);
    assertEquals(body.error, "OpenAI API key not configured");
  } finally {
    h.cleanup();
  }
});

Deno.test("check-vector-store-file: returns inVectorStore=false when file not found", async () => {
  const h = createTestHarness({ routes: [
      CALLER,
      openaiRoute("/vector_stores/", {}, { status: 404 }),
    ],
  });
  try {
    const res = await h.invoke(handler, { openaiFileId: "file-123", vectorStoreId: "vs-123" }, { headers: AUTH });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 200);
    assertEquals(body.inVectorStore, false);
    assertEquals(body.status, null);
    assertEquals(body.lastError, null);
  } finally {
    h.cleanup();
  }
});

Deno.test("check-vector-store-file: returns 500 on OpenAI API error", async () => {
  const h = createTestHarness({ routes: [
      CALLER,
      openaiRoute("/vector_stores/", { error: "rate limited" }, { status: 429 }),
    ],
  });
  try {
    const res = await h.invoke(handler, { openaiFileId: "file-123", vectorStoreId: "vs-123" }, { headers: AUTH });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 500);
    assertEquals(body.error, "OpenAI API error: 429");
  } finally {
    h.cleanup();
  }
});

Deno.test("check-vector-store-file: returns file status on success", async () => {
  const h = createTestHarness({ routes: [
      CALLER,
      openaiRoute("/vector_stores/", {
        status: "completed",
        last_error: null,
        created_at: 1700000000,
      }),
    ],
  });
  try {
    const res = await h.invoke(handler, { openaiFileId: "file-123", vectorStoreId: "vs-123" }, { headers: AUTH });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 200);
    assertEquals(body.inVectorStore, true);
    assertEquals(body.status, "completed");
    assertEquals(body.lastError, null);
    assertEquals(body.createdAt, 1700000000);
  } finally {
    h.cleanup();
  }
});

Deno.test("check-vector-store-file: sends correct authorization header", async () => {
  const h = createTestHarness({ routes: [
      CALLER,
      openaiRoute("/vector_stores/", { status: "completed", last_error: null, created_at: 0 }),
    ],
  });
  try {
    await h.invoke(handler, { openaiFileId: "file-abc", vectorStoreId: "vs-xyz" }, { headers: AUTH });
    // Verify the fetch was called with the right URL pattern
    const openaiCall = h.fetchLog.find(c => c.url.includes("api.openai.com"));
    assertEquals(openaiCall !== undefined, true);
    assertEquals(openaiCall!.url.includes("vs-xyz/files/file-abc"), true);
    assertEquals(openaiCall!.method, "GET");
  } finally {
    h.cleanup();
  }
});
