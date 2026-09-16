import { assertEquals, assert } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { createTestHarness, parseResponse } from "../handler-harness.ts";
import { handler, normalizeForSimilarity } from "../../../check-question-similarity/handler.ts";

Deno.test("check-question-similarity: OPTIONS returns CORS headers", async () => {
  const h = createTestHarness();
  try {
    const req = new Request("http://localhost/functions/v1/check-question-similarity", { method: "OPTIONS" });
    const res = await handler(req);
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  } finally { h.cleanup(); }
});

Deno.test("check-question-similarity: returns error when courseId is missing", async () => {
  const h = createTestHarness();
  try {
    const res = await h.invoke(handler, {});
    const { status, body } = await parseResponse(res);
    assertEquals(status >= 400, true);
    assertEquals(body.error.includes("courseId") || body.error.includes("required"), true);
  } finally { h.cleanup(); }
});

// #621 — cross-type normalization. The handler must reduce each question
// type to a single text representation so the LLM can compare across them.
// We test the helper directly since it's pure and exposed.

Deno.test("normalizeForSimilarity: MCQ uses the stem, ignores options", () => {
  const text = normalizeForSimilarity({
    id: "x",
    type: "mcq",
    question: "What is 2+2?",
    payload: { options: ["3", "4", "5"] },
    answer_key: { correct_indices: [1] },
    difficulty: "easy",
  });
  assertEquals(text, "What is 2+2?");
});

Deno.test("normalizeForSimilarity: Open joins stem and model answer", () => {
  const text = normalizeForSimilarity({
    id: "x",
    type: "open",
    question: "Explain photosynthesis.",
    payload: {},
    answer_key: { model_answer: "Plants convert light to chemical energy." },
    difficulty: "medium",
  });
  assert(text.includes("Explain photosynthesis"));
  assert(text.includes("Plants convert light"));
});

Deno.test("normalizeForSimilarity: Fill the Gaps strips placeholders and joins first acceptable", () => {
  const text = normalizeForSimilarity({
    id: "x",
    type: "fill_gaps",
    question: null,
    payload: { stem: "The capital of France is {{1}}." },
    answer_key: { gaps: [{ ordinal: 1, acceptable: ["Paris", "paris"] }] },
    difficulty: "easy",
  });
  assert(!text.includes("{{1}}"));
  assert(text.includes("___"));
  assert(text.includes("Paris"));
});

Deno.test("normalizeForSimilarity: Ordering joins prompt and items", () => {
  const text = normalizeForSimilarity({
    id: "x",
    type: "ordering",
    question: null,
    payload: {
      prompt: "Order the planets from the sun",
      items: ["Mercury", "Venus", "Earth"],
    },
    answer_key: {},
    difficulty: "medium",
  });
  assert(text.includes("Order the planets"));
  assert(text.includes("Mercury"));
  assert(text.includes("Earth"));
});

Deno.test("normalizeForSimilarity: Classification joins prompt + labels + items", () => {
  const text = normalizeForSimilarity({
    id: "x",
    type: "classification",
    question: null,
    payload: {
      prompt: "Sort animals",
      categories: [
        { id: "m", label: "Mammals" },
        { id: "b", label: "Birds" },
      ],
      items: [
        { id: "i1", text: "Dog" },
        { id: "i2", text: "Eagle" },
      ],
    },
    answer_key: { assignments: { i1: "m", i2: "b" } },
    difficulty: "medium",
  });
  assert(text.includes("Sort animals"));
  assert(text.includes("Mammals"));
  assert(text.includes("Eagle"));
});
