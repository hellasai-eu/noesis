import { describe, it, expect } from "vitest";
import type { Json } from "@/integrations/supabase/types";
import {
  toMcqUnified,
  toOpenUnified,
  toFillGapsUnified,
  toOrderingUnified,
  toClassificationUnified,
  mcqOptionsFromPayload,
  mcqIsMultiCorrectFromPayload,
  mcqCorrectIndexFromAnswerKey,
  mcqCorrectIndicesFromAnswerKey,
  openModelAnswerFromAnswerKey,
  openAnsweringModeFromPayload,
  fillGapsStemFromPayload,
  fillGapsAcceptableAnswersFromAnswerKey,
  fillGapsSkeletonFromStem,
  orderingPromptFromPayload,
  orderingItemsFromPayload,
  classificationPromptFromPayload,
  classificationCategoriesFromPayload,
  classificationItemsFromPayload,
  classificationAssignmentsFromAnswerKey,
  questionDiagramFromPayload,
} from "@/lib/question-payload";
import {
  fillGapsOrdinalsInStem,
  validateFillGapsQuestion,
  validateClassificationQuestion,
  FillGapsPayloadSchema,
  FillGapsAnswerKeySchema,
  OrderingPayloadSchema,
  OrderingAnswerKeySchema,
  ClassificationPayloadSchema,
  ClassificationAnswerKeySchema,
} from "@/types/question";

describe("toMcqUnified", () => {
  it("produces type='mcq' with payload.options and answer_key.correct_indices (multi-correct, #592)", () => {
    const result = toMcqUnified({ options: ["a", "b", "c", "d"], correct_answers: [2] });
    expect(result.type).toBe("mcq");
    expect(result.payload).toEqual({
      options: ["a", "b", "c", "d"],
      multi_correct: false,
    });
    expect(result.answer_key).toEqual({ correct_indices: [2], correct_index: 2 });
  });

  it("preserves multi-correct sets", () => {
    const result = toMcqUnified({ options: ["a", "b", "c", "d"], correct_answers: [0, 2] });
    expect(result.answer_key).toEqual({ correct_indices: [0, 2], correct_index: 0 });
  });

  it("writes payload.multi_correct so a renderer can hint without the key (#1011)", () => {
    // The "Select all that apply." hint is the one thing about the answer a
    // student needs BEFORE answering. It lives in the student-facing payload
    // so the answering surfaces can stop fetching `answer_key` entirely.
    expect(
      toMcqUnified({ options: ["a", "b"], correct_answers: [0, 1] }).payload,
    ).toMatchObject({ multi_correct: true });
    expect(
      toMcqUnified({ options: ["a", "b"], correct_answers: [0] }).payload,
    ).toMatchObject({ multi_correct: false });
    // Degenerate: no correct answer is not "several correct answers".
    expect(
      toMcqUnified({ options: ["a", "b"], correct_answers: [] }).payload,
    ).toMatchObject({ multi_correct: false });
  });

  it("mcqIsMultiCorrectFromPayload reads it back, and defaults absent to false", () => {
    expect(
      mcqIsMultiCorrectFromPayload(
        toMcqUnified({ options: ["a", "b"], correct_answers: [0, 1] }).payload,
      ),
    ).toBe(true);
    // A row written before the field existed and never backfilled reads as
    // single-correct, which under-hints rather than over-hints: the student
    // still sees every option and can still pick more than one.
    expect(mcqIsMultiCorrectFromPayload({ options: ["a", "b"] })).toBe(false);
    expect(mcqIsMultiCorrectFromPayload(null)).toBe(false);
    expect(mcqIsMultiCorrectFromPayload("nonsense")).toBe(false);
  });

  it("dual-writes legacy correct_index = first array entry for back-compat", () => {
    const result = toMcqUnified({ options: ["a", "b"], correct_answers: [1] });
    expect((result.answer_key as Record<string, unknown>).correct_index).toBe(1);
  });
});

describe("toOpenUnified", () => {
  it("produces type='open' with empty payload and full answer_key", () => {
    const result = toOpenUnified({
      model_answer: "force = mass × acceleration",
      rubric: "explain each term",
      explanation: "Newton's second law.",
    });
    expect(result.type).toBe("open");
    expect(result.payload).toEqual({});
    expect(result.answer_key).toEqual({
      model_answer: "force = mass × acceleration",
      rubric: "explain each term",
      explanation: "Newton's second law.",
    });
  });

  it("normalizes missing rubric/explanation to null (mirrors absorb migration)", () => {
    const result = toOpenUnified({ model_answer: "answer" });
    expect(result.answer_key).toEqual({
      model_answer: "answer",
      rubric: null,
      explanation: null,
    });
  });
});

