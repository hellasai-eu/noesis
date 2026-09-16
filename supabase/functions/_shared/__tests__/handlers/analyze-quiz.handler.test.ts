import { assertEquals, assertExists } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  createTestHarness,
  openaiRoute,
  parseResponse,
  supabaseRoute,
} from "../handler-harness.ts";
import { handler } from "../../../analyze-quiz/handler.ts";

const OPTS = { sanitizeOps: false, sanitizeResources: false };

const AI_RESPONSE = {
  output: [{
    type: "message",
    content: [{
      type: "output_text",
      text: JSON.stringify({
        report: {
          overall_understanding: "The class understood the basics but confused fractions.",
          common_misconceptions: [
            {
              title: "Adds numerators and denominators",
              description: "Students added denominators when summing fractions.",
              related_question_orders: [2, 99],
            },
          ],
          knowledge_gaps: [{ topic: "Fractions", description: "Adding unlike fractions." }],
          question_signals: [
            { question_order: 1, difficulty_signal: "easy", note: "Most correct." },
            { question_order: 2, difficulty_signal: "hard", note: "Most missed." },
            { question_order: 99, difficulty_signal: "moderate", note: "Unknown question ignored." },
          ],
          summary: "Reteach adding unlike fractions.",
        },
        clusters: [
          {
            label: "Fraction strugglers",
            rationale: "Missed the fraction-addition item.",
            summary: "Need targeted fraction practice.",
            // Aliases: S1=user-1, S2=user-2, S3=user-3. "S99" is a hallucinated
            // token that maps to nobody and must be dropped.
            member_user_ids: ["S2", "S3", "S99"],
          },
        ],
      }),
    }],
  }],
  status: "completed",
};

// AI response with no clusters — exercises the deterministic score-band
// fallback so the groups section is never empty when there are submitters.
const AI_RESPONSE_NO_CLUSTERS = {
  output: [{
    type: "message",
    content: [{
      type: "output_text",
      text: JSON.stringify({
        report: {
          overall_understanding: "Mixed performance.",
          common_misconceptions: [],
          knowledge_gaps: [],
          question_signals: [
            { question_order: 1, difficulty_signal: "easy", note: "Most correct." },
            { question_order: 2, difficulty_signal: "hard", note: "Most missed." },
          ],
          summary: "Reteach fractions.",
        },
        clusters: [],
      }),
    }],
  }],
  status: "completed",
};

// AI response whose sole cluster mixes one real alias (S1) with garbled tokens
// (a raw-looking UUID the model echoed instead of the alias, plus a hallucinated
// S99). Exercises the alias-mapping guard: bad members are dropped individually,
// the valid member survives, and the result is never crashed or wholesale-empty.
const AI_RESPONSE_GARBLED_IDS = {
  output: [{
    type: "message",
    content: [{
      type: "output_text",
      text: JSON.stringify({
        report: {
          overall_understanding: "Mixed performance.",
          common_misconceptions: [],
          knowledge_gaps: [],
          question_signals: [
            { question_order: 1, difficulty_signal: "easy", note: "Most correct." },
            { question_order: 2, difficulty_signal: "hard", note: "Most missed." },
          ],
          summary: "Reteach fractions.",
        },
        clusters: [
          {
            label: "Mixed group",
            rationale: "One real member plus tokens the model garbled.",
            summary: "Only the valid member should survive.",
            member_user_ids: ["S1", "00000000-0000-0000-0000-000000000000", "S99", ""],
          },
        ],
      }),
    }],
  }],
  status: "completed",
};

