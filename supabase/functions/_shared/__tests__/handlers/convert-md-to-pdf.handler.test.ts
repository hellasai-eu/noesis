import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { createTestHarness, parseResponse } from "../handler-harness.ts";
import type { MockRoute } from "../handler-harness.ts";
import { handler } from "../../../convert-md-to-pdf/handler.ts";

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

Deno.test("convert-md-to-pdf: OPTIONS returns CORS headers", async () => {
  const h = createTestHarness({ routes: [
      CALLER,CALLER] });
  try {
    const req = new Request("http://localhost/functions/v1/convert-md-to-pdf", { method: "OPTIONS" });
    const res = await handler(req);
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  } finally { h.cleanup(); }
});

Deno.test("convert-md-to-pdf: returns 400 when markdown and html are missing", async () => {
  const h = createTestHarness({ routes: [
      CALLER,CALLER] });
  try {
    const res = await h.invoke(handler, {}, { headers: AUTH });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 400);
    assertEquals(
      body.error.includes("markdown") || body.error.includes("html") || body.error.includes("required"),
      true,
    );
  } finally { h.cleanup(); }
});

Deno.test("convert-md-to-pdf: accepts html body (issue #657)", async () => {
  // No CONVERT_API_KEY here — we only need to confirm the handler doesn't 400
  // on an html-only payload. It should reach the API-key check and 500 there.
  const h = createTestHarness({ envVars: { CONVERTAPI_SECRET: "", CONVERT_API_KEY: "" }, routes: [CALLER] });
  try {
    const res = await h.invoke(handler, { html: "<p>hi</p>" }, { headers: AUTH });
    const { status } = await parseResponse(res);
    assertEquals(status, 500);
  } finally { h.cleanup(); }
});

Deno.test("convert-md-to-pdf: returns 500 when CONVERT_API_KEY is missing", async () => {
  const h = createTestHarness({ envVars: { CONVERTAPI_SECRET: "", CONVERT_API_KEY: "" }, routes: [CALLER] });
  try {
    const res = await h.invoke(handler, { markdown: "# Hello" }, { headers: AUTH });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 500);
    assertEquals(body.error.includes("CONVERT_API_KEY") || body.error.includes("not configured"), true);
  } finally { h.cleanup(); }
});
