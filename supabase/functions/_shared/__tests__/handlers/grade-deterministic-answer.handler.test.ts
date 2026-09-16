import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  createTestHarness,
  openaiRoute,
  parseResponse,
  supabaseRoute,
} from "../handler-harness.ts";
import { handler } from "../../../grade-deterministic-answer/handler.ts";

function llmVerdicts(
  verdicts: Array<{ ordinal: number; equivalent: boolean }>,
) {
  return {
    status: "completed",
    output: [{
      type: "message",
      content: [{
        type: "output_text",
        text: JSON.stringify({
          verdicts: verdicts.map((v) => ({
            ordinal: v.ordinal,
            equivalent: v.equivalent,
            reason: "",
          })),
        }),
      }],
    }],
  };
}

const OPTS = { sanitizeOps: false, sanitizeResources: false };
const AUTH_HEADERS = { Authorization: "Bearer student-token" };

// ── CORS preflight ──────────────────────────────────────────────────────

Deno.test("grade-deterministic-answer: OPTIONS returns CORS headers", async () => {
  const h = createTestHarness();
  try {
    const req = new Request("http://localhost/functions/v1/grade-deterministic-answer", {
      method: "OPTIONS",
    });
    const res = await handler(req);
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  } finally {
    h.cleanup();
  }
});

// ── Input validation ────────────────────────────────────────────────────

Deno.test({
  name: "grade-deterministic-answer: 400 when questionId is missing",
  ...OPTS,
  async fn() {
    const h = createTestHarness();
    try {
      const res = await h.invoke(handler, {
        courseId: "c1",
        questionType: "fill_gaps",
        submittedAnswer: ["x"],
      }, { headers: AUTH_HEADERS });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 400);
      assertEquals(body.error, "Missing required parameters");
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "grade-deterministic-answer: 400 when questionType is invalid",
  ...OPTS,
  async fn() {
    const h = createTestHarness();
    try {
      const res = await h.invoke(handler, {
        questionId: "q1",
        courseId: "c1",
        questionType: "mcq",
        submittedAnswer: [],
      }, { headers: AUTH_HEADERS });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 400);
      assertEquals(body.error, "Invalid questionType");
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "grade-deterministic-answer: 401 when no Authorization header is supplied",
  ...OPTS,
  async fn() {
    const h = createTestHarness();
    try {
      const res = await h.invoke(handler, {
        questionId: "q1",
        courseId: "c1",
        questionType: "fill_gaps",
        submittedAnswer: ["x"],
      });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 401);
      assertEquals(body.error, "Missing authorization");
    } finally {
      h.cleanup();
    }
  },
});

// ── Enrollment / authorization ──────────────────────────────────────────

Deno.test({
  name: "grade-deterministic-answer: 403 when the question has no published offerings",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        supabaseRoute("/auth/v1/user", { id: "student-1" }),
        supabaseRoute("/rest/v1/offering_questions", []),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        questionId: "q1",
        courseId: "c1",
        questionType: "fill_gaps",
        submittedAnswer: ["x"],
      }, { headers: AUTH_HEADERS });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 403);
      assertEquals(body.error, "Not authorized for this question");
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "grade-deterministic-answer: 403 when student is not enrolled in any class for this question",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        supabaseRoute("/auth/v1/user", { id: "student-1" }),
        // Published offering exists, but the student is not enrolled in its class.
        supabaseRoute("/rest/v1/offering_questions", [
          { offering_id: "o1", offerings: { id: "o1", class_id: "cl1" } },
        ]),
        supabaseRoute("/rest/v1/class_enrollments", []),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        questionId: "q1",
        courseId: "c1",
        questionType: "fill_gaps",
        submittedAnswer: ["x"],
      }, { headers: AUTH_HEADERS });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 403);
      assertEquals(body.error, "Not authorized for this question");
    } finally {
      h.cleanup();
    }
  },
});

// ── Question type guard ─────────────────────────────────────────────────

Deno.test({
  name: "grade-deterministic-answer: 400 when the question's row type differs from the request",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        supabaseRoute("/auth/v1/user", { id: "student-1" }),
        supabaseRoute("/rest/v1/offering_questions", [
          { offering_id: "o1", offerings: { id: "o1", class_id: "cl1" } },
        ]),
        supabaseRoute("/rest/v1/class_enrollments", [{ class_id: "cl1" }]),
        // Row says ordering, request claims fill_gaps → reject.
        supabaseRoute("/rest/v1/questions", {
          type: "ordering",
          payload: { prompt: "p", items: ["a", "b"] },
          answer_key: {},
          course_id: "c1",
        }),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        questionId: "q1",
        courseId: "c1",
        questionType: "fill_gaps",
        submittedAnswer: ["x"],
      }, { headers: AUTH_HEADERS });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 400);
      assertEquals(body.error, "Question type mismatch");
    } finally {
      h.cleanup();
    }
  },
});

