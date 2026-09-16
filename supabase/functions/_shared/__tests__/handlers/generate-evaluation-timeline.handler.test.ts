import { assertEquals, assertExists } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { createTestHarness, openaiRoute, parseResponse } from "../handler-harness.ts";
import type { MockRoute } from "../handler-harness.ts";
import { handler } from "../../../generate-evaluation-timeline/handler.ts";

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

Deno.test("generate-evaluation-timeline: OPTIONS returns CORS headers", async () => {
  const h = createTestHarness({ routes: [
      CALLER,CALLER] });
  try {
    const req = new Request("http://localhost/functions/v1/generate-evaluation-timeline", { method: "OPTIONS" });
    const res = await handler(req);
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  } finally { h.cleanup(); }
});

Deno.test("generate-evaluation-timeline: returns error when evaluations is missing", async () => {
  const h = createTestHarness({ routes: [
      CALLER,CALLER] });
  try {
    const res = await h.invoke(handler, {}, { headers: AUTH });
    const { status } = await parseResponse(res);
    assertEquals(status >= 400, true);
  } finally { h.cleanup(); }
});

// Structured-output shape `callOpenAIStructured` parses. The handler used the
// raw OpenAI SDK against a hosted saved prompt until the template moved
// in-repo, so this mock changed from `{ output_text }` to the standard one
// every other handler test uses.
const AI_RESPONSE = {
  output: [{
    type: "message",
    content: [{
      type: "output_text",
      text: JSON.stringify({
        analysis: {
          summary: "Steady progress across the term.",
          overallTrend: "improving",
          competencyInsights: [],
          strengths: [],
          areasForImprovement: [],
          recommendations: [],
        },
      }),
    }],
  }],
};

function evaluation(id: string, generatedAt: string, overallAssessment = "") {
  return {
    id,
    strengths: [],
    weaknesses: [],
    recommendations: [],
    overallAssessment,
    generatedAt,
    instructorFeedback: null,
    isManual: false,
  };
}

/** The user-message text actually sent to the model. */
function outboundPromptText(fetchLog: Array<{ url: string; method: string; body?: string }>): string {
  const call = fetchLog.find((e) => e.url.includes("api.openai.com") && e.method === "POST");
  assertExists(call);
  return call!.body!;
}

Deno.test("generate-evaluation-timeline: PII guardrail — does not pass studentName to OpenAI (issue #557)", async () => {
  const h = createTestHarness({ routes: [
      CALLER,openaiRoute("/v1/responses", AI_RESPONSE, { method: "POST" })],
  });
  try {
    const SENTINEL = "Maria Karagianni-Leakedname";
    const res = await h.invoke(handler, {
      evaluations: [evaluation("e1", "2026-01-01"), evaluation("e2", "2026-02-01")],
      studentName: SENTINEL,
      language: "en",
    }, { headers: AUTH });
    assertEquals(res.status, 200);

    const body = outboundPromptText(h.fetchLog);
    assertEquals(body.includes(SENTINEL), false);
    // The handler must not have grown a student-identity field of any spelling
    // while moving off the saved prompt.
    const reqBody = JSON.parse(body);
    const serialised = JSON.stringify(reqBody);
    for (const key of ["studentName", "student_name", "full_name"]) {
      assertEquals(serialised.includes(key), false);
    }
  } finally {
    h.cleanup();
  }
});

Deno.test("generate-evaluation-timeline: sends the history most-recent-first, matching the prompt", async () => {
  const h = createTestHarness({ routes: [
      CALLER,openaiRoute("/v1/responses", AI_RESPONSE, { method: "POST" })],
  });
  try {
    // Deliberately supplied oldest-first, to prove the handler reorders.
    const res = await h.invoke(handler, {
      evaluations: [
        evaluation("e1", "2026-01-01", "OLDEST-ASSESSMENT"),
        evaluation("e2", "2026-02-01", "MIDDLE-ASSESSMENT"),
        evaluation("e3", "2026-03-01", "NEWEST-ASSESSMENT"),
      ],
      language: "en",
    }, { headers: AUTH });
    assertEquals(res.status, 200);

    const body = outboundPromptText(h.fetchLog);
    const newest = body.indexOf("NEWEST-ASSESSMENT");
    const middle = body.indexOf("MIDDLE-ASSESSMENT");
    const oldest = body.indexOf("OLDEST-ASSESSMENT");
    assertEquals(newest > -1 && middle > -1 && oldest > -1, true);
    // The user prompt states "most recent first" in as many words; if the
    // handler sorted the other way the model would read the trend backwards.
    assertEquals(newest < middle, true);
    assertEquals(middle < oldest, true);
  } finally {
    h.cleanup();
  }
});

Deno.test("generate-evaluation-timeline: uses the in-repo prompt, not a hosted saved prompt", async () => {
  const h = createTestHarness({ routes: [
      CALLER,openaiRoute("/v1/responses", AI_RESPONSE, { method: "POST" })],
  });
  try {
    const res = await h.invoke(handler, {
      evaluations: [evaluation("e1", "2026-01-01"), evaluation("e2", "2026-02-01")],
      language: "en",
    }, { headers: AUTH });
    assertEquals(res.status, 200);

    const reqBody = JSON.parse(outboundPromptText(h.fetchLog));
    // A saved-prompt call carries `prompt: { id, version }` and no model of its
    // own. Naming the model here is the point: it is reviewable in this repo.
    assertEquals(reqBody?.prompt?.id, undefined);
    assertEquals(typeof reqBody?.model, "string");
    assertEquals(String(reqBody.model).length > 0, true);
  } finally {
    h.cleanup();
  }
});
