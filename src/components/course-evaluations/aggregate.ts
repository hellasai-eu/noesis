/**
 * Per-course evaluations report aggregation (#669).
 *
 * Pure helpers that fold N evaluator rows for a question into the shape the
 * report's table renders. No React or Supabase dependencies — keeps the
 * arithmetic unit-testable in isolation.
 *
 * Greek display labels are deliberately NOT applied here; the UI layer maps
 * codes → labels using `src/components/evaluator/rubric.ts` so this module
 * stays presentation-agnostic.
 */
import type {
  ProblemCategoryCode,
  RatingQuestionKey,
  VerdictCode,
} from "@/components/evaluator/rubric";
import type { Database } from "@/integrations/supabase/database-additions";

export type EvaluationRow =
  Database["public"]["Tables"]["question_evaluations"]["Row"];

const RATING_KEYS: ReadonlyArray<RatingQuestionKey> = [
  "clarity",
  "distractor_quality",
  "curriculum_alignment",
  "question_bank_alignment",
  "pedagogical_value",
  "language_appropriateness",
];

// Core dimensions are always rated (present on every evaluation row). Specialist
// dimensions are only filled on sampled rows. Using only core keys for
// overallAverage keeps it comparable across questions regardless of sampling.
const CORE_KEYS: ReadonlyArray<RatingQuestionKey> = ["clarity", "pedagogical_value"];

export interface VerdictCounts {
  good: number;
  needs_fixing: number;
  reject: number;
}

export interface QuestionAggregate {
  questionId: string;
  evaluatorCount: number;
  verdictCounts: VerdictCounts;
  /**
   * Plurality verdict across all evaluators. Ties break in this order:
   *   reject → needs_fixing → good
   * The bias toward worse verdicts mirrors how a reviewer reads the report
   * (one flagged verdict is more interesting than one Καλή).
   */
  majorityVerdict: VerdictCode;
  /** Union of every problem category flagged by any evaluator. */
  flaggedProblems: ProblemCategoryCode[];
  /**
   * Per-dimension average, rounded to 1 decimal place. The four "specialist"
   * dimensions are NULL on rows that weren't sampled (#678), so averages here
   * are computed only over rows that actually rated each dimension. A
   * dimension with zero non-null values reports 0.
   */
  ratingAverages: Record<RatingQuestionKey, number>;
  /**
   * Mean of the core-dimension averages (clarity + pedagogical_value). Core
   * ratings are present on every evaluation row, so this value is comparable
   * across all questions regardless of whether any evaluator was sampled for
   * the specialist block. 0 if no evaluator rated the question.
   *
   * Specialist ratings (distractor_quality, curriculum_alignment,
   * question_bank_alignment, language_appropriateness) are in `ratingAverages`
   * and only populated for questions where at least one evaluator was sampled.
   * Including them in the overall would make sampled questions incomparable to
   * unsampled ones.
   */
  overallAverage: number;
}

/**
 * Rounds to one decimal. Uses `Math.round` (banker-agnostic) since the values
 * here are means of 1..5 ints — well clear of representation gotchas.
 */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function pickMajorityVerdict(counts: VerdictCounts): VerdictCode {
  // Tie-break order: a single 'reject' or 'needs_fixing' is more interesting
  // to a reviewer than a 'good' — surface the worse verdict on ties.
  const order: Array<{ code: VerdictCode; n: number }> = [
    { code: "reject", n: counts.reject },
    { code: "needs_fixing", n: counts.needs_fixing },
    { code: "good", n: counts.good },
  ];
  let best = order[0];
  for (const o of order) if (o.n > best.n) best = o;
  return best.code;
}

export function aggregateQuestion(
  questionId: string,
  rows: EvaluationRow[],
): QuestionAggregate {
  const verdictCounts: VerdictCounts = { good: 0, needs_fixing: 0, reject: 0 };
  const ratingSums: Record<RatingQuestionKey, number> = {
    clarity: 0,
    distractor_quality: 0,
    curriculum_alignment: 0,
    question_bank_alignment: 0,
    pedagogical_value: 0,
    language_appropriateness: 0,
  };
  // Per-dimension count of rows that actually rated the dimension. Specialist
  // ratings are NULL on un-sampled rows (#678), so the divisor varies.
  const ratingCounts: Record<RatingQuestionKey, number> = {
    clarity: 0,
    distractor_quality: 0,
    curriculum_alignment: 0,
    question_bank_alignment: 0,
    pedagogical_value: 0,
    language_appropriateness: 0,
  };
  const problemSet = new Set<ProblemCategoryCode>();

  for (const r of rows) {
    const v = r.verdict as VerdictCode;
    if (v in verdictCounts) verdictCounts[v] += 1;
    for (const k of RATING_KEYS) {
      const val = r[k];
      if (typeof val === "number") {
        ratingSums[k] += val;
        ratingCounts[k] += 1;
      }
    }
    for (const code of r.problem_categories ?? []) {
      problemSet.add(code as ProblemCategoryCode);
    }
  }

  const ratingAverages = {} as Record<RatingQuestionKey, number>;
  for (const k of RATING_KEYS) {
    ratingAverages[k] =
      ratingCounts[k] === 0 ? 0 : round1(ratingSums[k] / ratingCounts[k]);
  }
  // Overall = mean of core dimensions (clarity + pedagogical_value), which are
  // always rated. This keeps the value comparable across questions regardless
  // of whether any evaluator was in the specialist-sampling block.
  const ratedCoreKeys = CORE_KEYS.filter((k) => ratingCounts[k] > 0);
  const overallAverage =
    ratedCoreKeys.length === 0
      ? 0
      : round1(
          ratedCoreKeys.reduce((acc, k) => acc + ratingAverages[k], 0) /
            ratedCoreKeys.length,
        );

  return {
    questionId,
    evaluatorCount: rows.length,
    verdictCounts,
    majorityVerdict: pickMajorityVerdict(verdictCounts),
    flaggedProblems: Array.from(problemSet),
    ratingAverages,
    overallAverage,
  };
}

/**
 * Groups raw evaluation rows by question_id and returns one aggregate per
 * question that has at least one row. Questions with zero evaluations are
 * dropped — the report only lists what's been actually evaluated.
 */
export function aggregateByQuestion(
  rows: EvaluationRow[],
): Map<string, QuestionAggregate> {
  const byQuestion = new Map<string, EvaluationRow[]>();
  for (const r of rows) {
    const list = byQuestion.get(r.question_id) ?? [];
    list.push(r);
    byQuestion.set(r.question_id, list);
  }
  const out = new Map<string, QuestionAggregate>();
  for (const [qid, group] of byQuestion) {
    out.set(qid, aggregateQuestion(qid, group));
  }
  return out;
}
