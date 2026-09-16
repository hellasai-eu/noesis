import { assertEquals, assertExists } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  createTestHarness,
  openaiRoute,
  parseResponse,
  supabaseRoute,
} from "../handler-harness.ts";
import { handler } from "../../../analyze-study-guide/handler.ts";

const OPTS = { sanitizeOps: false, sanitizeResources: false };

// Piece positions in the mocked guide are 0 and 1. Competency tokens are
// C1 (comp-1) and C2 (comp-2). Student aliases are S1..S3.
const AI_RESPONSE = {
  output: [{
    type: "message",
    content: [{
      type: "output_text",
      text: JSON.stringify({
        overall_narrative: "The class has cleared the first piece but stumbles on subtraction.",
        strengths: [
          {
            topic: "Single-digit addition",
            description: "Nearly everyone adds within ten reliably.",
            piece_positions: [0],
            competency_ids: ["C1"],
          },
        ],
        weaknesses: [
          {
            topic: "Subtraction across ten",
            description: "Students treat subtraction as commutative.",
            // 7 is not a real piece position and must be stripped; "C9" and a
            // raw-looking UUID are tokens the model invented or garbled.
            piece_positions: [1, 7],
            competency_ids: ["C2", "C9", "00000000-0000-0000-0000-000000000000"],
          },
          // Empty topic — dropped wholesale.
          { topic: "   ", description: "noise", piece_positions: [0], competency_ids: [] },
        ],
        misconceptions: [
          {
            title: "Subtraction is commutative",
            description: "Students think 3 - 5 equals 5 - 3.",
            evidence: "Most wrong answers on piece 2 picked the reversed difference.",
            piece_positions: [1],
          },
        ],
        suggested_actions: [
          {
            action: "Reteach subtraction with a number line.",
            rationale: "Every student passes through piece 2.",
            piece_positions: [1],
          },
        ],
        summary: "Addition is solid; subtraction needs a reteach.",
      }),
    }],
  }],
  status: "completed",
};

const PIECES = [
  { id: "piece-1", position: 0, title: "Adding within ten" },
  { id: "piece-2", position: 1, title: "Subtracting within ten" },
];

const PIECE_QUESTIONS = [
  {
    piece_id: "piece-1",
    position: 0,
    question_id: "q-1",
    questions: {
      id: "q-1",
      question: "2+2?",
      type: "mcq",
      difficulty: "easy",
      payload: { options: ["3", "4"] },
      competency_id: "comp-1",
    },
  },
  {
    piece_id: "piece-2",
    position: 0,
    question_id: "q-2",
    questions: {
      id: "q-2",
      question: "5-3?",
      type: "mcq",
      difficulty: "medium",
      payload: { options: ["2", "8"] },
      competency_id: "comp-2",
    },
  },
  {
    piece_id: "piece-2",
    position: 1,
    question_id: "q-3",
    questions: {
      id: "q-3",
      question: "Explain why 5-3 is not 3-5.",
      type: "open",
      difficulty: "medium",
      payload: {},
      competency_id: null,
    },
  },
];

// Three distinct submitters, so the MIN_SUBMISSIONS floor of 3 is met.
const ANSWERS = [
  { user_id: "user-1", question_id: "q-1", piece_id: "piece-1", submission: { selected_indices: [1] }, is_correct: true, grade: 100 },
  { user_id: "user-2", question_id: "q-1", piece_id: "piece-1", submission: { selected_indices: [1] }, is_correct: true, grade: 100 },
  { user_id: "user-3", question_id: "q-1", piece_id: "piece-1", submission: { selected_indices: [0] }, is_correct: false, grade: 0 },
  { user_id: "user-1", question_id: "q-2", piece_id: "piece-2", submission: { selected_indices: [1] }, is_correct: false, grade: 0 },
  {
    user_id: "user-1",
    question_id: "q-3",
    piece_id: "piece-2",
    submission: { open_text: "Because taking three from five leaves two." },
    is_correct: null,
    grade: 80,
  },
];

