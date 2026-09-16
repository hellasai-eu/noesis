import { describe, it, expect } from "vitest";

import {
  parseEditModel,
  buildAndValidate,
  normalizeDifficulty,
  type QuestionEditModel,
  type PreservedFields,
} from "@/lib/question-editor";
import type { UnifiedQuestionRaw } from "@/lib/unified-question";
import type { Json } from "@/integrations/supabase/types";

/**
 * Per-type coverage for the unified question editor core (#1001): every type
 * gets a valid edit that builds the expected columns and a rejected one that
 * trips its schema cap or cross-field validator. This is the AC's required
 * "valid + rejected, per type" — it exercises the same `to*Unified` writers and
 * `src/types/question.ts` validators the real save path uses.
 */

function preserved(over: Partial<PreservedFields> = {}): PreservedFields {
  return { originalQuestionColumn: null, ...over };
}

const shared = { explanation: "why", difficulty: "easy" as const };

describe("normalizeDifficulty", () => {
  it("passes through the three allowed values and defaults anything else", () => {
    expect(normalizeDifficulty("easy")).toBe("easy");
    expect(normalizeDifficulty("hard")).toBe("hard");
    expect(normalizeDifficulty("impossible")).toBe("medium");
    expect(normalizeDifficulty(null)).toBe("medium");
  });
});

describe("buildAndValidate — mcq", () => {
  it("accepts a well-formed multi-correct edit and writes the unified columns", () => {
    const model: QuestionEditModel = {
      shared,
      typed: { kind: "mcq", stem: "Which are even?", options: ["1", "2", "4"], correctIndices: [1, 2] },
      preserved: preserved({ originalQuestionColumn: "old" }),
    };
    const r = buildAndValidate(model);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.columns.question).toBe("Which are even?");
      expect(r.columns.payload).toMatchObject({ options: ["1", "2", "4"] });
      expect(r.columns.answer_key).toMatchObject({ correct_indices: [1, 2] });
      expect(r.columns.explanation).toBe("why");
      expect(r.columns.difficulty).toBe("easy");
    }
  });

  it("rejects a correct index that points past the option list", () => {
    const model: QuestionEditModel = {
      shared,
      typed: { kind: "mcq", stem: "Pick one", options: ["a", "b"], correctIndices: [5] },
      preserved: preserved(),
    };
    const r = buildAndValidate(model);
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.errors.some((e) => e.field === "correctIndices")).toBe(true);
  });

  it("rejects a blank option and a missing correct answer", () => {
    const model: QuestionEditModel = {
      shared,
      typed: { kind: "mcq", stem: "Q", options: ["a", "  "], correctIndices: [] },
      preserved: preserved(),
    };
    const r = buildAndValidate(model);
    expect(r.ok).toBe(false);
  });
});

describe("buildAndValidate — open", () => {
  it("accepts a model answer and preserves answering_mode", () => {
    const model: QuestionEditModel = {
      shared,
      typed: { kind: "open", stem: "Explain", modelAnswer: "Because reasons" },
      preserved: preserved({ answeringMode: "single" }),
    };
    const r = buildAndValidate(model);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.columns.question).toBe("Explain");
      expect(r.columns.answer_key).toMatchObject({ model_answer: "Because reasons" });
      expect(r.columns.payload).toMatchObject({ answering_mode: "single" });
    }
  });

  it("rejects an empty model answer", () => {
    const model: QuestionEditModel = {
      shared,
      typed: { kind: "open", stem: "Explain", modelAnswer: "   " },
      preserved: preserved(),
    };
    expect(buildAndValidate(model).ok).toBe(false);
  });
});

describe("buildAndValidate — fill_gaps", () => {
  it("accepts a stem whose placeholders match the gaps 1..N", () => {
    const model: QuestionEditModel = {
      shared,
      typed: {
        kind: "fill_gaps",
        stem: "The {{1}} was signed in {{2}}.",
        gaps: [
          { ordinal: 1, acceptable: ["treaty", "Σύνταγμα"] },
          { ordinal: 2, acceptable: ["1975"] },
        ],
      },
      preserved: preserved(),
    };
    const r = buildAndValidate(model);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.columns.payload).toMatchObject({ stem: "The {{1}} was signed in {{2}}." });
      expect((r.columns.answer_key as { gaps: unknown[] }).gaps).toHaveLength(2);
    }
  });

  it("rejects a stem placeholder with no matching gap entry", () => {
    const model: QuestionEditModel = {
      shared,
      typed: {
        kind: "fill_gaps",
        stem: "The {{1}} was signed in {{2}}.",
        gaps: [{ ordinal: 1, acceptable: ["treaty"] }],
      },
      preserved: preserved(),
    };
    const r = buildAndValidate(model);
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.errors.some((e) => e.field === "gaps")).toBe(true);
  });

  // #1042: the generator was raised to eight accepted answers per gap so it can
  // list every filler the source licenses. This schema gates the EDITOR, and a
  // generated row is not rewritten on save — so if this cap sits below the
  // generator's, an instructor can open such a question and never save it
  // again, failing on gaps they never touched.
  it("accepts a generated-size key of eight acceptable answers per gap", () => {
    const model: QuestionEditModel = {
      shared,
      typed: {
        kind: "fill_gaps",
        stem: "A citizen has a role within a {{1}}.",
        gaps: [{
          ordinal: 1,
          acceptable: [
            "constitution",
            "constitutions",
            "the constitution",
            "state",
            "states",
            "the state",
            "polity",
            "polities",
          ],
        }],
      },
      preserved: preserved(),
    };
    expect(buildAndValidate(model).ok).toBe(true);
  });

  it("still rejects a ninth acceptable answer", () => {
    const model: QuestionEditModel = {
      shared,
      typed: {
        kind: "fill_gaps",
        stem: "The {{1}} was signed in 1975.",
        gaps: [{ ordinal: 1, acceptable: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] }],
      },
      preserved: preserved(),
    };
    const r = buildAndValidate(model);
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.errors.some((e) => e.field.startsWith("answer_key"))).toBe(true);
  });
});

