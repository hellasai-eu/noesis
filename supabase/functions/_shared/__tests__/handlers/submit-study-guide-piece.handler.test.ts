// Handler tests for `submit-study-guide-piece` (#980).
//
// This function is the sole writer of `study_guide_answers` and the only thing
// standing between a student and a grade, so the cases below concentrate on the
// guarantees that are not visible from the pure helpers:
//
//   * authorization — enrollment and offering-group scoping, since the service
//     role bypasses RLS and `verify-study-guide-enrollment` is the only check;
//   * sequence — a piece that is not the student's current one is refused, so
//     knowing a future piece's id cannot skip the guide;
//   * immutability — one attempt per question, enforced before and during the
//     write;
//   * grading — correctness is recomputed from `answer_key` and a claim made by
//     the client is ignored;
//   * that open answers are recorded UNGRADED (pending instructor review)
//     and the review-draft prompt actually receives the question stem.
//
// Mirrors the mocking approach of grade-deterministic-answer.handler.test.ts.

import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  createTestHarness,
  type MockRoute,
  openaiRoute,
  parseResponse,
  supabaseRoute,
} from "../handler-harness.ts";
import { handler } from "../../../submit-study-guide-piece/handler.ts";

const OPTS = { sanitizeOps: false, sanitizeResources: false };
const AUTH_HEADERS = { Authorization: "Bearer student-token" };

const GUIDE = "sg-1";
const OFFERING = "off-1";
const PIECE = "piece-1";

/** Authenticated student who is enrolled and whole-class assigned. */
function authorizedRoutes(): MockRoute[] {
  return [
    supabaseRoute("/auth/v1/user", { id: "student-1", email: "s@test.local" }),
    supabaseRoute("/rest/v1/offering_study_guides", [
      { group_id: null, offerings: { id: OFFERING, class_id: "class-1" } },
    ]),
    supabaseRoute("/rest/v1/class_enrollments", [{ class_id: "class-1" }]),
  ];
}

/**
 * `study_guide_pieces` is read twice with different projections — once for the
 * submitted piece, once for every position to decide whether it is the last.
 * The second selects only `position`, which is what separates them here.
 */
function pieceRoutes(
  piece: { id: string; position: number },
  allPositions: number[],
): MockRoute[] {
  return [
    {
      match: (url) => url.includes("/rest/v1/study_guide_pieces") && url.includes("select=position"),
      respond: () =>
        new Response(JSON.stringify(allPositions.map((position) => ({ position }))), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    },
    supabaseRoute("/rest/v1/study_guide_pieces", {
      id: piece.id,
      position: piece.position,
      study_guide_id: GUIDE,
    }),
  ];
}

function progressRoute(currentPiecePosition: number | null): MockRoute {
  return supabaseRoute(
    "/rest/v1/study_guide_progress",
    currentPiecePosition === null ? null : { current_piece_position: currentPiecePosition },
  );
}

/**
 * The embedded `questions!inner(...)` column list from a PostgREST `select`.
 * Returns null when the request does not embed questions.
 */
function embeddedQuestionColumns(url: string): string[] | null {
  const select = new URL(url).searchParams.get("select");
  const match = select?.match(/questions!inner\(([^)]*)\)/);
  return match ? match[1].split(",").map((c) => c.trim()).filter(Boolean) : null;
}

/**
 * Serves the piece's questions, projected to exactly the columns the handler
 * asked for — PostgREST returns nothing else, and a mock that ignores `select`
 * would happily hand back a column the real query never requested, hiding
 * precisely the kind of omission the open-answer test below exists to catch.
 */