describe("mcqOptionsFromPayload", () => {
  it("returns the string array verbatim when payload is well-formed", () => {
    expect(mcqOptionsFromPayload({ options: ["a", "b", "c"] })).toEqual(["a", "b", "c"]);
  });

  it("coerces non-string entries via String() so renderers don't crash", () => {
    expect(mcqOptionsFromPayload({ options: [1, 2, "x"] })).toEqual(["1", "2", "x"]);
  });

  it("returns [] for empty / malformed / null payloads", () => {
    expect(mcqOptionsFromPayload(null)).toEqual([]);
    expect(mcqOptionsFromPayload({})).toEqual([]);
    expect(mcqOptionsFromPayload({ options: "not-an-array" })).toEqual([]);
    expect(mcqOptionsFromPayload([1, 2, 3] as never)).toEqual([]);
  });
});

describe("mcqCorrectIndicesFromAnswerKey", () => {
  it("returns the array verbatim when correct_indices is present", () => {
    expect(mcqCorrectIndicesFromAnswerKey({ correct_indices: [0, 2] })).toEqual([0, 2]);
    expect(mcqCorrectIndicesFromAnswerKey({ correct_indices: [3] })).toEqual([3]);
  });

  it("promotes a legacy single correct_index to a 1-element array", () => {
    // Critical back-compat path for rows authored before the migration.
    expect(mcqCorrectIndicesFromAnswerKey({ correct_index: 0 })).toEqual([0]);
    expect(mcqCorrectIndicesFromAnswerKey({ correct_index: 3 })).toEqual([3]);
  });

  it("prefers correct_indices when both keys are present", () => {
    expect(
      mcqCorrectIndicesFromAnswerKey({ correct_indices: [1, 2], correct_index: 0 }),
    ).toEqual([1, 2]);
  });

  it("returns [] for malformed / null shapes", () => {
    expect(mcqCorrectIndicesFromAnswerKey(null)).toEqual([]);
    expect(mcqCorrectIndicesFromAnswerKey({})).toEqual([]);
    expect(mcqCorrectIndicesFromAnswerKey({ correct_indices: "not-an-array" })).toEqual([]);
    expect(mcqCorrectIndicesFromAnswerKey({ correct_index: "0" })).toEqual([]);
  });

  it("filters non-number entries out of correct_indices", () => {
    expect(
      mcqCorrectIndicesFromAnswerKey({ correct_indices: [0, "x", 2] } as Json),
    ).toEqual([0, 2]);
  });
});

describe("mcqCorrectIndexFromAnswerKey (transitional shim)", () => {
  it("returns the first correct index for multi-correct rows", () => {
    expect(mcqCorrectIndexFromAnswerKey({ correct_indices: [2, 3] })).toBe(2);
  });

  it("returns the legacy single index for pre-#592 rows", () => {
    expect(mcqCorrectIndexFromAnswerKey({ correct_index: 1 })).toBe(1);
  });

  it("returns -1 (not 0) when no correct answer is recorded", () => {
    expect(mcqCorrectIndexFromAnswerKey(null)).toBe(-1);
    expect(mcqCorrectIndexFromAnswerKey({})).toBe(-1);
  });
});

describe("openModelAnswerFromAnswerKey", () => {
  it("returns the string model_answer when present", () => {
    expect(openModelAnswerFromAnswerKey({ model_answer: "x = 2" })).toBe("x = 2");
  });

  it("returns '' for missing/malformed payloads", () => {
    expect(openModelAnswerFromAnswerKey(null)).toBe("");
    expect(openModelAnswerFromAnswerKey({})).toBe("");
    expect(openModelAnswerFromAnswerKey({ model_answer: 42 })).toBe("");
  });
});

