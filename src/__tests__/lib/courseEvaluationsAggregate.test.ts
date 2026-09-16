/**
 * #669 — Aggregation helpers for the per-course evaluations report.
 *
 * Pure-function tests with no DB / React surface; exercise verdict counts,
 * majority verdict & its tie-break, the problem-category union, the six 1-5
 * averages, and the multi-evaluator case the acceptance criteria call out.
 */
import { describe, expect, it } from "vitest";
import {
  aggregateByQuestion,
  aggregateQuestion,
  type EvaluationRow,
} from "@/components/course-evaluations/aggregate";

function makeRow(overrides: Partial<EvaluationRow>): EvaluationRow {
  return {
    id: "r1",
    session_id: "s1",
    question_id: "q1",
    evaluator_id: "u1",
    verdict: "good",
    difficulty_confirmation: "correct",
    question_good: true,
    answer_good: true,
    clarity: 3,
    distractor_quality: 3,
    curriculum_alignment: 3,
    question_bank_alignment: 3,
    pedagogical_value: 3,
    language_appropriateness: 3,
    problem_categories: [],
    comment: null,
    was_sampled: false,
    cognitive_level: null,
    created_at: "2026-06-24T10:00:00Z",
    updated_at: "2026-06-24T10:00:00Z",
    ...overrides,
  };
}

