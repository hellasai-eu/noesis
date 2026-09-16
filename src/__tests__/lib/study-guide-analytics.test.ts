/**
 * #981 — the deterministic half of the instructor results view.
 *
 * The recurring hazard these cover: a study guide is a GATED sequence, so a
 * later piece has few responses because few students have reached it. Anything
 * that reads thinness as difficulty, or counts "hasn't got there yet" as
 * "answered wrong", makes the view lie to a teacher deciding what to reteach.
 */
import { describe, it, expect } from "vitest";
import {
  LOW_CONFIDENCE_RESPONSES,
  UNATTRIBUTED_COMPETENCY,
  answerCountsAsCorrect,
  buildCompetencyAggregates,
  buildPieceAggregates,
  buildQuestionAggregates,
  buildStudentRows,
  normalizeStudyGuideAnalysis,
  type AnalyticsAnswer,
  type AnalyticsPiece,
  type AnalyticsQuestion,
} from "@/lib/study-guide-analytics";

const pieces: AnalyticsPiece[] = [
  { id: "p0", position: 0, title: "Adding" },
  { id: "p1", position: 1, title: "Subtracting" },
];

const questions: AnalyticsQuestion[] = [
  {
    id: "q0",
    pieceId: "p0",
    position: 0,
    type: "mcq",
    text: "2+2?",
    options: ["3", "4"],
    competencyId: "c-add",
  },
  {
    id: "q1",
    pieceId: "p0",
    position: 1,
    type: "mcq",
    text: "1+1?",
    options: ["2", "3"],
    competencyId: "c-add",
  },
  {
    id: "q2",
    pieceId: "p1",
    position: 0,
    type: "open",
    text: "Why is 5-3 not 3-5?",
    options: [],
    competencyId: null,
  },
];

const roster = [
  { userId: "u1", fullName: "Alpha" },
  { userId: "u2", fullName: "Beta" },
  { userId: "u3", fullName: "Gamma" },
];

/** Terse answer builder — only the fields a given assertion cares about. */
function answer(partial: Partial<AnalyticsAnswer> & Pick<AnalyticsAnswer, "userId" | "questionId" | "pieceId">): AnalyticsAnswer {
  return {
    selectedIndices: [],
    isCorrect: null,
    grade: null,
    ...partial,
  };
}

describe("answerCountsAsCorrect", () => {
  it("uses is_correct for objective answers", () => {
    expect(
      answerCountsAsCorrect(answer({ userId: "u1", questionId: "q0", pieceId: "p0", isCorrect: true })),
    ).toBe(true);
    expect(
      answerCountsAsCorrect(answer({ userId: "u1", questionId: "q0", pieceId: "p0", isCorrect: false, grade: 100 })),
    ).toBe(false);
  });

  it("treats a passing grade as correct for open answers, which carry no is_correct", () => {
    // The regression this guards: open answers store is_correct = null, so a
    // naive `=== true` check scores every essay in the guide as wrong.
    const open = (grade: number | null) =>
      answerCountsAsCorrect(answer({ userId: "u1", questionId: "q2", pieceId: "p1", grade }));
    expect(open(80)).toBe(true);
    expect(open(50)).toBe(true);
    expect(open(49)).toBe(false);
    expect(open(null)).toBe(false);
  });
});

