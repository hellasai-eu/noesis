import { describe, it, expect } from "vitest";
import {
  emptyNonMcqAnswer,
  gradeNonMcq,
  isNonMcqComplete,
  isNonMcqType,
  nonMcqSubmission,
  readNonMcqAnswer,
  type AnswerableQuestion,
  type NonMcqAnswer,
} from "@/lib/quiz-non-mcq";

const classificationQ: AnswerableQuestion = {
  id: "c1",
  type: "classification",
  items: [
    { id: "i1", text: "Sodium" },
    { id: "i2", text: "Neon" },
  ],
  classificationAssignments: { i1: "metal", i2: "gas" },
};

const orderingQ: AnswerableQuestion = {
  id: "o1",
  type: "ordering",
  orderingItems: ["Mg", "Ne", "Na"],
};

const fillGapsQ: AnswerableQuestion = {
  id: "f1",
  type: "fill_gaps",
  fillGapsGaps: [
    { ordinal: 1, acceptable: ["water", "H2O"] },
    { ordinal: 2, acceptable: ["ice"] },
  ],
};

const openQ: AnswerableQuestion = { id: "op1", type: "open" };

describe("isNonMcqType", () => {
  it("is false only for mcq", () => {
    expect(isNonMcqType("mcq")).toBe(false);
    expect(isNonMcqType("open")).toBe(true);
    expect(isNonMcqType("ordering")).toBe(true);
    expect(isNonMcqType("fill_gaps")).toBe(true);
    expect(isNonMcqType("classification")).toBe(true);
  });
});

describe("emptyNonMcqAnswer", () => {
  it("classification starts with no placements", () => {
    expect(emptyNonMcqAnswer(classificationQ, "u1")).toEqual({
      kind: "classification",
      placements: {},
    });
  });

  it("ordering seeds an untouched shuffle that permutes the canonical items", () => {
    const ans = emptyNonMcqAnswer(orderingQ, "u1");
    expect(ans.kind).toBe("ordering");
    if (ans.kind === "ordering") {
      expect([...ans.order].sort()).toEqual([...orderingQ.orderingItems!].sort());
      expect(ans.touched).toBe(false);
    }
  });

  it("ordering shuffle is deterministic per (question, user)", () => {
    const a = emptyNonMcqAnswer(orderingQ, "u1");
    const b = emptyNonMcqAnswer(orderingQ, "u1");
    expect(a).toEqual(b);
  });

  it("fill_gaps starts with one empty string per gap", () => {
    expect(emptyNonMcqAnswer(fillGapsQ, "u1")).toEqual({
      kind: "fill_gaps",
      inputs: ["", ""],
    });
  });

  it("open starts with empty text", () => {
    expect(emptyNonMcqAnswer(openQ, "u1")).toEqual({ kind: "open", text: "" });
  });
});

describe("isNonMcqComplete", () => {
  it("classification requires every item placed", () => {
    expect(
      isNonMcqComplete(classificationQ, {
        kind: "classification",
        placements: { i1: "metal" },
      }),
    ).toBe(false);
    expect(
      isNonMcqComplete(classificationQ, {
        kind: "classification",
        placements: { i1: "metal", i2: "gas" },
      }),
    ).toBe(true);
  });

  it("ordering is complete once a touched answer holds every item", () => {
    expect(
      isNonMcqComplete(orderingQ, {
        kind: "ordering",
        order: ["Na", "Ne", "Mg"],
        touched: true,
      }),
    ).toBe(true);
    expect(
      isNonMcqComplete(orderingQ, {
        kind: "ordering",
        order: ["Na", "Ne"],
        touched: true,
      }),
    ).toBe(false);
  });

  /**
   * #1043. `emptyNonMcqAnswer` seeds an ordering answer with a shuffle of all
   * the items, and the completeness rule used to accept any order of the full
   * length. So an ordering question was "answered" the instant it rendered: a
   * study-guide piece with four questions reported three unanswered, and a
   * student could submit a one-shot, immutable piece having never opened the
   * ordering question — then be graded on the shuffle they never chose.
   *
   * The `touched` flag is what separates a rendered shuffle from an answer;
   * the student sets it by dragging or by confirming the order they were shown.
   */
  it("ordering does NOT count as answered until the student touches it (#1043)", () => {
    const untouched = emptyNonMcqAnswer(orderingQ, "u1");
    // Narrowed before spreading: `emptyNonMcqAnswer` returns the whole
    // `NonMcqAnswer` union, and adding `touched` to the other variants is not
    // valid. Asserting the kind is the point of the call anyway.
    if (untouched.kind !== "ordering") {
      throw new Error(`expected an ordering answer, got ${untouched.kind}`);
    }
    expect(isNonMcqComplete(orderingQ, untouched)).toBe(false);
    // Confirming the very same order — the "keep this order" path — answers it.
    expect(
      isNonMcqComplete(orderingQ, { ...untouched, touched: true }),
    ).toBe(true);
  });

  it("fill_gaps requires every blank non-empty", () => {
    expect(
      isNonMcqComplete(fillGapsQ, { kind: "fill_gaps", inputs: ["water", ""] }),
    ).toBe(false);
    expect(
      isNonMcqComplete(fillGapsQ, { kind: "fill_gaps", inputs: ["water", "ice"] }),
    ).toBe(true);
    expect(
      isNonMcqComplete(fillGapsQ, { kind: "fill_gaps", inputs: ["water", "   "] }),
    ).toBe(false);
  });

  it("open requires non-empty text", () => {
    expect(isNonMcqComplete(openQ, { kind: "open", text: "  " })).toBe(false);
    expect(isNonMcqComplete(openQ, { kind: "open", text: "answer" })).toBe(true);
  });
});