// ── Idempotency / one-shot guard ────────────────────────────────────────

Deno.test({
  name: "grade-deterministic-answer: 409 when student has already submitted",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        supabaseRoute("/auth/v1/user", { id: "student-1" }),
        supabaseRoute("/rest/v1/offering_questions", [
          { offering_id: "o1", offerings: { id: "o1", class_id: "cl1" } },
        ]),
        supabaseRoute("/rest/v1/class_enrollments", [{ class_id: "cl1" }]),
        supabaseRoute("/rest/v1/questions", {
          type: "fill_gaps",
          payload: { stem: "{{1}}" },
          answer_key: { gaps: [{ ordinal: 1, acceptable: ["x"] }] },
          course_id: "c1",
        }),
        // Existing grade row → triggers the 409 short-circuit.
        supabaseRoute("/rest/v1/open_question_grades", { id: "g1" }),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        questionId: "q1",
        courseId: "c1",
        questionType: "fill_gaps",
        submittedAnswer: ["x"],
      }, { headers: AUTH_HEADERS });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 409);
      assertEquals(body.error, "already_submitted");
    } finally {
      h.cleanup();
    }
  },
});

// ── Happy path — fill_gaps ──────────────────────────────────────────────

Deno.test({
  name: "grade-deterministic-answer: grades fill_gaps server-side and ignores client-supplied grades",
  ...OPTS,
  async fn() {
    // Track every write so we can assert the server-computed grade landed
    // in the row and the client never gets to dictate it.
    const writes: { path: string; body?: string }[] = [];
    const h = createTestHarness({
      routes: [
        supabaseRoute("/auth/v1/user", { id: "student-1" }),
        supabaseRoute("/rest/v1/offering_questions", [
          { offering_id: "o1", offerings: { id: "o1", class_id: "cl1" } },
        ]),
        supabaseRoute("/rest/v1/class_enrollments", [{ class_id: "cl1" }]),
        supabaseRoute("/rest/v1/questions", {
          type: "fill_gaps",
          payload: { stem: "{{1}} and {{2}}" },
          answer_key: {
            gaps: [
              { ordinal: 1, acceptable: ["alpha"] },
              { ordinal: 2, acceptable: ["beta"] },
            ],
          },
          course_id: "c1",
        }),
        // No existing grade.
        supabaseRoute("/rest/v1/open_question_grades", null, { method: "GET" }),
        {
          match: (url, init) =>
            url.includes("/rest/v1/open_question_grades") &&
            (init?.method ?? "GET").toUpperCase() === "POST",
          respond: (_url, init) => {
            writes.push({
              path: "open_question_grades",
              body: typeof init?.body === "string" ? init.body : undefined,
            });
            return new Response(JSON.stringify({}), {
              status: 201,
              headers: { "Content-Type": "application/json" },
            });
          },
        },
        {
          match: (url) => url.includes("/rest/v1/chat_sessions"),
          respond: (_url, init) => {
            writes.push({
              path: "chat_sessions",
              body: typeof init?.body === "string" ? init.body : undefined,
            });
            return new Response(JSON.stringify({}), {
              status: 201,
              headers: { "Content-Type": "application/json" },
            });
          },
        },
        // The LLM second-pass judges the "wrong" gap; here it confirms not
        // equivalent so the grade stays at 50.
        openaiRoute(
          "/v1/responses",
          llmVerdicts([{ ordinal: 2, equivalent: false }]),
          { method: "POST" },
        ),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        questionId: "q1",
        courseId: "c1",
        questionType: "fill_gaps",
        submittedAnswer: ["alpha", "wrong"],
      }, { headers: AUTH_HEADERS });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      assertEquals(body.success, true);
      // 1 of 2 gaps correct → 50.
      assertEquals(body.grade, 50);
      assertEquals(body.gapResults.perGap, [true, false]);
      assertEquals(body.gapResults.allCorrect, false);

      // The grade row body must carry the server-computed grade (50), not
      // whatever the client supplied. The harness POSTs the full row JSON.
      const gradeWrite = writes.find((w) => w.path === "open_question_grades");
      const gradeBody = JSON.parse(gradeWrite!.body!);
      assertEquals(gradeBody.grade, 50);
      assertEquals(gradeBody.user_id, "student-1");
      assertEquals(gradeBody.open_question_id, "q1");

      // Progress flipped to completed.
      const progressWrite = writes.find((w) => w.path === "chat_sessions");
      const progressBody = JSON.parse(progressWrite!.body!);
      assertEquals(progressBody.status, "completed");
    } finally {
      h.cleanup();
    }
  },
});