describe("openAnsweringModeFromPayload (#596)", () => {
  it("returns 'interactive' for every pre-#596 row (payload is null / {} / array)", () => {
    // Critical back-compat guarantee — existing open questions write `payload: {}`.
    expect(openAnsweringModeFromPayload(null)).toBe("interactive");
    expect(openAnsweringModeFromPayload(undefined)).toBe("interactive");
    expect(openAnsweringModeFromPayload({})).toBe("interactive");
    expect(openAnsweringModeFromPayload([1, 2, 3] as never)).toBe("interactive");
  });

  it("returns 'single' when payload.answering_mode is the 'single' literal", () => {
    expect(openAnsweringModeFromPayload({ answering_mode: "single" })).toBe("single");
  });

  it("returns 'interactive' when payload.answering_mode is the explicit 'interactive' literal", () => {
    expect(openAnsweringModeFromPayload({ answering_mode: "interactive" })).toBe("interactive");
  });

  it("returns 'interactive' for unknown / malformed values (no surprising defaults)", () => {
    expect(openAnsweringModeFromPayload({ answering_mode: "socratic" })).toBe("interactive");
    expect(openAnsweringModeFromPayload({ answering_mode: 1 })).toBe("interactive");
    expect(openAnsweringModeFromPayload({ answering_mode: null })).toBe("interactive");
  });
});

describe("toFillGapsUnified (#604)", () => {
  it("produces type='fill_gaps' with payload.stem and answer_key.gaps", () => {
    const result = toFillGapsUnified({
      stem: "The capital of France is {{1}}.",
      gaps: [{ ordinal: 1, acceptable: ["Paris", "París"] }],
    });
    expect(result.type).toBe("fill_gaps");
    expect(result.payload).toEqual({ stem: "The capital of France is {{1}}." });
    expect(result.answer_key).toEqual({
      gaps: [{ ordinal: 1, acceptable: ["Paris", "París"] }],
    });
  });

  it("sorts gaps by ordinal for a stable JSONB shape", () => {
    const result = toFillGapsUnified({
      stem: "{{1}} and {{2}}",
      gaps: [
        { ordinal: 2, acceptable: ["b"] },
        { ordinal: 1, acceptable: ["a"] },
      ],
    });
    const gaps = (result.answer_key as { gaps: Array<{ ordinal: number }> }).gaps;
    expect(gaps.map((g) => g.ordinal)).toEqual([1, 2]);
  });
});

describe("fillGapsStemFromPayload", () => {
  it("returns the stem string when payload is well-formed", () => {
    expect(fillGapsStemFromPayload({ stem: "X is {{1}}" })).toBe("X is {{1}}");
  });

  it("returns '' for malformed/null payloads", () => {
    expect(fillGapsStemFromPayload(null)).toBe("");
    expect(fillGapsStemFromPayload({})).toBe("");
    expect(fillGapsStemFromPayload({ stem: 42 })).toBe("");
    expect(fillGapsStemFromPayload([1, 2] as never)).toBe("");
  });
});

/**
 * #1011 — the pre-reveal gap skeleton. The acceptable answers and the gap
 * STRUCTURE share the `answer_key` column, so a student who is (correctly) not
 * shown the key must still get one input per blank or the piece can never be
 * submitted. Structure comes from the stem; answers stay withheld.
 */
describe("fillGapsSkeletonFromStem", () => {
  it("returns one answer-less gap per placeholder, sorted by ordinal", () => {
    expect(fillGapsSkeletonFromStem("X is {{2}} than {{1}}")).toEqual([
      { ordinal: 1, acceptable: [] },
      { ordinal: 2, acceptable: [] },
    ]);
  });

  it("never carries an acceptable answer — that is the whole point", () => {
    for (const gap of fillGapsSkeletonFromStem("a {{1}} b {{2}} c {{3}}")) {
      expect(gap.acceptable).toEqual([]);
    }
  });

  it("collapses a repeated ordinal to one gap, matching the renderer", () => {
    // FillGapsField renders one input per DISTINCT ordinal, and the submit gate
    // sizes its draft from this length. Counting the repeat twice would leave a
    // phantom blank that no input can fill, holding the gate open forever.
    expect(fillGapsSkeletonFromStem("{{1}} and again {{1}}")).toEqual([
      { ordinal: 1, acceptable: [] },
    ]);
  });

  it("returns [] for a stem with no placeholders, preserving the #1035 alert", () => {
    // A stem that wrote its blanks as `___` yields no gaps, which still trips
    // the "missing its blanks" guard in FillGapsField rather than rendering an
    // unanswerable question.
    expect(fillGapsSkeletonFromStem("X is ___ than Y")).toEqual([]);
    expect(fillGapsSkeletonFromStem("")).toEqual([]);
  });
});