describe("aggregateQuestion", () => {
  it("returns a zeroed shape for no rows", () => {
    const agg = aggregateQuestion("q1", []);
    expect(agg.evaluatorCount).toBe(0);
    expect(agg.verdictCounts).toEqual({ good: 0, needs_fixing: 0, reject: 0 });
    // Tie-break sends ties to 'reject' over 'needs_fixing' over 'good';
    // the empty case is effectively a 0-0-0 tie.
    expect(agg.majorityVerdict).toBe("reject");
    expect(agg.flaggedProblems).toEqual([]);
    expect(agg.overallAverage).toBe(0);
  });

  it("counts verdicts, unions problems, averages ratings across evaluators", () => {
    const rows: EvaluationRow[] = [
      makeRow({
        id: "r1",
        evaluator_id: "u1",
        verdict: "good",
        clarity: 5,
        distractor_quality: 5,
        curriculum_alignment: 5,
        question_bank_alignment: 5,
        pedagogical_value: 5,
        language_appropriateness: 5,
      }),
      makeRow({
        id: "r2",
        evaluator_id: "u2",
        verdict: "needs_fixing",
        problem_categories: ["weak_distractors", "unclear_stem"],
        clarity: 3,
        distractor_quality: 3,
        curriculum_alignment: 3,
        question_bank_alignment: 3,
        pedagogical_value: 3,
        language_appropriateness: 3,
      }),
      makeRow({
        id: "r3",
        evaluator_id: "u3",
        verdict: "needs_fixing",
        problem_categories: ["weak_distractors", "out_of_syllabus"],
        clarity: 1,
        distractor_quality: 1,
        curriculum_alignment: 1,
        question_bank_alignment: 1,
        pedagogical_value: 1,
        language_appropriateness: 1,
      }),
    ];

    const agg = aggregateQuestion("q1", rows);
    expect(agg.evaluatorCount).toBe(3);
    expect(agg.verdictCounts).toEqual({ good: 1, needs_fixing: 2, reject: 0 });
    expect(agg.majorityVerdict).toBe("needs_fixing");
    // Union, not duplicates.
    expect(new Set(agg.flaggedProblems)).toEqual(
      new Set(["weak_distractors", "unclear_stem", "out_of_syllabus"]),
    );
    // (5+3+1)/3 = 3.0 for every rating
    expect(agg.ratingAverages.clarity).toBe(3);
    expect(agg.overallAverage).toBe(3);
  });

  it("breaks verdict ties toward the worse verdict", () => {
    const rows: EvaluationRow[] = [
      makeRow({ id: "r1", evaluator_id: "u1", verdict: "good" }),
      makeRow({ id: "r2", evaluator_id: "u2", verdict: "reject" }),
    ];
    const agg = aggregateQuestion("q1", rows);
    // 1-0-1 tie between 'good' and 'reject' → reject wins.
    expect(agg.majorityVerdict).toBe("reject");
  });

  it("rounds the overall average to one decimal", () => {
    const rows: EvaluationRow[] = [
      makeRow({ id: "r1", evaluator_id: "u1", clarity: 4, distractor_quality: 4 }),
      makeRow({ id: "r2", evaluator_id: "u2", clarity: 5, distractor_quality: 5 }),
      makeRow({ id: "r3", evaluator_id: "u3", clarity: 4, distractor_quality: 4 }),
    ];
    const agg = aggregateQuestion("q1", rows);
    // clarity: (4+5+4)/3 = 4.333… → 4.3
    expect(agg.ratingAverages.clarity).toBe(4.3);
  });

  it("skips null specialist ratings when averaging (#678)", () => {
    // Two evaluators rated the core ratings; only one was sampled and so
    // filled the specialist ratings. Specialist averages must reflect only
    // the row that actually rated them, not divide by total evaluators.
    const rows: EvaluationRow[] = [
      makeRow({
        id: "r1",
        evaluator_id: "u1",
        clarity: 4,
        pedagogical_value: 4,
        // unsampled — specialist ratings are NULL on the new schema
        distractor_quality: null,
        curriculum_alignment: null,
        question_bank_alignment: null,
        language_appropriateness: null,
      }),
      makeRow({
        id: "r2",
        evaluator_id: "u2",
        clarity: 5,
        pedagogical_value: 5,
        // sampled — filled all four specialist ratings with 2
        distractor_quality: 2,
        curriculum_alignment: 2,
        question_bank_alignment: 2,
        language_appropriateness: 2,
        was_sampled: true,
        cognitive_level: "recall",
      }),
    ];
    const agg = aggregateQuestion("q1", rows);
    expect(agg.evaluatorCount).toBe(2);
    // Core: averaged across both rows.
    expect(agg.ratingAverages.clarity).toBe(4.5);
    expect(agg.ratingAverages.pedagogical_value).toBe(4.5);
    // Specialists: only one row rated them → average is that row's value (2),
    // not (0 + 2) / 2 = 1 as the old all-rows divisor would yield.
    expect(agg.ratingAverages.distractor_quality).toBe(2);
    expect(agg.ratingAverages.curriculum_alignment).toBe(2);
    // Overall = mean of core-only averages (clarity + pedagogical_value):
    //   (4.5 + 4.5) / 2 = 4.5 — specialist ratings don't affect the overall.
    expect(agg.overallAverage).toBe(4.5);
  });

  it("reports zero for a dimension every evaluator skipped (#678)", () => {
    const rows: EvaluationRow[] = [
      makeRow({
        id: "r1",
        evaluator_id: "u1",
        distractor_quality: null,
        curriculum_alignment: null,
        question_bank_alignment: null,
        language_appropriateness: null,
      }),
    ];
    const agg = aggregateQuestion("q1", rows);
    expect(agg.ratingAverages.distractor_quality).toBe(0);
    // Overall skips dimensions with zero ratings — only core ratings counted.
    expect(agg.overallAverage).toBe(3); // both core ratings are 3 (default)
  });
});

describe("aggregateByQuestion", () => {
  it("groups rows by question_id and returns one aggregate per question", () => {
    const rows: EvaluationRow[] = [
      makeRow({ id: "r1", question_id: "qA", evaluator_id: "u1", verdict: "good" }),
      makeRow({
        id: "r2",
        question_id: "qA",
        evaluator_id: "u2",
        verdict: "reject",
      }),
      makeRow({ id: "r3", question_id: "qB", evaluator_id: "u1", verdict: "good" }),
    ];

    const map = aggregateByQuestion(rows);
    expect(map.size).toBe(2);
    expect(map.get("qA")!.evaluatorCount).toBe(2);
    expect(map.get("qB")!.evaluatorCount).toBe(1);
  });

  it("returns an empty map for no rows", () => {
    expect(aggregateByQuestion([]).size).toBe(0);
  });
});