describe("buildStudentRows", () => {
  it("keeps students who never opened the guide, as not_started", () => {
    // A roster row with no progress is a student who has not engaged. Dropping
    // them would make the class look fully engaged.
    const rows = buildStudentRows(roster, [], [], pieces.length);
    expect(rows.map((r) => r.status)).toEqual(["not_started", "not_started", "not_started"]);
    expect(rows.every((r) => r.answered === 0 && r.meanScore === null)).toBe(true);
  });

  it("separates 'opened but not submitted' from 'not started'", () => {
    const rows = buildStudentRows(
      roster,
      [{ userId: "u1", currentPiecePosition: 0, completedAt: null }],
      [],
      pieces.length,
    );
    expect(rows.find((r) => r.userId === "u1")!.status).toBe("in_progress");
    expect(rows.find((r) => r.userId === "u2")!.status).toBe("not_started");
  });

  it("reports completion from completed_at or from running past the last piece", () => {
    const rows = buildStudentRows(
      roster,
      [
        { userId: "u1", currentPiecePosition: 2, completedAt: null },
        { userId: "u2", currentPiecePosition: 1, completedAt: "2026-07-28T00:00:00Z" },
        { userId: "u3", currentPiecePosition: 1, completedAt: null },
      ],
      [],
      pieces.length,
    );
    expect(rows.find((r) => r.userId === "u1")!.status).toBe("completed");
    expect(rows.find((r) => r.userId === "u2")!.status).toBe("completed");
    expect(rows.find((r) => r.userId === "u3")!.status).toBe("in_progress");
  });

  it("clamps progress to the guide length so a shortened guide can't over-report", () => {
    // Deleting a piece leaves progress pointers past the new end.
    const rows = buildStudentRows(
      roster.slice(0, 1),
      [{ userId: "u1", currentPiecePosition: 9, completedAt: null }],
      [],
      pieces.length,
    );
    expect(rows[0].piecesCompleted).toBe(2);
  });

  it("averages only graded answers and mixes objective with open correctness", () => {
    const rows = buildStudentRows(
      roster.slice(0, 1),
      [{ userId: "u1", currentPiecePosition: 1, completedAt: null }],
      [
        answer({ userId: "u1", questionId: "q0", pieceId: "p0", isCorrect: true, grade: 100 }),
        answer({ userId: "u1", questionId: "q1", pieceId: "p0", isCorrect: false, grade: 0 }),
        answer({ userId: "u1", questionId: "q2", pieceId: "p1", grade: 80 }),
      ],
      pieces.length,
    );
    expect(rows[0].answered).toBe(3);
    // Two "got it": the correct MCQ and the passing open answer.
    expect(rows[0].correct).toBe(2);
    expect(rows[0].meanScore).toBe(60);
  });
});

describe("buildQuestionAggregates", () => {
  it("tallies the option distribution for MCQ questions", () => {
    const aggregates = buildQuestionAggregates(questions, [
      answer({ userId: "u1", questionId: "q0", pieceId: "p0", selectedIndices: [1], isCorrect: true, grade: 100 }),
      answer({ userId: "u2", questionId: "q0", pieceId: "p0", selectedIndices: [0], isCorrect: false, grade: 0 }),
      answer({ userId: "u3", questionId: "q0", pieceId: "p0", selectedIndices: [0], isCorrect: false, grade: 0 }),
    ]);
    const q0 = aggregates.find((a) => a.questionId === "q0")!;
    expect(q0.answered).toBe(3);
    expect(q0.correct).toBe(1);
    expect(q0.incorrect).toBe(2);
    expect(q0.optionDistribution).toEqual([
      { option: "3", count: 2 },
      { option: "4", count: 1 },
    ]);
  });

  it("omits the distribution for non-MCQ questions", () => {
    const aggregates = buildQuestionAggregates(questions, []);
    expect(aggregates.find((a) => a.questionId === "q2")!.optionDistribution).toBeUndefined();
  });

  it("ignores out-of-range option indices rather than throwing", () => {
    // A stale submission recorded against an option the instructor has since
    // removed must not blow up the histogram.
    const aggregates = buildQuestionAggregates(questions, [
      answer({ userId: "u1", questionId: "q0", pieceId: "p0", selectedIndices: [7, -1, 1], isCorrect: true }),
    ]);
    expect(aggregates.find((a) => a.questionId === "q0")!.optionDistribution).toEqual([
      { option: "3", count: 0 },
      { option: "4", count: 1 },
    ]);
  });
});

