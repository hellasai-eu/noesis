import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  toMcqUnified,
  toOpenUnified,
  toFillGapsUnified,
  toOrderingUnified,
  toClassificationUnified,
  mcqCorrectIndexFromAnswerKey,
  mcqCorrectIndicesFromAnswerKey,
  questionDiagramFromPayload,
  mcqIsMultiCorrectFromPayload,
} from "../question-payload.ts";

Deno.test("toMcqUnified produces type='mcq' with payload.options and answer_key.correct_indices (#592)", () => {
  const result = toMcqUnified({ options: ["a", "b", "c", "d"], correct_answers: [2] });
  assertEquals(result.type, "mcq");
  assertEquals(result.payload, {
    options: ["a", "b", "c", "d"],
    multi_correct: false,
  });
  // Multi-correct shape + legacy single-index dual-write for one release.
  assertEquals(result.answer_key, { correct_indices: [2], correct_index: 2 });
});

Deno.test("toMcqUnified writes payload.multi_correct, the hint without the key (#1011)", () => {
  // Mirrors the frontend writer: whether several options are right is
  // presentation and lives in `payload`; WHICH ones is the answer and stays in
  // `answer_key`, so an answering surface can hint without holding the key.
  assertEquals(
    (toMcqUnified({ options: ["a", "b"], correct_answers: [0, 1] })
      .payload as Record<string, unknown>).multi_correct,
    true,
  );
  assertEquals(
    (toMcqUnified({ options: ["a", "b"], correct_answers: [0] })
      .payload as Record<string, unknown>).multi_correct,
    false,
  );
  // No correct answer is not "several correct answers".
  assertEquals(
    (toMcqUnified({ options: ["a", "b"], correct_answers: [] })
      .payload as Record<string, unknown>).multi_correct,
    false,
  );
});

Deno.test("mcqIsMultiCorrectFromPayload reads it back; absent reads as false (#1011)", () => {
  assertEquals(
    mcqIsMultiCorrectFromPayload(
      toMcqUnified({ options: ["a", "b"], correct_answers: [0, 1] }).payload,
    ),
    true,
  );
  // A row written before the field existed and never backfilled under-hints
  // rather than over-hints: every option is still shown and still selectable.
  assertEquals(mcqIsMultiCorrectFromPayload({ options: ["a", "b"] }), false);
  assertEquals(mcqIsMultiCorrectFromPayload(null), false);
  assertEquals(mcqIsMultiCorrectFromPayload("nonsense"), false);
});

Deno.test("toMcqUnified preserves multi-correct sets (#592)", () => {
  const result = toMcqUnified({ options: ["a", "b", "c", "d"], correct_answers: [0, 3] });
  assertEquals(result.answer_key, { correct_indices: [0, 3], correct_index: 0 });
});

Deno.test("mcqCorrectIndicesFromAnswerKey reads the multi-correct array", () => {
  assertEquals(mcqCorrectIndicesFromAnswerKey({ correct_indices: [0, 2] }), [0, 2]);
});

Deno.test("mcqCorrectIndicesFromAnswerKey promotes legacy correct_index to [N]", () => {
  // Back-compat path for rows authored on pre-#592 builds.
  assertEquals(mcqCorrectIndicesFromAnswerKey({ correct_index: 2 }), [2]);
});

Deno.test("mcqCorrectIndicesFromAnswerKey returns [] for malformed shapes", () => {
  assertEquals(mcqCorrectIndicesFromAnswerKey(null), []);
  assertEquals(mcqCorrectIndicesFromAnswerKey({}), []);
  assertEquals(mcqCorrectIndicesFromAnswerKey({ correct_index: "0" }), []);
});

Deno.test("mcqCorrectIndexFromAnswerKey (transitional shim) returns first correct index or -1", () => {
  assertEquals(mcqCorrectIndexFromAnswerKey({ correct_indices: [2, 3] }), 2);
  assertEquals(mcqCorrectIndexFromAnswerKey({ correct_index: 1 }), 1);
  assertEquals(mcqCorrectIndexFromAnswerKey({}), -1);
});

Deno.test("toOpenUnified produces type='open' with empty payload and full answer_key", () => {
  const result = toOpenUnified({
    model_answer: "force = mass × acceleration",
    rubric: "explain each term",
    explanation: "Newton's second law.",
  });
  assertEquals(result.type, "open");
  assertEquals(result.payload, {});
  assertEquals(result.answer_key, {
    model_answer: "force = mass × acceleration",
    rubric: "explain each term",
    explanation: "Newton's second law.",
  });
});

Deno.test("toOpenUnified normalizes missing rubric/explanation to null", () => {
  const result = toOpenUnified({ model_answer: "answer" });
  assertEquals(result.answer_key, {
    model_answer: "answer",
    rubric: null,
    explanation: null,
  });
});

// ---------------------------------------------------------------------------
// #627 — diagram round-trip across every question type
// ---------------------------------------------------------------------------

const sampleSvg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="3"/></svg>';

Deno.test("toMcqUnified attaches a diagram and the reader returns it", () => {
  const unified = toMcqUnified({
    options: ["a", "b"],
    correct_answers: [0],
    diagram: { source: sampleSvg, alt: "circle" },
  });
  assertEquals(questionDiagramFromPayload(unified.payload), {
    source: sampleSvg,
    alt: "circle",
  });
});

Deno.test("toOpenUnified attaches a diagram alongside answering_mode", () => {
  const unified = toOpenUnified({
    model_answer: "a",
    answering_mode: "single",
    diagram: { source: sampleSvg },
  });
  assertEquals(questionDiagramFromPayload(unified.payload), { source: sampleSvg });
});

Deno.test("toFillGapsUnified / toOrderingUnified / toClassificationUnified all round-trip diagrams", () => {
  const fillGaps = toFillGapsUnified({
    stem: "{{1}} fills the gap",
    gaps: [{ ordinal: 1, acceptable: ["yes"] }],
    diagram: { source: sampleSvg, alt: "fg" },
  });
  assertEquals(questionDiagramFromPayload(fillGaps.payload), { source: sampleSvg, alt: "fg" });

  const ordering = toOrderingUnified({
    prompt: "sort",
    items: ["a", "b", "c"],
    diagram: { source: sampleSvg },
  });
  assertEquals(questionDiagramFromPayload(ordering.payload), { source: sampleSvg });

  const classification = toClassificationUnified({
    prompt: "sort",
    categories: [
      { id: "c1", label: "A" },
      { id: "c2", label: "B" },
    ],
    items: [
      { id: "i1", text: "x" },
      { id: "i2", text: "y" },
    ],
    assignments: { i1: "c1", i2: "c2" },
    diagram: { source: sampleSvg, alt: "classify" },
  });
  assertEquals(questionDiagramFromPayload(classification.payload), {
    source: sampleSvg,
    alt: "classify",
  });
});

Deno.test("questionDiagramFromPayload returns null for missing/malformed/oversized inputs", () => {
  assertEquals(questionDiagramFromPayload(null), null);
  assertEquals(questionDiagramFromPayload(undefined), null);
  assertEquals(questionDiagramFromPayload({}), null);
  assertEquals(questionDiagramFromPayload({ diagram: { format: "png", source: "x" } }), null);
  assertEquals(questionDiagramFromPayload({ diagram: { format: "svg", source: "" } }), null);
  assertEquals(questionDiagramFromPayload({ diagram: "string" }), null);
});
