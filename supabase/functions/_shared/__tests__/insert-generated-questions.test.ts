/**
 * Tests for the server-side unified question insert helper (#696).
 *
 * Uses `createTestHarness` from `handler-harness.ts` to intercept `fetch` so a
 * real `@supabase/supabase-js` client runs against in-memory routes. Verifies:
 *
 *   - Each of the 5 question types inserts the unified row + junctions
 *     (canonical `question_chapters` / `question_competencies`).
 *   - `open` rows are rebuilt with `answering_mode: "single"` (per #618)
 *     and the diagram from the generator's `payload.diagram` survives
 *     (per #627/#636).
 *   - A failed row does not abort the batch; later rows still land.
 *   - Junction failure is reported as a warning on the inserted row,
 *     not as a fatal error (the question itself landed).
 *   - Empty chapter / competency arrays do not POST junction rows.
 */
import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  createTestHarness,
  type FetchLogEntry,
  type MockRoute,
} from "./handler-harness.ts";
import { insertGeneratedQuestions } from "../insert-generated-questions.ts";

const OPTS = { sanitizeOps: false, sanitizeResources: false };

const SUPABASE_URL = "http://localhost:54321";
const SERVICE_KEY = "test-service-role-key";

function makeClient() {
  return createClient(SUPABASE_URL, SERVICE_KEY);
}

/**
 * A `questions` POST route that returns a new id per call, so multi-row
 * batches can be distinguished in assertions. `.select("id").single()`
 * expects a singleton object, which is what we return here.
 */