describe("fillGapsAcceptableAnswersFromAnswerKey", () => {
  it("returns gaps sorted by ordinal", () => {
    const result = fillGapsAcceptableAnswersFromAnswerKey({
      gaps: [
        { ordinal: 2, acceptable: ["b"] },
        { ordinal: 1, acceptable: ["a", "alpha"] },
      ],
    });
    expect(result).toEqual([
      { ordinal: 1, acceptable: ["a", "alpha"] },
      { ordinal: 2, acceptable: ["b"] },
    ]);
  });

  it("returns [] for malformed/null inputs", () => {
    expect(fillGapsAcceptableAnswersFromAnswerKey(null)).toEqual([]);
    expect(fillGapsAcceptableAnswersFromAnswerKey({})).toEqual([]);
    expect(fillGapsAcceptableAnswersFromAnswerKey({ gaps: "x" })).toEqual([]);
  });

  it("drops gap entries without a positive integer ordinal", () => {
    const result = fillGapsAcceptableAnswersFromAnswerKey({
      gaps: [
        { ordinal: "1", acceptable: ["x"] },
        { ordinal: 0, acceptable: ["y"] },
        { ordinal: 1, acceptable: ["a"] },
      ],
    });
    expect(result).toEqual([{ ordinal: 1, acceptable: ["a"] }]);
  });

  it("drops gap entries with no acceptable answers", () => {
    const result = fillGapsAcceptableAnswersFromAnswerKey({
      gaps: [
        { ordinal: 1, acceptable: [] },
        { ordinal: 2, acceptable: ["x"] },
      ],
    });
    expect(result).toEqual([{ ordinal: 2, acceptable: ["x"] }]);
  });
});

describe("fillGapsOrdinalsInStem", () => {
  it("extracts and sorts the unique ordinals", () => {
    expect(fillGapsOrdinalsInStem("X is {{2}} than {{1}}")).toEqual([1, 2]);
  });

  it("returns [] for a stem with no markers", () => {
    expect(fillGapsOrdinalsInStem("no blanks here")).toEqual([]);
  });

  it("de-duplicates repeated ordinals", () => {
    expect(fillGapsOrdinalsInStem("{{1}} and {{1}}")).toEqual([1]);
  });
});

describe("validateFillGapsQuestion", () => {
  it("accepts a well-formed contiguous question", () => {
    const ok = validateFillGapsQuestion(
      { stem: "X is {{1}} and {{2}}" },
      { gaps: [{ ordinal: 1, acceptable: ["a"] }, { ordinal: 2, acceptable: ["b"] }] },
    );
    expect(ok).toBe(true);
  });

  it("rejects stem/gap ordinal mismatch", () => {
    const ok = validateFillGapsQuestion(
      { stem: "X is {{1}}" },
      { gaps: [{ ordinal: 1, acceptable: ["a"] }, { ordinal: 2, acceptable: ["b"] }] },
    );
    expect(ok).toBe(false);
  });

  it("rejects non-contiguous ordinals", () => {
    const ok = validateFillGapsQuestion(
      { stem: "X is {{1}} and {{3}}" },
      { gaps: [{ ordinal: 1, acceptable: ["a"] }, { ordinal: 3, acceptable: ["b"] }] },
    );
    expect(ok).toBe(false);
  });
});

describe("Fill-gaps Zod schemas", () => {
  it("rejects an empty stem", () => {
    expect(FillGapsPayloadSchema.safeParse({ stem: "" }).success).toBe(false);
  });

  it("rejects zero gaps", () => {
    expect(FillGapsAnswerKeySchema.safeParse({ gaps: [] }).success).toBe(false);
  });

  it("rejects more than the max number of gaps", () => {
    const tooMany = Array.from({ length: 9 }, (_, i) => ({
      ordinal: i + 1,
      acceptable: ["a"],
    }));
    expect(FillGapsAnswerKeySchema.safeParse({ gaps: tooMany }).success).toBe(false);
  });

  it("rejects a gap with an empty acceptable[]", () => {
    expect(
      FillGapsAnswerKeySchema.safeParse({ gaps: [{ ordinal: 1, acceptable: [] }] }).success,
    ).toBe(false);
  });
});

