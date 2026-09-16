import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  createTestHarness,
  supabaseRoute,
  parseResponse,
} from "../handler-harness.ts";
import { handler } from "../../../generate-cheatsheet/handler.ts";

const OPTS = { sanitizeOps: false, sanitizeResources: false };

Deno.test("generate-cheatsheet: OPTIONS returns CORS headers", async () => {
  const h = createTestHarness();
  try {
    const req = new Request("http://localhost/functions/v1/generate-cheatsheet", { method: "OPTIONS" });
    const res = await handler(req);
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  } finally {
    h.cleanup();
  }
});

Deno.test("generate-cheatsheet: returns 500 when chapterId is missing", async () => {
  const h = createTestHarness();
  try {
    const res = await h.invoke(handler, {});
    const { status, body } = await parseResponse(res);
    assertEquals(status, 500);
    assertEquals(body.error, "chapterId is required");
  } finally {
    h.cleanup();
  }
});

Deno.test({
  name: "generate-cheatsheet: an unauthenticated caller is refused before the chapter is read",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        supabaseRoute("/rest/v1/material_chapters", null),
      ],
    });
    try {
      // Used to answer 500 "Chapter not found" to anyone who asked, which
      // both skipped the caller check and confirmed whether a chapter id
      // exists. The gate (#1136) now answers first.
      const res = await h.invoke(handler, { chapterId: "ch-nonexistent" });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 401);
      assertEquals(body.error, "Unauthorized");
    } finally {
      h.cleanup();
    }
  },
});
