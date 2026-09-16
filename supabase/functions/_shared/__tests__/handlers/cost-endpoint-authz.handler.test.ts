import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  createTestHarness,
  FetchLogEntry,
  MockRoute,
  parseResponse,
} from "../handler-harness.ts";
import { resetRateLimits } from "../../rate-limit.ts";
import { handler as convertHtml } from "../../../convert-html-to-pdf/handler.ts";
import { handler as convertMd } from "../../../convert-md-to-pdf/handler.ts";
import { handler as studyImage } from "../../../generate-study-image/handler.ts";
import { handler as moderateImage } from "../../../moderate-study-image/handler.ts";
import { handler as timeline } from "../../../generate-evaluation-timeline/handler.ts";
import { handler as vectorStoreFile } from "../../../check-vector-store-file/handler.ts";

// ── Gap C: cost, not data (#1137) ──────────────────────────────────────
// None of these reaches tenant data. What they had in common was spending the
// platform's OpenAI/ConvertAPI budget for anyone who knew the URL.
//
// Authentication is the whole gate here, deliberately: there is no tenant
// resource in the request to authorize a caller against — someone converting
// their own HTML to PDF is not acting on a course. The stronger check has
// nothing to bind to, so the weaker one is the right one rather than a
// shortcut.
//
// The gate runs BEFORE the body is parsed, let alone validated, so an anonymous
// caller neither learns which fields the endpoint wants nor gets any parsing
// work done on their behalf.

const OPTS = { sanitizeOps: false, sanitizeResources: false };
const AUTH = { Authorization: "Bearer test-token" };

function authUserRoute(user: unknown, status = 200): MockRoute {
  return {
    match: (url) => url.includes("/auth/v1/user"),
    respond: () =>
      new Response(JSON.stringify(user), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  };
}

const CALLER = authUserRoute({ id: "user-1", email: "student@test.local" });

/** Did the request reach anything that costs money? */
function spent(fetchLog: FetchLogEntry[]): boolean {
  return fetchLog.some((c) =>
    c.url.includes("api.openai.com") || c.url.includes("convertapi.com")
  );
}

const CASES: Array<{
  name: string;
  handler: (req: Request) => Promise<Response>;
  body: Record<string, unknown>;
}> = [
  { name: "convert-html-to-pdf", handler: convertHtml, body: { html: "<p>hi</p>" } },
  { name: "convert-md-to-pdf", handler: convertMd, body: { markdown: "# hi" } },
  { name: "generate-study-image", handler: studyImage, body: { prompt: "a cell" } },
  { name: "moderate-study-image", handler: moderateImage, body: { fileUrl: "https://x/y.png" } },
  {
    name: "generate-evaluation-timeline",
    handler: timeline,
    body: { evaluations: [], language: "en" },
  },
  {
    name: "check-vector-store-file",
    handler: vectorStoreFile,
    body: { openaiFileId: "file-1", vectorStoreId: "vs-1" },
  },
];

for (const c of CASES) {
  Deno.test({
    name: `${c.name}: 401 without an Authorization header, and spends nothing`,
    ...OPTS,
    async fn() {
      const h = createTestHarness({ routes: [CALLER] });
      try {
        const res = await h.invoke(c.handler, c.body);
        const { status, body } = await parseResponse(res);
        assertEquals(status, 401);
        assertEquals(body.error, "Unauthorized");
        assertEquals(spent(h.fetchLog), false);
      } finally {
        h.cleanup();
      }
    },
  });

  Deno.test({
    name: `${c.name}: 401 when the token does not resolve`,
    ...OPTS,
    async fn() {
      const h = createTestHarness({ routes: [authUserRoute({ error: "bad jwt" }, 401)] });
      try {
        const res = await h.invoke(c.handler, c.body, { headers: AUTH });
        const { status } = await parseResponse(res);
        assertEquals(status, 401);
        assertEquals(spent(h.fetchLog), false);
      } finally {
        h.cleanup();
      }
    },
  });

  Deno.test({
    name: `${c.name}: the gate answers before input validation`,
    ...OPTS,
    async fn() {
      // An empty body would be a 400 for a signed-in caller. Anonymous, it must
      // still be 401 — otherwise the endpoint teaches the internet its shape.
      const h = createTestHarness({ routes: [CALLER] });
      try {
        const res = await h.invoke(c.handler, {});
        const { status } = await parseResponse(res);
        assertEquals(status, 401);
      } finally {
        h.cleanup();
      }
    },
  });

  Deno.test({
    name: `${c.name}: the gate answers before the body is even parsed`,
    ...OPTS,
    async fn() {
      // Not the same claim as the test above. Field validation running after
      // the gate is one thing; `req.json()` itself running first is another —
      // it turns a malformed anonymous request into a parser-derived 500
      // instead of the uniform 401, and does the work of parsing for someone
      // who was never allowed to ask.
      const h = createTestHarness({ routes: [CALLER] });
      try {
        const req = new Request("http://localhost/functions/v1/test", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{ this is not json",
        });
        const res = await c.handler(req);
        const { status, body } = await parseResponse(res);
        assertEquals(status, 401);
        assertEquals(body.error, "Unauthorized");
        assertEquals(spent(h.fetchLog), false);
      } finally {
        h.cleanup();
      }
    },
  });
}

// ── The expensive one gets a ceiling as well as a gate ─────────────────

Deno.test({
  name: "generate-study-image: a signed-in caller is rate limited per user",
  ...OPTS,
  async fn() {
    // Authentication stops the internet spending the platform's money. It does
    // not stop one signed-in student, and this is the priciest call here.
    resetRateLimits();
    const h = createTestHarness({
      routes: [
        CALLER,
        {
          match: (url) => url.includes("api.openai.com"),
          respond: () =>
            new Response(JSON.stringify({ data: [{ b64_json: "AAAA" }] }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
        },
      ],
    });
    try {
      let limited = 0;
      for (let i = 0; i < 25; i++) {
        const res = await h.invoke(studyImage, { prompt: "a cell" }, { headers: AUTH });
        if (res.status === 429) limited++;
        else await res.body?.cancel();
      }
      // 20 allowed, the rest refused.
      assertEquals(limited, 5);
    } finally {
      resetRateLimits();
      h.cleanup();
    }
  },
});

Deno.test({
  name: "generate-study-image: the limit is per caller, not global",
  ...OPTS,
  async fn() {
    // One student exhausting their budget must not lock out the next.
    resetRateLimits();
    let userId = "user-a";
    const h = createTestHarness({
      routes: [
        {
          match: (url) => url.includes("/auth/v1/user"),
          respond: () =>
            new Response(JSON.stringify({ id: userId, email: "s@test.local" }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
        },
        {
          match: (url) => url.includes("api.openai.com"),
          respond: () =>
            new Response(JSON.stringify({ data: [{ b64_json: "AAAA" }] }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
        },
      ],
    });
    try {
      for (let i = 0; i < 21; i++) {
        const res = await h.invoke(studyImage, { prompt: "a cell" }, { headers: AUTH });
        await res.body?.cancel();
      }

      userId = "user-b";
      const res = await h.invoke(studyImage, { prompt: "a cell" }, { headers: AUTH });
      assertEquals(res.status === 429, false);
      await res.body?.cancel();
    } finally {
      resetRateLimits();
      h.cleanup();
    }
  },
});