// ── Happy path — ordering ───────────────────────────────────────────────

Deno.test({
  name: "grade-deterministic-answer: grades ordering server-side against the canonical order",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        supabaseRoute("/auth/v1/user", { id: "student-1" }),
        supabaseRoute("/rest/v1/offering_questions", [
          { offering_id: "o1", offerings: { id: "o1", class_id: "cl1" } },
        ]),
        supabaseRoute("/rest/v1/class_enrollments", [{ class_id: "cl1" }]),
        supabaseRoute("/rest/v1/questions", {
          type: "ordering",
          payload: { prompt: "p", items: ["one", "two", "three"] },
          answer_key: {},
          course_id: "c1",
        }),
        supabaseRoute("/rest/v1/open_question_grades", null, { method: "GET" }),
        supabaseRoute("/rest/v1/open_question_grades", {}, { method: "POST" }),
        supabaseRoute("/rest/v1/chat_sessions", {}),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        questionId: "q1",
        courseId: "c1",
        questionType: "ordering",
        // Student's order is exactly canonical → 100, all correct.
        submittedAnswer: ["one", "two", "three"],
      }, { headers: AUTH_HEADERS });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      assertEquals(body.grade, 100);
      assertEquals(body.gapResults.allCorrect, true);
      assertEquals(body.gapResults.perPosition, [true, true, true]);
    } finally {
      h.cleanup();
    }
  },
});

// ── Happy path — classification ─────────────────────────────────────────

Deno.test({
  name: "grade-deterministic-answer: grades classification server-side from answer_key.assignments",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        supabaseRoute("/auth/v1/user", { id: "student-1" }),
        supabaseRoute("/rest/v1/offering_questions", [
          { offering_id: "o1", offerings: { id: "o1", class_id: "cl1" } },
        ]),
        supabaseRoute("/rest/v1/class_enrollments", [{ class_id: "cl1" }]),
        supabaseRoute("/rest/v1/questions", {
          type: "classification",
          payload: {
            prompt: "p",
            categories: [{ id: "cat-a", label: "A" }, { id: "cat-b", label: "B" }],
            items: [{ id: "it-1", text: "x" }, { id: "it-2", text: "y" }],
          },
          answer_key: { assignments: { "it-1": "cat-a", "it-2": "cat-b" } },
          course_id: "c1",
        }),
        supabaseRoute("/rest/v1/open_question_grades", null, { method: "GET" }),
        supabaseRoute("/rest/v1/open_question_grades", {}, { method: "POST" }),
        supabaseRoute("/rest/v1/chat_sessions", {}),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        questionId: "q1",
        courseId: "c1",
        questionType: "classification",
        // One right, one wrong → 50.
        submittedAnswer: { "it-1": "cat-a", "it-2": "cat-a" },
        hintsUsed: 1,
      }, { headers: AUTH_HEADERS });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      assertEquals(body.grade, 50);
      assertEquals(body.gapResults.perItem, { "it-1": true, "it-2": false });
      assertEquals(body.gapResults.allCorrect, false);
      assertEquals(body.gapResults.hintsUsed, 1);
    } finally {
      h.cleanup();
    }
  },
});

// ── fill_gaps — LLM second pass ─────────────────────────────────────────

