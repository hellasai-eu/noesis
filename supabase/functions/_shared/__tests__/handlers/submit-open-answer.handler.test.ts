import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  createTestHarness,
  FetchLogEntry,
  openaiRoute,
  parseResponse,
  supabaseRoute,
} from "../handler-harness.ts";
import { handler } from "../../../submit-open-answer/handler.ts";

const OPTS = { sanitizeOps: false, sanitizeResources: false };
const AUTH_HEADERS = { Authorization: "Bearer student-token" };

// The routes every gated happy-ish path shares: auth, enrollment, the
// single-mode question, and no prior submission.
function baseRoutes() {
  return [
    supabaseRoute("/auth/v1/user", { id: "student-1" }),
    supabaseRoute("/rest/v1/offering_questions", [
      { offering_id: "o1", offerings: { id: "o1", class_id: "cl1" } },
    ]),
    supabaseRoute("/rest/v1/class_enrollments", [{ class_id: "cl1" }]),
    supabaseRoute("/rest/v1/questions", {
      question: "What is X?",
      answer_key: { model_answer: "the answer", rubric: null, explanation: null },
      payload: { answering_mode: "single" },
      course_id: "c1",
    }),
  ];
}

function gradeInsert(fetchLog: FetchLogEntry[]): FetchLogEntry | undefined {
  return fetchLog.find((e) =>
    e.method === "POST" && e.url.includes("/rest/v1/open_question_grades")
  );
}

// ── CORS preflight ──────────────────────────────────────────────────────

Deno.test("submit-open-answer: OPTIONS returns CORS headers", async () => {
  const h = createTestHarness();
  try {
    const req = new Request("http://localhost/functions/v1/submit-open-answer", {
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
  name: "submit-open-answer: 400 when questionId missing",
  ...OPTS,
  async fn() {
    const h = createTestHarness();
    try {
      const res = await h.invoke(handler, { courseId: "c1", studentAnswer: "answer" }, {
        headers: AUTH_HEADERS,
      });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 400);
      assertEquals(body.error, "Missing required parameters");
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "submit-open-answer: 400 when studentAnswer is empty after trim",
  ...OPTS,
  async fn() {
    const h = createTestHarness();
    try {
      const res = await h.invoke(handler, {
        questionId: "q1",
        courseId: "c1",
        studentAnswer: "   ",
      }, { headers: AUTH_HEADERS });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 400);
      assertEquals(body.error, "Empty answer");
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "submit-open-answer: 401 when no Authorization header is supplied",
  ...OPTS,
  async fn() {
    const h = createTestHarness();
    try {
      const res = await h.invoke(handler, {
        questionId: "q1",
        courseId: "c1",
        studentAnswer: "an answer",
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
  name: "submit-open-answer: 403 when the question has no published offerings",
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
        studentAnswer: "an answer",
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
  name: "submit-open-answer: 403 when student is not enrolled in any class for this question",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        supabaseRoute("/auth/v1/user", { id: "student-1" }),
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
        studentAnswer: "an answer",
      }, { headers: AUTH_HEADERS });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 403);
      assertEquals(body.error, "Not authorized for this question");
    } finally {
      h.cleanup();
    }
  },
});

// ── Wrong-mode guard ────────────────────────────────────────────────────

Deno.test({
  name: "submit-open-answer: 400 when the question is in interactive mode",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        supabaseRoute("/auth/v1/user", { id: "student-1" }),
        supabaseRoute("/rest/v1/offering_questions", [
          { offering_id: "o1", offerings: { id: "o1", class_id: "cl1" } },
        ]),
        supabaseRoute("/rest/v1/class_enrollments", [{ class_id: "cl1" }]),
        // Question fetched with empty payload (interactive default).
        supabaseRoute("/rest/v1/questions", {
          question: "What is X?",
          answer_key: { model_answer: "the answer", rubric: null, explanation: null },
          payload: {},
          course_id: "c1",
        }),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        questionId: "q1",
        courseId: "c1",
        studentAnswer: "an answer",
      }, { headers: AUTH_HEADERS });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 400);
      assertEquals(body.error, "wrong_mode");
    } finally {
      h.cleanup();
    }
  },
});

// ── Idempotency / one-shot guard ────────────────────────────────────────

Deno.test({
  name: "submit-open-answer: 409 when student has already submitted",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        ...baseRoutes(),
        // The unique (question, user) index rejects the second insert.
        {
          match: (url: string, init?: RequestInit) =>
            url.includes("/rest/v1/open_question_grades") &&
            (init?.method ?? "GET") === "POST",
          respond: () =>
            new Response(
              JSON.stringify({ code: "23505", message: "duplicate key value" }),
              { status: 409, headers: { "Content-Type": "application/json" } },
            ),
        },
      ],
    });
    try {
      const res = await h.invoke(handler, {
        questionId: "q1",
        courseId: "c1",
        studentAnswer: "an answer",
      }, { headers: AUTH_HEADERS });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 409);
      assertEquals(body.error, "already_submitted");
    } finally {
      h.cleanup();
    }
  },
});

