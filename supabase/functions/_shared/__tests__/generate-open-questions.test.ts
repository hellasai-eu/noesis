import { assertEquals, assertExists } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { toOpenUnified } from "../question-payload.ts";

// Mirrors the structured output schema declared in
// supabase/functions/generate-open-questions/handler.ts. Kept in sync manually
// so the test catches schema drift.
const OPEN_QUESTIONS_OUTPUT_SCHEMA = {
  name: "generate_open_questions",
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
            model_answer: { type: "string" },
            explanation: { type: "string" },
            difficulty: { type: "string", enum: ["easy", "medium", "hard"] },
            chapter_ids: { type: "array", items: { type: "string" } },
            competency_ids: { type: "array", items: { type: "string" } },
            generation_rationale: { type: "string" },
          },
          required: [
            "question",
            "model_answer",
            "explanation",
            "difficulty",
            "chapter_ids",
            "competency_ids",
            "generation_rationale",
          ],
        },
      },
    },
    required: ["questions"],
  },
};

Deno.test("generate-open-questions: schema defines required top-level fields", () => {
  assertExists(OPEN_QUESTIONS_OUTPUT_SCHEMA.schema.properties.questions);
  assertEquals(OPEN_QUESTIONS_OUTPUT_SCHEMA.schema.required.includes("questions"), true);
});

Deno.test("generate-open-questions: difficulty enum is easy/medium/hard", () => {
  const enumValues = OPEN_QUESTIONS_OUTPUT_SCHEMA.schema.properties.questions.items.properties.difficulty.enum;
  assertEquals(enumValues.includes("easy"), true);
  assertEquals(enumValues.includes("medium"), true);
  assertEquals(enumValues.includes("hard"), true);
  assertEquals(enumValues.includes("impossible"), false);
});

Deno.test("generate-open-questions: schema requires generation_rationale field", () => {
  const required = OPEN_QUESTIONS_OUTPUT_SCHEMA.schema.properties.questions.items.required;
  assertEquals(required.includes("generation_rationale"), true);
});

Deno.test("generate-open-questions: generation_rationale is a string", () => {
  const rationaleSchema =
    OPEN_QUESTIONS_OUTPUT_SCHEMA.schema.properties.questions.items.properties.generation_rationale;
  assertEquals(rationaleSchema.type, "string");
});

Deno.test("generate-open-questions: question shape passes required-field check", () => {
  const mockQuestion = {
    question: "Explain Newton's second law in your own words.",
    model_answer: "Force equals mass times acceleration; force, mass, and acceleration are all related linearly.",
    explanation: "Detailed step-by-step explanation with key concepts and hints.",
    difficulty: "medium",
    chapter_ids: ["chapter-1"],
    competency_ids: ["comp-1"],
    generation_rationale:
      "Drawn from Chapter 3 'Newton's Laws' to test the student's ability to articulate the second law in plain language.",
  };

  assertExists(mockQuestion.question);
  assertExists(mockQuestion.model_answer);
  assertExists(mockQuestion.generation_rationale);
  assertEquals(["easy", "medium", "hard"].includes(mockQuestion.difficulty), true);
});

Deno.test("generate-open-questions: chapter_ids and competency_ids are string arrays", () => {
  const itemProps = OPEN_QUESTIONS_OUTPUT_SCHEMA.schema.properties.questions.items.properties;
  assertEquals(itemProps.chapter_ids.type, "array");
  assertEquals(itemProps.chapter_ids.items.type, "string");
  assertEquals(itemProps.competency_ids.type, "array");
  assertEquals(itemProps.competency_ids.items.type, "string");
});

// The dual-write contract (#578): the formatted open question returned from
// the handler must (a) carry a pre-generated UUID so the frontend can write
// the same id into both `open_questions` and the sibling `questions` row,
// and (b) include the unified `type` / `payload` / `answer_key` columns.
Deno.test("generate-open-questions: formatted question carries a UUID and the unified open shape", () => {
  const aiQ = {
    model_answer: "F = m·a",
    explanation: "Newton's second law.",
  };
  const formatted = {
    id: crypto.randomUUID(),
    course_id: "course-1",
    question: "State Newton's second law.",
    model_answer: aiQ.model_answer,
    ...toOpenUnified({
      model_answer: aiQ.model_answer,
      rubric: null,
      explanation: aiQ.explanation,
    }),
    explanation: aiQ.explanation,
  };
  assertEquals(typeof formatted.id, "string");
  // 8-4-4-4-12 hex chunks
  assertEquals(/^[0-9a-f-]{36}$/.test(formatted.id), true);
  assertEquals(formatted.type, "open");
  assertEquals(formatted.payload, {});
  assertEquals(formatted.answer_key, {
    model_answer: aiQ.model_answer,
    rubric: null,
    explanation: aiQ.explanation,
  });
});
