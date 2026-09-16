import { describe, it, expect } from "vitest";
import {
  computePieceStates,
  splitPieceIdsByReveal,
  pieceStatusForPosition,
  isPieceOpenable,
  isGuideComplete,
  nextPositionAfterSubmit,
  emptyPlayerAnswer,
  isPlayerAnswerComplete,
  unansweredQuestionIds,
  pieceSubmitReady,
  playerSubmission,
  playerDraftEntry,
  readPlayerAnswer,
  readPlayerDraft,
  type PlayerQuestion,
  type PlayerAnswer,
} from "@/lib/study-guide-player";

const pieces = [
  { id: "p0", position: 0 },
  { id: "p1", position: 1 },
  { id: "p2", position: 2 },
];

describe("study-guide lock/unlock state machine", () => {
  it("locks every piece after the current position and marks earlier ones done", () => {
    // Student is on the second piece (position 1): p0 done, p1 current, p2 locked.
    const states = computePieceStates(pieces, 1);
    expect(states.map((s) => [s.piece.id, s.status])).toEqual([
      ["p0", "completed"],
      ["p1", "current"],
      ["p2", "locked"],
    ]);
  });

  it("starts with only the first piece unlocked", () => {
    const states = computePieceStates(pieces, 0);
    expect(states.map((s) => s.status)).toEqual(["current", "locked", "locked"]);
  });

  it("marks every piece completed once the guide is finished", () => {
    const states = computePieceStates(pieces, 3);
    expect(states.every((s) => s.status === "completed")).toBe(true);
  });

  it("sorts pieces by position before deriving status", () => {
    const scrambled = [pieces[2], pieces[0], pieces[1]];
    const states = computePieceStates(scrambled, 1);
    expect(states.map((s) => s.piece.id)).toEqual(["p0", "p1", "p2"]);
  });

  it("pieceStatusForPosition classifies below/at/above the current position", () => {
    expect(pieceStatusForPosition(0, 1)).toBe("completed");
    expect(pieceStatusForPosition(1, 1)).toBe("current");
    expect(pieceStatusForPosition(2, 1)).toBe("locked");
  });

  it("only current and completed pieces are openable", () => {
    expect(isPieceOpenable("current")).toBe(true);
    expect(isPieceOpenable("completed")).toBe(true);
    expect(isPieceOpenable("locked")).toBe(false);
  });

  it("reports guide completion only after the final piece is submitted", () => {
    expect(isGuideComplete(pieces, 0)).toBe(false);
    expect(isGuideComplete(pieces, 2)).toBe(false); // last piece still current
    expect(isGuideComplete(pieces, 3)).toBe(true);
    expect(isGuideComplete([], 0)).toBe(false);
  });

  it("advances the current position past the submitted piece without regressing", () => {
    expect(nextPositionAfterSubmit(0, 0)).toBe(1);
    // Re-submitting/reviewing an earlier piece never pulls the student back.
    expect(nextPositionAfterSubmit(0, 2)).toBe(2);
    expect(nextPositionAfterSubmit(2, 2)).toBe(3);
  });
});

// Minimal question fixtures for the submit gate — one of every type.
const mcq: PlayerQuestion = { id: "mcq", type: "mcq" };
const open: PlayerQuestion = { id: "open", type: "open" };
const fill: PlayerQuestion = {
  id: "fill",
  type: "fill_gaps",
  fillGapsGaps: [
    { ordinal: 1, acceptable: ["a"] },
    { ordinal: 2, acceptable: ["b"] },
  ],
};
const ordering: PlayerQuestion = {
  id: "ordering",
  type: "ordering",
  orderingItems: ["x", "y", "z"],
};
const classification: PlayerQuestion = {
  id: "classification",
  type: "classification",
  items: [
    { id: "i1", text: "one" },
    { id: "i2", text: "two" },
  ],
  classificationAssignments: { i1: "c1", i2: "c2" },
};

/**
 * #1011 — which pieces may have their `answer_key` fetched. The player reveals
 * correctness only for a completed piece, so that is exactly the set entitled
 * to the key; the current piece is fetched without it and locked pieces are not
 * fetched at all.
 */