// deno-lint-ignore no-explicit-any
function questionsRoute(questions: any[]): MockRoute {
  return {
    match: (url) => url.includes("/rest/v1/study_guide_piece_questions"),
    respond: (url) => {
      const columns = embeddedQuestionColumns(url);
      const rows = questions.map((q, i) => ({
        question_id: q.id,
        position: i,
        questions: columns
          ? Object.fromEntries(columns.filter((c) => c in q).map((c) => [c, q[c]]))
          : q,
      }));
      return new Response(JSON.stringify(rows), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  };
}

function mcq(id: string, correctIndices: number[]) {
  return {
    id,
    question: `Question ${id}?`,
    type: "mcq",
    payload: { options: ["A", "B", "C"] },
    answer_key: { correct_indices: correctIndices },
    explanation: "because",
    course_id: "course-1",
  };
}

/** The RPC reply; `.single()` means the body must be the object itself. */
function rpcRoute(currentPiecePosition: number, completedAt: string | null): MockRoute {
  return supabaseRoute("/rest/v1/rpc/submit_study_guide_piece_answers", {
    current_piece_position: currentPiecePosition,
    completed_at: completedAt,
  });
}

/** No prior answers for any of the piece's questions. */
const NO_EXISTING_ANSWERS = supabaseRoute("/rest/v1/study_guide_answers", []);

// ── CORS + input validation ─────────────────────────────────────────────

Deno.test("submit-study-guide-piece: OPTIONS returns CORS headers", async () => {
  const h = createTestHarness();
  try {
    const res = await handler(
      new Request("http://localhost/functions/v1/submit-study-guide-piece", { method: "OPTIONS" }),
    );
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  } finally {
    h.cleanup();
  }
});

Deno.test({
  name: "submit-study-guide-piece: 400 when an id parameter is missing",
  ...OPTS,
  async fn() {
    const h = createTestHarness();
    try {
      const res = await h.invoke(handler, {
        studyGuideId: GUIDE,
        offeringId: OFFERING,
        answers: [],
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
  name: "submit-study-guide-piece: 400 when answers is not an array",
  ...OPTS,
  async fn() {
    const h = createTestHarness();
    try {
      const res = await h.invoke(handler, {
        studyGuideId: GUIDE,
        offeringId: OFFERING,
        pieceId: PIECE,
        answers: { q1: "x" },
      }, { headers: AUTH_HEADERS });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 400);
      assertEquals(body.error, "answers must be an array");
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "submit-study-guide-piece: 401 without an Authorization header",
  ...OPTS,
  async fn() {
    const h = createTestHarness();
    try {
      const res = await h.invoke(handler, {
        studyGuideId: GUIDE,
        offeringId: OFFERING,
        pieceId: PIECE,
        answers: [],
      });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 401);
      assertEquals(body.error, "Missing authorization");
    } finally {
      h.cleanup();
    }
  },
});

// ── Authorization ───────────────────────────────────────────────────────

Deno.test({
  name: "submit-study-guide-piece: 403 when the guide is not published to the offering",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        supabaseRoute("/auth/v1/user", { id: "student-1" }),
        supabaseRoute("/rest/v1/offering_study_guides", []),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        studyGuideId: GUIDE,
        offeringId: OFFERING,
        pieceId: PIECE,
        answers: [],
      }, { headers: AUTH_HEADERS });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 403);
      assertEquals(body.error, "Not authorized for this study guide");
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "submit-study-guide-piece: 403 when the student is not enrolled in the class",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        supabaseRoute("/auth/v1/user", { id: "student-1" }),
        supabaseRoute("/rest/v1/offering_study_guides", [
          { group_id: null, offerings: { id: OFFERING, class_id: "class-1" } },
        ]),
        supabaseRoute("/rest/v1/class_enrollments", []),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        studyGuideId: GUIDE,
        offeringId: OFFERING,
        pieceId: PIECE,
        answers: [],
      }, { headers: AUTH_HEADERS });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 403);
      assertEquals(body.error, "Not authorized for this study guide");
    } finally {
      h.cleanup();
    }
  },
});

// Group scoping is the check RLS would normally make; under the service role it
// exists only in `verify-study-guide-enrollment`, so an enrolled classmate who
// is not in the assigned group must still be refused.
Deno.test({
  name: "submit-study-guide-piece: 403 for an enrolled student outside the assigned group",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        supabaseRoute("/auth/v1/user", { id: "student-1" }),
        supabaseRoute("/rest/v1/offering_study_guides", [
          { group_id: "group-1", offerings: { id: OFFERING, class_id: "class-1" } },
        ]),
        supabaseRoute("/rest/v1/class_enrollments", [{ class_id: "class-1" }]),
        supabaseRoute("/rest/v1/offering_group_members", []),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        studyGuideId: GUIDE,
        offeringId: OFFERING,
        pieceId: PIECE,
        answers: [],
      }, { headers: AUTH_HEADERS });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 403);
      assertEquals(body.error, "Not authorized for this study guide");
    } finally {
      h.cleanup();
    }
  },
});