describe("buildPieceAggregates", () => {
  const progress = [
    { userId: "u1", currentPiecePosition: 1, completedAt: null },
    { userId: "u2", currentPiecePosition: 1, completedAt: null },
    { userId: "u3", currentPiecePosition: 1, completedAt: null },
  ];
  const answers = [
    answer({ userId: "u1", questionId: "q0", pieceId: "p0", isCorrect: true, grade: 100 }),
    answer({ userId: "u2", questionId: "q0", pieceId: "p0", isCorrect: true, grade: 100 }),
    answer({ userId: "u3", questionId: "q0", pieceId: "p0", isCorrect: false, grade: 0 }),
    answer({ userId: "u1", questionId: "q1", pieceId: "p0", isCorrect: false, grade: 0 }),
    answer({ userId: "u2", questionId: "q1", pieceId: "p0", isCorrect: false, grade: 0 }),
    answer({ userId: "u3", questionId: "q1", pieceId: "p0", isCorrect: false, grade: 0 }),
  ];

  it("counts completion from the progress pointer, not from answers", () => {
    const [p0, p1] = buildPieceAggregates(pieces, questions, answers, progress);
    expect(p0.completed).toBe(3);
    expect(p0.respondents).toBe(3);
    expect(p1.completed).toBe(0);
  });

  it("flags a piece nobody has reached as low confidence, not as a hard piece", () => {
    // The core hazard: piece 2 has no data because the class is gated behind
    // piece 1. Without the flag it reads as an unanswered disaster.
    const [, p1] = buildPieceAggregates(pieces, questions, answers, progress);
    expect(p1.respondents).toBe(0);
    expect(p1.lowConfidence).toBe(true);
    expect(p1.meanScore).toBeNull();
    expect(p1.hardestQuestions).toEqual([]);
  });

  it("clears the flag once enough students have responded", () => {
    const [p0] = buildPieceAggregates(pieces, questions, answers, progress);
    expect(p0.respondents).toBeGreaterThanOrEqual(LOW_CONFIDENCE_RESPONSES);
    expect(p0.lowConfidence).toBe(false);
  });

  it("ranks the hardest questions worst-first and never lists unanswered ones", () => {
    const [p0] = buildPieceAggregates(pieces, questions, answers, progress);
    expect(p0.hardestQuestions.map((q) => q.questionId)).toEqual(["q1", "q0"]);
  });

  it("breaks a tie on correctness rate toward the larger sample", () => {
    // Two questions both at 0%: the one twenty students missed is the more
    // trustworthy signal than the one a single student missed.
    const tie = buildPieceAggregates(
      [pieces[0]],
      [questions[0], questions[1]],
      [
        answer({ userId: "u1", questionId: "q0", pieceId: "p0", isCorrect: false, grade: 0 }),
        answer({ userId: "u1", questionId: "q1", pieceId: "p0", isCorrect: false, grade: 0 }),
        answer({ userId: "u2", questionId: "q1", pieceId: "p0", isCorrect: false, grade: 0 }),
      ],
      progress,
    );
    expect(tie[0].hardestQuestions.map((q) => q.questionId)).toEqual(["q1", "q0"]);
  });

  it("returns pieces in sequence order regardless of input order", () => {
    const reversed = buildPieceAggregates([...pieces].reverse(), questions, answers, progress);
    expect(reversed.map((p) => p.position)).toEqual([0, 1]);
  });
});

