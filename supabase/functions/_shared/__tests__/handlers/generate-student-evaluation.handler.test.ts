import { assertEquals, assertExists } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  createTestHarness,
  openaiRoute,
  parseResponse,
  supabaseRoute,
  authorizedCallerRoutes,
  BEARER_AUTH,
} from "../handler-harness.ts";
import { handler } from "../../../generate-student-evaluation/handler.ts";

const OPTS = { sanitizeOps: false, sanitizeResources: false };

Deno.test("generate-student-evaluation: OPTIONS returns CORS headers", async () => {
  const h = createTestHarness();
  try {
    const req = new Request("http://localhost/functions/v1/generate-student-evaluation", { method: "OPTIONS" });
    const res = await handler(req);
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  } finally { h.cleanup(); }
});

Deno.test("generate-student-evaluation: returns error when required params missing", async () => {
  const h = createTestHarness();
  try {
    const res = await h.invoke(handler, {});
    const { status } = await parseResponse(res);
    assertEquals(status >= 400, true);
  } finally { h.cleanup(); }
});

/** The structured payload the model is stubbed to return. */
function aiResponse() {
  return {
    output: [{
      type: "message",
      content: [{
        type: "output_text",
        text: JSON.stringify({
          engagementSummary: "Uses the platform steadily.",
          engagementLevel: "moderate",
          progressSummary: "Doing well.",
          overallTrend: "improving",
          keyImprovements: ["k1"],
          resolvedIssues: [],
          persistentChallenges: [],
          newStrengths: [],
          recommendations: ["r1"],
          insightfulObservation: "notable pattern",
          competencyScores: [{ competencyId: "comp-1", score: 80, rationale: "solid" }],
        }),
      }],
    }],
    status: "completed",
  };
}

/** The user-message text the handler sent to OpenAI. */
function promptText(h: ReturnType<typeof createTestHarness>): string {
  const openAiCall = h.fetchLog.find(
    (e) => e.url.includes("api.openai.com") && e.method === "POST",
  );
  assertExists(openAiCall);
  assertExists(openAiCall!.body);
  const reqBody = JSON.parse(openAiCall!.body!);
  const userMessage = reqBody.input.find((m: any) => m.role === "user");
  assertExists(userMessage);
  return typeof userMessage.content === "string"
    ? userMessage.content
    : (userMessage.content as any[]).map((c: any) => c.text ?? "").join(" ");
}

