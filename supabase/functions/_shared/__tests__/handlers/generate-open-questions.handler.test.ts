import { assertEquals, assertExists } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  createTestHarness,
  supabaseRoute,
  openaiRoute,
  parseResponse,
} from "../handler-harness.ts";
import { handler } from "../../../generate-open-questions/handler.ts";

const OPTS = { sanitizeOps: false, sanitizeResources: false };

// ── Input validation ───────────────────────────────────────────────────

Deno.test("generate-open-questions: OPTIONS returns CORS headers", async () => {
  const h = createTestHarness();
  try {
    const req = new Request("http://localhost/functions/v1/generate-open-questions", { method: "OPTIONS" });
    const res = await handler(req);
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  } finally {
    h.cleanup();
  }
});

// ── No chapters found ──────────────────────────────────────────────────

Deno.test({
  name: "generate-open-questions: returns 400 when no course content found",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        supabaseRoute("/rest/v1/course_competencies", []),
        supabaseRoute("/rest/v1/material_chapters", []),
        supabaseRoute("/rest/v1/courses", {
          title: "Math", description: "", theme: "", language: "en",
          institution_id: "inst-1", institutions: { name: "Test School" },
        }),
      ],
    });
    try {
      const res = await h.invoke(handler, { courseId: "course-1", numQuestions: 3, difficulty: "medium" });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 400);
      assertEquals(body.error.includes("No course content found"), true);
    } finally {
      h.cleanup();
    }
  },
});

// ── No materials synced ────────────────────────────────────────────────

Deno.test({
  name: "generate-open-questions: returns 400 when no materials synced",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        supabaseRoute("/rest/v1/course_competencies", []),
        supabaseRoute("/rest/v1/material_chapters", [{
          id: "ch-1", title: "Ch 1", chapter_number: 1, content_type: "text",
          content: null, openai_file_id: null, material_id: "mat-1",
          instructions: null, file_name: null,
          course_materials: {
            id: "mat-1", title: "Textbook", file_name: "book.pdf",
            course_id: "course-1", material_type: "textbook",
            openai_file_id: null, page_count: 10, file_size: 1000,
          },
        }]),
        supabaseRoute("/rest/v1/courses", {
          title: "Math", description: "", theme: "", language: "en",
          institution_id: "inst-1", institutions: { name: "Test School" },
        }),
      ],
    });
    try {
      const res = await h.invoke(handler, { courseId: "course-1", numQuestions: 3 });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 400);
      assertEquals(body.error.includes("No materials have been synced"), true);
    } finally {
      h.cleanup();
    }
  },
});

// ── Content size exceeds limits ────────────────────────────────────────

Deno.test({
  name: "generate-open-questions: returns 400 when content exceeds page limit",
  ...OPTS,
  async fn() {
    const bigChapters = Array.from({ length: 50 }, (_, i) => ({
      id: `ch-${i}`, title: `Ch ${i}`, chapter_number: i, content_type: "text",
      content: null, openai_file_id: `file-${i}`, material_id: "mat-1",
      instructions: null, file_name: `Pages 1-10`,
      course_materials: {
        id: "mat-1", title: "Textbook", file_name: "book.pdf",
        course_id: "course-1", material_type: "textbook",
        openai_file_id: null, page_count: 500, file_size: 50 * 1024 * 1024,
      },
    }));

    const h = createTestHarness({
      routes: [
        supabaseRoute("/rest/v1/course_competencies", []),
        supabaseRoute("/rest/v1/material_chapters", bigChapters),
        supabaseRoute("/rest/v1/courses", {
          title: "Math", description: "", theme: "", language: "en",
          institution_id: "inst-1", institutions: { name: "Test School" },
        }),
      ],
    });
    try {
      const res = await h.invoke(handler, { courseId: "course-1", numQuestions: 3 });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 400);
      assertEquals(body.error.includes("exceeds limits"), true);
    } finally {
      h.cleanup();
    }
  },
});