describe("toOrderingUnified (#606)", () => {
  it("produces type='ordering' with payload.{prompt,items} and empty answer_key", () => {
    const result = toOrderingUnified({
      prompt: "Sort by atomic number, ascending.",
      items: ["Mg", "Ne", "Na"],
    });
    expect(result.type).toBe("ordering");
    expect(result.payload).toEqual({
      prompt: "Sort by atomic number, ascending.",
      items: ["Mg", "Ne", "Na"],
    });
    expect(result.answer_key).toEqual({});
  });

  it("clones items so caller mutations do not leak into the row", () => {
    const items = ["a", "b", "c"];
    const result = toOrderingUnified({ prompt: "p", items });
    items.push("d");
    expect((result.payload as { items: string[] }).items).toEqual(["a", "b", "c"]);
  });
});

describe("orderingPromptFromPayload", () => {
  it("returns the prompt string when payload is well-formed", () => {
    expect(orderingPromptFromPayload({ prompt: "Sort these" })).toBe("Sort these");
  });

  it("returns '' for malformed/null payloads", () => {
    expect(orderingPromptFromPayload(null)).toBe("");
    expect(orderingPromptFromPayload({})).toBe("");
    expect(orderingPromptFromPayload({ prompt: 42 })).toBe("");
    expect(orderingPromptFromPayload([1, 2] as never)).toBe("");
  });
});

describe("orderingItemsFromPayload", () => {
  it("returns the items array verbatim when payload is well-formed", () => {
    expect(orderingItemsFromPayload({ items: ["a", "b", "c"] })).toEqual(["a", "b", "c"]);
  });

  it("drops non-string and empty entries defensively", () => {
    expect(orderingItemsFromPayload({ items: ["a", "", 1, "b"] } as Json)).toEqual(["a", "b"]);
  });

  it("returns [] for malformed/null inputs", () => {
    expect(orderingItemsFromPayload(null)).toEqual([]);
    expect(orderingItemsFromPayload({})).toEqual([]);
    expect(orderingItemsFromPayload({ items: "not-an-array" })).toEqual([]);
  });
});

describe("Ordering Zod schemas", () => {
  it("rejects an empty prompt", () => {
    expect(
      OrderingPayloadSchema.safeParse({ prompt: "", items: ["a", "b", "c"] }).success,
    ).toBe(false);
  });

  it("rejects fewer than 3 items", () => {
    expect(
      OrderingPayloadSchema.safeParse({ prompt: "p", items: ["a", "b"] }).success,
    ).toBe(false);
  });

  it("rejects more than 8 items", () => {
    expect(
      OrderingPayloadSchema.safeParse({
        prompt: "p",
        items: Array.from({ length: 9 }, (_, i) => `item ${i + 1}`),
      }).success,
    ).toBe(false);
  });

  it("rejects an item exceeding the 200-char cap", () => {
    expect(
      OrderingPayloadSchema.safeParse({
        prompt: "p",
        items: ["a", "b", "x".repeat(201)],
      }).success,
    ).toBe(false);
  });

  it("accepts exactly 3 minimum items", () => {
    expect(
      OrderingPayloadSchema.safeParse({ prompt: "p", items: ["a", "b", "c"] }).success,
    ).toBe(true);
  });

  it("rejects non-empty answer_key (strict)", () => {
    expect(OrderingAnswerKeySchema.safeParse({}).success).toBe(true);
    expect(OrderingAnswerKeySchema.safeParse({ foo: "bar" }).success).toBe(false);
  });
});

describe("toClassificationUnified (#610)", () => {
  const sample = {
    prompt: "Classify these properties as physical or chemical.",
    categories: [
      { id: "phys", label: "Physical" },
      { id: "chem", label: "Chemical" },
    ],
    items: [
      { id: "i1", text: "Melting point" },
      { id: "i2", text: "Reacts with water" },
      { id: "i3", text: "Density" },
      { id: "i4", text: "Forms an oxide" },
    ],
    assignments: { i1: "phys", i2: "chem", i3: "phys", i4: "chem" },
  };

  it("produces type='classification' with payload.{prompt,categories,items} and answer_key.assignments", () => {
    const result = toClassificationUnified(sample);
    expect(result.type).toBe("classification");
    expect(result.payload).toEqual({
      prompt: sample.prompt,
      categories: sample.categories,
      items: sample.items,
    });
    expect(result.answer_key).toEqual({ assignments: sample.assignments });
  });

  it("does NOT leak category_id into payload.items (answer-key separation)", () => {
    const result = toClassificationUnified(sample);
    const items = (result.payload as { items: Record<string, unknown>[] }).items;
    for (const it of items) {
      expect(Object.keys(it).sort()).toEqual(["id", "text"]);
    }
  });

  it("clones assignments so caller mutations do not leak into the row", () => {
    const assignments = { ...sample.assignments };
    const result = toClassificationUnified({ ...sample, assignments });
    assignments.i1 = "tampered";
    expect((result.answer_key as { assignments: Record<string, string> }).assignments.i1).toBe(
      "phys",
    );
  });
});

