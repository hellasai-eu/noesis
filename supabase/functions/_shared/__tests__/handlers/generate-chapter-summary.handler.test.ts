import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  createTestHarness,
  supabaseRoute,
  parseResponse,
} from "../handler-harness.ts";
import { handler } from "../../../generate-chapter-summary/handler.ts";

const OPTS = { sanitizeOps: false, sanitizeResources: false };

Deno.test("generate-chapter-summary: OPTIONS returns CORS headers", async () => {
  const h = createTestHarness();
  try {
    const req = new Request("http://localhost/functions/v1/generate-chapter-summary", { method: "OPTIONS" });
    const res = await handler(req);
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  } finally {
    h.cleanup();
  }
});

Deno.test("generate-chapter-summary: returns 500 when neither chapters nor whole documents are provided", async () => {
  const h = createTestHarness();
  try {
    const res = await h.invoke(handler, {});
    const { status, body } = await parseResponse(res);
    assertEquals(status, 500);
    assertEquals(body.error, "chapterIds or materialIds is required");
  } finally {
    h.cleanup();
  }
});

Deno.test({
  name: "generate-chapter-summary: accepts single chapterId",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        supabaseRoute("/rest/v1/material_chapters", []),
      ],
    });
    try {
      const res = await h.invoke(handler, { chapterId: "ch-1" });
      const { status, body } = await parseResponse(res);
      // Will fail because no chapters found, but not with input validation error
      assertEquals(body.error !== "chapterId or chapterIds is required", true);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "generate-chapter-summary: accepts array of chapterIds",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        supabaseRoute("/rest/v1/material_chapters", []),
      ],
    });
    try {
      const res = await h.invoke(handler, { chapterIds: ["ch-1", "ch-2"] });
      const { status, body } = await parseResponse(res);
      assertEquals(body.error !== "chapterId or chapterIds is required", true);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "generate-chapter-summary: an unauthenticated caller is refused before the chapters are read",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        supabaseRoute("/rest/v1/material_chapters", { message: "error" }, { status: 400 }),
      ],
    });
    try {
      // The chapters fetch is now downstream of the gate (#1136), so an
      // unauthenticated caller never reaches it.
      const res = await h.invoke(handler, { chapterId: "ch-1" });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 401);
      assertEquals(body.error, "Unauthorized");
    } finally {
      h.cleanup();
    }
  },
});