describe("buildCompetencyAggregates", () => {
  const titles = new Map([["c-add", "Addition within ten"]]);

  it("groups unattributed questions rather than dropping them", () => {
    // Silently omitting them would make the roll-up look like it covers the
    // whole guide when it covers only the attributed part.
    const rows = buildCompetencyAggregates(questions, [], titles);
    expect(rows.map((r) => r.competencyId)).toContain(UNATTRIBUTED_COMPETENCY);
    expect(rows.find((r) => r.unattributed)!.title).toMatch(/not linked/i);
  });

  it("sorts weakest first and always sinks the unattributed bucket to the end", () => {
    const rows = buildCompetencyAggregates(
      questions,
      [
        // c-add scores badly; the unattributed open answer scores perfectly.
        answer({ userId: "u1", questionId: "q0", pieceId: "p0", isCorrect: false, grade: 0 }),
        answer({ userId: "u1", questionId: "q2", pieceId: "p1", grade: 100 }),
      ],
      titles,
    );
    expect(rows[0].competencyId).toBe("c-add");
    expect(rows[rows.length - 1].competencyId).toBe(UNATTRIBUTED_COMPETENCY);
  });

  it("lists a competency nobody has answered yet with a null score", () => {
    const rows = buildCompetencyAggregates(questions, [], titles);
    const add = rows.find((r) => r.competencyId === "c-add")!;
    expect(add.answered).toBe(0);
    expect(add.meanScore).toBeNull();
    expect(add.lowConfidence).toBe(true);
  });

  it("ignores answers for questions that are no longer in the guide", () => {
    // The instructor deleted a piece after students answered it: those rows
    // can't be attributed to a competency, so counting them would skew the mean.
    const rows = buildCompetencyAggregates(
      questions,
      [answer({ userId: "u1", questionId: "deleted-q", pieceId: "gone", isCorrect: true, grade: 100 })],
      titles,
    );
    expect(rows.every((r) => r.answered === 0)).toBe(true);
  });

  it("counts distinct respondents, not answers", () => {
    const rows = buildCompetencyAggregates(
      questions,
      [
        answer({ userId: "u1", questionId: "q0", pieceId: "p0", isCorrect: true, grade: 100 }),
        answer({ userId: "u1", questionId: "q1", pieceId: "p0", isCorrect: true, grade: 100 }),
      ],
      titles,
    );
    const add = rows.find((r) => r.competencyId === "c-add")!;
    expect(add.answered).toBe(2);
    expect(add.respondents).toBe(1);
    // One student is not a class-level signal, however many questions they did.
    expect(add.lowConfidence).toBe(true);
  });
});

describe("normalizeStudyGuideAnalysis", () => {
  it("survives a null row", () => {
    const a = normalizeStudyGuideAnalysis(null);
    expect(a.report.strengths).toEqual([]);
    expect(a.report.overall_narrative).toBe("");
    expect(a.submission_count).toBe(0);
    expect(a.generated_at).toBeNull();
  });

  it("drops non-object entries from the finding lists", () => {
    // The column is model-written JSONB; a malformed entry must not take the
    // whole panel down.
    const a = normalizeStudyGuideAnalysis({
      report: {
        strengths: [{ topic: "Addition" }, "nonsense", null, 7],
        low_confidence_piece_positions: [0, "1", null],
        low_confidence_competency_ids: ["c-add", 3],
      },
      submission_count: 4,
      low_confidence: true,
      generated_at: "2026-07-28T00:00:00Z",
      model: "gpt-5.2",
    });
    expect(a.report.strengths).toHaveLength(1);
    expect(a.report.low_confidence_piece_positions).toEqual([0]);
    expect(a.report.low_confidence_competency_ids).toEqual(["c-add"]);
    expect(a.low_confidence).toBe(true);
    expect(a.model).toBe("gpt-5.2");
  });

  it("reads clusters back, and reports none for a row written before they existed", () => {
    expect(normalizeStudyGuideAnalysis({ report: {} }).clusters).toEqual([]);

    const a = normalizeStudyGuideAnalysis({
      report: {},
      clusters: [
        {
          label: "Treats subtraction as commutative",
          rationale: "Both reversed the difference.",
          summary: "Reteach on a number line.",
          member_user_ids: ["u1", "u2"],
        },
      ],
    });
    expect(a.clusters).toEqual([
      {
        label: "Treats subtraction as commutative",
        rationale: "Both reversed the difference.",
        summary: "Reteach on a number line.",
        member_user_ids: ["u1", "u2"],
      },
    ]);
  });

  it("keeps a malformed cluster renderable instead of dropping the panel", () => {
    const a = normalizeStudyGuideAnalysis({
      report: {},
      clusters: [
        // Non-string members and a blank label: the group still has two real
        // students in it, so salvaging it beats discarding the finding.
        { label: "   ", member_user_ids: ["u1", 7, null, "u2"] },
        "nonsense",
        null,
      ],
    });
    expect(a.clusters).toHaveLength(1);
    expect(a.clusters[0].label).toBe("Group");
    expect(a.clusters[0].rationale).toBe("");
    expect(a.clusters[0].member_user_ids).toEqual(["u1", "u2"]);
  });
});