describe("classificationPromptFromPayload (#610)", () => {
  it("returns the prompt string when payload is well-formed", () => {
    expect(classificationPromptFromPayload({ prompt: "Sort these" })).toBe("Sort these");
  });

  it("returns '' for malformed/null payloads", () => {
    expect(classificationPromptFromPayload(null)).toBe("");
    expect(classificationPromptFromPayload({})).toBe("");
    expect(classificationPromptFromPayload({ prompt: 42 })).toBe("");
    expect(classificationPromptFromPayload([1, 2] as never)).toBe("");
  });
});

describe("classificationCategoriesFromPayload (#610)", () => {
  it("returns categories verbatim when payload is well-formed", () => {
    const cats = [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ];
    expect(classificationCategoriesFromPayload({ categories: cats })).toEqual(cats);
  });

  it("drops entries missing id/label or with wrong types", () => {
    const out = classificationCategoriesFromPayload({
      categories: [
        { id: "a", label: "A" },
        { id: "", label: "B" },
        { id: "c", label: 42 },
        { id: "d", label: "D" },
      ],
    });
    expect(out).toEqual([
      { id: "a", label: "A" },
      { id: "d", label: "D" },
    ]);
  });

  it("returns [] for malformed/null inputs", () => {
    expect(classificationCategoriesFromPayload(null)).toEqual([]);
    expect(classificationCategoriesFromPayload({})).toEqual([]);
    expect(classificationCategoriesFromPayload({ categories: "x" })).toEqual([]);
  });
});

describe("classificationItemsFromPayload (#610)", () => {
  it("returns items verbatim when payload is well-formed", () => {
    const items = [
      { id: "i1", text: "alpha" },
      { id: "i2", text: "beta" },
    ];
    expect(classificationItemsFromPayload({ items })).toEqual(items);
  });

  it("drops malformed item entries", () => {
    const out = classificationItemsFromPayload({
      items: [
        { id: "i1", text: "alpha" },
        { id: "i2", text: "" },
        { id: "", text: "beta" },
        "not-an-object",
        { id: "i3", text: "gamma" },
      ],
    });
    expect(out).toEqual([
      { id: "i1", text: "alpha" },
      { id: "i3", text: "gamma" },
    ]);
  });

  it("returns [] for malformed/null inputs", () => {
    expect(classificationItemsFromPayload(null)).toEqual([]);
    expect(classificationItemsFromPayload({})).toEqual([]);
    expect(classificationItemsFromPayload({ items: 42 })).toEqual([]);
  });
});

describe("classificationAssignmentsFromAnswerKey (#610)", () => {
  it("returns the assignments map verbatim when well-formed", () => {
    expect(
      classificationAssignmentsFromAnswerKey({ assignments: { i1: "phys", i2: "chem" } }),
    ).toEqual({ i1: "phys", i2: "chem" });
  });

  it("drops non-string values defensively", () => {
    expect(
      classificationAssignmentsFromAnswerKey({
        assignments: { i1: "phys", i2: 1 as unknown as string, i3: null as unknown as string },
      }),
    ).toEqual({ i1: "phys" });
  });

  it("returns {} for malformed/null inputs", () => {
    expect(classificationAssignmentsFromAnswerKey(null)).toEqual({});
    expect(classificationAssignmentsFromAnswerKey({})).toEqual({});
    expect(classificationAssignmentsFromAnswerKey({ assignments: [1, 2] })).toEqual({});
    expect(classificationAssignmentsFromAnswerKey({ assignments: "x" })).toEqual({});
  });
});

