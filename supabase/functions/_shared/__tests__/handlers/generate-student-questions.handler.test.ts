import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { createTestHarness, parseResponse } from "../handler-harness.ts";
import { handler } from "../../../generate-student-questions/handler.ts";

Deno.test("generate-student-questions: OPTIONS returns CORS headers", async () => {
  const h = createTestHarness();
  try {
    const req = new Request("http://localhost/functions/v1/generate-student-questions", { method: "OPTIONS" });
    const res = await handler(req);
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  } finally { h.cleanup(); }
});

Deno.test("generate-student-questions: returns 400 for invalid difficulty", async () => {
  const h = createTestHarness();
  try {
    const res = await h.invoke(handler, { courseId: "c1", chapterId: "ch1", difficulty: "impossible" });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 400);
    assertEquals(body.error.includes("difficulty"), true);
  } finally { h.cleanup(); }
});