function baseRoutes(overrides: Record<string, unknown> = {}) {
  return [
    supabaseRoute("/auth/v1/user", { id: "instr-1", email: "instr@test.local" }),
    supabaseRoute("/rest/v1/rpc/can_manage_offering", overrides.canManage ?? true, {
      method: "POST",
    }),
    supabaseRoute(
      "/rest/v1/offering_study_guides",
      overrides.assignments ?? [{ id: "osg-1", group_id: null, published_at: "2026-07-20T00:00:00Z" }],
    ),
    supabaseRoute("/rest/v1/offerings", { course_id: "course-1", class_id: "class-1" }),
    supabaseRoute("/rest/v1/study_guides", { title: "Numbers 1-10" }),
    supabaseRoute("/rest/v1/courses", { language: "en", institution_id: "inst-1" }),
    supabaseRoute("/rest/v1/class_enrollments", overrides.enrollments ?? [
      { user_id: "user-1" },
      { user_id: "user-2" },
      { user_id: "user-3" },
    ]),
    supabaseRoute("/rest/v1/study_guide_pieces", PIECES),
    supabaseRoute("/rest/v1/study_guide_piece_questions", PIECE_QUESTIONS),
    supabaseRoute("/rest/v1/course_competencies", [
      { id: "comp-1", title: "Addition within ten" },
      { id: "comp-2", title: "Subtraction within ten" },
    ]),
    supabaseRoute("/rest/v1/study_guide_answers", overrides.answers ?? ANSWERS),
    supabaseRoute("/rest/v1/study_guide_progress", overrides.progress ?? [
      { user_id: "user-1", current_piece_position: 1, completed_at: null },
      { user_id: "user-2", current_piece_position: 1, completed_at: null },
      { user_id: "user-3", current_piece_position: 1, completed_at: null },
    ]),
    supabaseRoute("/rest/v1/study_guide_analyses", overrides.saved ?? {
      id: "sga-1",
      study_guide_id: "guide-1",
      offering_id: "off-1",
      report: {},
      submission_count: 3,
      low_confidence: true,
    }, { method: "POST" }),
    openaiRoute("/v1/responses", overrides.aiResponse ?? AI_RESPONSE, { method: "POST" }),
  ];
}

/** The upserted row, read back out of the fetch log. */
function savedRowFrom(fetchLog: Array<{ url: string; method: string; body?: string }>) {
  const upsert = fetchLog.find(
    (e) => e.url.includes("/rest/v1/study_guide_analyses") && e.method === "POST",
  );
  assertExists(upsert);
  const parsed = JSON.parse(upsert!.body!);
  // deno-lint-ignore no-explicit-any
  return (Array.isArray(parsed) ? parsed[0] : parsed) as any;
}

/** Everything sent to the model as user-message text. */
function outboundPromptText(
  fetchLog: Array<{ url: string; method: string; body?: string }>,
): string {
  const call = fetchLog.find((e) => e.url.includes("api.openai.com") && e.method === "POST");
  assertExists(call);
  const body = JSON.parse(call!.body!);
  // deno-lint-ignore no-explicit-any
  return (body.input as any[])
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join(" ");
}

Deno.test("analyze-study-guide: OPTIONS returns CORS headers", async () => {
  const h = createTestHarness();
  try {
    const req = new Request("http://localhost/functions/v1/analyze-study-guide", {
      method: "OPTIONS",
    });
    const res = await handler(req);
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  } finally {
    h.cleanup();
  }
});

Deno.test("analyze-study-guide: 400 when study_guide_id / offering_id missing", async () => {
  const h = createTestHarness();
  try {
    const res = await h.invoke(handler, {});
    assertEquals((await parseResponse(res)).status, 400);
  } finally {
    h.cleanup();
  }
});

