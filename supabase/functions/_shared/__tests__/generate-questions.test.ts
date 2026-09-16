import { assertEquals, assertExists } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { capNumQuestions } from "../question-utils.ts";
import { toMcqUnified } from "../question-payload.ts";

// Multi-correct (#592): the schema field is now `correct_answers: integer[]`.
// T/F opt-in (#602): options length is [2, 4] so the LLM may emit 2-option
// True/False items when the instructor opts in. T/F is a SUBSET of MCQ —
// same storage shape, just options.length === 2.
const MCQ_OUTPUT_SCHEMA = {
  name: "generate_quiz_questions",
  strict: true,
  schema: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            question: { type: "string" },
            options: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 4 },
            correct_answers: {
              type: "array",
              items: { type: "integer", minimum: 0, maximum: 3 },
              minItems: 1,
              maxItems: 3,
              // `uniqueItems` intentionally absent — forbidden by OpenAI strict
              // structured-output mode (#877). Uniqueness is enforced in the
              // handler's post-parse validation, not the schema.
            },
            explanation: { type: "string" },
            difficulty: { type: "string", enum: ["easy", "medium", "hard"] },
            chapter_ids: { type: "array", items: { type: "string" } },
            competency_ids: { type: "array", items: { type: "string" } },
            generation_rationale: { type: "string" },
          },
          required: ["question", "options", "correct_answers", "explanation", "difficulty", "chapter_ids", "competency_ids", "generation_rationale"],
        },
      },
    },
    required: ["questions"],
  },
};

// Mirror of the runtime filter at handler.ts (after #602 the bound on
// correct_answers indices is options.length, not a hard-coded 4).
interface GeneratedQuestion {
  question: string;
  options: string[];
  correct_answers: number[];
  explanation: string;
  difficulty: string;
  chapter_ids: string[];
  competency_ids: string[];
  generation_rationale?: string;
}

function passesRuntimeFilter(q: GeneratedQuestion): boolean {
  const okShape =
    !!q.question &&
    typeof q.question === "string" &&
    Array.isArray(q.options) &&
    q.options.length >= 2 &&
    Array.isArray(q.correct_answers) &&
    q.correct_answers.length >= 1;
  if (!okShape) return false;
  const okIndices = q.correct_answers.every(
    (i) => typeof i === "number" && Number.isInteger(i) && i >= 0 && i < q.options.length,
  );
  if (!okIndices) return false;
  return new Set(q.correct_answers).size === q.correct_answers.length;
}

Deno.test("generate-questions: schema defines required fields", () => {
  assertExists(MCQ_OUTPUT_SCHEMA.schema.properties.questions);
  assertEquals(MCQ_OUTPUT_SCHEMA.schema.required.includes("questions"), true);
});

Deno.test("generate-questions: options array allows 2-4 items (T/F opt-in #602)", () => {
  const optionsSchema = MCQ_OUTPUT_SCHEMA.schema.properties.questions.items.properties.options;
  assertEquals(optionsSchema.minItems, 2);
  assertEquals(optionsSchema.maxItems, 4);
});

Deno.test("generate-questions: correct_answers is a non-empty integer array (#592)", () => {
  const correctSchema = MCQ_OUTPUT_SCHEMA.schema.properties.questions.items.properties.correct_answers;
  assertEquals(correctSchema.type, "array");
  assertEquals(correctSchema.minItems, 1);
  assertEquals(correctSchema.maxItems, 3);
  // `uniqueItems` must NOT be present — OpenAI strict mode rejects it (#877).
  assertEquals("uniqueItems" in correctSchema, false);
  assertEquals(correctSchema.items.minimum, 0);
  assertEquals(correctSchema.items.maximum, 3);
});

Deno.test("generate-questions: validates difficulty enum", () => {
  const difficultySchema = MCQ_OUTPUT_SCHEMA.schema.properties.questions.items.properties.difficulty;
  const validDifficulties = difficultySchema.enum;

  assertEquals(validDifficulties.includes("easy"), true);
  assertEquals(validDifficulties.includes("medium"), true);
  assertEquals(validDifficulties.includes("hard"), true);
  assertEquals(validDifficulties.includes("impossible"), false);
});

Deno.test("generate-questions: generated question has required structure (multi-correct)", () => {
  const mockQuestion = {
    question: "Which of these are prime?",
    options: ["2", "4", "6", "9"],
    correct_answers: [0],
    explanation: "Only 2 is prime among the options.",
    difficulty: "easy",
    chapter_ids: ["chapter-1"],
    competency_ids: ["comp-1"],
    generation_rationale: "Tests basic prime recall.",
  };

  assertExists(mockQuestion.question);
  assertEquals(mockQuestion.options.length, 4);
  assertEquals(Array.isArray(mockQuestion.correct_answers), true);
  assertEquals(mockQuestion.correct_answers.every((i) => i >= 0 && i <= 3), true);
});

Deno.test("generate-questions: schema requires generation_rationale field", () => {
  const required = MCQ_OUTPUT_SCHEMA.schema.properties.questions.items.required;
  assertEquals(required.includes("generation_rationale"), true);
});