// ── Study-guide mode ───────────────────────────────────────────────────
//
// Questions can be written from the theory a study guide already generated.
// That theory — not the textbook behind it — is what students read, so it is
// the only source sent, while the return shape stays identical (competencies
// and all).

const THEORY_HTML = "<p>The Congress of Vienna redrew the map of Europe in 1815.</p>";

const STUDY_GUIDE_AI_RESPONSE = {
  id: "resp-1",
  status: "completed",
  output: [{
    type: "message",
    content: [{
      type: "output_text",
      text: JSON.stringify({
        questions: [{
          question: "Why did the Congress of Vienna matter for the balance of power?",
          model_answer: "It restored a multipolar equilibrium after the Napoleonic wars.",
          explanation: "Step-by-step reasoning about the balance of power.",
          difficulty: "medium",
          chapter_ids: [],
          competency_ids: ["comp-1"],
          generation_rationale: "Drawn from the guide's section on the Congress of Vienna.",
          diagram: null,
        }],
      }),
    }],
  }],
};

const COURSE_ROUTE = supabaseRoute("/rest/v1/courses", {
  title: "History", description: "", theme: "", language: "en",
  institution_id: "inst-1", institutions: { name: "Test School" },
});

// Study-guide mode is gated: the caller is resolved from the bearer token and
// must manage the course. These stand in for an institution admin.
const MANAGER_AUTH = { authorization: "Bearer test-token" };
const MANAGER_ROUTES = [
  supabaseRoute("/auth/v1/user", { id: "instr-1", email: "instr@test.local" }),
  supabaseRoute("/rest/v1/rpc/is_institution_admin", true, { method: "POST" }),
];

