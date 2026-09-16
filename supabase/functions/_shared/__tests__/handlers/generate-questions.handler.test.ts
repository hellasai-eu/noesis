import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  createTestHarness,
  supabaseRoute,
  openaiRoute,
  parseResponse,
} from "../handler-harness.ts";
import { handler } from "../../../generate-questions/handler.ts";

const OPTS = { sanitizeOps: false, sanitizeResources: false };

// ── Input validation (no Supabase client needed) ───────────────────────

Deno.test("generate-questions: OPTIONS returns CORS headers", async () => {
  const h = createTestHarness();
  try {
    const req = new Request("http://localhost/functions/v1/generate-questions", { method: "OPTIONS" });
    const res = await handler(req);
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  } finally {
    h.cleanup();
  }
});

// ── No chapters found ──────────────────────────────────────────────────

Deno.test({
  name: "generate-questions: returns 400 when no course content found",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        // course_competencies — empty
        supabaseRoute("/rest/v1/course_competencies", []),
        // material_chapters — empty (no content)
        supabaseRoute("/rest/v1/material_chapters", []),
        // courses — returns course info
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

// ── No materials synced and no content ─────────────────────────────────

Deno.test({
  name: "generate-questions: returns 400 when no materials synced to OpenAI",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        supabaseRoute("/rest/v1/course_competencies", []),
        // material_chapters — has a chapter but no openai_file_id and no content
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
  name: "generate-questions: returns 400 when content exceeds page limit",
  ...OPTS,
  async fn() {
    // Create chapters that exceed 400 pages
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

// ── Whole-document "Other" materials (#1019) ───────────────────────────

// An "Other" material is never split into chapters, so it cannot be selected
// through the chapter tree at all. It arrives as `materialIds` and is attached
// whole, the same way the study-guide functions attach it.

const OTHER_MATERIAL = {
  id: "mat-other", title: "Course syllabus", file_name: "syllabus.pdf",
  course_id: "course-1", material_type: "other",
  openai_file_id: "file-other", page_count: 12, file_size: 2048,
};

const COURSE_ROUTE = supabaseRoute("/rest/v1/courses", {
  title: "Math", description: "", theme: "", language: "en",
  institution_id: "inst-1", institutions: { name: "Test School" },
});

// The model is asked to attribute each question to a chapter. This one names a
// chapter that was never in the batch, which is exactly what it does when the
// only source is a document with no chapters.
const AI_RESPONSE = {
  id: "resp-1",
  status: "completed",
  output: [{
    type: "message",
    content: [{
      type: "output_text",
      text: JSON.stringify({
        questions: [{
          question: "What is the late-submission policy?",
          options: ["A", "B", "C", "D"],
          correct_answers: [0],
          explanation: "Stated in the syllabus.",
          difficulty: "medium",
          chapter_ids: ["ch-imagined"],
          competency_ids: [],
          generation_rationale: "Drawn from the syllabus's assessment section.",
          diagram: null,
        }],
      }),
    }],
  }],
};

Deno.test({
  name: "generate-questions: generates from a whole document with no chapters selected",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        supabaseRoute("/rest/v1/course_competencies", []),
        supabaseRoute("/rest/v1/material_chapters", []),
        supabaseRoute("/rest/v1/course_materials", [OTHER_MATERIAL]),
        COURSE_ROUTE,
        supabaseRoute("/rest/v1/questions", []),
        openaiRoute("/v1/responses", AI_RESPONSE, { method: "POST" }),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        courseId: "course-1",
        numQuestions: 1,
        difficulty: "medium",
        chapterIds: [],
        materialIds: ["mat-other"],
      });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      assertEquals(body.questions.length, 1);

      // The document's own file is what the model was given.
      const call = h.fetchLog.find((e) => e.url.includes("api.openai.com"));
      assertEquals(call?.body?.includes("file-other"), true);

      // And it is named as chapterless, so the model is not left guessing.
      assertEquals(call?.body?.includes("Course syllabus"), true);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "generate-questions: a question from a whole document is linked to no chapter",
  ...OPTS,
  async fn() {
    // The AI named a chapter that was not in the batch. With chapters present
    // the handler falls back to the first one; here there is no chapter the
    // question could honestly belong to, so it must be left unlinked rather
    // than filed under material it did not come from.
    const h = createTestHarness({
      routes: [
        supabaseRoute("/rest/v1/course_competencies", []),
        supabaseRoute("/rest/v1/material_chapters", []),
        supabaseRoute("/rest/v1/course_materials", [OTHER_MATERIAL]),
        COURSE_ROUTE,
        supabaseRoute("/rest/v1/questions", []),
        openaiRoute("/v1/responses", AI_RESPONSE, { method: "POST" }),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        courseId: "course-1", numQuestions: 1, difficulty: "medium",
        materialIds: ["mat-other"],
      });
      const { body } = await parseResponse(res);
      assertEquals(body.questions[0].chapter_ids, []);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "generate-questions: a mixed batch does not pin document questions to the first chapter",
  ...OPTS,
  async fn() {
    // Same fallback, the other way round: a batch that mixes chapters with a
    // whole document. Some of its questions genuinely have no chapter, and the
    // handler cannot tell which — so it stops guessing for the whole batch.
    const h = createTestHarness({
      routes: [
        supabaseRoute("/rest/v1/course_competencies", []),
        supabaseRoute("/rest/v1/material_chapters", [{
          id: "ch-1", title: "Ch 1", chapter_number: 1, content_type: "text",
          content: null, openai_file_id: "file-ch1", material_id: "mat-1",
          instructions: null, file_name: "Pages 1-10",
          course_materials: {
            id: "mat-1", title: "Textbook", file_name: "book.pdf",
            course_id: "course-1", material_type: "textbook",
            openai_file_id: null, page_count: 100, file_size: 1_000_000,
          },
        }]),
        supabaseRoute("/rest/v1/course_materials", [OTHER_MATERIAL]),
        COURSE_ROUTE,
        supabaseRoute("/rest/v1/questions", []),
        openaiRoute("/v1/responses", AI_RESPONSE, { method: "POST" }),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        courseId: "course-1", numQuestions: 1, difficulty: "medium",
        chapterIds: ["ch-1"], materialIds: ["mat-other"],
      });
      const { body } = await parseResponse(res);
      assertEquals(body.questions[0].chapter_ids, []);

      // Both sources reached the model.
      const call = h.fetchLog.find((e) => e.url.includes("api.openai.com"));
      assertEquals(call?.body?.includes("file-ch1"), true);
      assertEquals(call?.body?.includes("file-other"), true);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "generate-questions: refuses a whole document belonging to another course",
  ...OPTS,
  async fn() {
    // Nothing authenticates an ordinary generation request, so a body id is
    // only ever as safe as the course filter behind it. With the material
    // filtered out there is no source left, and the request fails rather than
    // silently generating from nothing.
    const h = createTestHarness({
      routes: [
        supabaseRoute("/rest/v1/course_competencies", []),
        supabaseRoute("/rest/v1/material_chapters", []),
        supabaseRoute("/rest/v1/course_materials", [
          { ...OTHER_MATERIAL, course_id: "course-2" },
        ]),
        COURSE_ROUTE,
      ],
    });
    try {
      const res = await h.invoke(handler, {
        courseId: "course-1", numQuestions: 1, difficulty: "medium",
        materialIds: ["mat-other"],
      });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 400);
      assertEquals(body.error.includes("No course content found"), true);
      assertEquals(h.fetchLog.some((e) => e.url.includes("api.openai.com")), false);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "generate-questions: a whole document counts against the page budget",
  ...OPTS,
  async fn() {
    // The entire file is attached, so its own page count is what it costs —
    // held to the same 400-page ceiling the chapters are.
    const h = createTestHarness({
      routes: [
        supabaseRoute("/rest/v1/course_competencies", []),
        supabaseRoute("/rest/v1/material_chapters", []),
        supabaseRoute("/rest/v1/course_materials", [
          { ...OTHER_MATERIAL, page_count: 900, file_size: 4096 },
        ]),
        COURSE_ROUTE,
      ],
    });
    try {
      const res = await h.invoke(handler, {
        courseId: "course-1", numQuestions: 1, difficulty: "medium",
        materialIds: ["mat-other"],
      });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 400);
      assertEquals(body.error.includes("exceeds limits"), true);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "generate-questions: a document-only request does not sweep in the course's chapters",
  ...OPTS,
  async fn() {
    // An unfiltered chapter query means "every chapter in the course" — the
    // default when a caller names neither chapters nor competencies. A
    // document-only request sends `chapterIds: []`, which used to fall into
    // that default: the syllabus was generated from alongside the entire
    // textbook, and the page budget was spent on material nobody selected.
    let chapterQueries = 0;
    const h = createTestHarness({
      routes: [
        supabaseRoute("/rest/v1/course_competencies", []),
        {
          match: (url: string) => url.includes("/rest/v1/material_chapters"),
          respond: () => {
            chapterQueries++;
            return new Response(
              JSON.stringify([{
                id: "ch-1", title: "Ch 1", chapter_number: 1, content_type: "text",
                content: null, openai_file_id: "file-ch1", material_id: "mat-1",
                instructions: null, file_name: "Pages 1-200",
                course_materials: {
                  id: "mat-1", title: "Textbook", file_name: "book.pdf",
                  course_id: "course-1", material_type: "textbook",
                  openai_file_id: null, page_count: 200, file_size: 1_000_000,
                },
              }]),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          },
        },
        supabaseRoute("/rest/v1/course_materials", [OTHER_MATERIAL]),
        COURSE_ROUTE,
        supabaseRoute("/rest/v1/questions", []),
        openaiRoute("/v1/responses", AI_RESPONSE, { method: "POST" }),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        courseId: "course-1", numQuestions: 1, difficulty: "medium",
        chapterIds: [], materialIds: ["mat-other"],
      });
      const { status } = await parseResponse(res);
      assertEquals(status, 200);

      // The chapter table is not consulted at all.
      assertEquals(chapterQueries, 0);

      // Only the document reached the model.
      const call = h.fetchLog.find((e) => e.url.includes("api.openai.com"));
      assertEquals(call?.body?.includes("file-other"), true);
      assertEquals(call?.body?.includes("file-ch1"), false);
      assertEquals(call?.body?.includes("Ch 1"), false);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "generate-questions: naming neither chapters nor documents still means the whole course",
  ...OPTS,
  async fn() {
    // The other side of the guard above: with no `materialIds` the old
    // "generate from every chapter" default must survive untouched.
    const h = createTestHarness({
      routes: [
        supabaseRoute("/rest/v1/course_competencies", []),
        supabaseRoute("/rest/v1/material_chapters", [{
          id: "ch-1", title: "Ch 1", chapter_number: 1, content_type: "text",
          content: null, openai_file_id: "file-ch1", material_id: "mat-1",
          instructions: null, file_name: "Pages 1-10",
          course_materials: {
            id: "mat-1", title: "Textbook", file_name: "book.pdf",
            course_id: "course-1", material_type: "textbook",
            openai_file_id: null, page_count: 100, file_size: 1_000_000,
          },
        }]),
        COURSE_ROUTE,
        supabaseRoute("/rest/v1/questions", []),
        openaiRoute("/v1/responses", AI_RESPONSE, { method: "POST" }),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        courseId: "course-1", numQuestions: 1, difficulty: "medium",
      });
      const { status } = await parseResponse(res);
      assertEquals(status, 200);
      const call = h.fetchLog.find((e) => e.url.includes("api.openai.com"));
      assertEquals(call?.body?.includes("file-ch1"), true);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "generate-questions: a selected document survives the 20-file cap",
  ...OPTS,
  async fn() {
    // Only the first 20 files are sent. With the document's id appended after
    // the chapters, a selection of 20 small chapters plus one document stayed
    // inside the page budget yet dropped the document from the call — while the
    // prompt still named it as a source.
    const chapters = Array.from({ length: 24 }, (_, i) => ({
      id: `ch-${i}`, title: `Ch ${i}`, chapter_number: i, content_type: "text",
      content: null, openai_file_id: `file-ch${i}`, material_id: "mat-1",
      instructions: null, file_name: "Pages 1-2",
      course_materials: {
        id: "mat-1", title: "Textbook", file_name: "book.pdf",
        course_id: "course-1", material_type: "textbook",
        openai_file_id: null, page_count: 100, file_size: 100_000,
      },
    }));

    const h = createTestHarness({
      routes: [
        supabaseRoute("/rest/v1/course_competencies", []),
        supabaseRoute("/rest/v1/material_chapters", chapters),
        supabaseRoute("/rest/v1/course_materials", [OTHER_MATERIAL]),
        COURSE_ROUTE,
        supabaseRoute("/rest/v1/questions", []),
        openaiRoute("/v1/responses", AI_RESPONSE, { method: "POST" }),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        courseId: "course-1", numQuestions: 1, difficulty: "medium",
        chapterIds: chapters.map((c) => c.id), materialIds: ["mat-other"],
      });
      const { status } = await parseResponse(res);
      assertEquals(status, 200);

      const call = h.fetchLog.find((e) => e.url.includes("api.openai.com"));
      assertEquals(call?.body?.includes("file-other"), true);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "generate-questions: the prompt names only the sources that were actually attached",
  ...OPTS,
  async fn() {
    // Only 20 files are sent. Whatever the cap discards must also disappear
    // from the prompt's source list — a chapter the model is told it has, but
    // never receives, is one it will answer about anyway, inventing the content
    // it was denied. Chapter ids it cannot see are refused for attribution too.
    const chapters = Array.from({ length: 24 }, (_, i) => ({
      id: `ch-${i}`, title: `Chapter Title ${i}`, chapter_number: i, content_type: "text",
      content: null, openai_file_id: `file-ch${i}`, material_id: "mat-1",
      instructions: null, file_name: "Pages 1-2",
      course_materials: {
        id: "mat-1", title: "Textbook", file_name: "book.pdf",
        course_id: "course-1", material_type: "textbook",
        openai_file_id: null, page_count: 100, file_size: 100_000,
      },
    }));

    const h = createTestHarness({
      routes: [
        supabaseRoute("/rest/v1/course_competencies", []),
        supabaseRoute("/rest/v1/material_chapters", chapters),
        supabaseRoute("/rest/v1/course_materials", [OTHER_MATERIAL]),
        COURSE_ROUTE,
        supabaseRoute("/rest/v1/questions", []),
        openaiRoute("/v1/responses", AI_RESPONSE, { method: "POST" }),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        courseId: "course-1", numQuestions: 1, difficulty: "medium",
        chapterIds: chapters.map((c) => c.id), materialIds: ["mat-other"],
      });
      const { status } = await parseResponse(res);
      assertEquals(status, 200);

      const call = h.fetchLog.find((e) => e.url.includes("api.openai.com"));
      const body = call?.body ?? "";

      // The document plus the first 19 chapter files fill the cap.
      assertEquals(body.includes("file-other"), true);
      assertEquals(body.includes("Chapter Title 0"), true);

      // Chapters past the cap are attached nowhere, so they are named nowhere.
      assertEquals(body.includes("file-ch23"), false);
      assertEquals(body.includes("Chapter Title 23"), false);
    } finally {
      h.cleanup();
    }
  },
});