Deno.test("generate-questions: validates question array is not empty", () => {
  const mockResponse = { questions: [] };
  assertEquals(Array.isArray(mockResponse.questions), true);
  assertEquals(mockResponse.questions.length === 0, true);
});

Deno.test("generate-questions: caps numQuestions at 5", () => {
  assertEquals(capNumQuestions(10), 5);
  assertEquals(capNumQuestions(6), 5);
  assertEquals(capNumQuestions(5), 5);
  assertEquals(capNumQuestions(3), 3);
  assertEquals(capNumQuestions(1), 1);
  assertEquals(capNumQuestions(0), 5);
  assertEquals(capNumQuestions(undefined), 5);
  assertEquals(capNumQuestions(-1), 1);
});

Deno.test("generate-questions: requires valid difficulty", () => {
  const validDifficulties = ["easy", "medium", "hard", "mixed"];
  assertEquals(validDifficulties.includes("easy"), true);
  assertEquals(validDifficulties.includes("mixed"), true);
  assertEquals(validDifficulties.includes("invalid"), false);
});

Deno.test("generate-questions: OPTIONS returns CORS headers", () => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };
  assertEquals(corsHeaders["Access-Control-Allow-Origin"], "*");
});

// Multi-correct (#592): the formatted question must carry the unified
// `payload` / `answer_key` columns with `correct_indices` (dual-writing the
// legacy `correct_index` for one release).
Deno.test("generate-questions: formatted question writes the multi-correct unified MCQ shape (#592)", () => {
  const aiQ = { options: ["w", "x", "y", "z"], correct_answers: [1, 2] };
  const formatted = {
    course_id: "course-1",
    question: "Which letters come second or third?",
    ...toMcqUnified({ options: aiQ.options, correct_answers: aiQ.correct_answers }),
  };
  assertEquals(formatted.type, "mcq");
  assertEquals(formatted.payload, { options: aiQ.options, multi_correct: true });
  assertEquals(formatted.answer_key, { correct_indices: [1, 2], correct_index: 1 });
});

Deno.test("generate-questions: single-correct items still serialize as a 1-element array (#592)", () => {
  const formatted = toMcqUnified({ options: ["a", "b", "c", "d"], correct_answers: [3] });
  assertEquals(formatted.answer_key, { correct_indices: [3], correct_index: 3 });
});

// ── T/F opt-in (#602) ────────────────────────────────────────────────────

Deno.test("generate-questions: 2-option T/F item passes the runtime filter (#602)", () => {
  const tfQuestion: GeneratedQuestion = {
    question: "Photosynthesis converts light energy into chemical energy.",
    options: ["True", "False"],
    correct_answers: [0],
    explanation: "Photosynthesis stores energy in glucose bonds.",
    difficulty: "easy",
    chapter_ids: ["chapter-1"],
    competency_ids: [],
    generation_rationale: "Tests a clean binary recall claim from Chapter 1.",
  };
  assertEquals(passesRuntimeFilter(tfQuestion), true);
});

Deno.test("generate-questions: T/F formatted as unified MCQ shape stores 2-option payload (#602)", () => {
  const formatted = toMcqUnified({ options: ["True", "False"], correct_answers: [1] });
  assertEquals(formatted.type, "mcq");
  assertEquals(formatted.payload, { options: ["True", "False"], multi_correct: false });
  assertEquals(formatted.answer_key, { correct_indices: [1], correct_index: 1 });
});

Deno.test("generate-questions: localized T/F (Greek) stores 2-option payload verbatim (#602)", () => {
  const formatted = toMcqUnified({ options: ["Σωστό", "Λάθος"], correct_answers: [0] });
  assertEquals(formatted.payload, {
    options: ["Σωστό", "Λάθος"],
    multi_correct: false,
  });
  assertEquals(formatted.answer_key, { correct_indices: [0], correct_index: 0 });
});

Deno.test("generate-questions: 2-option item with index >= options.length is rejected (#602)", () => {
  // Negative case: model returns index 2 on a 2-option set — the runtime
  // filter must reject this even though the JSON schema's `maximum: 3`
  // would let it through.
  const rogue: GeneratedQuestion = {
    question: "Cells have nuclei.",
    options: ["True", "False"],
    correct_answers: [2],
    explanation: "Bad payload.",
    difficulty: "easy",
    chapter_ids: ["chapter-1"],
    competency_ids: [],
    generation_rationale: "Bad case.",
  };
  assertEquals(passesRuntimeFilter(rogue), false);
});

Deno.test("generate-questions: 4-option flow unchanged when T/F is disabled (#602)", () => {
  // With enableTrueFalse=false the prompt does not invite 2-option items
  // and the runtime filter still accepts a normal 4-option MCQ.
  const fourOption: GeneratedQuestion = {
    question: "Which is prime?",
    options: ["2", "4", "6", "8"],
    correct_answers: [0],
    explanation: "2 is the only prime among the options.",
    difficulty: "easy",
    chapter_ids: ["chapter-1"],
    competency_ids: [],
    generation_rationale: "Tests prime recall.",
  };
  assertEquals(passesRuntimeFilter(fourOption), true);
});