function questionsInsertRoute(opts?: { failOnIndex?: number }): MockRoute {
  let calls = 0;
  return {
    match: (url, init) => {
      const isPost = (init?.method ?? "GET").toUpperCase() === "POST";
      return isPost && url.includes("/rest/v1/questions") &&
        !url.includes("question_chapters") &&
        !url.includes("question_competencies");
    },
    respond: () => {
      const idx = calls++;
      if (opts?.failOnIndex === idx) {
        return new Response(
          JSON.stringify({
            code: "23505",
            message: "duplicate key value violates unique constraint",
          }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ id: `inserted-${idx}` }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    },
  };
}

function junctionRoute(
  path: string,
  opts?: { failOnIndex?: number },
): MockRoute {
  let calls = 0;
  return {
    match: (url, init) => {
      const isPost = (init?.method ?? "GET").toUpperCase() === "POST";
      return isPost && url.includes(path);
    },
    respond: () => {
      const idx = calls++;
      if (opts?.failOnIndex === idx) {
        return new Response(
          JSON.stringify({
            code: "23503",
            message: "foreign key violation",
          }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("[]", {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    },
  };
}

function postsTo(log: FetchLogEntry[], pathFragment: string): FetchLogEntry[] {
  return log.filter(
    (e) =>
      e.method.toUpperCase() === "POST" && e.url.includes(pathFragment),
  );
}

function postsToQuestions(log: FetchLogEntry[]): FetchLogEntry[] {
  return log.filter(
    (e) =>
      e.method.toUpperCase() === "POST" &&
      e.url.includes("/rest/v1/questions") &&
      !e.url.includes("question_chapters") &&
      !e.url.includes("question_competencies"),
  );
}

// ── Type coverage ────────────────────────────────────────────────────────

Deno.test({
  name: "insertGeneratedQuestions: mcq writes question + chapter + competency junctions",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        junctionRoute("/rest/v1/question_chapters"),
        junctionRoute("/rest/v1/question_competencies"),
        questionsInsertRoute(),
      ],
    });
    try {
      const result = await insertGeneratedQuestions(makeClient(), {
        type: "mcq",
        courseId: "course-1",
        createdBy: "user-1",
        generated: [
          {
            question: "What is 2 + 2?",
            type: "mcq",
            payload: { options: ["3", "4", "5"] },
            answer_key: { correct_indices: [1], correct_index: 1 },
            difficulty: "easy",
            hidden: false,
            chapter_ids: ["ch-1", "ch-2"],
            competency_ids: ["comp-1"],
          },
        ],
      });

      assertEquals(result.errors, []);
      assertEquals(result.inserted.length, 1);
      assertEquals(result.inserted[0].id, "inserted-0");
      assertEquals(result.inserted[0].chapterLinksWarning, undefined);
      assertEquals(result.inserted[0].competencyLinksWarning, undefined);

      assertEquals(postsToQuestions(h.fetchLog).length, 1);
      const qBody = JSON.parse(
        postsToQuestions(h.fetchLog)[0].body!,
      ) as Record<string, unknown>;
      assertEquals(qBody.type, "mcq");
      assertEquals(qBody.course_id, "course-1");
      assertEquals(qBody.created_by, "user-1");
      assertEquals(qBody.is_user_generated, false);
      // Junction-only / open-only fields must not bleed into the row.
      assertEquals("chapter_ids" in qBody, false);
      assertEquals("competency_ids" in qBody, false);
      assertEquals("model_answer" in qBody, false);

      const chBody = JSON.parse(
        postsTo(h.fetchLog, "/rest/v1/question_chapters")[0].body!,
      ) as Array<{ question_id: string; chapter_id: string }>;
      assertEquals(chBody.length, 2);
      assertEquals(chBody[0].question_id, "inserted-0");
      assertEquals(new Set(chBody.map((r) => r.chapter_id)), new Set(["ch-1", "ch-2"]));

      const cmpBody = JSON.parse(
        postsTo(h.fetchLog, "/rest/v1/question_competencies")[0].body!,
      ) as Array<{ question_id: string; competency_id: string }>;
      assertEquals(cmpBody, [
        { question_id: "inserted-0", competency_id: "comp-1" },
      ]);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "insertGeneratedQuestions: open re-applies toOpenUnified (#618) and preserves diagram (#627/#636)",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        junctionRoute("/rest/v1/question_chapters"),
        junctionRoute("/rest/v1/question_competencies"),
        questionsInsertRoute(),
      ],
    });
    try {
      const result = await insertGeneratedQuestions(makeClient(), {
        type: "open",
        courseId: "course-1",
        createdBy: null,
        generated: [
          {
            question: "Explain photosynthesis.",
            type: "open",
            // Server's `toOpenUnified` call in the generator omits
            // answering_mode, so payload is { diagram: ... } and
            // model_answer is in answer_key.
            payload: {
              diagram: {
                format: "svg",
                source: "<svg/>",
                alt: "leaf",
              },
            },
            answer_key: {
              model_answer: "Plants convert light to energy.",
              rubric: null,
              explanation: "ok",
            },
            model_answer: "Plants convert light to energy.",
            explanation: "ok",
            difficulty: "medium",
            hidden: false,
            chapter_ids: ["ch-1"],
            competency_ids: [],
          },
        ],
      });

      assertEquals(result.errors, []);
      assertEquals(result.inserted.length, 1);

      const body = JSON.parse(
        postsToQuestions(h.fetchLog)[0].body!,
      ) as Record<string, unknown>;
      const payload = body.payload as Record<string, unknown>;
      // Rewritten by `toOpenUnified` with answering_mode: "single".
      assertEquals(payload.answering_mode, "single");
      // Diagram threaded back through from the generator payload.
      assertExists(payload.diagram);
      assertEquals(
        (payload.diagram as Record<string, unknown>).source,
        "<svg/>",
      );
      assertEquals(
        (payload.diagram as Record<string, unknown>).alt,
        "leaf",
      );
      // Answer key carries the model answer the row was constructed from.
      const answerKey = body.answer_key as Record<string, unknown>;
      assertEquals(answerKey.model_answer, "Plants convert light to energy.");

      // Empty competency_ids skips the competency junction POST.
      assertEquals(postsTo(h.fetchLog, "/rest/v1/question_competencies").length, 0);
      assertEquals(postsTo(h.fetchLog, "/rest/v1/question_chapters").length, 1);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "insertGeneratedQuestions: open falls back to answer_key.model_answer when model_answer absent",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [questionsInsertRoute()],
    });
    try {
      const result = await insertGeneratedQuestions(makeClient(), {
        type: "open",
        courseId: "course-1",
        createdBy: null,
        generated: [
          {
            question: "Q",
            type: "open",
            payload: {},
            answer_key: { model_answer: "from-answer-key" },
            difficulty: "easy",
            hidden: false,
          },
        ],
      });

      assertEquals(result.errors, []);
      const body = JSON.parse(
        postsToQuestions(h.fetchLog)[0].body!,
      ) as Record<string, unknown>;
      const answerKey = body.answer_key as Record<string, unknown>;
      assertEquals(answerKey.model_answer, "from-answer-key");
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "insertGeneratedQuestions: fill_gaps passes payload/answer_key through unchanged",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        junctionRoute("/rest/v1/question_chapters"),
        questionsInsertRoute(),
      ],
    });
    try {
      const payload = {
        stem: "The capital of France is ___",
        diagram: { format: "svg", source: "<svg/>" },
      };
      const answerKey = {
        gaps: [{ ordinal: 1, acceptable: ["Paris"] }],
      };
      const result = await insertGeneratedQuestions(makeClient(), {
        type: "fill_gaps",
        courseId: "course-1",
        createdBy: "user-1",
        generated: [
          {
            question: "The capital of France is ___",
            type: "fill_gaps",
            payload,
            answer_key: answerKey,
            difficulty: "easy",
            hidden: false,
            chapter_ids: ["ch-1"],
          },
        ],
      });

      assertEquals(result.errors, []);
      const body = JSON.parse(
        postsToQuestions(h.fetchLog)[0].body!,
      ) as Record<string, unknown>;
      assertEquals(body.payload, payload);
      assertEquals(body.answer_key, answerKey);
      assertEquals(body.type, "fill_gaps");
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "insertGeneratedQuestions: ordering passes payload/answer_key through unchanged",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        junctionRoute("/rest/v1/question_competencies"),
        questionsInsertRoute(),
      ],
    });
    try {
      const payload = { prompt: "Order these", items: ["a", "b", "c"] };
      const result = await insertGeneratedQuestions(makeClient(), {
        type: "ordering",
        courseId: "course-1",
        createdBy: "user-1",
        generated: [
          {
            question: "Order these",
            type: "ordering",
            payload,
            answer_key: {},
            difficulty: "medium",
            hidden: false,
            competency_ids: ["comp-a", "comp-b"],
          },
        ],
      });

      assertEquals(result.errors, []);
      const body = JSON.parse(
        postsToQuestions(h.fetchLog)[0].body!,
      ) as Record<string, unknown>;
      assertEquals(body.payload, payload);
      assertEquals(body.type, "ordering");

      const cmpBody = JSON.parse(
        postsTo(h.fetchLog, "/rest/v1/question_competencies")[0].body!,
      ) as Array<{ question_id: string; competency_id: string }>;
      assertEquals(cmpBody.length, 2);
      assertEquals(cmpBody.map((r) => r.competency_id), ["comp-a", "comp-b"]);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "insertGeneratedQuestions: classification passes payload/answer_key through unchanged",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [questionsInsertRoute()],
    });
    try {
      const payload = {
        prompt: "Classify these",
        categories: [{ id: "c1", label: "Animals" }],
        items: [{ id: "i1", text: "Cat" }],
      };
      const answerKey = { assignments: { i1: "c1" } };
      const result = await insertGeneratedQuestions(makeClient(), {
        type: "classification",
        courseId: "course-1",
        createdBy: "user-1",
        generated: [
          {
            question: "Classify these",
            type: "classification",
            payload,
            answer_key: answerKey,
            difficulty: "hard",
            hidden: true,
          },
        ],
      });

      assertEquals(result.errors, []);
      const body = JSON.parse(
        postsToQuestions(h.fetchLog)[0].body!,
      ) as Record<string, unknown>;
      assertEquals(body.payload, payload);
      assertEquals(body.answer_key, answerKey);
      assertEquals(body.type, "classification");
      assertEquals(body.hidden, true);
    } finally {
      h.cleanup();
    }
  },
});

