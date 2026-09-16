import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  createTestHarness,
  supabaseRoute,
  parseResponse,
} from "../handler-harness.ts";
import { handler } from "../../../extract-competencies/handler.ts";

const OPTS = { sanitizeOps: false, sanitizeResources: false };

Deno.test("extract-competencies: OPTIONS returns CORS headers", async () => {
  const h = createTestHarness();
  try {
    const req = new Request("http://localhost/functions/v1/extract-competencies", { method: "OPTIONS" });
    const res = await handler(req);
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  } finally {
    h.cleanup();
  }
});

Deno.test("extract-competencies: returns 500 when courseId is missing", async () => {
  const h = createTestHarness();
  try {
    const res = await h.invoke(handler, { materialId: "mat-1" });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 500);
    assertEquals(body.error, "courseId is required");
  } finally {
    h.cleanup();
  }
});

Deno.test("extract-competencies: returns 500 when materialId is missing", async () => {
  const h = createTestHarness();
  try {
    const res = await h.invoke(handler, { courseId: "c1" });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 500);
    assertEquals(body.error, "materialId is required");
  } finally {
    h.cleanup();
  }
});

Deno.test({
  name: "extract-competencies: returns error when no chapters found",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        supabaseRoute("/rest/v1/material_chapters", []),
        supabaseRoute("/rest/v1/courses", { language: "en" }),
      ],
    });
    try {
      const res = await h.invoke(handler, { courseId: "c1", materialId: "mat-1" });
      const { status, body } = await parseResponse(res);
      // Should fail because no chapters found
      assertEquals(status >= 400, true);
    } finally {
      h.cleanup();
    }
  },
});
