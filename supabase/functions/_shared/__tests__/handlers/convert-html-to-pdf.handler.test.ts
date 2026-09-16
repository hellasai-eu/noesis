import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  convertApiRoute,
  createTestHarness,
  parseResponse,
} from "../handler-harness.ts";
import type { MockRoute } from "../handler-harness.ts";
import { handler } from "../../../convert-html-to-pdf/handler.ts";

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

Deno.test("convert-html-to-pdf: OPTIONS returns CORS headers", async () => {
  const h = createTestHarness({ routes: [
      CALLER,CALLER] });
  try {
    const req = new Request(
      "http://localhost/functions/v1/convert-html-to-pdf",
      { method: "OPTIONS" },
    );
    const res = await handler(req);
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  } finally {
    h.cleanup();
  }
});

Deno.test("convert-html-to-pdf: returns 400 when html is missing", async () => {
  const h = createTestHarness({ routes: [
      CALLER,CALLER] });
  try {
    const res = await h.invoke(handler, {}, { headers: AUTH });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 400);
    assertEquals(body.error.toLowerCase().includes("html"), true);
  } finally {
    h.cleanup();
  }
});

Deno.test("convert-html-to-pdf: returns 400 when html is empty", async () => {
  const h = createTestHarness({ routes: [
      CALLER,CALLER] });
  try {
    const res = await h.invoke(handler, { html: "" }, { headers: AUTH });
    const { status } = await parseResponse(res);
    assertEquals(status, 400);
  } finally {
    h.cleanup();
  }
});

Deno.test(
  "convert-html-to-pdf: returns 500 when CONVERT_API_KEY is missing",
  async () => {
    const h = createTestHarness({
      routes: [CALLER],
      envVars: { CONVERTAPI_SECRET: "", CONVERT_API_KEY: "" },
    });
    try {
      const res = await h.invoke(handler, { html: "<p>hi</p>" }, { headers: AUTH });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 500);
      assertEquals(
        body.error.includes("CONVERT_API_KEY") ||
          body.error.includes("not configured"),
        true,
      );
    } finally {
      h.cleanup();
    }
  },
);

Deno.test(
  "convert-html-to-pdf: happy path wraps input in print stylesheet with .page-break rule",
  async () => {
    const fakePdf = btoa("FAKE_PDF_BYTES");
    const h = createTestHarness({
      envVars: { CONVERT_API_KEY: "test-key" },
      routes: [
        CALLER,
        convertApiRoute({
          Files: [{ FileName: "test.pdf", FileData: fakePdf }],
        }),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        html: '<p>Before</p><div class="page-break"></div><p>After</p>',
        filename: "midterm",
      }, { headers: AUTH });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      assertEquals(body.pdfBase64, fakePdf);

      // The body sent to ConvertAPI is base64-encoded; decode and verify
      // the print stylesheet was applied so page breaks survive in the PDF.
      const convertCall = h.fetchLog.find((entry) =>
        entry.url.includes("convertapi.com")
      );
      if (!convertCall || !convertCall.body) {
        throw new Error("Expected a ConvertAPI call to be logged");
      }
      const payload = JSON.parse(convertCall.body);
      const fileParam = payload.Parameters.find(
        (p: { Name: string }) => p.Name === "File",
      );
      const decoded = atob(fileParam.FileValue.Data);
      assertEquals(decoded.includes("page-break-after: always"), true);
      assertEquals(decoded.includes("@page"), true);
      assertEquals(decoded.includes('<div class="page-break"></div>'), true);
    } finally {
      h.cleanup();
    }
  },
);

Deno.test(
  "convert-html-to-pdf: surfaces ConvertAPI failures as 500",
  async () => {
    const h = createTestHarness({
      envVars: { CONVERT_API_KEY: "test-key" },
      routes: [
        CALLER,
        convertApiRoute({ error: "boom" }, { status: 502 }),
      ],
    });
    try {
      const res = await h.invoke(handler, { html: "<p>hi</p>" }, { headers: AUTH });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 500);
      assertEquals(body.error.includes("ConvertAPI"), true);
    } finally {
      h.cleanup();
    }
  },
);
