// Handler tests for `submit-quiz-answers` (#1094).
//
// This function is the only writer of `quiz_answers` now that students have no
// INSERT policy on it, so the cases below cover the guarantees that are not
// visible from the pure graders:
//
//   * grading — correctness is recomputed from `answer_key`, and a verdict the
//     client puts in the body is ignored (it is not even read);
//   * versioning — every answer carries the `updated_at` it was graded against,
//     and a stale-key refusal from the RPC is retried once against
//     a fresh read before the student is told to try again;
//   * attribution — the questions must belong to the course the answers are
//     filed under, and the caller comes from the token, never the body;
//   * finalisation — `finalizeSession` travels to the RPC, so the answers and
//     the completed session commit together;
//   * fill-gaps equivalence — the LLM judge upgrades a near-miss, never blocks a
//     submission when it fails, is not called at all when the exact matcher was
//     already satisfied, and is not paid for twice across the stale-key retry.
//
// Mirrors the mocking approach of submit-study-guide-piece.handler.test.ts.

import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  createTestHarness,
  type MockRoute,
  openaiRoute,
  parseResponse,
  supabaseRoute,
} from "../handler-harness.ts";
import { handler } from "../../../submit-quiz-answers/handler.ts";

const OPTS = { sanitizeOps: false, sanitizeResources: false };
const AUTH_HEADERS = { Authorization: "Bearer student-token" };

const COURSE = "course-1";
const SESSION = "session-1";
const VERSION = "2026-08-24T10:00:00.123456+00:00";

const AUTHED = supabaseRoute("/auth/v1/user", { id: "student-1", email: "s@test.local" });

// deno-lint-ignore no-explicit-any
type Json = any;

function question(overrides: Record<string, Json> = {}): Json {
  return {
    id: "q1",
    type: "mcq",
    payload: { options: ["A", "B", "C"] },
    answer_key: { correct_indices: [1] },
    course_id: COURSE,
    updated_at: VERSION,
    ...overrides,
  };
}