describe("study-guide answer-key reveal split", () => {
  it("gives the key to completed pieces and withholds it from the current one", () => {
    expect(splitPieceIdsByReveal(pieces, 1)).toEqual({
      revealed: ["p0"],
      unrevealed: ["p1"],
    });
  });

  it("reveals nothing on a freshly-started guide", () => {
    // Nothing has been submitted, so no key has any business being requested.
    expect(splitPieceIdsByReveal(pieces, 0)).toEqual({
      revealed: [],
      unrevealed: ["p0"],
    });
  });

  it("reveals every piece once the guide is finished", () => {
    // Position past the last piece: all submitted, all reviewable.
    expect(splitPieceIdsByReveal(pieces, 3)).toEqual({
      revealed: ["p0", "p1", "p2"],
      unrevealed: [],
    });
  });

  it("omits locked pieces from both lists", () => {
    const { revealed, unrevealed } = splitPieceIdsByReveal(pieces, 0);
    expect([...revealed, ...unrevealed]).not.toContain("p1");
    expect([...revealed, ...unrevealed]).not.toContain("p2");
  });

  it("agrees with computePieceStates rather than re-deriving the rule", () => {
    // The two must not drift: `reveal` in the renderer is `status ===
    // "completed"`, and this split decides what the key is fetched for.
    for (const position of [0, 1, 2, 3]) {
      const { revealed } = splitPieceIdsByReveal(pieces, position);
      const completed = computePieceStates(pieces, position)
        .filter((s) => s.status === "completed")
        .map((s) => s.piece.id);
      expect(revealed).toEqual(completed);
    }
  });

  it("orders by position even when the input is not sorted", () => {
    const shuffled = [pieces[2], pieces[0], pieces[1]];
    expect(splitPieceIdsByReveal(shuffled, 2)).toEqual({
      revealed: ["p0", "p1"],
      unrevealed: ["p2"],
    });
  });
});

describe("study-guide per-piece submit gate", () => {
  const questions = [mcq, open, fill, ordering, classification];

  function allAnswered(): Record<string, PlayerAnswer> {
    return {
      mcq: { kind: "mcq", selected: [0] },
      open: { kind: "open", text: "an answer" },
      fill: { kind: "fill_gaps", inputs: ["a", "b"] },
      ordering: { kind: "ordering", order: ["x", "y", "z"], touched: true },
      classification: { kind: "classification", placements: { i1: "c1", i2: "c2" } },
    };
  }

  it("is not ready when the piece has no answers at all", () => {
    expect(pieceSubmitReady(questions, {})).toBe(false);
    expect(unansweredQuestionIds(questions, {})).toEqual([
      "mcq",
      "open",
      "fill",
      "ordering",
      "classification",
    ]);
  });

  it("names exactly the still-unanswered questions", () => {
    const answers = allAnswered();
    // Blank out MCQ (no option picked) and one fill gap.
    answers.mcq = { kind: "mcq", selected: [] };
    answers.fill = { kind: "fill_gaps", inputs: ["a", "  "] };
    expect(unansweredQuestionIds(questions, answers)).toEqual(["mcq", "fill"]);
    expect(pieceSubmitReady(questions, answers)).toBe(false);
  });

  it("is ready once every question has an acceptable answer", () => {
    const answers = allAnswered();
    expect(unansweredQuestionIds(questions, answers)).toEqual([]);
    expect(pieceSubmitReady(questions, answers)).toBe(true);
  });

  /**
   * #1043 — the piece the issue was filed against had four questions and
   * reported three unanswered, because the ordering question's seeded shuffle
   * already satisfied the gate. The gate must now name it too, until the
   * student drags or confirms.
   */
  it("counts an untouched ordering question as unanswered", () => {
    const seeded = emptyPlayerAnswer(ordering, "u1");
    if (seeded.kind !== "ordering") throw new Error("expected an ordering answer");

    const answers = allAnswered();
    answers.ordering = seeded;
    expect(unansweredQuestionIds(questions, answers)).toEqual(["ordering"]);
    expect(pieceSubmitReady(questions, answers)).toBe(false);

    // Confirming the shuffled order as-is — no drag — clears the gate.
    answers.ordering = { ...seeded, touched: true };
    expect(pieceSubmitReady(questions, answers)).toBe(true);
  });

  it("treats a whitespace-only open answer as unanswered", () => {
    expect(isPlayerAnswerComplete(open, { kind: "open", text: "   " })).toBe(false);
    expect(isPlayerAnswerComplete(open, { kind: "open", text: "x" })).toBe(true);
  });

  it("requires an MCQ selection", () => {
    expect(isPlayerAnswerComplete(mcq, { kind: "mcq", selected: [] })).toBe(false);
    expect(isPlayerAnswerComplete(mcq, { kind: "mcq", selected: [2] })).toBe(true);
  });

  it("never counts a piece with zero questions as ready", () => {
    expect(pieceSubmitReady([], {})).toBe(false);
  });
});