// ── The submission is recorded UNGRADED, and the AI never grades ────────

Deno.test({
  name:
    "submit-open-answer: records the answer with no grade, completes the session, stores a draft with no grade",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        ...baseRoutes(),
        supabaseRoute("/rest/v1/open_question_grades", {}),
        supabaseRoute("/rest/v1/chat_sessions", {}),
        // Language lookup for the draft prompt.
        supabaseRoute("/rest/v1/courses", { institution_id: "inst-1", language: null }),
        supabaseRoute("/rest/v1/institutions", {
          ai_features_disabled: [],
          default_language: null,
        }),
        openaiRoute("/v1/responses", {
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({
                    feedback: "Solid start; expand the second part.",
                    strengths: ["clear", "structured"],
                    areas_for_improvement: ["depth", "examples"],
                  }),
                },
              ],
            },
          ],
        }),
        supabaseRoute("/rest/v1/open_answer_ai_drafts", {}),
        supabaseRoute("/rest/v1/ai_usage_logs", {}),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        questionId: "q1",
        courseId: "c1",
        studentAnswer: "an answer",
      }, { headers: AUTH_HEADERS });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      assertEquals(body.success, true);
      assertEquals(body.pendingReview, true);
      // The response must not hand the student a verdict of any kind.
      assertEquals(body.grade, undefined);
      assertEquals(body.feedback, undefined);

      // The stored submission row carries no grade and no feedback.
      const insert = gradeInsert(h.fetchLog);
      assertEquals(insert !== undefined, true, "expected an open_question_grades insert");
      const inserted = JSON.parse(insert!.body!);
      assertEquals(inserted.submitted_answer, "an answer");
      assertEquals("grade" in inserted, false, "the recorder must never write a grade");
      assertEquals("feedback" in inserted, false, "the recorder must never write feedback");

      // Completion signal for the student UI.
      assertEquals(
        h.fetchLog.some((e) =>
          e.method === "POST" && e.url.includes("/rest/v1/chat_sessions") &&
          (e.body ?? "").includes('"completed"')
        ),
        true,
        "expected the chat_sessions completion upsert",
      );

      // The draft went to the manager-only table, and carries no number.
      const draftInsert = h.fetchLog.find((e) =>
        e.method === "POST" && e.url.includes("/rest/v1/open_answer_ai_drafts")
      );
      assertEquals(draftInsert !== undefined, true, "expected a draft insert");
      const draft = JSON.parse(draftInsert!.body!);
      assertEquals(draft.source, "practice");
      assertEquals("grade" in draft, false, "a draft must never carry a grade");
      assertEquals(typeof draft.feedback, "string");
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "submit-open-answer: stores under the question's course, ignoring the body's",
  ...OPTS,
  async fn() {
    // The question belongs to c1; the body names another course. Every write
    // must land under c1 — the body id is contract, not scope (#1135 rule).
    const h = createTestHarness({
      routes: [
        ...baseRoutes(),
        supabaseRoute("/rest/v1/open_question_grades", {}),
        supabaseRoute("/rest/v1/chat_sessions", {}),
        supabaseRoute("/rest/v1/courses", { institution_id: "inst-1", language: null }),
        supabaseRoute("/rest/v1/institutions", {
          ai_features_disabled: [],
          default_language: null,
        }),
        openaiRoute("/v1/responses", {
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({
                    feedback: "Fine.",
                    strengths: ["a", "b"],
                    areas_for_improvement: ["c", "d"],
                  }),
                },
              ],
            },
          ],
        }),
        supabaseRoute("/rest/v1/open_answer_ai_drafts", {}),
        supabaseRoute("/rest/v1/ai_usage_logs", {}),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        questionId: "q1",
        courseId: "c-somebody-elses-course",
        studentAnswer: "an answer",
      }, { headers: AUTH_HEADERS });
      const { status } = await parseResponse(res);
      assertEquals(status, 200);

      const insert = gradeInsert(h.fetchLog);
      assertEquals(JSON.parse(insert!.body!).course_id, "c1");
      const sessionInsert = h.fetchLog.find((e) =>
        e.method === "POST" && e.url.includes("/rest/v1/chat_sessions")
      );
      assertEquals(JSON.parse(sessionInsert!.body!).course_id, "c1");
      const draftInsert = h.fetchLog.find((e) =>
        e.method === "POST" && e.url.includes("/rest/v1/open_answer_ai_drafts")
      );
      assertEquals(JSON.parse(draftInsert!.body!).course_id, "c1");
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "submit-open-answer: still records the submission when the draft model call fails",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        ...baseRoutes(),
        supabaseRoute("/rest/v1/open_question_grades", {}),
        supabaseRoute("/rest/v1/chat_sessions", {}),
        supabaseRoute("/rest/v1/courses", { institution_id: "inst-1", language: null }),
        supabaseRoute("/rest/v1/institutions", {
          ai_features_disabled: [],
          default_language: null,
        }),
        {
          match: (url: string) => url.includes("api.openai.com"),
          respond: () => new Response("upstream down", { status: 500 }),
        },
        supabaseRoute("/rest/v1/ai_usage_logs", {}),
        supabaseRoute("/rest/v1/ai_rate_limit_events", {}),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        questionId: "q1",
        courseId: "c1",
        studentAnswer: "an answer",
      }, { headers: AUTH_HEADERS });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200, "a draft failure must not fail the submission");
      assertEquals(body.pendingReview, true);
      assertEquals(gradeInsert(h.fetchLog) !== undefined, true);
    } finally {
      h.cleanup();
    }
  },
});