Deno.test({
  name: "generate-open-questions: rejects a study guide from another course",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        ...MANAGER_ROUTES,
        supabaseRoute("/rest/v1/course_competencies", []),
        supabaseRoute("/rest/v1/study_guides", {
          id: "sg-1", title: "Someone else's guide", course_id: "course-2",
        }),
        COURSE_ROUTE,
      ],
    });
    try {
      const res = await h.invoke(handler, {
        courseId: "course-1", numQuestions: 1, difficulty: "medium", studyGuideId: "sg-1",
      }, { headers: MANAGER_AUTH });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 400);
      assertEquals(body.error.includes("Study guide not found for this course"), true);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "generate-open-questions: returns 400 when the study guide has no theory yet",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        ...MANAGER_ROUTES,
        supabaseRoute("/rest/v1/course_competencies", []),
        supabaseRoute("/rest/v1/study_guide_pieces", [
          { id: "p-1", position: 0, title: "Outline only", theory_html: null },
        ]),
        supabaseRoute("/rest/v1/study_guides", {
          id: "sg-1", title: "Europe 1815-1871", course_id: "course-1",
        }),
        COURSE_ROUTE,
      ],
    });
    try {
      const res = await h.invoke(handler, {
        courseId: "course-1", numQuestions: 1, difficulty: "medium", studyGuideId: "sg-1",
      }, { headers: MANAGER_AUTH });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 400);
      assertEquals(body.error.includes("no generated theory yet"), true);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "generate-open-questions: generates from study guide theory alone, keeping the return shape",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        ...MANAGER_ROUTES,
        supabaseRoute("/rest/v1/course_competencies", [
          { id: "comp-1", title: "Historical analysis", description: null, chapter_id: null },
        ]),
        supabaseRoute("/rest/v1/study_guide_source_chapters", []),
        supabaseRoute("/rest/v1/study_guide_pieces", [
          { id: "p-1", position: 0, title: "Congress of Vienna", theory_html: THEORY_HTML },
        ]),
        supabaseRoute("/rest/v1/study_guides", {
          id: "sg-1", title: "Europe 1815-1871", course_id: "course-1",
        }),
        COURSE_ROUTE,
        supabaseRoute("/rest/v1/questions", []),
        openaiRoute("/v1/responses", STUDY_GUIDE_AI_RESPONSE, { method: "POST" }),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        courseId: "course-1",
        numQuestions: 1,
        difficulty: "medium",
        studyGuideId: "sg-1",
        pieceIds: ["p-1"],
      }, { headers: MANAGER_AUTH });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      assertEquals(body.questions.length, 1);

      // Unchanged contract: competencies still come back, still validated.
      assertEquals(body.questions[0].competency_ids, ["comp-1"]);
      assertEquals(body.questions[0].competency_id, "comp-1");
      // The guide recorded no source chapters, so there is nothing to attribute.
      assertEquals(body.questions[0].chapter_ids, []);

      // A guide with no source chapters must not fall back to "every chapter
      // in the course" — that query is skipped entirely.
      assertEquals(h.fetchLog.some((e) => e.url.includes("/rest/v1/material_chapters")), false);

      // The theory reached the model.
      const aiCall = h.fetchLog.find((e) => e.url.includes("api.openai.com") && e.method === "POST");
      assertExists(aiCall);
      assertEquals(aiCall!.body!.includes("Congress of Vienna"), true);
      assertEquals(aiCall!.body!.includes("STUDY GUIDE THEORY"), true);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "generate-open-questions: study guide questions inherit the guide's source chapters without sending their files",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        ...MANAGER_ROUTES,
        supabaseRoute("/rest/v1/course_competencies", []),
        supabaseRoute("/rest/v1/study_guide_source_chapters", [{ chapter_id: "ch-1" }]),
        supabaseRoute("/rest/v1/study_guide_pieces", [
          { id: "p-1", position: 0, title: "Congress of Vienna", theory_html: THEORY_HTML },
        ]),
        supabaseRoute("/rest/v1/study_guides", {
          id: "sg-1", title: "Europe 1815-1871", course_id: "course-1",
        }),
        supabaseRoute("/rest/v1/material_chapters", [{
          id: "ch-1", title: "The Restoration", chapter_number: 1, content_type: "pdf",
          content: "Raw textbook prose the guide was distilled from.",
          openai_file_id: "file-sentinel-1", material_id: "mat-1",
          instructions: null, file_name: "Pages 1-10",
          course_materials: {
            id: "mat-1", title: "History textbook", file_name: "history.pdf",
            course_id: "course-1", material_type: "textbook",
            openai_file_id: null, page_count: 100, file_size: 1_000_000,
          },
        }]),
        COURSE_ROUTE,
        supabaseRoute("/rest/v1/questions", []),
        openaiRoute("/v1/responses", STUDY_GUIDE_AI_RESPONSE, { method: "POST" }),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        courseId: "course-1", numQuestions: 1, difficulty: "medium", studyGuideId: "sg-1",
      }, { headers: MANAGER_AUTH });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);

      // The model returned no chapter_ids; provenance falls back to the
      // chapter the guide was built from.
      assertEquals(body.questions[0].chapter_ids, ["ch-1"]);

      const aiCall = h.fetchLog.find((e) => e.url.includes("api.openai.com") && e.method === "POST");
      assertExists(aiCall);
      // Neither the chapter's OpenAI file nor its raw prose is sent — the
      // theory is the only source the questions may be written from.
      assertEquals(aiCall!.body!.includes("file-sentinel-1"), false);
      assertEquals(aiCall!.body!.includes("Raw textbook prose"), false);
      assertEquals(aiCall!.body!.includes("Congress of Vienna"), true);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "generate-open-questions: a pathologically long guide is truncated rather than sent whole",
  ...OPTS,
  async fn() {
    const TAIL_SENTINEL = "THE-VERY-LAST-PARAGRAPH";
    const hugeTheory = "<p>" + "Europe. ".repeat(20_000) + TAIL_SENTINEL + "</p>";

    const h = createTestHarness({
      routes: [
        ...MANAGER_ROUTES,
        supabaseRoute("/rest/v1/course_competencies", []),
        supabaseRoute("/rest/v1/study_guide_source_chapters", []),
        supabaseRoute("/rest/v1/study_guide_pieces", [
          { id: "p-1", position: 0, title: "Everything at once", theory_html: hugeTheory },
        ]),
        supabaseRoute("/rest/v1/study_guides", {
          id: "sg-1", title: "Europe 1815-1871", course_id: "course-1",
        }),
        COURSE_ROUTE,
        supabaseRoute("/rest/v1/questions", []),
        openaiRoute("/v1/responses", STUDY_GUIDE_AI_RESPONSE, { method: "POST" }),
      ],
    });
    try {
      // 160k chars of theory against a 120k cap.
      assertEquals(hugeTheory.length > 120_000, true);

      const res = await h.invoke(handler, {
        courseId: "course-1", numQuestions: 1, difficulty: "medium", studyGuideId: "sg-1",
      }, { headers: MANAGER_AUTH });
      assertEquals((await parseResponse(res)).status, 200);

      const aiCall = h.fetchLog.find((e) => e.url.includes("api.openai.com") && e.method === "POST");
      assertExists(aiCall);
      assertEquals(aiCall!.body!.includes("Everything at once"), true);
      assertEquals(aiCall!.body!.includes(TAIL_SENTINEL), false);
    } finally {
      h.cleanup();
    }
  },
});