function questionsRoute(rows: Json[]): MockRoute {
  return {
    match: (url) => url.includes("/rest/v1/questions"),
    respond: () =>
      new Response(JSON.stringify(rows), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  };
}

/** The RPC reply: one row per question, as `record_quiz_answers` returns it. */
function rpcRoute(rows: Array<{ question_id: string; is_correct: boolean }>): MockRoute {
  return supabaseRoute(
    "/rest/v1/rpc/record_quiz_answers",
    rows.map((r) => ({ ...r, recorded_now: true })),
  );
}

function rpcErrorRoute(code: string, message = "boom", hint: string | null = null): MockRoute {
  return {
    match: (url) => url.includes("/rest/v1/rpc/record_quiz_answers"),
    respond: () =>
      new Response(JSON.stringify({ code, message, details: null, hint }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
  };
}

/** The `_answers` array the handler passed to the RPC on call `index`. */
function rpcPayload(
  fetchLog: Array<{ url: string; body?: string }>,
  index = 0,
): { _answers: Json[]; _finalize: boolean; _user_id: string; _quiz_id: string | null } {
  const calls = fetchLog.filter((e) => e.url.includes("/rpc/record_quiz_answers"));
  return JSON.parse(calls[index].body ?? "{}");
}

function requestBody(answers: Json[], extra: Record<string, Json> = {}) {
  return {
    courseId: COURSE,
    sessionId: SESSION,
    quizId: "quiz-1",
    offeringId: "off-1",
    answers,
    ...extra,
  };
}

// ── CORS + input validation ─────────────────────────────────────────────

Deno.test("submit-quiz-answers: OPTIONS returns CORS headers", async () => {
  const h = createTestHarness();
  try {
    const res = await handler(
      new Request("http://localhost/functions/v1/submit-quiz-answers", { method: "OPTIONS" }),
    );
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  } finally {
    h.cleanup();
  }
});

Deno.test({
  name: "submit-quiz-answers: 400 when the session id is missing",
  ...OPTS,
  async fn() {
    const h = createTestHarness();
    try {
      const res = await h.invoke(handler, {
        courseId: COURSE,
        answers: [{ questionId: "q1", submission: { selected_indices: [1] } }],
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
  name: "submit-quiz-answers: 400 when answers is empty",
  ...OPTS,
  async fn() {
    const h = createTestHarness();
    try {
      const res = await h.invoke(handler, requestBody([]), { headers: AUTH_HEADERS });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 400);
      assertEquals(body.error, "answers must be a non-empty array");
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "submit-quiz-answers: 400 when the same question is answered twice",
  ...OPTS,
  async fn() {
    const h = createTestHarness();
    try {
      const res = await h.invoke(
        handler,
        requestBody([
          { questionId: "q1", submission: { selected_indices: [0] } },
          { questionId: "q1", submission: { selected_indices: [1] } },
        ]),
        { headers: AUTH_HEADERS },
      );
      const { status, body } = await parseResponse(res);
      assertEquals(status, 400);
      assertEquals(body.error, "Each answer must name a distinct question");
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "submit-quiz-answers: 401 without an Authorization header",
  ...OPTS,
  async fn() {
    const h = createTestHarness();
    try {
      const res = await h.invoke(
        handler,
        requestBody([{ questionId: "q1", submission: { selected_indices: [1] } }]),
      );
      const { status, body } = await parseResponse(res);
      assertEquals(status, 401);
      assertEquals(body.error, "Missing authorization");
    } finally {
      h.cleanup();
    }
  },
});

// ── Attribution ─────────────────────────────────────────────────────────

Deno.test({
  name: "submit-quiz-answers: 403 when a question belongs to another course",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [AUTHED, questionsRoute([question({ course_id: "other-course" })])],
    });
    try {
      const res = await h.invoke(
        handler,
        requestBody([{ questionId: "q1", submission: { selected_indices: [1] } }]),
        { headers: AUTH_HEADERS },
      );
      const { status, body } = await parseResponse(res);
      assertEquals(status, 403);
      assertEquals(body.error, "Question does not belong to this course");
      assertEquals(h.fetchLog.filter((e) => e.url.includes("/rpc/")).length, 0);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "submit-quiz-answers: 404 when a question no longer exists",
  ...OPTS,
  async fn() {
    const h = createTestHarness({ routes: [AUTHED, questionsRoute([])] });
    try {
      const res = await h.invoke(
        handler,
        requestBody([{ questionId: "q1", submission: { selected_indices: [1] } }]),
        { headers: AUTH_HEADERS },
      );
      const { status, body } = await parseResponse(res);
      assertEquals(status, 404);
      assertEquals(body.error, "One or more questions no longer exist");
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "submit-quiz-answers: the recorded student is the token's, not the body's",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        AUTHED,
        questionsRoute([question()]),
        rpcRoute([{ question_id: "q1", is_correct: true }]),
      ],
    });
    try {
      await h.invoke(
        handler,
        requestBody([{ questionId: "q1", submission: { selected_indices: [1] } }], {
          userId: "someone-else",
          user_id: "someone-else",
        }),
        { headers: AUTH_HEADERS },
      );
      assertEquals(rpcPayload(h.fetchLog)._user_id, "student-1");
    } finally {
      h.cleanup();
    }
  },
});

// ── Grading ─────────────────────────────────────────────────────────────

Deno.test({
  name: "submit-quiz-answers: grades MCQ from the answer key and ignores a client verdict",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        AUTHED,
        questionsRoute([question()]),
        rpcRoute([{ question_id: "q1", is_correct: false }]),
      ],
    });
    try {
      // The client claims a correct answer while submitting the wrong option.
      const res = await h.invoke(
        handler,
        requestBody([
          {
            questionId: "q1",
            submission: { selected_indices: [0] },
            isCorrect: true,
            is_correct: true,
          },
        ]),
        { headers: AUTH_HEADERS },
      );
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);

      const sent = rpcPayload(h.fetchLog)._answers;
      assertEquals(sent.length, 1);
      assertEquals(sent[0].is_correct, false);
      assertEquals(sent[0].selected_answer, 0);
      assertEquals(sent[0].submission, { selected_indices: [0] });
      assertEquals(sent[0].question_version, VERSION);

      // And what comes back is what the RPC stored.
      assertEquals(body.results, [{ questionId: "q1", isCorrect: false, recordedNow: true }]);
      assertEquals(body.correctCount, 0);
      assertEquals(body.totalCount, 1);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "submit-quiz-answers: grades every question type from its own key",
  ...OPTS,
  async fn() {
    const rows = [
      question({ id: "mcq", answer_key: { correct_indices: [1, 2] } }),
      question({
        id: "ord",
        type: "ordering",
        payload: { prompt: "p", items: ["a", "b", "c"] },
        answer_key: {},
      }),
      question({
        id: "cls",
        type: "classification",
        payload: { categories: [], items: [] },
        answer_key: { assignments: { i1: "c1", i2: "c2" } },
      }),
      question({
        id: "gap",
        type: "fill_gaps",
        payload: { stem: "The {{1}} is blue" },
        answer_key: { gaps: [{ ordinal: 1, acceptable: ["sky"] }] },
      }),
      question({ id: "open", type: "open", payload: {}, answer_key: { model_answer: "m" } }),
    ];
    const h = createTestHarness({
      routes: [
        AUTHED,
        questionsRoute(rows),
        rpcRoute(rows.map((r) => ({ question_id: r.id, is_correct: false }))),
      ],
    });
    try {
      const res = await h.invoke(
        handler,
        requestBody([
          { questionId: "mcq", submission: { selected_indices: [2, 1] } }, // set match
          { questionId: "ord", submission: { ordering: ["a", "c", "b"] } }, // wrong order
          { questionId: "cls", submission: { classification: { i1: "c1", i2: "c2" } } },
          { questionId: "gap", submission: { fill_gaps: ["  SKY  "] } }, // normalised match
          { questionId: "open", submission: { open_text: "an essay" } },
        ]),
        { headers: AUTH_HEADERS },
      );
      assertEquals((await parseResponse(res)).status, 200);

      const byId = new Map(
        rpcPayload(h.fetchLog)._answers.map((a: Json) => [a.question_id, a]),
      );
      assertEquals(byId.get("mcq").is_correct, true);
      assertEquals(byId.get("ord").is_correct, false);
      assertEquals(byId.get("cls").is_correct, true);
      assertEquals(byId.get("gap").is_correct, true);
      // An open answer in a quiz is recorded, never auto-scored.
      assertEquals(byId.get("open").is_correct, false);
      assertEquals(byId.get("open").submission, { open_text: "an essay" });
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "submit-quiz-answers: a submission of the wrong shape grades as unanswered, not as an error",
  ...OPTS,
  async fn() {
    // Losing a whole attempt — including a time-up auto-submit — over one
    // malformed entry would cost the student more than the entry is worth.
    const h = createTestHarness({
      routes: [
        AUTHED,
        questionsRoute([question()]),
        rpcRoute([{ question_id: "q1", is_correct: false }]),
      ],
    });
    try {
      const res = await h.invoke(
        handler,
        requestBody([{ questionId: "q1", submission: { ordering: ["a"] } }]),
        { headers: AUTH_HEADERS },
      );
      assertEquals((await parseResponse(res)).status, 200);
      const sent = rpcPayload(h.fetchLog)._answers;
      assertEquals(sent[0].is_correct, false);
      assertEquals(sent[0].submission, { selected_indices: [] });
    } finally {
      h.cleanup();
    }
  },
});

// ── Fill-gaps equivalence judge (#784 on the quiz surface) ──────────────

/** A judge response accepting/rejecting each ordinal. */
function llmVerdicts(verdicts: Array<{ ordinal: number; equivalent: boolean }>) {
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

function gapQuestion(overrides: Record<string, Json> = {}): Json {
  return question({
    id: "gap",
    type: "fill_gaps",
    payload: { stem: "The {{1}} is {{2}}" },
    answer_key: {
      gaps: [
        { ordinal: 1, acceptable: ["sky"] },
        { ordinal: 2, acceptable: ["blue"] },
      ],
    },
    ...overrides,
  });
}

function openaiCalls(fetchLog: Array<{ url: string }>): number {
  return fetchLog.filter((e) => e.url.includes("api.openai.com")).length;
}

Deno.test({
  name: "submit-quiz-answers: fill_gaps — a near miss the judge accepts is recorded correct",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        AUTHED,
        questionsRoute([gapQuestion()]),
        rpcRoute([{ question_id: "gap", is_correct: true }]),
        openaiRoute("/v1/responses", llmVerdicts([{ ordinal: 2, equivalent: true }]), {
          method: "POST",
        }),
      ],
    });
    try {
      // Gap 1 matches exactly; gap 2 is a misspelling the exact matcher rejects.
      const res = await h.invoke(
        handler,
        requestBody([{ questionId: "gap", submission: { fill_gaps: ["sky", "bleu"] } }]),
        { headers: AUTH_HEADERS },
      );
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);

      const sent = rpcPayload(h.fetchLog)._answers[0];
      assertEquals(sent.is_correct, true);
      // The student's literal text is what gets stored, not the judged form.
      assertEquals(sent.submission, { fill_gaps: ["sky", "bleu"] });

      // The per-gap breakdown travels back so the player marks what the server
      // accepted rather than re-deriving a stricter answer.
      assertEquals(body.results[0].perGap, [true, true]);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "submit-quiz-answers: fill_gaps — the judge is not called when every gap matched exactly",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        AUTHED,
        questionsRoute([gapQuestion()]),
        rpcRoute([{ question_id: "gap", is_correct: true }]),
      ],
    });
    try {
      const res = await h.invoke(
        handler,
        // Normalisation (trim, case) is the exact matcher's job, not the model's.
        requestBody([{ questionId: "gap", submission: { fill_gaps: ["  SKY ", "Blue"] } }]),
        { headers: AUTH_HEADERS },
      );
      assertEquals((await parseResponse(res)).status, 200);
      assertEquals(rpcPayload(h.fetchLog)._answers[0].is_correct, true);
      assertEquals(openaiCalls(h.fetchLog), 0);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "submit-quiz-answers: fill_gaps — a judge failure leaves the exact grade and still records",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        AUTHED,
        questionsRoute([gapQuestion()]),
        rpcRoute([{ question_id: "gap", is_correct: false }]),
        openaiRoute("/v1/responses", { error: "boom" }, { method: "POST", status: 500 }),
      ],
    });
    try {
      const res = await h.invoke(
        handler,
        requestBody([{ questionId: "gap", submission: { fill_gaps: ["sky", "bleu"] } }]),
        { headers: AUTH_HEADERS },
      );
      const { status, body } = await parseResponse(res);
      // A model outage must never cost the student their submission.
      assertEquals(status, 200);
      const sent = rpcPayload(h.fetchLog)._answers[0];
      assertEquals(sent.is_correct, false);
      assertEquals(body.results[0].perGap, [true, false]);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "submit-quiz-answers: fill_gaps — a resubmission reports the stored verdict with no per-gap marks",
  ...OPTS,
  async fn() {
    // The attempt already holds an answer for this question, so the RPC keeps
    // it and reports `recorded_now: false`. The marks computed here describe
    // text that was dropped; sending them next to the stored verdict would
    // describe one answer with the grade of another.
    const h = createTestHarness({
      routes: [
        AUTHED,
        questionsRoute([gapQuestion()]),
        supabaseRoute("/rest/v1/rpc/record_quiz_answers", [
          { question_id: "gap", is_correct: false, recorded_now: false },
        ]),
        openaiRoute("/v1/responses", llmVerdicts([{ ordinal: 2, equivalent: true }]), {
          method: "POST",
        }),
      ],
    });
    try {
      const res = await h.invoke(
        handler,
        requestBody([{ questionId: "gap", submission: { fill_gaps: ["sky", "bleu"] } }]),
        { headers: AUTH_HEADERS },
      );
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      assertEquals(body.results[0].isCorrect, false);
      assertEquals(body.results[0].recordedNow, false);
      assertEquals("perGap" in body.results[0], false);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "submit-quiz-answers: fill_gaps — a stale-key retry does not pay for the same judgement twice",
  ...OPTS,
  async fn() {
    // Two questions: an MCQ the instructor edits under the submission, and a
    // fill-gaps question that does not change. The retry must re-grade, but the
    // unchanged question's verdict is already known.
    let rpcCalls = 0;
    const h = createTestHarness({
      routes: [
        AUTHED,
        {
          match: (url: string) => url.includes("/rest/v1/questions"),
          respond: () =>
            new Response(
              JSON.stringify([
                question({
                  id: "q1",
                  updated_at: rpcCalls === 0 ? VERSION : "2026-08-24T11:00:00+00:00",
                }),
                gapQuestion(),
              ]),
              { status: 200, headers: { "Content-Type": "application/json" } },
            ),
        },
        {
          match: (url: string) => url.includes("/rest/v1/rpc/record_quiz_answers"),
          respond: () => {
            rpcCalls += 1;
            if (rpcCalls === 1) {
              return new Response(
                JSON.stringify({
                  code: "P0001",
                  message: "answer key changed while grading (1 question(s))",
                  hint: "stale_answer_key",
                }),
                { status: 400, headers: { "Content-Type": "application/json" } },
              );
            }
            return new Response(
              JSON.stringify([
                { question_id: "q1", is_correct: true, recorded_now: true },
                { question_id: "gap", is_correct: true, recorded_now: true },
              ]),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          },
        },
        openaiRoute("/v1/responses", llmVerdicts([{ ordinal: 2, equivalent: true }]), {
          method: "POST",
        }),
      ],
    });
    try {
      const res = await h.invoke(
        handler,
        requestBody([
          { questionId: "q1", submission: { selected_indices: [1] } },
          { questionId: "gap", submission: { fill_gaps: ["sky", "bleu"] } },
        ]),
        { headers: AUTH_HEADERS },
      );
      assertEquals((await parseResponse(res)).status, 200);
      assertEquals(rpcCalls, 2);
      // Graded twice, judged once.
      assertEquals(openaiCalls(h.fetchLog), 1);
    } finally {
      h.cleanup();
    }
  },
});

// ── Grading under a moving answer key ───────────────────────────────────

Deno.test({
  name: "submit-quiz-answers: re-grades once against the new key when the RPC reports a stale key",
  ...OPTS,
  async fn() {
    const NEW_VERSION = "2026-08-24T10:05:00+00:00";
    let questionReads = 0;
    let rpcCalls = 0;
    const h = createTestHarness({
      routes: [
        AUTHED,
        {
          match: (url) => url.includes("/rest/v1/questions"),
          respond: () => {
            questionReads += 1;
            // The instructor's edit lands between the two reads: option 0 is
            // the correct one now, and the row carries a new `updated_at`.
            const row = questionReads === 1
              ? question()
              : question({ answer_key: { correct_indices: [0] }, updated_at: NEW_VERSION });
            return new Response(JSON.stringify([row]), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          },
        },
        {
          match: (url) => url.includes("/rest/v1/rpc/record_quiz_answers"),
          respond: () => {
            rpcCalls += 1;
            if (rpcCalls === 1) {
              return new Response(
                JSON.stringify({
                  code: "P0001",
                  message: "answer key changed while grading (1 question(s))",
                  hint: "stale_answer_key",
                }),
                { status: 400, headers: { "Content-Type": "application/json" } },
              );
            }
            return new Response(
              JSON.stringify([{ question_id: "q1", is_correct: true, recorded_now: true }]),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          },
        },
      ],
    });
    try {
      const res = await h.invoke(
        handler,
        requestBody([{ questionId: "q1", submission: { selected_indices: [0] } }]),
        { headers: AUTH_HEADERS },
      );
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      assertEquals(questionReads, 2);

      // First attempt graded against the old key (option 0 wrong), second
      // against the new one (option 0 right) — and it carries the new version.
      assertEquals(rpcPayload(h.fetchLog, 0)._answers[0].is_correct, false);
      assertEquals(rpcPayload(h.fetchLog, 1)._answers[0].is_correct, true);
      assertEquals(rpcPayload(h.fetchLog, 1)._answers[0].question_version, NEW_VERSION);
      assertEquals(body.results, [{ questionId: "q1", isCorrect: true, recordedNow: true }]);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "submit-quiz-answers: 409 when the key keeps moving under the retry",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        AUTHED,
        questionsRoute([question()]),
        rpcErrorRoute("P0001", "answer key changed while grading (1 question(s))", "stale_answer_key"),
      ],
    });
    try {
      const res = await h.invoke(
        handler,
        requestBody([{ questionId: "q1", submission: { selected_indices: [1] } }]),
        { headers: AUTH_HEADERS },
      );
      const { status, body } = await parseResponse(res);
      assertEquals(status, 409);
      assertEquals(body.error, "question_changed");
      assertEquals(h.fetchLog.filter((e) => e.url.includes("/rpc/")).length, 2);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "submit-quiz-answers: 403 when the RPC refuses the attribution",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        AUTHED,
        questionsRoute([question()]),
        rpcErrorRoute("42501", "student may not file work under offering off-1"),
      ],
    });
    try {
      const res = await h.invoke(
        handler,
        requestBody([{ questionId: "q1", submission: { selected_indices: [1] } }]),
        { headers: AUTH_HEADERS },
      );
      const { status, body } = await parseResponse(res);
      assertEquals(status, 403);
      assertEquals(body.error, "not_authorized");
    } finally {
      h.cleanup();
    }
  },
});

// ── Finalisation ────────────────────────────────────────────────────────

Deno.test({
  name: "submit-quiz-answers: passes finalizeSession through to the RPC",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        AUTHED,
        questionsRoute([question()]),
        rpcRoute([{ question_id: "q1", is_correct: true }]),
      ],
    });
    try {
      await h.invoke(
        handler,
        requestBody([{ questionId: "q1", submission: { selected_indices: [1] } }], {
          finalizeSession: true,
        }),
        { headers: AUTH_HEADERS },
      );
      const payload = rpcPayload(h.fetchLog);
      assertEquals(payload._finalize, true);
      assertEquals(payload._quiz_id, "quiz-1");
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "submit-quiz-answers: practice mode sends no quiz and no offering",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        AUTHED,
        questionsRoute([question()]),
        rpcRoute([{ question_id: "q1", is_correct: true }]),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        courseId: COURSE,
        sessionId: SESSION,
        quizId: null,
        offeringId: null,
        answers: [{ questionId: "q1", submission: { selected_indices: [1] } }],
      }, { headers: AUTH_HEADERS });
      assertEquals((await parseResponse(res)).status, 200);
      const payload = rpcPayload(h.fetchLog);
      assertEquals(payload._quiz_id, null);
      assertEquals(payload._finalize, false);
    } finally {
      h.cleanup();
    }
  },
});