describe("validateClassificationQuestion (#610)", () => {
  const goodPayload = {
    prompt: "p",
    categories: [
      { id: "a", label: "Alpha" },
      { id: "b", label: "Beta" },
    ],
    items: [
      { id: "i1", text: "one" },
      { id: "i2", text: "two" },
      { id: "i3", text: "three" },
      { id: "i4", text: "four" },
    ],
  };
  const goodAnswer = { assignments: { i1: "a", i2: "b", i3: "a", i4: "b" } };

  it("accepts a well-formed pair", () => {
    expect(validateClassificationQuestion(goodPayload, goodAnswer)).toBe(true);
  });

  it("rejects duplicate category labels (NFC + lowercase)", () => {
    const bad = {
      ...goodPayload,
      categories: [
        { id: "a", label: "Alpha" },
        { id: "b", label: " ALPHA " },
      ],
    };
    expect(validateClassificationQuestion(bad, goodAnswer)).toBe(false);
  });

  it("rejects an item with no assignment", () => {
    const bad = { assignments: { i1: "a", i2: "b", i3: "a" } };
    expect(validateClassificationQuestion(goodPayload, bad)).toBe(false);
  });

  it("rejects an assignment pointing to a non-declared category id", () => {
    const bad = { assignments: { i1: "a", i2: "b", i3: "a", i4: "ghost" } };
    expect(validateClassificationQuestion(goodPayload, bad)).toBe(false);
  });

  it("rejects an assignment for an undeclared item id", () => {
    const bad = { assignments: { ...goodAnswer.assignments, phantom: "a" } };
    expect(validateClassificationQuestion(goodPayload, bad)).toBe(false);
  });
});

describe("Classification Zod schemas (#610)", () => {
  const validCategories = [
    { id: "a", label: "Alpha" },
    { id: "b", label: "Beta" },
  ];
  const validItems = [
    { id: "i1", text: "one" },
    { id: "i2", text: "two" },
    { id: "i3", text: "three" },
    { id: "i4", text: "four" },
  ];

  it("accepts the minimum (2 categories, 4 items)", () => {
    expect(
      ClassificationPayloadSchema.safeParse({
        prompt: "p",
        categories: validCategories,
        items: validItems,
      }).success,
    ).toBe(true);
  });

  it("rejects fewer than 2 categories", () => {
    expect(
      ClassificationPayloadSchema.safeParse({
        prompt: "p",
        categories: [{ id: "a", label: "Alpha" }],
        items: validItems,
      }).success,
    ).toBe(false);
  });

  it("rejects more than 5 categories", () => {
    expect(
      ClassificationPayloadSchema.safeParse({
        prompt: "p",
        categories: Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, label: `Cat ${i}` })),
        items: validItems,
      }).success,
    ).toBe(false);
  });

  it("rejects fewer than 4 items", () => {
    expect(
      ClassificationPayloadSchema.safeParse({
        prompt: "p",
        categories: validCategories,
        items: validItems.slice(0, 3),
      }).success,
    ).toBe(false);
  });

  it("rejects more than 12 items", () => {
    const tooMany = Array.from({ length: 13 }, (_, i) => ({ id: `i${i}`, text: `t${i}` }));
    expect(
      ClassificationPayloadSchema.safeParse({
        prompt: "p",
        categories: validCategories,
        items: tooMany,
      }).success,
    ).toBe(false);
  });

  it("rejects an empty category label", () => {
    expect(
      ClassificationPayloadSchema.safeParse({
        prompt: "p",
        categories: [{ id: "a", label: "" }, { id: "b", label: "B" }],
        items: validItems,
      }).success,
    ).toBe(false);
  });

  it("rejects an item text longer than 120 chars", () => {
    expect(
      ClassificationPayloadSchema.safeParse({
        prompt: "p",
        categories: validCategories,
        items: [
          { id: "i1", text: "x".repeat(121) },
          { id: "i2", text: "two" },
          { id: "i3", text: "three" },
          { id: "i4", text: "four" },
        ],
      }).success,
    ).toBe(false);
  });

  it("answer_key schema accepts a string-to-string record", () => {
    expect(
      ClassificationAnswerKeySchema.safeParse({ assignments: { i1: "a", i2: "b" } }).success,
    ).toBe(true);
  });
});