// Closure (20260910120000): an instructor marking the guide as done sets
// `closed_at` on the assignment row, and a closed route no longer accepts
// submissions — distinct from not-authorized, so the player can say so.
Deno.test({
  name: "submit-study-guide-piece: 403 guide_closed once the assignment is marked done",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        supabaseRoute("/auth/v1/user", { id: "student-1" }),
        supabaseRoute("/rest/v1/offering_study_guides", [
          {
            group_id: null,
            closed_at: "2026-09-09T10:00:00Z",
            offerings: { id: OFFERING, class_id: "class-1" },
          },
        ]),
        supabaseRoute("/rest/v1/class_enrollments", [{ class_id: "class-1" }]),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        studyGuideId: GUIDE,
        offeringId: OFFERING,
        pieceId: PIECE,
        answers: [],
      }, { headers: AUTH_HEADERS });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 403);
      assertEquals(body.code, "guide_closed");
    } finally {
      h.cleanup();
    }
  },
});

// A student whose own group's row is closed is refused even though ANOTHER
// group's row is still open — closure is per assignment row, and someone
// else's open route must not reopen yours.
Deno.test({
  name: "submit-study-guide-piece: 403 guide_closed when only the student's group row is closed",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        supabaseRoute("/auth/v1/user", { id: "student-1" }),
        supabaseRoute("/rest/v1/offering_study_guides", [
          {
            group_id: "group-1",
            closed_at: "2026-09-09T10:00:00Z",
            offerings: { id: OFFERING, class_id: "class-1" },
          },
          {
            group_id: "group-2",
            closed_at: null,
            offerings: { id: OFFERING, class_id: "class-1" },
          },
        ]),
        supabaseRoute("/rest/v1/class_enrollments", [{ class_id: "class-1" }]),
        supabaseRoute("/rest/v1/offering_group_members", [{ group_id: "group-1" }]),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        studyGuideId: GUIDE,
        offeringId: OFFERING,
        pieceId: PIECE,
        answers: [],
      }, { headers: AUTH_HEADERS });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 403);
      assertEquals(body.code, "guide_closed");
    } finally {
      h.cleanup();
    }
  },
});

// Deadline gate (20260910130000): a past-due assignment refuses a student who
// never started — the server-side twin of the locked student tile — while a
// student with an existing progress row keeps the grace period.
Deno.test({
  name: "submit-study-guide-piece: 403 guide_expired for a never-started student past the deadline",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        supabaseRoute("/auth/v1/user", { id: "student-1" }),
        supabaseRoute("/rest/v1/offering_study_guides", [
          {
            group_id: null,
            closed_at: null,
            due_date: "2020-01-01T00:00:00Z",
            offerings: { id: OFFERING, class_id: "class-1" },
          },
        ]),
        supabaseRoute("/rest/v1/class_enrollments", [{ class_id: "class-1" }]),
        ...pieceRoutes({ id: PIECE, position: 0 }, [0]),
        progressRoute(null),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        studyGuideId: GUIDE,
        offeringId: OFFERING,
        pieceId: PIECE,
        answers: [{ questionId: "q1", submission: { selected_indices: [0] } }],
      }, { headers: AUTH_HEADERS });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 403);
      assertEquals(body.code, "guide_expired");
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "submit-study-guide-piece: a started student passes the deadline gate",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        supabaseRoute("/auth/v1/user", { id: "student-1" }),
        supabaseRoute("/rest/v1/offering_study_guides", [
          {
            group_id: null,
            closed_at: null,
            due_date: "2020-01-01T00:00:00Z",
            offerings: { id: OFFERING, class_id: "class-1" },
          },
        ]),
        supabaseRoute("/rest/v1/class_enrollments", [{ class_id: "class-1" }]),
        ...pieceRoutes({ id: PIECE, position: 0 }, [0]),
        progressRoute(0),
        // No questions served: reaching "Piece has no questions" proves the
        // request got PAST the deadline gate without building the whole
        // grading fixture.
        questionsRoute([]),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        studyGuideId: GUIDE,
        offeringId: OFFERING,
        pieceId: PIECE,
        answers: [{ questionId: "q1", submission: { selected_indices: [0] } }],
      }, { headers: AUTH_HEADERS });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 400);
      assertEquals(body.error, "Piece has no questions");
    } finally {
      h.cleanup();
    }
  },
});

// ── Sequence + immutability ─────────────────────────────────────────────

Deno.test({
  name: "submit-study-guide-piece: 404 when the piece is not part of the guide",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        ...authorizedRoutes(),
        supabaseRoute("/rest/v1/study_guide_pieces", null),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        studyGuideId: GUIDE,
        offeringId: OFFERING,
        pieceId: PIECE,
        answers: [],
      }, { headers: AUTH_HEADERS });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 404);
      assertEquals(body.error, "Piece not found");
    } finally {
      h.cleanup();
    }
  },
});