// ── No moderation (#1040) ───────────────────────────────────────────────

Deno.test({
  name: "submit-open-answer: never calls the moderation endpoint",
  ...OPTS,
  async fn() {
    // Carried over from the retired grader: a one-shot answer to a set
    // question is coursework, and the filter could not tell it from abuse.
    // Asserting "no /v1/moderations request was made" rather than just
    // "returns 200".
    let moderationCalls = 0;
    const h = createTestHarness({
      routes: [
        ...baseRoutes(),
        supabaseRoute("/rest/v1/open_question_grades", {}),
        supabaseRoute("/rest/v1/chat_sessions", {}),
        supabaseRoute("/rest/v1/courses", { institution_id: "inst-1", language: null }),
        supabaseRoute("/rest/v1/institutions", {
          ai_features_disabled: [],
          default_language: null,
        }),
        {
          match: (url: string) => url.includes("/v1/moderations"),
          respond: () => {
            moderationCalls += 1;
            return new Response(
              JSON.stringify({
                results: [
                  { flagged: true, categories: { harassment: true }, category_scores: {} },
                ],
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          },
        },
        openaiRoute("/v1/responses", {
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({
                    feedback: "Good.",
                    strengths: ["a", "b"],
                    areas_for_improvement: ["c", "d"],
                  }),
                },
              ],
            },
          ],
        }),
        supabaseRoute("/rest/v1/open_answer_ai_drafts", {}),
        supabaseRoute("/rest/v1/ai_usage_logs", {}),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        questionId: "q1",
        courseId: "c1",
        studentAnswer:
          "Η δολοφονία του Φραγκίσκου Φερδινάνδου ήταν η αφορμή, όχι η αιτία.",
      }, { headers: AUTH_HEADERS });
      const { status, body } = await parseResponse(res);
      assertEquals(moderationCalls, 0);
      assertEquals(status, 200);
      assertEquals(body.error, undefined);
    } finally {
      h.cleanup();
    }
  },
});

// ── Per-school AI toggle (G8) ───────────────────────────────────────────

Deno.test({
  name:
    "submit-open-answer: a disabled grading family skips the draft but still records the submission",
  ...OPTS,
  async fn() {
    // Under the retired grader this was a 403 — no grade could exist without
    // the model. Recording a submission needs no model, so the toggle now
    // only suppresses the draft.
    const { _clearAiFeatureGateCache } = await import("../../ai-feature-gate.ts");
    _clearAiFeatureGateCache();
    const h = createTestHarness({
      routes: [
        ...baseRoutes(),
        supabaseRoute("/rest/v1/open_question_grades", {}),
        supabaseRoute("/rest/v1/chat_sessions", {}),
        // The gate resolves course → institution → toggle list.
        supabaseRoute("/rest/v1/courses", {
          institution_id: "inst-gate-1",
          language: null,
        }),
        supabaseRoute("/rest/v1/institutions", {
          ai_features_disabled: ["grading"],
          default_language: null,
        }),
        // Must never be reached — the gate throws before the request is built.
        openaiRoute("/v1/responses", { output: [] }, { method: "POST" }),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        questionId: "q1",
        courseId: "c1",
        studentAnswer: "an answer",
      }, { headers: AUTH_HEADERS });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      assertEquals(body.pendingReview, true);
      assertEquals(gradeInsert(h.fetchLog) !== undefined, true);
      assertEquals(
        h.fetchLog.some((e) => e.url.includes("api.openai.com")),
        false,
        "a disabled family must not produce an OpenAI request",
      );
      assertEquals(
        h.fetchLog.some((e) => e.url.includes("/rest/v1/open_answer_ai_drafts")),
        false,
        "no draft may be stored when the family is off",
      );
    } finally {
      _clearAiFeatureGateCache();
      h.cleanup();
    }
  },
});
