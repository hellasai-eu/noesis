import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  createTestHarness,
  parseResponse,
} from "../handler-harness.ts";
import { handler } from "../../../split-chapters/handler.ts";

Deno.test("split-chapters: OPTIONS returns CORS headers", async () => {
  const h = createTestHarness();
  try {
    const req = new Request("http://localhost/functions/v1/split-chapters", { method: "OPTIONS" });
    const res = await handler(req);
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  } finally {
    h.cleanup();
  }
});

Deno.test("split-chapters: returns 400 when filePath is missing", async () => {
  const h = createTestHarness();
  try {
    const res = await h.invoke(handler, {
      bucketName: "files",
      chapters: [{ chapterIndex: 0, pageStart: 1, pageEnd: 10, title: "Ch 1" }],
    });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 400);
    assertEquals(body.error, "Missing required parameters: filePath, bucketName, chapters");
  } finally {
    h.cleanup();
  }
});

Deno.test("split-chapters: returns 400 when chapters is empty", async () => {
  const h = createTestHarness();
  try {
    const res = await h.invoke(handler, {
      filePath: "/test.pdf",
      bucketName: "files",
      chapters: [],
    });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 400);
    assertEquals(body.error, "Missing required parameters: filePath, bucketName, chapters");
  } finally {
    h.cleanup();
  }
});

Deno.test("split-chapters: returns 400 when bucketName is missing", async () => {
  const h = createTestHarness();
  try {
    const res = await h.invoke(handler, {
      filePath: "/test.pdf",
      chapters: [{ chapterIndex: 0, pageStart: 1, pageEnd: 10, title: "Ch 1" }],
    });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 400);
    assertEquals(body.error, "Missing required parameters: filePath, bucketName, chapters");
  } finally {
    h.cleanup();
  }
});