// ── Resilience ───────────────────────────────────────────────────────────

Deno.test({
  name: "insertGeneratedQuestions: per-row error does not abort the batch",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        junctionRoute("/rest/v1/question_chapters"),
        // Fail the SECOND questions insert; the 1st and 3rd should still land.
        questionsInsertRoute({ failOnIndex: 1 }),
      ],
    });
    try {
      const result = await insertGeneratedQuestions(makeClient(), {
        type: "mcq",
        courseId: "course-1",
        createdBy: "user-1",
        generated: [
          {
            question: "Q1",
            type: "mcq",
            payload: { options: ["a", "b"] },
            answer_key: { correct_indices: [0] },
            difficulty: "easy",
            hidden: false,
            chapter_ids: ["ch-1"],
          },
          {
            question: "Q2",
            type: "mcq",
            payload: { options: ["a", "b"] },
            answer_key: { correct_indices: [0] },
            difficulty: "easy",
            hidden: false,
            chapter_ids: ["ch-1"],
          },
          {
            question: "Q3",
            type: "mcq",
            payload: { options: ["a", "b"] },
            answer_key: { correct_indices: [0] },
            difficulty: "easy",
            hidden: false,
            chapter_ids: ["ch-1"],
          },
        ],
      });

      assertEquals(result.inserted.length, 2);
      assertEquals(result.inserted.map((r) => r.index), [0, 2]);
      assertEquals(result.inserted.map((r) => r.question), ["Q1", "Q3"]);

      assertEquals(result.errors.length, 1);
      assertEquals(result.errors[0].index, 1);
      assertEquals(result.errors[0].question, "Q2");
      assertEquals(
        result.errors[0].error.includes("duplicate key"),
        true,
        `expected error to mention duplicate key, got: ${result.errors[0].error}`,
      );

      // Three questions POSTs (one per row, including the failing one).
      assertEquals(postsToQuestions(h.fetchLog).length, 3);
      // Only the two successful rows write their chapter junctions.
      assertEquals(postsTo(h.fetchLog, "/rest/v1/question_chapters").length, 2);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "insertGeneratedQuestions: junction failure surfaces as warning, row still inserted",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        // Both junction calls fail.
        junctionRoute("/rest/v1/question_chapters", { failOnIndex: 0 }),
        junctionRoute("/rest/v1/question_competencies", { failOnIndex: 0 }),
        questionsInsertRoute(),
      ],
    });
    try {
      const result = await insertGeneratedQuestions(makeClient(), {
        type: "mcq",
        courseId: "course-1",
        createdBy: "user-1",
        generated: [
          {
            question: "Q1",
            type: "mcq",
            payload: { options: ["a", "b"] },
            answer_key: { correct_indices: [0] },
            difficulty: "easy",
            hidden: false,
            chapter_ids: ["ch-1"],
            competency_ids: ["comp-1"],
          },
        ],
      });

      assertEquals(result.errors, []);
      assertEquals(result.inserted.length, 1);
      assertEquals(result.inserted[0].id, "inserted-0");
      assertExists(result.inserted[0].chapterLinksWarning);
      assertExists(result.inserted[0].competencyLinksWarning);
      assertEquals(
        result.inserted[0].chapterLinksWarning!.includes("foreign key"),
        true,
      );
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "insertGeneratedQuestions: no junctions are POSTed for rows with empty chapter/competency arrays",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [questionsInsertRoute()],
    });
    try {
      const result = await insertGeneratedQuestions(makeClient(), {
        type: "ordering",
        courseId: "course-1",
        createdBy: null,
        generated: [
          {
            question: "Q",
            type: "ordering",
            payload: { prompt: "p", items: ["a"] },
            answer_key: {},
            difficulty: "easy",
            hidden: false,
            // No chapter_ids, no competency_ids.
          },
        ],
      });
      assertEquals(result.errors, []);
      assertEquals(result.inserted.length, 1);
      assertEquals(postsTo(h.fetchLog, "/rest/v1/question_chapters").length, 0);
      assertEquals(postsTo(h.fetchLog, "/rest/v1/question_competencies").length, 0);
    } finally {
      h.cleanup();
    }
  },
});