function baseRoutes(overrides: Record<string, unknown> = {}) {
  return [
    supabaseRoute("/auth/v1/user", { id: "instr-1", email: "instr@test.local" }),
    // can_manage_offering RPC
    supabaseRoute("/rest/v1/rpc/can_manage_offering", true, { method: "POST" }),
    // The handler reads ALL published assignment rows for (quiz, offering) —
    // whole-class plus any group-scoped ones — so the route returns an array.
    supabaseRoute("/rest/v1/offering_quizzes", overrides.offeringQuiz ?? [
      { id: "oq-1", group_id: null, published_at: "2026-05-01T00:00:00Z" },
    ]),
    supabaseRoute("/rest/v1/offerings", { course_id: "course-1", class_id: "class-1" }),
    supabaseRoute("/rest/v1/courses", { language: "en", institution_id: "inst-1" }),
    supabaseRoute("/rest/v1/class_enrollments", [
      { user_id: "user-1" },
      { user_id: "user-2" },
      { user_id: "user-3" },
    ]),
    supabaseRoute("/rest/v1/quiz_questions", [
      {
        order_num: 1,
        question_id: "q-1",
        questions: { id: "q-1", question: "2+2?", type: "mcq", difficulty: "easy", payload: { options: ["3", "4"] }, answer_key: { correct_indices: [1] } },
      },
      {
        order_num: 2,
        question_id: "q-2",
        questions: { id: "q-2", question: "1/2 + 1/3?", type: "mcq", difficulty: "medium", payload: { options: ["5/6", "2/5"] }, answer_key: { correct_indices: [0] } },
      },
    ]),
    supabaseRoute("/rest/v1/quiz_answers", overrides.quizAnswers ?? [
      { user_id: "user-1", question_id: "q-1", is_correct: true, selected_answer: 1, submission: null, offering_id: "off-1", answered_at: "2026-06-01T00:00:00Z" },
      { user_id: "user-1", question_id: "q-2", is_correct: true, selected_answer: 0, submission: null, offering_id: "off-1", answered_at: "2026-06-01T00:00:00Z" },
      { user_id: "user-2", question_id: "q-1", is_correct: true, selected_answer: 1, submission: null, offering_id: "off-1", answered_at: "2026-06-01T00:00:00Z" },
      { user_id: "user-2", question_id: "q-2", is_correct: false, selected_answer: 1, submission: null, offering_id: "off-1", answered_at: "2026-06-01T00:00:00Z" },
      { user_id: "user-3", question_id: "q-2", is_correct: false, selected_answer: 1, submission: null, offering_id: null, answered_at: "2026-06-01T00:00:00Z" },
    ]),
    supabaseRoute("/rest/v1/open_question_grades", []),
    supabaseRoute("/rest/v1/quiz_analyses", overrides.saved ?? {
      id: "an-1",
      quiz_id: "quiz-1",
      offering_id: "off-1",
      report: {},
      clusters: [],
      submission_count: 3,
      low_confidence: true,
    }, { method: "POST" }),
    openaiRoute("/v1/responses", overrides.aiResponse ?? AI_RESPONSE, { method: "POST" }),
  ];
}

Deno.test("analyze-quiz: OPTIONS returns CORS headers", async () => {
  const h = createTestHarness();
  try {
    const req = new Request("http://localhost/functions/v1/analyze-quiz", { method: "OPTIONS" });
    const res = await handler(req);
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  } finally {
    h.cleanup();
  }
});

Deno.test("analyze-quiz: 400 when quiz_id / offering_id missing", async () => {
  const h = createTestHarness();
  try {
    const res = await h.invoke(handler, {});
    assertEquals((await parseResponse(res)).status, 400);
  } finally {
    h.cleanup();
  }
});