// The whole point of a sequential player: a student who learns a later piece's
// id must not be able to submit it and jump the progress pointer past the
// pieces in between.
Deno.test({
  name: "submit-study-guide-piece: 403 piece_locked for a piece ahead of the student",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        ...authorizedRoutes(),
        ...pieceRoutes({ id: PIECE, position: 3 }, [0, 1, 2, 3]),
        progressRoute(0),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        studyGuideId: GUIDE,
        offeringId: OFFERING,
        pieceId: PIECE,
        answers: [],
      }, { headers: AUTH_HEADERS });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 403);
      assertEquals(body.error, "piece_locked");
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "submit-study-guide-piece: 403 piece_locked for an already-completed piece",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        ...authorizedRoutes(),
        ...pieceRoutes({ id: PIECE, position: 0 }, [0, 1]),
        progressRoute(1),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        studyGuideId: GUIDE,
        offeringId: OFFERING,
        pieceId: PIECE,
        answers: [{ questionId: "q1", submission: { selected_indices: [0] } }],
      }, { headers: AUTH_HEADERS });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 403);
      assertEquals(body.error, "piece_locked");
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "submit-study-guide-piece: 400 incomplete_piece names the unanswered questions",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        ...authorizedRoutes(),
        ...pieceRoutes({ id: PIECE, position: 0 }, [0]),
        progressRoute(0),
        questionsRoute([mcq("q1", [0]), mcq("q2", [1])]),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        studyGuideId: GUIDE,
        offeringId: OFFERING,
        pieceId: PIECE,
        answers: [{ questionId: "q1", submission: { selected_indices: [0] } }],
      }, { headers: AUTH_HEADERS });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 400);
      assertEquals(body.error, "incomplete_piece");
      assertEquals(body.unanswered, ["q2"]);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "submit-study-guide-piece: 409 when the piece was already submitted",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        ...authorizedRoutes(),
        ...pieceRoutes({ id: PIECE, position: 0 }, [0]),
        progressRoute(0),
        questionsRoute([mcq("q1", [0])]),
        supabaseRoute("/rest/v1/study_guide_answers", [{ question_id: "q1" }]),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        studyGuideId: GUIDE,
        offeringId: OFFERING,
        pieceId: PIECE,
        answers: [{ questionId: "q1", submission: { selected_indices: [0] } }],
      }, { headers: AUTH_HEADERS });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 409);
      assertEquals(body.error, "already_submitted");
    } finally {
      h.cleanup();
    }
  },
});

// A lost race on the insert surfaces as the same refusal, not a 500.
Deno.test({
  name: "submit-study-guide-piece: 409 when the RPC hits the one-attempt constraint",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        ...authorizedRoutes(),
        ...pieceRoutes({ id: PIECE, position: 0 }, [0]),
        progressRoute(0),
        questionsRoute([mcq("q1", [0])]),
        NO_EXISTING_ANSWERS,
        supabaseRoute("/rest/v1/rpc/submit_study_guide_piece_answers", {
          code: "23505",
          message: "duplicate key value violates unique constraint",
        }, { status: 409 }),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        studyGuideId: GUIDE,
        offeringId: OFFERING,
        pieceId: PIECE,
        answers: [{ questionId: "q1", submission: { selected_indices: [0] } }],
      }, { headers: AUTH_HEADERS });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 409);
      assertEquals(body.error, "already_submitted");
    } finally {
      h.cleanup();
    }
  },
});

// ── Grading ─────────────────────────────────────────────────────────────