describe("toOpenUnified — #596 answering_mode", () => {
  it("writes payload: {} when answering_mode is omitted (preserves pre-#596 byte shape)", () => {
    const result = toOpenUnified({ model_answer: "a" });
    expect(result.payload).toEqual({});
  });

  it("writes payload: { answering_mode: 'interactive' } when explicitly set", () => {
    const result = toOpenUnified({ model_answer: "a", answering_mode: "interactive" });
    expect(result.payload).toEqual({ answering_mode: "interactive" });
  });

  it("writes payload: { answering_mode: 'single' } when explicitly set", () => {
    const result = toOpenUnified({ model_answer: "a", answering_mode: "single" });
    expect(result.payload).toEqual({ answering_mode: "single" });
  });
});

describe("#627 diagram round-trip across every question type", () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>';

  it("mcq: writer puts diagram in payload, reader returns the same source + alt", () => {
    const unified = toMcqUnified({
      options: ["a", "b"],
      correct_answers: [0],
      diagram: { source: svg, alt: "circle" },
    });
    const payload = unified.payload as Record<string, unknown>;
    expect(payload.diagram).toEqual({ format: "svg", source: svg, alt: "circle" });
    expect(questionDiagramFromPayload(unified.payload)).toEqual({ source: svg, alt: "circle" });
  });

  it("open: writer + reader round-trip diagram alongside answering_mode", () => {
    const unified = toOpenUnified({
      model_answer: "a",
      answering_mode: "single",
      diagram: { source: svg },
    });
    expect(questionDiagramFromPayload(unified.payload)).toEqual({ source: svg });
  });

  it("fill_gaps: writer + reader round-trip diagram", () => {
    const unified = toFillGapsUnified({
      stem: "{{1}} is the answer",
      gaps: [{ ordinal: 1, acceptable: ["yes"] }],
      diagram: { source: svg, alt: "diagram" },
    });
    expect(questionDiagramFromPayload(unified.payload)).toEqual({ source: svg, alt: "diagram" });
  });

  it("ordering: writer + reader round-trip diagram", () => {
    const unified = toOrderingUnified({
      prompt: "sort these",
      items: ["a", "b", "c"],
      diagram: { source: svg },
    });
    expect(questionDiagramFromPayload(unified.payload)).toEqual({ source: svg });
  });

  it("classification: writer + reader round-trip diagram", () => {
    const unified = toClassificationUnified({
      prompt: "sort these",
      categories: [
        { id: "c1", label: "A" },
        { id: "c2", label: "B" },
      ],
      items: [
        { id: "i1", text: "x" },
        { id: "i2", text: "y" },
      ],
      assignments: { i1: "c1", i2: "c2" },
      diagram: { source: svg, alt: "Greek triangle" },
    });
    expect(questionDiagramFromPayload(unified.payload)).toEqual({ source: svg, alt: "Greek triangle" });
  });

  it("writers omit the field entirely when diagram is undefined (byte-for-byte legacy shape)", () => {
    const mcq = toMcqUnified({ options: ["a", "b"], correct_answers: [0] });
    expect((mcq.payload as Record<string, unknown>).diagram).toBeUndefined();
    expect(questionDiagramFromPayload(mcq.payload)).toBeNull();

    const open = toOpenUnified({ model_answer: "a" });
    expect((open.payload as Record<string, unknown>).diagram).toBeUndefined();
    expect(questionDiagramFromPayload(open.payload)).toBeNull();
  });

  it("reader defends against malformed JSONB (null, wrong shape, missing format, empty source)", () => {
    expect(questionDiagramFromPayload(null)).toBeNull();
    expect(questionDiagramFromPayload(undefined)).toBeNull();
    expect(questionDiagramFromPayload({ diagram: null })).toBeNull();
    expect(questionDiagramFromPayload({ diagram: { format: "png", source: svg } })).toBeNull();
    expect(questionDiagramFromPayload({ diagram: { format: "svg" } })).toBeNull();
    expect(questionDiagramFromPayload({ diagram: { format: "svg", source: "" } })).toBeNull();
    expect(questionDiagramFromPayload({ diagram: "not an object" })).toBeNull();
  });

  it("reader drops empty alt but keeps non-empty alt", () => {
    expect(questionDiagramFromPayload({ diagram: { format: "svg", source: svg, alt: "" } }))
      .toEqual({ source: svg });
    expect(questionDiagramFromPayload({ diagram: { format: "svg", source: svg, alt: "x" } }))
      .toEqual({ source: svg, alt: "x" });
  });
});