Deno.test({
  name: "generate-student-evaluation: builds context from quiz answers of every question type",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        ...authorizedCallerRoutes(),
        supabaseRoute("/rest/v1/courses", {
          language: "en",
          institution_id: null,
          title: "Algebra",
          description: "",
        }),
        supabaseRoute("/rest/v1/quiz_answers", [
          {
            is_correct: true,
            answered_at: "2026-01-04T00:00:00Z",
            submission: { selected_indices: [1] },
            questions: {
              question: "MCQ_Q1", type: "mcq", difficulty: "easy",
              competency_id: "comp-1", answer_key: { correct_indices: [1] },
            },
          },
          {
            // Open answers are recorded is_correct=false because a quiz never
            // auto-scores prose — the context must not pass that on as a verdict.
            is_correct: false,
            answered_at: "2026-01-03T00:00:00Z",
            submission: { open_text: "OPEN_TEXT_ANSWER" },
            questions: {
              question: "OPEN_Q", type: "open", difficulty: "hard",
              competency_id: "comp-1", answer_key: { model_answer: "MODEL_ANSWER_TEXT" },
            },
          },
          {
            is_correct: false,
            answered_at: "2026-01-02T00:00:00Z",
            submission: { fill_gaps: ["GAP_ONE", "GAP_TWO"] },
            questions: {
              question: "GAPS_Q", type: "fill_gaps", difficulty: "medium",
              competency_id: null, answer_key: { gaps: [] },
            },
          },
          {
            is_correct: true,
            answered_at: "2026-01-01T00:00:00Z",
            submission: { ordering: ["STEP_A", "STEP_B"] },
            questions: {
              question: "ORDER_Q", type: "ordering", difficulty: "easy",
              competency_id: null, answer_key: {},
            },
          },
        ]),
        supabaseRoute("/rest/v1/course_competencies", [
          { id: "comp-1", title: "Skill", description: "" },
        ]),
        openaiRoute("/v1/responses", aiResponse(), { method: "POST" }),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        courseId: "course-1",
        userId: "user-1",
      }, { headers: BEARER_AUTH });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      assertEquals(body.evaluation.hasEnoughData, true);

      const text = promptText(h);

      // Every question type reaches the model, not just MCQ.
      for (const q of ["MCQ_Q1", "OPEN_Q", "GAPS_Q", "ORDER_Q"]) {
        assertEquals(text.includes(q), true);
      }

      // Open answers carry the student's text and the model answer, and are
      // flagged ungraded rather than reported as wrong.
      assertEquals(text.includes("OPEN_TEXT_ANSWER"), true);
      assertEquals(text.includes("MODEL_ANSWER_TEXT"), true);
      assertEquals(text.includes('"isCorrect": null'), true);
      assertEquals(text.includes('"graded": false'), true);

      // Literal submissions for the deterministic non-MCQ types.
      assertEquals(text.includes("GAP_ONE | GAP_TWO"), true);
      assertEquals(text.includes("STEP_A → STEP_B"), true);

      // MCQ slimming (#356): correctness only, no option text.
      assertEquals(text.includes("selectedAnswer"), false);
      assertEquals(text.includes("correctAnswer"), false);
      assertEquals(text.includes("selected_indices"), false);
      assertEquals(text.includes('"isCorrect": true'), true);

      // Competency linkage travels with the answer.
      assertEquals(text.includes("competencyId"), true);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "generate-student-evaluation: caps every student-supplied field so one answer cannot eat the input budget",
  ...OPTS,
  async fn() {
    // Longer than any cap in the handler, for each field a student controls.
    const LONG_OPEN = "o".repeat(5000);
    const LONG_GAP = "g".repeat(5000);
    const LONG_STEP = "s".repeat(5000);
    const LONG_MODEL_ANSWER = "m".repeat(5000);

    const h = createTestHarness({
      routes: [
        ...authorizedCallerRoutes(),
        supabaseRoute("/rest/v1/courses", { language: "en", institution_id: null, title: "T", description: "" }),
        supabaseRoute("/rest/v1/quiz_answers", [
          {
            is_correct: false, answered_at: "2026-01-03T00:00:00Z",
            submission: { open_text: LONG_OPEN },
            questions: {
              question: "OPEN_Q", type: "open", difficulty: "hard",
              competency_id: null, answer_key: { model_answer: LONG_MODEL_ANSWER },
            },
          },
          {
            is_correct: false, answered_at: "2026-01-02T00:00:00Z",
            submission: { fill_gaps: [LONG_GAP] },
            questions: {
              question: "GAPS_Q", type: "fill_gaps", difficulty: "medium",
              competency_id: null, answer_key: { gaps: [] },
            },
          },
          {
            is_correct: false, answered_at: "2026-01-01T00:00:00Z",
            submission: { ordering: [LONG_STEP] },
            questions: {
              question: "ORDER_Q", type: "ordering", difficulty: "easy",
              competency_id: null, answer_key: {},
            },
          },
        ]),
        supabaseRoute("/rest/v1/course_competencies", []),
        openaiRoute("/v1/responses", aiResponse(), { method: "POST" }),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        courseId: "course-1",
        userId: "user-1",
      }, { headers: BEARER_AUTH });
      assertEquals(res.status, 200);

      const text = promptText(h);
      // Each field is truncated well short of what was submitted. Asserting on
      // the longest run of each character keeps this independent of the exact
      // cap while still failing if a field goes through unbounded.
      for (const ch of ["o", "g", "s", "m"]) {
        const longest = Math.max(
          0,
          ...(text.match(new RegExp(`${ch}+`, "g")) || []).map((m: string) => m.length),
        );
        assertEquals(longest < 1000, true, `${ch} run was ${longest} chars — field not capped`);
      }
      // Truncation is marked, not silent.
      assertEquals(text.includes("…"), true);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "generate-student-evaluation: requests the 200 most recent quiz answers plus graded sources, never transcripts",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        ...authorizedCallerRoutes(),
        supabaseRoute("/rest/v1/courses", { language: "en", institution_id: null, title: "T", description: "" }),
        supabaseRoute("/rest/v1/quiz_answers", [
          {
            is_correct: true, answered_at: "2026-01-03T00:00:00Z", submission: {},
            questions: { question: "Q1", type: "mcq", difficulty: "easy", competency_id: null, answer_key: {} },
          },
          {
            is_correct: false, answered_at: "2026-01-02T00:00:00Z", submission: {},
            questions: { question: "Q2", type: "mcq", difficulty: "easy", competency_id: null, answer_key: {} },
          },
          {
            is_correct: true, answered_at: "2026-01-01T00:00:00Z", submission: {},
            questions: { question: "Q3", type: "mcq", difficulty: "easy", competency_id: null, answer_key: {} },
          },
        ]),
        supabaseRoute("/rest/v1/course_competencies", []),
        openaiRoute("/v1/responses", aiResponse(), { method: "POST" }),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        courseId: "course-1",
        userId: "user-1",
      }, { headers: BEARER_AUTH });
      assertEquals(res.status, 200);

      const answersCall = h.fetchLog.find((e) => e.url.includes("/rest/v1/quiz_answers"));
      assertExists(answersCall);
      // Newest first, capped at 200 (PostgREST Range is 0-based and inclusive).
      assertEquals(answersCall!.url.includes("order=answered_at.desc"), true);
      assertEquals(
        answersCall!.url.includes("limit=200") ||
          (answersCall!.headers?.["range"] ?? answersCall!.headers?.["Range"]) === "0-199",
        true,
      );

      // The other graded sources are requested for the evaluation axis.
      assertEquals(h.fetchLog.some((e) => e.url.includes("/rest/v1/open_question_grades")), true);

      // The engagement practice count excludes formal quiz submissions.
      assertEquals(
        h.fetchLog.some((e) =>
          e.url.includes("/rest/v1/quiz_answers") && e.url.includes("quiz_id=is.null")
        ),
        true,
      );

      // Transcript content and tutor state stay out — chat activity is read
      // only as a slim id list for the engagement count.
      assertEquals(h.fetchLog.some((e) => e.url.includes("/rest/v1/open_question_chats")), false);
      assertEquals(h.fetchLog.some((e) => e.url.includes("/rest/v1/study_tutor_session_state")), false);
      const chatMessagesCall = h.fetchLog.find((e) => e.url.includes("/rest/v1/chat_messages"));
      if (chatMessagesCall) {
        assertEquals(chatMessagesCall.url.includes("select=id"), true);
      }
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "generate-student-evaluation: two axes — study guide answers and interaction grades reach the model, engagement counts in prompt and response",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        // Must precede authorizedCallerRoutes so the handler's own offerings
        // lookup sees an id; the gate only needs class_id, which is kept.
        supabaseRoute("/rest/v1/offerings", [{ id: "off-1", class_id: "class-1" }]),
        ...authorizedCallerRoutes(),
        supabaseRoute("/rest/v1/courses", { language: "en", institution_id: null, title: "T", description: "" }),
        supabaseRoute("/rest/v1/quiz_answers", []),
        supabaseRoute("/rest/v1/study_guide_answers", [
          {
            is_correct: null, grade: 72, feedback: "SG_FEEDBACK_TEXT",
            submitted_at: "2026-01-05T00:00:00Z",
            submission: { open_text: "SG_OPEN_ANSWER" },
            questions: {
              question: "SG_QUESTION", type: "open", difficulty: "medium",
              competency_id: "comp-1", answer_key: { model_answer: "SG_MODEL" },
            },
          },
          {
            is_correct: true, grade: null, feedback: null,
            submitted_at: "2026-01-04T00:00:00Z",
            submission: { selected_indices: [0] },
            questions: {
              question: "SG_MCQ", type: "mcq", difficulty: "easy",
              competency_id: "comp-1", answer_key: { correct_indices: [0] },
            },
          },
        ]),
        supabaseRoute("/rest/v1/study_guide_progress", [{ id: "sgp-1" }, { id: "sgp-2" }]),
        supabaseRoute("/rest/v1/open_question_grades", [
          {
            grade: 85, graded_at: "2026-01-06T00:00:00Z",
            feedback: "IG_FEEDBACK_TEXT",
            strengths: ["IG_STRENGTH"], areas_for_improvement: ["IG_AREA"],
          },
        ]),
        supabaseRoute("/rest/v1/flashcard_reviews", [{ id: "f1" }, { id: "f2" }, { id: "f3" }]),
        supabaseRoute("/rest/v1/chat_messages", [{ id: "m1" }, { id: "m2" }]),
        supabaseRoute("/rest/v1/course_competencies", [
          { id: "comp-1", title: "Skill", description: "" },
        ]),
        openaiRoute("/v1/responses", aiResponse(), { method: "POST" }),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        courseId: "course-1",
        userId: "user-1",
      }, { headers: BEARER_AUTH });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);

      // Zero quiz answers is fine — study guide + interaction evidence gates it.
      assertEquals(body.evaluation.hasEnoughData, true);

      const text = promptText(h);

      // Study guide answers as graded evidence, with the AI grader's verdict.
      assertEquals(text.includes("SG_QUESTION"), true);
      assertEquals(text.includes("SG_OPEN_ANSWER"), true);
      assertEquals(text.includes("SG_MODEL"), true);
      assertEquals(text.includes("SG_FEEDBACK_TEXT"), true);
      assertEquals(text.includes('"grade": 72'), true);
      assertEquals(text.includes("SG_MCQ"), true);

      // Interaction grades as evidence.
      assertEquals(text.includes("IG_FEEDBACK_TEXT"), true);
      assertEquals(text.includes("IG_STRENGTH"), true);
      assertEquals(text.includes("IG_AREA"), true);
      assertEquals(text.includes('"grade": 85'), true);

      // Engagement counts reach the model.
      assertEquals(text.includes('"flashcardsReviewed": "3"'), true);
      assertEquals(text.includes('"chatMessagesSent": "2"'), true);
      assertEquals(text.includes('"studyGuidesStarted": "2"'), true);
      assertEquals(text.includes('"studyGuideAnswersSubmitted": "2"'), true);

      // The engagement axis comes back with deterministic counts attached.
      assertEquals(body.evaluation.engagement.level, "moderate");
      assertEquals(body.evaluation.engagement.summary, "Uses the platform steadily.");
      assertEquals(body.evaluation.engagement.counts.flashcardsReviewed, 3);
      assertEquals(body.evaluation.engagement.counts.chatMessagesSent, 2);
      assertEquals(body.evaluation.engagement.counts.studyGuideAnswersSubmitted, 2);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "generate-student-evaluation: a body offeringId scopes the offerings lookup to that section",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        supabaseRoute("/rest/v1/offerings", [{ id: "off-1", class_id: "class-1" }]),
        ...authorizedCallerRoutes(),
        supabaseRoute("/rest/v1/courses", { language: "en", institution_id: null, title: "T", description: "" }),
        supabaseRoute("/rest/v1/quiz_answers", [
          {
            is_correct: true, answered_at: "2026-01-03T00:00:00Z", submission: {},
            questions: { question: "Q1", type: "mcq", difficulty: "easy", competency_id: null, answer_key: {} },
          },
          {
            is_correct: false, answered_at: "2026-01-02T00:00:00Z", submission: {},
            questions: { question: "Q2", type: "mcq", difficulty: "easy", competency_id: null, answer_key: {} },
          },
          {
            is_correct: true, answered_at: "2026-01-01T00:00:00Z", submission: {},
            questions: { question: "Q3", type: "mcq", difficulty: "easy", competency_id: null, answer_key: {} },
          },
        ]),
        supabaseRoute("/rest/v1/course_competencies", []),
        openaiRoute("/v1/responses", aiResponse(), { method: "POST" }),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        courseId: "course-1",
        userId: "user-1",
        offeringId: "off-1",
      }, { headers: BEARER_AUTH });
      assertEquals(res.status, 200);

      // The handler's own offerings read (course_id + id) is pinned to the
      // requested section, so study-guide evidence cannot cross sections.
      assertEquals(
        h.fetchLog.some((e) =>
          e.url.includes("/rest/v1/offerings") &&
          e.url.includes("course_id=eq.course-1") &&
          e.url.includes("id=eq.off-1")
        ),
        true,
      );
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "generate-student-evaluation: too few quiz answers short-circuits before OpenAI",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        ...authorizedCallerRoutes(),
        supabaseRoute("/rest/v1/courses", { language: "en", institution_id: null, title: "T", description: "" }),
        supabaseRoute("/rest/v1/quiz_answers", [
          {
            is_correct: true, answered_at: "2026-01-01T00:00:00Z", submission: {},
            questions: { question: "Q1", type: "mcq", difficulty: "easy", competency_id: null, answer_key: {} },
          },
        ]),
        supabaseRoute("/rest/v1/course_competencies", []),
        openaiRoute("/v1/responses", aiResponse(), { method: "POST" }),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        courseId: "course-1",
        userId: "user-1",
      }, { headers: BEARER_AUTH });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      assertEquals(body.evaluation.hasEnoughData, false);
      assertEquals(h.fetchLog.some((e) => e.url.includes("api.openai.com")), false);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "generate-student-evaluation: PII guardrail — does not pass studentName / student_name / full_name to OpenAI (issue #557)",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        ...authorizedCallerRoutes(),
        supabaseRoute("/rest/v1/courses", { language: "en", institution_id: null, title: "T", description: "" }),
        supabaseRoute("/rest/v1/quiz_answers", [
          {
            is_correct: true, answered_at: "2026-01-03T00:00:00Z", submission: {},
            questions: { question: "Q1", type: "mcq", difficulty: "easy", competency_id: null, answer_key: {} },
          },
          {
            is_correct: false, answered_at: "2026-01-02T00:00:00Z", submission: {},
            questions: { question: "Q2", type: "mcq", difficulty: "easy", competency_id: null, answer_key: {} },
          },
          {
            is_correct: true, answered_at: "2026-01-01T00:00:00Z", submission: {},
            questions: { question: "Q3", type: "mcq", difficulty: "easy", competency_id: null, answer_key: {} },
          },
        ]),
        supabaseRoute("/rest/v1/course_competencies", []),
        openaiRoute("/v1/responses", aiResponse(), { method: "POST" }),
      ],
    });
    try {
      // Send a body that *includes* a name-like key — the handler must ignore it
      // and never forward it to OpenAI even if a stale client passes it.
      const SENTINEL = "Maria Karagianni-Leakedname";
      const res = await h.invoke(handler, {
        courseId: "course-1",
        userId: "user-1",
        studentName: SENTINEL,
      }, { headers: BEARER_AUTH });
      assertEquals(res.status, 200);

      const openAiCall = h.fetchLog.find(
        (e) => e.url.includes("api.openai.com") && e.method === "POST",
      );
      assertExists(openAiCall);
      assertEquals(openAiCall!.body!.includes(SENTINEL), false);
      assertEquals(openAiCall!.body!.includes("studentName"), false);
      assertEquals(openAiCall!.body!.includes("student_name"), false);
      assertEquals(openAiCall!.body!.includes("full_name"), false);
    } finally {
      h.cleanup();
    }
  },
});