// The client sends only a selection. Even when it also claims the answer is
// right, the grade comes from `answer_key`.
Deno.test({
  name: "submit-study-guide-piece: recomputes correctness and ignores a client claim",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        ...authorizedRoutes(),
        ...pieceRoutes({ id: PIECE, position: 0 }, [0, 1]),
        progressRoute(0),
        questionsRoute([mcq("q1", [2])]),
        NO_EXISTING_ANSWERS,
        rpcRoute(1, null),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        studyGuideId: GUIDE,
        offeringId: OFFERING,
        pieceId: PIECE,
        answers: [{
          questionId: "q1",
          submission: { selected_indices: [0] },
          isCorrect: true,
          grade: 100,
        }],
      }, { headers: AUTH_HEADERS });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      assertEquals(body.results.length, 1);
      assertEquals(body.results[0].isCorrect, false);
      assertEquals(body.results[0].grade, 0);
      assertEquals(body.progress.currentPiecePosition, 1);

      // And the row handed to the RPC carries the recomputed values, not the
      // client's — this is what actually lands in `study_guide_answers`.
      const rpcCall = h.fetchLog.find((e) => e.url.includes("submit_study_guide_piece_answers"));
      const sent = JSON.parse(rpcCall!.body!);
      assertEquals(sent._answers[0].is_correct, false);
      assertEquals(sent._answers[0].grade, 0);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "submit-study-guide-piece: grades a correct MCQ and reports the explanation",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        ...authorizedRoutes(),
        ...pieceRoutes({ id: PIECE, position: 0 }, [0, 1]),
        progressRoute(0),
        questionsRoute([mcq("q1", [1])]),
        NO_EXISTING_ANSWERS,
        rpcRoute(1, null),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        studyGuideId: GUIDE,
        offeringId: OFFERING,
        pieceId: PIECE,
        answers: [{ questionId: "q1", submission: { selected_indices: [1] } }],
      }, { headers: AUTH_HEADERS });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      assertEquals(body.results[0].isCorrect, true);
      assertEquals(body.results[0].grade, 100);
      assertEquals(body.results[0].explanation, "because");
    } finally {
      h.cleanup();
    }
  },
});

// Submitting the last piece is what marks the guide finished.
Deno.test({
  name: "submit-study-guide-piece: reports completion when the final piece is submitted",
  ...OPTS,
  async fn() {
    const completedAt = "2026-07-28T10:00:00.000Z";
    const h = createTestHarness({
      routes: [
        ...authorizedRoutes(),
        ...pieceRoutes({ id: PIECE, position: 1 }, [0, 1]),
        progressRoute(1),
        questionsRoute([mcq("q1", [0])]),
        NO_EXISTING_ANSWERS,
        rpcRoute(2, completedAt),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        studyGuideId: GUIDE,
        offeringId: OFFERING,
        pieceId: PIECE,
        answers: [{ questionId: "q1", submission: { selected_indices: [0] } }],
      }, { headers: AUTH_HEADERS });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      assertEquals(body.progress.completedAt, completedAt);

      const rpcCall = h.fetchLog.find((e) => e.url.includes("submit_study_guide_piece_answers"));
      assertEquals(JSON.parse(rpcCall!.body!)._is_final, true);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "submit-study-guide-piece: 400 for a question type the grader does not handle",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        ...authorizedRoutes(),
        ...pieceRoutes({ id: PIECE, position: 0 }, [0]),
        progressRoute(0),
        questionsRoute([{ ...mcq("q1", [0]), type: "matching" }]),
        NO_EXISTING_ANSWERS,
      ],
    });
    try {
      const res = await h.invoke(handler, {
        studyGuideId: GUIDE,
        offeringId: OFFERING,
        pieceId: PIECE,
        answers: [{ questionId: "q1", submission: { selected_indices: [0] } }],
      }, { headers: AUTH_HEADERS });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 400);
      assertEquals(body.error, "Unsupported question type: matching");
    } finally {
      h.cleanup();
    }
  },
});

// ── Open answers ────────────────────────────────────────────────────────

function openQuestion(id: string, stem: string) {
  return {
    id,
    question: stem,
    type: "open",
    payload: { answering_mode: "single" },
    answer_key: { model_answer: "the model answer", rubric: null, explanation: null },
    explanation: null,
    course_id: "course-1",
  };
}

const CLEAN_MODERATION = openaiRoute("/v1/moderations", {
  results: [{ flagged: false, categories: {}, category_scores: {} }],
});

function openDraftRoute() {
  return openaiRoute("/v1/responses", {
    status: "completed",
    output: [{
      type: "message",
      content: [{
        type: "output_text",
        text: JSON.stringify({
          feedback: "Reasonable answer with room to grow.",
          strengths: ["clear", "on topic"],
          areas_for_improvement: ["add detail", "cite the text"],
        }),
      }],
    }],
  });
}