describe("study-guide player answer round-trip", () => {
  it("seeds an empty answer per type", () => {
    expect(emptyPlayerAnswer(mcq, "u1")).toEqual({ kind: "mcq", selected: [] });
    expect(emptyPlayerAnswer(open, "u1")).toEqual({ kind: "open", text: "" });
    expect(emptyPlayerAnswer(fill, "u1")).toEqual({ kind: "fill_gaps", inputs: ["", ""] });
    // Ordering seeds a deterministic shuffle containing every item, untouched.
    const ord = emptyPlayerAnswer(ordering, "u1");
    expect(ord.kind).toBe("ordering");
    if (ord.kind === "ordering") {
      expect([...ord.order].sort()).toEqual(["x", "y", "z"]);
      expect(ord.touched).toBe(false);
    }
  });

  it("serialises and reconstructs each type via submission jsonb", () => {
    const cases: Array<[PlayerQuestion, PlayerAnswer]> = [
      [mcq, { kind: "mcq", selected: [0, 2] }],
      [open, { kind: "open", text: "hello" }],
      [fill, { kind: "fill_gaps", inputs: ["a", "b"] }],
      [ordering, { kind: "ordering", order: ["z", "x", "y"], touched: true }],
      [classification, { kind: "classification", placements: { i1: "c1", i2: "c2" } }],
    ];
    for (const [q, answer] of cases) {
      const submission = playerSubmission(answer);
      const restored = readPlayerAnswer(q, { submission }, "u1");
      expect(restored).toEqual(answer);
    }
  });

  it("stores MCQ selections under selected_indices", () => {
    expect(playerSubmission({ kind: "mcq", selected: [1, 3] })).toEqual({
      selected_indices: [1, 3],
    });
  });
});

/**
 * The draft codec (#1043). A draft entry has to say whether an ordering answer
 * is a decision or the seeded shuffle — the submission jsonb cannot, because
 * it is the wire contract the edge function grades.
 */
describe("study-guide draft codec", () => {
  it("stamps ordering drafts with their touched state and leaves the wire shape alone", () => {
    const touched: PlayerAnswer = { kind: "ordering", order: ["z", "x", "y"], touched: true };
    expect(playerDraftEntry(touched)).toEqual({
      ordering: ["z", "x", "y"],
      ordering_touched: true,
    });
    expect(playerSubmission(touched)).toEqual({ ordering: ["z", "x", "y"] });

    const untouched: PlayerAnswer = { kind: "ordering", order: ["z", "x", "y"], touched: false };
    expect(playerDraftEntry(untouched)).toEqual({
      ordering: ["z", "x", "y"],
      ordering_touched: false,
    });
  });

  it("leaves every other type's draft entry identical to its submission", () => {
    const answers: PlayerAnswer[] = [
      { kind: "mcq", selected: [0, 2] },
      { kind: "open", text: "hello" },
      { kind: "fill_gaps", inputs: ["a", "b"] },
      { kind: "classification", placements: { i1: "c1" } },
    ];
    for (const answer of answers) {
      expect(playerDraftEntry(answer)).toEqual(playerSubmission(answer));
    }
  });

  it("round-trips an ordering draft through both touched states", () => {
    for (const touched of [true, false]) {
      const answer: PlayerAnswer = { kind: "ordering", order: ["y", "z", "x"], touched };
      expect(readPlayerDraft(ordering, playerDraftEntry(answer), "u1")).toEqual(answer);
    }
  });

  /**
   * The legacy shape: before the stamp existed the player persisted every
   * question in the piece, seeded ordering defaults included, as a bare
   * `{ ordering: [...] }`. Such an entry is indistinguishable from a chosen
   * order, so it must resume UNTOUCHED — the student may never have opened
   * that question, and the piece is one-shot and immutable.
   */
  it("resumes a legacy ordering draft untouched, behind the submit gate", () => {
    const legacy = { ordering: ["z", "x", "y"] };
    const restored = readPlayerDraft(ordering, legacy, "u1");
    expect(restored).toEqual({ kind: "ordering", order: ["z", "x", "y"], touched: false });
    expect(isPlayerAnswerComplete(ordering, restored)).toBe(false);
  });

  it("seeds a shuffle when a draft entry is missing or unreadable", () => {
    for (const entry of [null, undefined, "nonsense", { ordering: "not-an-array" }]) {
      const restored = readPlayerDraft(ordering, entry as never, "u1");
      expect(restored.kind).toBe("ordering");
      if (restored.kind === "ordering") {
        expect([...restored.order].sort()).toEqual(["x", "y", "z"]);
        expect(restored.touched).toBe(false);
      }
    }
  });
});