// The gateway authenticates nothing (verify_jwt = false) and the handler holds
// the service-role key, so these two tests are the whole access boundary on a
// guide's theory.

Deno.test({
  name: "generate-open-questions: study-guide mode refuses an unauthenticated caller",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        supabaseRoute("/rest/v1/course_competencies", []),
        supabaseRoute("/rest/v1/study_guides", {
          id: "sg-1", title: "Europe 1815-1871", course_id: "course-1",
        }),
        supabaseRoute("/rest/v1/study_guide_pieces", [
          { id: "p-1", position: 0, title: "Congress of Vienna", theory_html: THEORY_HTML },
        ]),
        COURSE_ROUTE,
      ],
    });
    try {
      // No Authorization header.
      const res = await h.invoke(handler, {
        courseId: "course-1", numQuestions: 1, difficulty: "medium", studyGuideId: "sg-1",
      });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 401);
      assertEquals(body.error.includes("Authorization required"), true);
      // Nothing about the guide was read, let alone sent to OpenAI.
      assertEquals(h.fetchLog.some((e) => e.url.includes("/rest/v1/study_guide")), false);
      assertEquals(h.fetchLog.some((e) => e.url.includes("api.openai.com")), false);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "generate-open-questions: study-guide mode refuses a caller who does not manage the course",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        supabaseRoute("/auth/v1/user", { id: "student-1", email: "student@test.local" }),
        // Neither an institution admin…
        supabaseRoute("/rest/v1/rpc/is_institution_admin", false, { method: "POST" }),
        // …nor an assigned instructor (membership lookup returns no row).
        supabaseRoute("/rest/v1/user_institutions", null),
        supabaseRoute("/rest/v1/course_competencies", []),
        supabaseRoute("/rest/v1/study_guides", {
          id: "sg-1", title: "Europe 1815-1871", course_id: "course-1",
        }),
        supabaseRoute("/rest/v1/study_guide_pieces", [
          { id: "p-1", position: 0, title: "Congress of Vienna", theory_html: THEORY_HTML },
        ]),
        COURSE_ROUTE,
      ],
    });
    try {
      const res = await h.invoke(handler, {
        courseId: "course-1", numQuestions: 1, difficulty: "medium", studyGuideId: "sg-1",
      }, { headers: { authorization: "Bearer student-token" } });
      const { status } = await parseResponse(res);
      assertEquals(status, 403);
      assertEquals(h.fetchLog.some((e) => e.url.includes("/rest/v1/study_guide")), false);
      assertEquals(h.fetchLog.some((e) => e.url.includes("api.openai.com")), false);
    } finally {
      h.cleanup();
    }
  },
});