// Regression test: the piece's questions are fetched with an explicit column
// list, and `question` was missing from it — so the draft prompt rendered an
// empty stem and reviewed the answer against nothing. Also the contract test
// for the pending-review model: the recorded row and the response both carry
// NO grade and NO feedback, and the AI draft lands in the manager-only table.
Deno.test({
  name: "submit-study-guide-piece: records an open answer ungraded and drafts against the real stem",
  ...OPTS,
  async fn() {
    const stem = "Explain why the Peloponnesian War began.";
    const h = createTestHarness({
      routes: [
        ...authorizedRoutes(),
        ...pieceRoutes({ id: PIECE, position: 0 }, [0, 1]),
        progressRoute(0),
        questionsRoute([openQuestion("q1", stem)]),
        NO_EXISTING_ANSWERS,
        supabaseRoute("/rest/v1/courses", { language: "en", institution_id: "inst-1" }),
        supabaseRoute("/rest/v1/institutions", {
          ai_features_disabled: [],
          default_language: null,
        }),
        CLEAN_MODERATION,
        openDraftRoute(),
        supabaseRoute("/rest/v1/open_answer_ai_drafts", {}),
        supabaseRoute("/rest/v1/ai_usage_logs", {}),
        rpcRoute(1, null),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        studyGuideId: GUIDE,
        offeringId: OFFERING,
        pieceId: PIECE,
        answers: [{ questionId: "q1", submission: { open_text: "Because of Sparta." } }],
      }, { headers: AUTH_HEADERS });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      // Pending instructor review: no verdict of any kind reaches the student.
      assertEquals(body.results[0].grade, null);
      assertEquals(body.results[0].isCorrect, null);
      assertEquals(body.results[0].feedback, null);

      // The transaction was handed an ungraded row.
      const rpcCall = h.fetchLog.find((e) =>
        e.url.includes("submit_study_guide_piece_answers")
      );
      const rpcAnswers = JSON.parse(rpcCall!.body!)._answers;
      assertEquals(rpcAnswers[0].grade, null);
      assertEquals(rpcAnswers[0].feedback, null);

      // The draft was produced from the real stem and stored manager-only,
      // without a grade.
      const draftModelCall = h.fetchLog.find(
        (e) => e.url.includes("api.openai.com") && e.url.includes("/v1/responses"),
      );
      assertEquals(draftModelCall!.body!.includes(stem), true);
      const draftInsert = h.fetchLog.find((e) =>
        e.method === "POST" && e.url.includes("/rest/v1/open_answer_ai_drafts")
      );
      assertEquals(draftInsert !== undefined, true, "expected a draft insert");
      const draft = JSON.parse(draftInsert!.body!);
      assertEquals(draft.source, "study_guide");
      assertEquals("grade" in draft, false, "a draft must never carry a grade");
    } finally {
      h.cleanup();
    }
  },
});

// Nothing is written when moderation blocks an answer — the student keeps their
// one attempt at the piece.
Deno.test({
  name: "submit-study-guide-piece: 422 and no write when moderation flags an answer",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        ...authorizedRoutes(),
        ...pieceRoutes({ id: PIECE, position: 0 }, [0, 1]),
        progressRoute(0),
        questionsRoute([openQuestion("q1", "Why?")]),
        NO_EXISTING_ANSWERS,
        openaiRoute("/v1/moderations", {
          results: [{
            flagged: true,
            categories: { harassment: true },
            category_scores: { harassment: 0.99 },
          }],
        }),
        supabaseRoute("/rest/v1/admin_notifications", {}),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        studyGuideId: GUIDE,
        offeringId: OFFERING,
        pieceId: PIECE,
        answers: [{ questionId: "q1", submission: { open_text: "abusive text" } }],
      }, { headers: AUTH_HEADERS });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 422);
      assertEquals(body.error, "content_blocked");
      assertEquals(
        h.fetchLog.some((e) => e.url.includes("submit_study_guide_piece_answers")),
        false,
      );
    } finally {
      h.cleanup();
    }
  },
});

// An empty answer must not reach the LLM, and must not consume the attempt.
Deno.test({
  name: "submit-study-guide-piece: 400 for a whitespace-only open answer",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        ...authorizedRoutes(),
        ...pieceRoutes({ id: PIECE, position: 0 }, [0]),
        progressRoute(0),
        questionsRoute([openQuestion("q1", "Why?")]),
        NO_EXISTING_ANSWERS,
      ],
    });
    try {
      const res = await h.invoke(handler, {
        studyGuideId: GUIDE,
        offeringId: OFFERING,
        pieceId: PIECE,
        answers: [{ questionId: "q1", submission: { open_text: "   " } }],
      }, { headers: AUTH_HEADERS });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 400);
      assertEquals(body.error, "Empty open answer for q1");
      assertEquals(h.fetchLog.some((e) => e.url.includes("api.openai.com")), false);
    } finally {
      h.cleanup();
    }
  },
});
