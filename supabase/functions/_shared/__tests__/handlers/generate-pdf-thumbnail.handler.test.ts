import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { createTestHarness, parseResponse } from "../handler-harness.ts";
import { handler } from "../../../generate-pdf-thumbnail/handler.ts";

Deno.test("generate-pdf-thumbnail: OPTIONS returns CORS headers", async () => {
  const h = createTestHarness();
  try {
    const req = new Request("http://localhost/functions/v1/generate-pdf-thumbnail", { method: "OPTIONS" });
    const res = await handler(req);
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  } finally { h.cleanup(); }
});

Deno.test("generate-pdf-thumbnail: returns 500 when filePath is missing", async () => {
  const h = createTestHarness();
  try {
    const res = await h.invoke(handler, { bucketName: "files" });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 500);
    assertEquals(body.error.includes("filePath") || body.error.includes("Missing"), true);
  } finally { h.cleanup(); }
});

Deno.test("generate-pdf-thumbnail: an unauthenticated caller is refused before the config is consulted", async () => {
  // This used to answer 500 "CONVERT_API_KEY not configured" to anyone who
  // asked, which both skipped the caller check and reported how the deployment
  // is set up. The gate (#1135) now runs first, so the same request is a 401 —
  // the key check is only reached by a caller who got past it.
  const h = createTestHarness({ envVars: { CONVERT_API_KEY: "", CONVERTAPI_SECRET: "" } });
  try {
    const res = await h.invoke(handler, { filePath: "/test.pdf", bucketName: "files" });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 401);
    assertEquals(body.error, "Unauthorized");
  } finally { h.cleanup(); }
});