describe("gradeNonMcq", () => {
  it("classification correct only when all items match the key", () => {
    expect(
      gradeNonMcq(classificationQ, {
        kind: "classification",
        placements: { i1: "metal", i2: "gas" },
      }),
    ).toBe(true);
    expect(
      gradeNonMcq(classificationQ, {
        kind: "classification",
        placements: { i1: "gas", i2: "gas" },
      }),
    ).toBe(false);
  });

  it("ordering correct only when the order matches canonical exactly", () => {
    expect(
      gradeNonMcq(orderingQ, {
        kind: "ordering",
        order: ["Mg", "Ne", "Na"],
        touched: true,
      }),
    ).toBe(true);
    expect(
      gradeNonMcq(orderingQ, {
        kind: "ordering",
        order: ["Ne", "Mg", "Na"],
        touched: true,
      }),
    ).toBe(false);
  });

  it("fill_gaps correct when each blank matches an acceptable answer (case/space-insensitive)", () => {
    expect(
      gradeNonMcq(fillGapsQ, { kind: "fill_gaps", inputs: ["  H2O ", "ICE"] }),
    ).toBe(true);
    expect(
      gradeNonMcq(fillGapsQ, { kind: "fill_gaps", inputs: ["water", "steam"] }),
    ).toBe(false);
  });

  it("open is never auto-correct", () => {
    expect(gradeNonMcq(openQ, { kind: "open", text: "a brilliant essay" })).toBe(
      false,
    );
  });
});

describe("nonMcqSubmission", () => {
  it("uses a distinct top-level key per type and never carries selected_indices", () => {
    expect(
      nonMcqSubmission({ kind: "classification", placements: { i1: "metal" } }),
    ).toEqual({ classification: { i1: "metal" } });
    // `touched` is a client-side gate flag, never part of the wire shape.
    expect(
      nonMcqSubmission({ kind: "ordering", order: ["a", "b"], touched: true }),
    ).toEqual({ ordering: ["a", "b"] });
    expect(nonMcqSubmission({ kind: "fill_gaps", inputs: ["x"] })).toEqual({
      fill_gaps: ["x"],
    });
    expect(nonMcqSubmission({ kind: "open", text: "hi" })).toEqual({
      open_text: "hi",
    });
  });
});

describe("readNonMcqAnswer", () => {
  it("round-trips each type through its submission shape", () => {
    const cases: Array<[AnswerableQuestion, NonMcqAnswer]> = [
      [
        classificationQ,
        { kind: "classification", placements: { i1: "metal", i2: "gas" } },
      ],
      // A stored order is by definition one the student chose, so it comes
      // back `touched` and stays past the answered gate on resume (#1043).
      [orderingQ, { kind: "ordering", order: ["Na", "Ne", "Mg"], touched: true }],
      [fillGapsQ, { kind: "fill_gaps", inputs: ["water", "ice"] }],
      [openQ, { kind: "open", text: "my answer" }],
    ];
    for (const [q, ans] of cases) {
      const row = { submission: nonMcqSubmission(ans) };
      expect(readNonMcqAnswer(q, row, "u1")).toEqual(ans);
    }
  });

  it("falls back to an untouched shuffled order when ordering has no stored submission", () => {
    const ans = readNonMcqAnswer(orderingQ, { submission: null }, "u1");
    expect(ans.kind).toBe("ordering");
    if (ans.kind === "ordering") {
      expect([...ans.order].sort()).toEqual([...orderingQ.orderingItems!].sort());
      // The fallback is a rendering convenience, not an answer — a resumed
      // question with nothing stored must stay behind the gate (#1043).
      expect(ans.touched).toBe(false);
      expect(isNonMcqComplete(orderingQ, ans)).toBe(false);
    }
  });

  it("pads fill_gaps to the gap count when the stored array is short", () => {
    const ans = readNonMcqAnswer(
      fillGapsQ,
      { submission: { fill_gaps: ["water"] } },
      "u1",
    );
    expect(ans).toEqual({ kind: "fill_gaps", inputs: ["water", ""] });
  });

  it("tolerates malformed submission jsonb", () => {
    expect(readNonMcqAnswer(openQ, { submission: 42 as never }, "u1")).toEqual({
      kind: "open",
      text: "",
    });
  });
});