Deno.test({
  name: "analyze-study-guide: 403 when the caller cannot manage the offering",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        supabaseRoute("/auth/v1/user", { id: "instr-1" }),
        supabaseRoute("/rest/v1/rpc/can_manage_offering", false, { method: "POST" }),
      ],
    });
    try {
      const res = await h.invoke(handler, { study_guide_id: "guide-1", offering_id: "off-1" }, {
        headers: { authorization: "Bearer test-token" },
      });
      assertEquals((await parseResponse(res)).status, 403);
      // Authorization must fail before any student data is read.
      assertEquals(
        h.fetchLog.some((e) => e.url.includes("/rest/v1/study_guide_answers")),
        false,
      );
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "analyze-study-guide: 404 when the guide is not published to this offering",
  ...OPTS,
  async fn() {
    const h = createTestHarness({ routes: baseRoutes({ assignments: [] }) });
    try {
      const res = await h.invoke(handler, { study_guide_id: "guide-1", offering_id: "off-1" }, {
        headers: { authorization: "Bearer test-token" },
      });
      assertEquals((await parseResponse(res)).status, 404);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "analyze-study-guide: below the submission floor, no AI call is made",
  ...OPTS,
  async fn() {
    // Two distinct submitters — one short of MIN_SUBMISSIONS (3).
    const h = createTestHarness({
      routes: baseRoutes({
        answers: [
          { user_id: "user-1", question_id: "q-1", piece_id: "piece-1", submission: { selected_indices: [1] }, is_correct: true, grade: 100 },
          { user_id: "user-2", question_id: "q-1", piece_id: "piece-1", submission: { selected_indices: [1] }, is_correct: true, grade: 100 },
        ],
      }),
    });
    try {
      const res = await h.invoke(handler, { study_guide_id: "guide-1", offering_id: "off-1" }, {
        headers: { authorization: "Bearer test-token" },
      });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      assertEquals(body.insufficientData, true);
      assertEquals(body.submission_count, 2);
      // The floor exists to stop us paying for — and publishing — a reading of
      // two students, so nothing may reach the model.
      assertEquals(h.fetchLog.some((e) => e.url.includes("api.openai.com")), false);
      // And nothing may be cached either.
      assertEquals(
        h.fetchLog.some(
          (e) => e.url.includes("/rest/v1/study_guide_analyses") && e.method === "POST",
        ),
        false,
      );
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "analyze-study-guide: an empty roster short-circuits before the model",
  ...OPTS,
  async fn() {
    const h = createTestHarness({ routes: baseRoutes({ enrollments: [] }) });
    try {
      const res = await h.invoke(handler, { study_guide_id: "guide-1", offering_id: "off-1" }, {
        headers: { authorization: "Bearer test-token" },
      });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      assertEquals(body.insufficientData, true);
      assertEquals(body.submission_count, 0);
      assertEquals(h.fetchLog.some((e) => e.url.includes("api.openai.com")), false);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "analyze-study-guide: no student PII reaches the model — only opaque tokens",
  ...OPTS,
  async fn() {
    const h = createTestHarness({ routes: baseRoutes() });
    try {
      const res = await h.invoke(handler, { study_guide_id: "guide-1", offering_id: "off-1" }, {
        headers: { authorization: "Bearer test-token" },
      });
      assertEquals((await parseResponse(res)).status, 200);

      const text = outboundPromptText(h.fetchLog);
      // Profiles are keyed by student_id, never by a name field.
      assertEquals(text.includes('"student_id"'), true);
      assertEquals(text.includes('"full_name"'), false);
      assertEquals(text.includes("full_name"), false);
      assertEquals(text.includes("email"), false);
      // Aliases are the SHORT tokens — raw user_ids never leave the database,
      // because a model cannot echo a UUID back verbatim (see #846).
      assertEquals(text.includes('"S1"'), true);
      assertEquals(text.includes("user-1"), false);
      assertEquals(text.includes("user-2"), false);
      assertEquals(text.includes("user-3"), false);
      // Competency ids are tokenised for the same reason.
      assertEquals(text.includes('"C1"'), true);
      assertEquals(text.includes("comp-1"), false);
      assertEquals(text.includes("comp-2"), false);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "analyze-study-guide: the alias round-trip maps tokens back and drops garbled ones",
  ...OPTS,
  async fn() {
    const h = createTestHarness({ routes: baseRoutes() });
    try {
      const res = await h.invoke(handler, { study_guide_id: "guide-1", offering_id: "off-1" }, {
        headers: { authorization: "Bearer test-token" },
      });
      assertEquals((await parseResponse(res)).status, 200);

      const savedRow = savedRowFrom(h.fetchLog);
      const report = savedRow.report;

      // C1 maps back to the real competency id — the whole point of the token.
      assertEquals(report.strengths[0].competency_ids, ["comp-1"]);
      // The valid token survives while the hallucinated C9 and the UUID the
      // model echoed instead of a token are dropped individually.
      assertEquals(report.weaknesses[0].competency_ids, ["comp-2"]);
      // Piece position 7 doesn't exist in this guide and is stripped.
      assertEquals(report.weaknesses[0].piece_positions, [1]);
      // The empty-topic finding is dropped, so one weakness survives.
      assertEquals(report.weaknesses.length, 1);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "analyze-study-guide: thin pieces and competencies are flagged low-confidence",
  ...OPTS,
  async fn() {
    const h = createTestHarness({ routes: baseRoutes() });
    try {
      const res = await h.invoke(handler, { study_guide_id: "guide-1", offering_id: "off-1" }, {
        headers: { authorization: "Bearer test-token" },
      });
      assertEquals((await parseResponse(res)).status, 200);

      const savedRow = savedRowFrom(h.fetchLog);
      // Piece 0 has all three students; piece 1 has only user-1. A gated
      // sequence always has a thin tail, so the tail must be marked rather
      // than read as a finding.
      assertEquals(savedRow.report.low_confidence_piece_positions, [1]);
      // comp-1 has 3 responses; comp-2 has 1.
      assertEquals(savedRow.report.low_confidence_competency_ids, ["comp-2"]);
      // 3 submitters < LOW_CONFIDENCE_THRESHOLD (5) → whole report caveated.
      assertEquals(savedRow.low_confidence, true);
      assertEquals(savedRow.submission_count, 3);

      // The flags are also handed to the model so it phrases those findings
      // tentatively rather than inventing certainty.
      const text = outboundPromptText(h.fetchLog);
      assertEquals(text.includes('"low_confidence": true'), true);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "analyze-study-guide: competency confidence counts students, not answers",
  ...OPTS,
  async fn() {
    // One learner working through three questions on a competency is one data
    // point about the class, not three. Counting answers would clear the
    // threshold here and publish a single student's confusion as class-level
    // evidence — while the raw table beside it, which counts respondents, still
    // marked the same competency tentative.
    const h = createTestHarness({
      routes: baseRoutes({
        answers: [
          // Three students on comp-1's question → a real class-level signal.
          { user_id: "user-1", question_id: "q-1", piece_id: "piece-1", submission: { selected_indices: [1] }, is_correct: true, grade: 100 },
          { user_id: "user-2", question_id: "q-1", piece_id: "piece-1", submission: { selected_indices: [1] }, is_correct: true, grade: 100 },
          { user_id: "user-3", question_id: "q-1", piece_id: "piece-1", submission: { selected_indices: [0] }, is_correct: false, grade: 0 },
          // user-1 alone races ahead: three answers, but still ONE learner.
          { user_id: "user-1", question_id: "q-2", piece_id: "piece-2", submission: { selected_indices: [1] }, is_correct: false, grade: 0 },
          { user_id: "user-1", question_id: "q-3", piece_id: "piece-2", submission: { open_text: "..." }, is_correct: null, grade: 40 },
        ],
      }),
    });
    try {
      const res = await h.invoke(handler, { study_guide_id: "guide-1", offering_id: "off-1" }, {
        headers: { authorization: "Bearer test-token" },
      });
      assertEquals((await parseResponse(res)).status, 200);

      const savedRow = savedRowFrom(h.fetchLog);
      // comp-2 is answered twice but by one student → still tentative.
      assertEquals(savedRow.report.low_confidence_competency_ids, ["comp-2"]);

      // The model is shown both numbers so it can see why comp-2 is flagged.
      const text = outboundPromptText(h.fetchLog);
      assertEquals(text.includes('"students"'), true);
      assertEquals(text.includes('"answers"'), true);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "analyze-study-guide: answers for questions no longer in the guide are ignored",
  ...OPTS,
  async fn() {
    // The instructor deleted a piece after students answered it. Its answers
    // can't be attributed to any piece or competency, so counting them would
    // both inflate the submitter count past the floor and skew every average.
    const h = createTestHarness({
      routes: baseRoutes({
        answers: [
          { user_id: "user-1", question_id: "q-1", piece_id: "piece-1", submission: { selected_indices: [1] }, is_correct: true, grade: 100 },
          { user_id: "user-2", question_id: "q-1", piece_id: "piece-1", submission: { selected_indices: [1] }, is_correct: true, grade: 100 },
          { user_id: "user-3", question_id: "gone", piece_id: "deleted-piece", submission: {}, is_correct: true, grade: 100 },
        ],
      }),
    });
    try {
      const res = await h.invoke(handler, { study_guide_id: "guide-1", offering_id: "off-1" }, {
        headers: { authorization: "Bearer test-token" },
      });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      // user-3's orphaned answer doesn't count, so we're still below the floor.
      assertEquals(body.insufficientData, true);
      assertEquals(body.submission_count, 2);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "analyze-study-guide: a group filter narrows the roster before the floor is applied",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        supabaseRoute("/auth/v1/user", { id: "instr-1" }),
        supabaseRoute("/rest/v1/rpc/can_manage_offering", true, { method: "POST" }),
        supabaseRoute("/rest/v1/offering_study_guides", [
          { id: "osg-1", group_id: null, published_at: "2026-07-20T00:00:00Z" },
        ]),
        supabaseRoute("/rest/v1/offerings", { course_id: "course-1", class_id: "class-1" }),
        supabaseRoute("/rest/v1/study_guides", { title: "Numbers 1-10" }),
        supabaseRoute("/rest/v1/courses", { language: "en", institution_id: "inst-1" }),
        supabaseRoute("/rest/v1/class_enrollments", [
          { user_id: "user-1" },
          { user_id: "user-2" },
          { user_id: "user-3" },
        ]),
        supabaseRoute("/rest/v1/offering_group_members", [{ user_id: "user-1" }]),
        supabaseRoute("/rest/v1/offering_groups", { id: "grp-1" }),
        supabaseRoute("/rest/v1/study_guide_pieces", PIECES),
        supabaseRoute("/rest/v1/study_guide_piece_questions", PIECE_QUESTIONS),
        supabaseRoute("/rest/v1/course_competencies", []),
        // What the DB returns once the roster has been narrowed to the group.
        supabaseRoute(
          "/rest/v1/study_guide_answers",
          ANSWERS.filter((a) => a.user_id === "user-1"),
        ),
        supabaseRoute("/rest/v1/study_guide_progress", []),
        openaiRoute("/v1/responses", AI_RESPONSE, { method: "POST" }),
      ],
    });
    try {
      const res = await h.invoke(
        handler,
        { study_guide_id: "guide-1", offering_id: "off-1", group_id: "grp-1" },
        { headers: { authorization: "Bearer test-token" } },
      );
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);

      // The answers query must be scoped to the group's members only — that
      // narrowing is what keeps a group view from reporting the whole class.
      const answersCall = h.fetchLog.find((e) => e.url.includes("/rest/v1/study_guide_answers"));
      assertExists(answersCall);
      assertEquals(answersCall!.url.includes("user-1"), true);
      assertEquals(answersCall!.url.includes("user-2"), false);
      assertEquals(answersCall!.url.includes("user-3"), false);

      // Only user-1 is in the group, so the group is below the floor even
      // though the whole class is not.
      assertEquals(body.insufficientData, true);
      assertEquals(body.submission_count, 1);
      assertEquals(h.fetchLog.some((e) => e.url.includes("api.openai.com")), false);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "analyze-study-guide: the cached row is keyed by scope, not just guide + class",
  ...OPTS,
  async fn() {
    // A whole-class refresh writes group_id NULL; a group refresh writes the
    // group. Sharing one slot would let a group-scoped run overwrite the
    // whole-class report, and the panel — which cannot tell which cohort a
    // stored row describes — would then label one group's weaknesses as the
    // whole class's.
    const wholeClass = createTestHarness({ routes: baseRoutes() });
    try {
      await wholeClass.invoke(handler, { study_guide_id: "guide-1", offering_id: "off-1" }, {
        headers: { authorization: "Bearer test-token" },
      });
      const row = savedRowFrom(wholeClass.fetchLog);
      assertEquals(row.group_id, null);

      const upsert = wholeClass.fetchLog.find(
        (e) => e.url.includes("/rest/v1/study_guide_analyses") && e.method === "POST",
      );
      // The conflict target must name the scope column too, or the upsert
      // silently collapses the two scopes back into one row.
      assertEquals(upsert!.url.includes("group_id"), true);
    } finally {
      wholeClass.cleanup();
    }

    const grouped = createTestHarness({
      routes: [
        supabaseRoute("/rest/v1/offering_group_members", [
          { user_id: "user-1" },
          { user_id: "user-2" },
          { user_id: "user-3" },
        ]),
        supabaseRoute("/rest/v1/offering_groups", { id: "grp-1" }),
        ...baseRoutes(),
      ],
    });
    try {
      await grouped.invoke(
        handler,
        { study_guide_id: "guide-1", offering_id: "off-1", group_id: "grp-1" },
        { headers: { authorization: "Bearer test-token" } },
      );
      assertEquals(savedRowFrom(grouped.fetchLog).group_id, "grp-1");
    } finally {
      grouped.cleanup();
    }
  },
});

Deno.test({
  name:
    "analyze-study-guide: a group-only assignment does not make the whole class the cohort",
  ...OPTS,
  async fn() {
    // The guide is published ONLY to grp-1, whose sole member is user-1. That
    // is still "assigned to this offering", so the publication check passes —
    // but the assigned population is the group, not the class. Reading the full
    // roster would count user-2 and user-3, who were never given the guide,
    // and cache the result under the whole-class scope.
    const h = createTestHarness({
      routes: [
        supabaseRoute("/auth/v1/user", { id: "instr-1" }),
        supabaseRoute("/rest/v1/rpc/can_manage_offering", true, { method: "POST" }),
        supabaseRoute("/rest/v1/offering_study_guides", [
          { id: "osg-1", group_id: "grp-1", published_at: "2026-07-20T00:00:00Z" },
        ]),
        supabaseRoute("/rest/v1/offerings", { course_id: "course-1", class_id: "class-1" }),
        supabaseRoute("/rest/v1/study_guides", { title: "Numbers 1-10" }),
        supabaseRoute("/rest/v1/courses", { language: "en", institution_id: "inst-1" }),
        supabaseRoute("/rest/v1/class_enrollments", [
          { user_id: "user-1" },
          { user_id: "user-2" },
          { user_id: "user-3" },
        ]),
        // Membership of the assigned group.
        supabaseRoute("/rest/v1/offering_group_members", [{ user_id: "user-1" }]),
        supabaseRoute("/rest/v1/study_guide_pieces", PIECES),
        supabaseRoute("/rest/v1/study_guide_piece_questions", PIECE_QUESTIONS),
        supabaseRoute("/rest/v1/course_competencies", []),
        supabaseRoute("/rest/v1/study_guide_answers", []),
        supabaseRoute("/rest/v1/study_guide_progress", []),
        openaiRoute("/v1/responses", AI_RESPONSE, { method: "POST" }),
      ],
    });
    try {
      // No group filter — the instructor asked for the unfiltered view.
      const res = await h.invoke(handler, { study_guide_id: "guide-1", offering_id: "off-1" }, {
        headers: { authorization: "Bearer test-token" },
      });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      assertEquals(body.insufficientData, true);

      // The answers query must be scoped to the assigned student only.
      const answersCall = h.fetchLog.find((e) => e.url.includes("/rest/v1/study_guide_answers"));
      assertExists(answersCall);
      assertEquals(answersCall!.url.includes("user-1"), true);
      assertEquals(answersCall!.url.includes("user-2"), false);
      assertEquals(answersCall!.url.includes("user-3"), false);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "analyze-study-guide: a whole-class assignment keeps the whole roster",
  ...OPTS,
  async fn() {
    // The mirror of the test above: with a whole-class row present, no
    // narrowing happens and every enrolled student counts.
    const h = createTestHarness({ routes: baseRoutes() });
    try {
      const res = await h.invoke(handler, { study_guide_id: "guide-1", offering_id: "off-1" }, {
        headers: { authorization: "Bearer test-token" },
      });
      assertEquals((await parseResponse(res)).status, 200);

      const answersCall = h.fetchLog.find((e) => e.url.includes("/rest/v1/study_guide_answers"));
      assertExists(answersCall);
      for (const id of ["user-1", "user-2", "user-3"]) {
        assertEquals(answersCall!.url.includes(id), true);
      }
      // And no group-membership lookup was needed at all.
      assertEquals(
        h.fetchLog.some((e) => e.url.includes("/rest/v1/offering_group_members")),
        false,
      );
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name:
    "analyze-study-guide: refuses a group of this class the guide never reached",
  ...OPTS,
  async fn() {
    // The guide is published only to grp-1. Asking for grp-other — a real group
    // of the same class — would intersect its members with the assigned
    // population and cache the overlap under grp-other's name, implying that
    // whole group had been assigned the guide. The caller is authorized and the
    // data would be real; it is the LABEL that would be false, and the cache is
    // scope-keyed so it would persist.
    const h = createTestHarness({
      routes: [
        supabaseRoute("/auth/v1/user", { id: "instr-1" }),
        supabaseRoute("/rest/v1/rpc/can_manage_offering", true, { method: "POST" }),
        supabaseRoute("/rest/v1/offering_study_guides", [
          { id: "osg-1", group_id: "grp-1", published_at: "2026-07-20T00:00:00Z" },
        ]),
        supabaseRoute("/rest/v1/offerings", { course_id: "course-1", class_id: "class-1" }),
        supabaseRoute("/rest/v1/study_guides", { title: "Numbers 1-10" }),
        supabaseRoute("/rest/v1/courses", { language: "en", institution_id: "inst-1" }),
        supabaseRoute("/rest/v1/class_enrollments", [{ user_id: "user-1" }]),
        supabaseRoute("/rest/v1/offering_groups", { id: "grp-other" }),
        supabaseRoute("/rest/v1/offering_group_members", [{ user_id: "user-1" }]),
      ],
    });
    try {
      const res = await h.invoke(
        handler,
        { study_guide_id: "guide-1", offering_id: "off-1", group_id: "grp-other" },
        { headers: { authorization: "Bearer test-token" } },
      );
      const { status, body } = await parseResponse(res);
      assertEquals(status, 404);
      assertEquals(body.error, "This study guide is not assigned to that group");
      assertEquals(h.fetchLog.some((e) => e.url.includes("api.openai.com")), false);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name:
    "analyze-study-guide: a whole-class assignment may still be sliced by any group",
  ...OPTS,
  async fn() {
    // The legitimate case the rule above must not break: everyone was assigned
    // the guide, so "how is my reading-support group doing on it?" is a real
    // question even though that group is not itself an assignment target.
    const h = createTestHarness({
      routes: [
        supabaseRoute("/rest/v1/offering_groups", { id: "grp-adhoc" }),
        supabaseRoute("/rest/v1/offering_group_members", [
          { user_id: "user-1" },
          { user_id: "user-2" },
          { user_id: "user-3" },
        ]),
        ...baseRoutes(),
      ],
    });
    try {
      const res = await h.invoke(
        handler,
        { study_guide_id: "guide-1", offering_id: "off-1", group_id: "grp-adhoc" },
        { headers: { authorization: "Bearer test-token" } },
      );
      assertEquals((await parseResponse(res)).status, 200);
      assertEquals(savedRowFrom(h.fetchLog).group_id, "grp-adhoc");
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "analyze-study-guide: 404 when the named group belongs to another class",
  ...OPTS,
  async fn() {
    // `offering_groups` is queried with both the group id AND the offering id,
    // so a group from a class the caller doesn't manage returns nothing. Without
    // this check, naming someone else's group would read its membership back
    // through the analysis.
    const h = createTestHarness({
      routes: [
        supabaseRoute("/auth/v1/user", { id: "instr-1" }),
        supabaseRoute("/rest/v1/rpc/can_manage_offering", true, { method: "POST" }),
        supabaseRoute("/rest/v1/offering_study_guides", [
          { id: "osg-1", group_id: null, published_at: "2026-07-20T00:00:00Z" },
        ]),
        supabaseRoute("/rest/v1/offerings", { course_id: "course-1", class_id: "class-1" }),
        supabaseRoute("/rest/v1/study_guides", { title: "Numbers 1-10" }),
        supabaseRoute("/rest/v1/courses", { language: "en", institution_id: "inst-1" }),
        supabaseRoute("/rest/v1/class_enrollments", [{ user_id: "user-1" }]),
        // No row: the group's offering_id doesn't match.
        supabaseRoute("/rest/v1/offering_groups", null),
      ],
    });
    try {
      const res = await h.invoke(
        handler,
        { study_guide_id: "guide-1", offering_id: "off-1", group_id: "foreign-grp" },
        { headers: { authorization: "Bearer test-token" } },
      );
      assertEquals((await parseResponse(res)).status, 404);
      assertEquals(
        h.fetchLog.some((e) => e.url.includes("/rest/v1/offering_group_members")),
        false,
      );
    } finally {
      h.cleanup();
    }
  },
});

// ---------------------------------------------------------------------------
// Clusters
// ---------------------------------------------------------------------------

/** An AI_RESPONSE variant carrying the given clusters. */
// deno-lint-ignore no-explicit-any
function aiResponseWithClusters(clusters: any[]) {
  const payload = JSON.parse(AI_RESPONSE.output[0].content[0].text);
  payload.clusters = clusters;
  return {
    output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(payload) }] }],
    status: "completed",
  };
}

Deno.test({
  name: "analyze-study-guide: cluster aliases map back to real user_ids",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: baseRoutes({
        aiResponse: aiResponseWithClusters([
          {
            label: "Treats subtraction as commutative",
            rationale: "Both reversed the difference on piece 2.",
            summary: "Reteach subtraction on a number line.",
            member_user_ids: ["S1", "S2"],
          },
          {
            label: "Secure on addition",
            rationale: "Clean run through piece 1.",
            summary: "Ready for extension work.",
            member_user_ids: ["S3"],
          },
        ]),
      }),
    });
    try {
      const res = await h.invoke(handler, { study_guide_id: "guide-1", offering_id: "off-1" }, {
        headers: { authorization: "Bearer test-token" },
      });
      assertEquals((await parseResponse(res)).status, 200);

      const saved = savedRowFrom(h.fetchLog);
      assertEquals(saved.clusters.length, 2);
      // Aliases in, real ids out — the panel needs ids it can join to a roster.
      assertEquals(saved.clusters[0].member_user_ids, ["user-1", "user-2"]);
      assertEquals(saved.clusters[1].member_user_ids, ["user-3"]);
      assertEquals(saved.clusters[0].label, "Treats subtraction as commutative");
      assertEquals(saved.clusters[0].summary, "Reteach subtraction on a number line.");

      // And the aliases are all the model ever saw.
      const text = outboundPromptText(h.fetchLog);
      assertEquals(text.includes("user-1"), false);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "analyze-study-guide: a student cannot land in two clusters, and bad aliases are dropped",
  ...OPTS,
  async fn() {
    // These clusters become real offering groups downstream, where a duplicate
    // would put one learner in two groups from a single act — so the duplicate
    // is resolved here, in favour of the first cluster that claimed them.
    const h = createTestHarness({
      routes: baseRoutes({
        aiResponse: aiResponseWithClusters([
          {
            label: "First claim",
            rationale: "r",
            summary: "s",
            member_user_ids: ["S1", "S99", "user-2"],
          },
          { label: "Second claim", rationale: "r", summary: "s", member_user_ids: ["S1", "S2"] },
          // Nothing resolvable at all — the cluster itself is dropped, not
          // stored as an empty group the instructor would have to clean up.
          { label: "All noise", rationale: "r", summary: "s", member_user_ids: ["s1", "S42"] },
        ]),
      }),
    });
    try {
      const res = await h.invoke(handler, { study_guide_id: "guide-1", offering_id: "off-1" }, {
        headers: { authorization: "Bearer test-token" },
      });
      assertEquals((await parseResponse(res)).status, 200);

      const saved = savedRowFrom(h.fetchLog);
      assertEquals(saved.clusters.length, 2);
      // S99 is invented and "user-2" is a raw id the model echoed instead of a
      // token; neither resolves, so only S1 survives the first cluster.
      assertEquals(saved.clusters[0].member_user_ids, ["user-1"]);
      // S1 was already used, so the second cluster keeps only S2.
      assertEquals(saved.clusters[1].member_user_ids, ["user-2"]);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "analyze-study-guide: no usable model clusters falls back to score bands",
  ...OPTS,
  async fn() {
    // The mocked AI_RESPONSE has no clusters at all — the same situation as a
    // model that returned only unresolvable aliases. With submitters present
    // the section must still have something to act on.
    const h = createTestHarness({ routes: baseRoutes() });
    try {
      const res = await h.invoke(handler, { study_guide_id: "guide-1", offering_id: "off-1" }, {
        headers: { authorization: "Bearer test-token" },
      });
      assertEquals((await parseResponse(res)).status, 200);

      const saved = savedRowFrom(h.fetchLog);
      // user-1: 2 of 3 correct (67%) → approaching. user-2: 1/1 → on track.
      // user-3: 0/1 → needs support.
      const byLabel = new Map<string, string[]>(
        // deno-lint-ignore no-explicit-any
        saved.clusters.map((c: any) => [c.label, c.member_user_ids]),
      );
      assertEquals(byLabel.get("Needs support"), ["user-3"]);
      assertEquals(byLabel.get("Approaching mastery"), ["user-1"]);
      assertEquals(byLabel.get("On track"), ["user-2"]);
      // Every submitter is placed exactly once.
      assertEquals(
        // deno-lint-ignore no-explicit-any
        saved.clusters.flatMap((c: any) => c.member_user_ids).length,
        3,
      );
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "analyze-study-guide: clusters are capped to the number of submitters",
  ...OPTS,
  async fn() {
    // Three submitters cap the target at 3 even though MAX_CLUSTERS is 5, and
    // the cap is enforced on the way out as well as stated in the prompt.
    const h = createTestHarness({
      routes: baseRoutes({
        aiResponse: aiResponseWithClusters([
          { label: "One", rationale: "r", summary: "s", member_user_ids: ["S1"] },
          { label: "Two", rationale: "r", summary: "s", member_user_ids: ["S2"] },
          { label: "Three", rationale: "r", summary: "s", member_user_ids: ["S3"] },
          { label: "Four", rationale: "r", summary: "s", member_user_ids: ["S1", "S2", "S3"] },
        ]),
      }),
    });
    try {
      const res = await h.invoke(handler, { study_guide_id: "guide-1", offering_id: "off-1" }, {
        headers: { authorization: "Bearer test-token" },
      });
      assertEquals((await parseResponse(res)).status, 200);

      const saved = savedRowFrom(h.fetchLog);
      assertEquals(saved.clusters.length, 3);
      assertEquals(outboundPromptText(h.fetchLog).includes("Target maximum number of clusters: 3"), true);
    } finally {
      h.cleanup();
    }
  },
});