// ── Generation provenance ────────────────────────────────────────────────

Deno.test({
  name:
    "insertGeneratedQuestions: material_ids become question_materials rows and generated_for_group_id stays on the question",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        junctionRoute("/rest/v1/question_materials"),
        junctionRoute("/rest/v1/question_chapters"),
        junctionRoute("/rest/v1/question_competencies"),
        questionsInsertRoute(),
      ],
    });
    try {
      const result = await insertGeneratedQuestions(makeClient(), {
        type: "mcq",
        courseId: "course-1",
        createdBy: "user-1",
        generated: [
          {
            question: "Whole-doc sourced question",
            type: "mcq",
            payload: { options: ["a", "b"] },
            answer_key: { correct_indices: [0], correct_index: 0 },
            difficulty: "easy",
            hidden: false,
            chapter_ids: [],
            competency_ids: [],
            material_ids: ["mat-1", "mat-2"],
            generated_for_group_id: "group-1",
          },
        ],
      });

      assertEquals(result.errors, []);
      assertEquals(result.inserted.length, 1);
      assertEquals(result.inserted[0].materialLinksWarning, undefined);

      const qBody = JSON.parse(
        postsToQuestions(h.fetchLog)[0].body!,
      ) as Record<string, unknown>;
      // The junction-only field is stripped; the provenance COLUMN survives.
      assertEquals("material_ids" in qBody, false);
      assertEquals(qBody.generated_for_group_id, "group-1");

      const matBody = JSON.parse(
        postsTo(h.fetchLog, "/rest/v1/question_materials")[0].body!,
      ) as Array<{ question_id: string; material_id: string }>;
      assertEquals(matBody, [
        { question_id: "inserted-0", material_id: "mat-1" },
        { question_id: "inserted-0", material_id: "mat-2" },
      ]);
      // Empty chapter/competency arrays still POST nothing.
      assertEquals(postsTo(h.fetchLog, "/rest/v1/question_chapters").length, 0);
      assertEquals(postsTo(h.fetchLog, "/rest/v1/question_competencies").length, 0);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name:
    "insertGeneratedQuestions: a failed question_materials insert is a warning, not a dropped row",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        junctionRoute("/rest/v1/question_materials", { failOnIndex: 0 }),
        junctionRoute("/rest/v1/question_chapters"),
        junctionRoute("/rest/v1/question_competencies"),
        questionsInsertRoute(),
      ],
    });
    try {
      const result = await insertGeneratedQuestions(makeClient(), {
        type: "mcq",
        courseId: "course-1",
        createdBy: null,
        generated: [
          {
            question: "Q",
            type: "mcq",
            payload: { options: ["a", "b"] },
            answer_key: { correct_indices: [0], correct_index: 0 },
            difficulty: "easy",
            hidden: false,
            material_ids: ["mat-1"],
          },
        ],
      });
      assertEquals(result.errors, []);
      assertEquals(result.inserted.length, 1);
      assertExists(result.inserted[0].materialLinksWarning);
    } finally {
      h.cleanup();
    }
  },
});