Deno.test({
  name:
    "grade-deterministic-answer: fill_gaps — LLM upgrades a synonym/typo to correct",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        supabaseRoute("/auth/v1/user", { id: "student-1" }),
        supabaseRoute("/rest/v1/offering_questions", [
          { offering_id: "o1", offerings: { id: "o1", class_id: "cl1" } },
        ]),
        supabaseRoute("/rest/v1/class_enrollments", [{ class_id: "cl1" }]),
        supabaseRoute("/rest/v1/questions", {
          type: "fill_gaps",
          payload: { stem: "{{1}} and {{2}}" },
          answer_key: {
            gaps: [
              { ordinal: 1, acceptable: ["alpha"] },
              { ordinal: 2, acceptable: ["beta"] },
            ],
          },
          course_id: "c1",
        }),
        supabaseRoute("/rest/v1/open_question_grades", null, { method: "GET" }),
        supabaseRoute("/rest/v1/open_question_grades", {}, { method: "POST" }),
        supabaseRoute("/rest/v1/chat_sessions", {}),
        // Exact match misses gap 2 ("beta-synonym"); the LLM accepts it.
        openaiRoute(
          "/v1/responses",
          llmVerdicts([{ ordinal: 2, equivalent: true }]),
          { method: "POST" },
        ),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        questionId: "q1",
        courseId: "c1",
        questionType: "fill_gaps",
        submittedAnswer: ["alpha", "beta-synonym"],
      }, { headers: AUTH_HEADERS });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      assertEquals(body.grade, 100);
      assertEquals(body.gapResults.perGap, [true, true]);
      assertEquals(body.gapResults.allCorrect, true);
      assertEquals(body.gapResults.llmCallMade, true);
      assertEquals(body.gapResults.llmFailed, false);
      // The LLM was called exactly once (one batched call for non-matching gaps).
      const llmCalls = h.fetchLog.filter(
        (e) => e.url.includes("api.openai.com") && e.method === "POST",
      );
      assertEquals(llmCalls.length, 1);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name:
    "grade-deterministic-answer: fill_gaps — no LLM call when everything exact-matches",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        supabaseRoute("/auth/v1/user", { id: "student-1" }),
        supabaseRoute("/rest/v1/offering_questions", [
          { offering_id: "o1", offerings: { id: "o1", class_id: "cl1" } },
        ]),
        supabaseRoute("/rest/v1/class_enrollments", [{ class_id: "cl1" }]),
        supabaseRoute("/rest/v1/questions", {
          type: "fill_gaps",
          payload: { stem: "{{1}} and {{2}}" },
          answer_key: {
            gaps: [
              { ordinal: 1, acceptable: ["alpha"] },
              { ordinal: 2, acceptable: ["beta"] },
            ],
          },
          course_id: "c1",
        }),
        supabaseRoute("/rest/v1/open_question_grades", null, { method: "GET" }),
        supabaseRoute("/rest/v1/open_question_grades", {}, { method: "POST" }),
        supabaseRoute("/rest/v1/chat_sessions", {}),
        // If anything calls OpenAI, it will hit the harness 404 fallback and
        // we'd see it in fetchLog — the assertion below makes that fail.
      ],
    });
    try {
      const res = await h.invoke(handler, {
        questionId: "q1",
        courseId: "c1",
        questionType: "fill_gaps",
        submittedAnswer: ["alpha", "beta"],
      }, { headers: AUTH_HEADERS });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      assertEquals(body.grade, 100);
      assertEquals(body.gapResults.perGap, [true, true]);
      assertEquals(body.gapResults.allCorrect, true);
      assertEquals(body.gapResults.llmCallMade, false);
      assertEquals(body.gapResults.llmFailed, false);
      const llmCalls = h.fetchLog.filter(
        (e) => e.url.includes("api.openai.com"),
      );
      assertEquals(llmCalls.length, 0);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name:
    "grade-deterministic-answer: fill_gaps — LLM failure falls back to exact-match grade",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        supabaseRoute("/auth/v1/user", { id: "student-1" }),
        supabaseRoute("/rest/v1/offering_questions", [
          { offering_id: "o1", offerings: { id: "o1", class_id: "cl1" } },
        ]),
        supabaseRoute("/rest/v1/class_enrollments", [{ class_id: "cl1" }]),
        supabaseRoute("/rest/v1/questions", {
          type: "fill_gaps",
          payload: { stem: "{{1}} and {{2}}" },
          answer_key: {
            gaps: [
              { ordinal: 1, acceptable: ["alpha"] },
              { ordinal: 2, acceptable: ["beta"] },
            ],
          },
          course_id: "c1",
        }),
        supabaseRoute("/rest/v1/open_question_grades", null, { method: "GET" }),
        supabaseRoute("/rest/v1/open_question_grades", {}, { method: "POST" }),
        supabaseRoute("/rest/v1/chat_sessions", {}),
        // OpenAI 500 — judge must swallow it and return the exact result.
        openaiRoute("/v1/responses", { error: "boom" }, {
          method: "POST",
          status: 500,
        }),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        questionId: "q1",
        courseId: "c1",
        questionType: "fill_gaps",
        submittedAnswer: ["alpha", "wrong"],
      }, { headers: AUTH_HEADERS });
      const { status, body } = await parseResponse(res);
      // Submission still succeeds — the deterministic grade stands.
      assertEquals(status, 200);
      assertEquals(body.grade, 50);
      assertEquals(body.gapResults.perGap, [true, false]);
      assertEquals(body.gapResults.allCorrect, false);
      assertEquals(body.gapResults.llmCallMade, true);
      assertEquals(body.gapResults.llmFailed, true);
    } finally {
      h.cleanup();
    }
  },
});