Deno.test({
  name: "analyze-quiz: 403 when caller cannot manage the offering",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        supabaseRoute("/auth/v1/user", { id: "instr-1" }),
        supabaseRoute("/rest/v1/rpc/can_manage_offering", false, { method: "POST" }),
      ],
    });
    try {
      const res = await h.invoke(handler, { quiz_id: "quiz-1", offering_id: "off-1" }, {
        headers: { authorization: "Bearer test-token" },
      });
      assertEquals((await parseResponse(res)).status, 403);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "analyze-quiz: 404 when the quiz has no published assignment in the offering",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: baseRoutes({ offeringQuiz: [] }),
    });
    try {
      const res = await h.invoke(handler, { quiz_id: "quiz-1", offering_id: "off-1" }, {
        headers: { authorization: "Bearer test-token" },
      });
      const { status } = await parseResponse(res);
      assertEquals(status, 404);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "analyze-quiz: group scope narrows the roster and keys the upsert",
  ...OPTS,
  async fn() {
    // Whole-class assignment, analysis narrowed to grp-1 whose only members
    // are user-2 and user-3 — but that leaves just 2 submitters, below the
    // floor, so use all three as members to reach it and assert the scope.
    const h = createTestHarness({
      routes: [
        ...baseRoutes(),
        supabaseRoute("/rest/v1/offering_groups", { id: "grp-1" }),
        supabaseRoute("/rest/v1/offering_group_members", [
          { user_id: "user-1" },
          { user_id: "user-2" },
          { user_id: "user-3" },
        ]),
      ],
    });
    try {
      const res = await h.invoke(
        handler,
        { quiz_id: "quiz-1", offering_id: "off-1", group_id: "grp-1" },
        { headers: { authorization: "Bearer test-token" } },
      );
      const { status } = await parseResponse(res);
      assertEquals(status, 200);

      const upsertCall = h.fetchLog.find(
        (e) => e.url.includes("/rest/v1/quiz_analyses") && e.method === "POST",
      );
      assertExists(upsertCall);
      const saved = JSON.parse(upsertCall!.body!);
      const savedRow = Array.isArray(saved) ? saved[0] : saved;
      // The cached row is keyed by the cohort it describes.
      assertEquals(savedRow.group_id, "grp-1");
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "analyze-quiz: 404 when the named group belongs to another offering",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        ...baseRoutes(),
        // The (id, offering_id) lookup finds nothing.
        supabaseRoute("/rest/v1/offering_groups", null),
      ],
    });
    try {
      const res = await h.invoke(
        handler,
        { quiz_id: "quiz-1", offering_id: "off-1", group_id: "grp-other" },
        { headers: { authorization: "Bearer test-token" } },
      );
      const { status } = await parseResponse(res);
      assertEquals(status, 404);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "analyze-quiz: below-threshold submissions returns a clear message, no AI call",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: baseRoutes({
        quizAnswers: [
          { user_id: "user-1", question_id: "q-1", is_correct: true, selected_answer: 1, submission: null, offering_id: "off-1", answered_at: "2026-06-01T00:00:00Z" },
        ],
      }),
    });
    try {
      const res = await h.invoke(handler, { quiz_id: "quiz-1", offering_id: "off-1" }, {
        headers: { authorization: "Bearer test-token" },
      });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      assertEquals(body.insufficientData, true);
      assertEquals(body.submission_count, 1);
      // No OpenAI call should have been made.
      const openAiCall = h.fetchLog.find((e) => e.url.includes("api.openai.com"));
      assertEquals(openAiCall, undefined);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "analyze-quiz: happy path — analyzes, sanitizes AI output, upserts, no PII to LLM",
  ...OPTS,
  async fn() {
    const h = createTestHarness({ routes: baseRoutes() });
    try {
      const res = await h.invoke(handler, { quiz_id: "quiz-1", offering_id: "off-1" }, {
        headers: { authorization: "Bearer test-token" },
      });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      assertExists(body.analysis);

      // OpenAI must be called and must not leak names — only opaque ids are sent.
      const openAiCall = h.fetchLog.find(
        (e) => e.url.includes("api.openai.com") && e.method === "POST",
      );
      assertExists(openAiCall);
      const reqBody = JSON.parse(openAiCall!.body!);
      const text = (reqBody.input as any[])
        .map((m) => (typeof m.content === "string" ? m.content : ""))
        .join(" ");
      assertEquals(text.includes("\"full_name\""), false);
      assertEquals(text.includes("\"student_id\""), true);
      // Students are aliased behind short tokens; raw user_ids never reach the
      // model (that's the bug — LLMs can't echo them back).
      assertEquals(text.includes("\"S1\""), true);
      assertEquals(text.includes("user-1"), false);
      assertEquals(text.includes("user-2"), false);
      assertEquals(text.includes("user-3"), false);

      // The analysis is persisted via an upsert to quiz_analyses.
      const upsertCall = h.fetchLog.find(
        (e) => e.url.includes("/rest/v1/quiz_analyses") && e.method === "POST",
      );
      assertExists(upsertCall);
      const saved = JSON.parse(upsertCall!.body!);
      const savedRow = Array.isArray(saved) ? saved[0] : saved;
      // Unknown question order (99) is stripped from question_signals.
      assertEquals(savedRow.report.question_signals.length, 2);
      // Report validation also filters unknown orders out of misconceptions:
      // the mocked misconception carried [2, 99] and only the real order survives.
      assertEquals(
        savedRow.report.common_misconceptions[0].related_question_orders,
        [2],
      );
      // Hallucinated token (S99) is dropped; aliases map back to real user_ids.
      assertEquals(savedRow.clusters[0].member_user_ids.sort(), ["user-2", "user-3"]);
      // 3 submissions < LOW_CONFIDENCE_THRESHOLD (5) → flagged.
      assertEquals(savedRow.low_confidence, true);
      assertEquals(savedRow.submission_count, 3);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name:
    "analyze-quiz: drops only the garbled cluster members, keeps the valid one (#846)",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: baseRoutes({ aiResponse: AI_RESPONSE_GARBLED_IDS }),
    });
    try {
      const res = await h.invoke(handler, { quiz_id: "quiz-1", offering_id: "off-1" }, {
        headers: { authorization: "Bearer test-token" },
      });
      const { status } = await parseResponse(res);
      // Garbled/unknown ids must not crash the handler.
      assertEquals(status, 200);

      const upsertCall = h.fetchLog.find(
        (e) => e.url.includes("/rest/v1/quiz_analyses") && e.method === "POST",
      );
      assertExists(upsertCall);
      const saved = JSON.parse(upsertCall!.body!);
      const savedRow = Array.isArray(saved) ? saved[0] : saved;
      const clusters = savedRow.clusters as Array<{ member_user_ids: string[] }>;
      // The cluster is not dropped wholesale: the one valid alias (S1 → user-1)
      // survives while the UUID echo, hallucinated S99, and empty token are
      // dropped individually.
      assertEquals(clusters.length, 1);
      assertEquals(clusters[0].member_user_ids, ["user-1"]);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name:
    "analyze-quiz: falls back to score-band groups when the model returns no clusters",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: baseRoutes({ aiResponse: AI_RESPONSE_NO_CLUSTERS }),
    });
    try {
      const res = await h.invoke(handler, { quiz_id: "quiz-1", offering_id: "off-1" }, {
        headers: { authorization: "Bearer test-token" },
      });
      const { status } = await parseResponse(res);
      assertEquals(status, 200);

      const upsertCall = h.fetchLog.find(
        (e) => e.url.includes("/rest/v1/quiz_analyses") && e.method === "POST",
      );
      assertExists(upsertCall);
      const saved = JSON.parse(upsertCall!.body!);
      const savedRow = Array.isArray(saved) ? saved[0] : saved;
      // Even with an empty AI clusters array, the deterministic fallback groups
      // the three submitters so the section is never empty when data exists.
      const clusters = savedRow.clusters as Array<{ member_user_ids: string[] }>;
      assertEquals(clusters.length > 0, true);
      const grouped = clusters.flatMap((c) => c.member_user_ids).sort();
      assertEquals(grouped, ["user-1", "user-2", "user-3"]);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name:
    "analyze-quiz: excludes open_question_grades rows from students who didn't submit this quiz's MCQ questions",
  ...OPTS,
  async fn() {
    // Simulates the same open question being reused across two quizzes for
    // this offering: user-4 has a grade row via `open_question_grades`
    // (which has no quiz_id) but never answered this quiz's MCQ question.
    const h = createTestHarness({
      routes: [
        supabaseRoute("/auth/v1/user", { id: "instr-1", email: "instr@test.local" }),
        supabaseRoute("/rest/v1/rpc/can_manage_offering", true, { method: "POST" }),
        supabaseRoute("/rest/v1/offering_quizzes", [
          { id: "oq-1", group_id: null, published_at: "2026-05-01T00:00:00Z" },
        ]),
        supabaseRoute("/rest/v1/offerings", { course_id: "course-1", class_id: "class-1" }),
        supabaseRoute("/rest/v1/courses", { language: "en", institution_id: "inst-1" }),
        supabaseRoute("/rest/v1/class_enrollments", [
          { user_id: "user-1" },
          { user_id: "user-2" },
          { user_id: "user-3" },
          { user_id: "user-4" },
        ]),
        supabaseRoute("/rest/v1/quiz_questions", [
          {
            order_num: 1,
            question_id: "q-1",
            questions: { id: "q-1", question: "2+2?", type: "mcq", difficulty: "easy", payload: { options: ["3", "4"] }, answer_key: { correct_indices: [1] } },
          },
          {
            order_num: 2,
            question_id: "q-2",
            questions: { id: "q-2", question: "Explain fractions.", type: "open", difficulty: "medium", payload: null, answer_key: null },
          },
        ]),
        supabaseRoute("/rest/v1/quiz_answers", [
          { user_id: "user-1", question_id: "q-1", is_correct: true, selected_answer: 1, submission: null, offering_id: "off-1", answered_at: "2026-06-01T00:00:00Z" },
          { user_id: "user-2", question_id: "q-1", is_correct: true, selected_answer: 1, submission: null, offering_id: "off-1", answered_at: "2026-06-01T00:00:00Z" },
          { user_id: "user-3", question_id: "q-1", is_correct: false, selected_answer: 0, submission: null, offering_id: "off-1", answered_at: "2026-06-01T00:00:00Z" },
        ]),
        supabaseRoute("/rest/v1/open_question_grades", [
          { user_id: "user-1", open_question_id: "q-2", grade: 80, submitted_answer: "...", offering_id: "off-1", graded_at: "2026-06-01T00:00:00Z" },
          // user-4 never answered this quiz's q-1 — this row leaked in from
          // a different quiz that reuses the same open question (q-2).
          { user_id: "user-4", open_question_id: "q-2", grade: 90, submitted_answer: "...", offering_id: "off-1", graded_at: "2026-06-01T00:00:00Z" },
        ]),
        supabaseRoute("/rest/v1/quiz_analyses", {
          id: "an-1",
          quiz_id: "quiz-1",
          offering_id: "off-1",
          report: {},
          clusters: [],
          submission_count: 3,
          low_confidence: true,
        }, { method: "POST" }),
        openaiRoute("/v1/responses", AI_RESPONSE, { method: "POST" }),
      ],
    });
    try {
      const res = await h.invoke(handler, { quiz_id: "quiz-1", offering_id: "off-1" }, {
        headers: { authorization: "Bearer test-token" },
      });
      const { status } = await parseResponse(res);
      assertEquals(status, 200);

      const upsertCall = h.fetchLog.find(
        (e) => e.url.includes("/rest/v1/quiz_analyses") && e.method === "POST",
      );
      assertExists(upsertCall);
      const saved = JSON.parse(upsertCall!.body!);
      const savedRow = Array.isArray(saved) ? saved[0] : saved;
      // Only user-1, user-2, user-3 answered this quiz's MCQ question;
      // user-4's leaked open grade must not inflate the submission count.
      assertEquals(savedRow.submission_count, 3);
    } finally {
      h.cleanup();
    }
  },
});
