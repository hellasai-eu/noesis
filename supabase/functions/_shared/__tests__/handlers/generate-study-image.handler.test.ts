import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { createTestHarness, parseResponse } from "../handler-harness.ts";
import type { MockRoute } from "../handler-harness.ts";
import { handler } from "../../../generate-study-image/handler.ts";

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

Deno.test("generate-study-image: OPTIONS returns CORS headers", async () => {
  const h = createTestHarness({ routes: [
      CALLER,CALLER] });
  try {
    const req = new Request("http://localhost/functions/v1/generate-study-image", { method: "OPTIONS" });
    const res = await handler(req);
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  } finally { h.cleanup(); }
});

Deno.test("generate-study-image: returns error when prompt is missing", async () => {
  const h = createTestHarness({ routes: [
      CALLER,CALLER] });
  try {
    const res = await h.invoke(handler, {}, { headers: AUTH });
    const { status, body } = await parseResponse(res);
    assertEquals(status >= 400, true);
    assertEquals(body.error.includes("prompt") || body.error.includes("required"), true);
  } finally { h.cleanup(); }
});

Deno.test("generate-study-image: returns 500 when OPENAI_API_KEY is missing", async () => {
  const h = createTestHarness({ envVars: { OPENAI_API_KEY: "" }, routes: [CALLER] });
  try {
    const res = await h.invoke(handler, { prompt: "draw a circle" }, { headers: AUTH });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 500);
  } finally { h.cleanup(); }
});
