import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  createTestHarness,
  parseResponse,
} from "../handler-harness.ts";
import { handler } from "../../../detect-chapters/handler.ts";

Deno.test("detect-chapters: OPTIONS returns CORS headers", async () => {
  const h = createTestHarness();
  try {
    const req = new Request("http://localhost/functions/v1/detect-chapters", { method: "OPTIONS" });
    const res = await handler(req);
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  } finally {
    h.cleanup();
  }
});

Deno.test("detect-chapters: returns 400 when filePath is missing", async () => {
  const h = createTestHarness();
  try {
    const res = await h.invoke(handler, { bucketName: "files" });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 400);
    assertEquals(body.error.includes("filePath"), true);
  } finally {
    h.cleanup();
  }
});

Deno.test("detect-chapters: returns 400 when bucketName is missing", async () => {
  const h = createTestHarness();
  try {
    const res = await h.invoke(handler, { filePath: "/test.pdf" });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 400);
    assertEquals(body.error.includes("bucketName"), true);
  } finally {
    h.cleanup();
  }
});