describe("buildAndValidate — ordering", () => {
  it("accepts three-plus items in canonical order", () => {
    const model: QuestionEditModel = {
      shared,
      typed: { kind: "ordering", prompt: "Order the reigns", items: ["Otto", "George I", "Constantine I"] },
      preserved: preserved(),
    };
    const r = buildAndValidate(model);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.columns.payload).toMatchObject({ items: ["Otto", "George I", "Constantine I"] });
      expect(r.columns.answer_key).toEqual({});
    }
  });

  it("rejects fewer than ORDERING_MIN_ITEMS items", () => {
    const model: QuestionEditModel = {
      shared,
      typed: { kind: "ordering", prompt: "Order", items: ["a", "b"] },
      preserved: preserved(),
    };
    expect(buildAndValidate(model).ok).toBe(false);
  });
});

describe("buildAndValidate — classification", () => {
  const validModel: QuestionEditModel = {
    shared,
    typed: {
      kind: "classification",
      prompt: "Sort the shapes",
      categories: [
        { id: "c1", label: "Round" },
        { id: "c2", label: "Angular" },
      ],
      items: [
        { id: "i1", text: "Circle" },
        { id: "i2", text: "Square" },
        { id: "i3", text: "Ellipse" },
        { id: "i4", text: "Triangle" },
      ],
      assignments: { i1: "c1", i2: "c2", i3: "c1", i4: "c2" },
    },
    preserved: preserved(),
  };

  it("accepts a fully-assigned set and keeps assignments in answer_key only", () => {
    const r = buildAndValidate(validModel);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.columns.answer_key).toMatchObject({ assignments: { i1: "c1", i4: "c2" } });
      // The student-facing payload must not carry the assignment map.
      expect(r.columns.payload).not.toHaveProperty("assignments");
    }
  });

  it("rejects an item left without a category", () => {
    const model: QuestionEditModel = {
      ...validModel,
      typed: { ...validModel.typed, assignments: { i1: "c1", i2: "c2", i3: "c1" } },
    } as QuestionEditModel;
    const r = buildAndValidate(model);
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.errors.some((e) => e.field === "assignments")).toBe(true);
  });
});

describe("parseEditModel round-trips", () => {
  it("mcq: reads options + correct indices back out of the stored columns", () => {
    const raw: UnifiedQuestionRaw = {
      question: "Which are even?",
      payload: { options: ["1", "2", "4"] } as unknown as Json,
      answer_key: { correct_indices: [1, 2], correct_index: 1 } as unknown as Json,
      explanation: "why",
      generation_rationale: null,
    };
    const model = parseEditModel("mcq", raw, "hard");
    expect(model.typed).toMatchObject({
      kind: "mcq",
      stem: "Which are even?",
      options: ["1", "2", "4"],
      correctIndices: [1, 2],
    });
    expect(model.shared).toEqual({ explanation: "why", difficulty: "hard" });
    // Re-building the parsed model reproduces the original answer key.
    const rebuilt = buildAndValidate(model);
    expect(rebuilt.ok).toBe(true);
    if (rebuilt.ok) expect(rebuilt.columns.answer_key).toMatchObject({ correct_indices: [1, 2] });
  });

  it("classification: reads categories, items and assignments back out", () => {
    const raw: UnifiedQuestionRaw = {
      question: null,
      payload: {
        prompt: "Sort",
        categories: [
          { id: "c1", label: "Round" },
          { id: "c2", label: "Angular" },
        ],
        items: [
          { id: "i1", text: "Circle" },
          { id: "i2", text: "Square" },
          { id: "i3", text: "Ellipse" },
          { id: "i4", text: "Triangle" },
        ],
      } as unknown as Json,
      answer_key: { assignments: { i1: "c1", i2: "c2", i3: "c1", i4: "c2" } } as unknown as Json,
      explanation: null,
      generation_rationale: null,
    };
    const model = parseEditModel("classification", raw, "medium");
    expect(buildAndValidate(model).ok).toBe(true);
  });
});
