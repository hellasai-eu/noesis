// Pure aggregation for deriving a student group's weakest competencies,
// their chapters, and one suggested target difficulty. Kept free of any IO so
// it can be unit-tested under `npm test` (Deno). See issue #852.
//
// The handler feeds this module rows it has already fetched (quiz answers,
// question→competency links, the group's latest evaluation competency scores,
// the competency catalog with chapter links, and chapter titles). This module
// combines them into a ranked, weakest-first result.

/** A single MCQ answer by one group member. */
export interface QuizAnswerRow {
  user_id: string;
  is_correct: boolean;
  question_id: string;
}

/** Link from an answered question to a competency it exercises. */
export interface QuestionCompetencyRow {
  question_id: string;
  competency_id: string;
}

/**
 * One competency score from a member's latest evaluation. `score` is 0–100
 * where higher = stronger. Nulls are ignored (no signal).
 */
export interface EvalScoreRow {
  competency_id: string;
  score: number | null;
  /** The member this score belongs to, so members with eval-only signal still count. */
  user_id: string;
}

/** Competency catalog entry with its associated chapter ids (union of sources). */
export interface CompetencyMeta {
  id: string;
  title: string;
  chapter_ids: string[];
}

/** Chapter lookup for rolling competency → material chapter. */
export interface ChapterMeta {
  id: string;
  title: string;
}

export interface DeriveWeaknessesInput {
  memberCount: number;
  quizAnswers: QuizAnswerRow[];
  questionCompetencies: QuestionCompetencyRow[];
  evalScores: EvalScoreRow[];
  competencies: CompetencyMeta[];
  chapters: ChapterMeta[];
  /** How many weak competencies to return (weakest first). Default 3. */
  topN?: number;
}

export type SuggestedDifficulty = "easy" | "medium" | "hard";

export interface WeakCompetency {
  competency_id: string;
  title: string;
  /** Combined mastery 0–100 (lower = weaker). */
  mastery: number;
  /** Mean of members' evaluation scores for this competency, or null. */
  eval_avg: number | null;
  mcq_correct: number;
  mcq_total: number;
  /** MCQ correctness percent, or null when no answers touched this competency. */
  mcq_percent: number | null;
  chapters: ChapterMeta[];
}

export interface OverallStats {
  member_count: number;
  members_with_data: number;
  total_answers: number;
  correct_answers: number;
  percent_correct: number | null;
}

export interface DeriveWeaknessesResult {
  insufficient_data: boolean;
  reason?: string;
  suggested_difficulty: SuggestedDifficulty | null;
  overall: OverallStats;
  weak_competencies: WeakCompetency[];
}

// --- Tunable thresholds -----------------------------------------------------

/** Minimum MCQ answers required (when there are no evaluations) to say anything. */
export const MIN_ANSWERS_WITHOUT_EVALS = 5;
/** Overall correctness < this ⇒ suggest "easy". */
export const EASY_MAX_PERCENT = 50;
/** Overall correctness < this (and ≥ EASY_MAX) ⇒ suggest "medium"; else "hard". */
export const MEDIUM_MAX_PERCENT = 75;
/** Weight given to evaluation score vs MCQ percent when both are present. */
export const EVAL_WEIGHT = 0.5;

/**
 * Map the group's overall MCQ correctness to a single target difficulty.
 * Returns null when there is no correctness signal at all.
 */
export function suggestDifficulty(
  percentCorrect: number | null,
): SuggestedDifficulty | null {
  if (percentCorrect === null) return null;
  if (percentCorrect < EASY_MAX_PERCENT) return "easy";
  if (percentCorrect < MEDIUM_MAX_PERCENT) return "medium";
  return "hard";
}

interface CompetencyTally {
  mcq_total: number;
  mcq_correct: number;
  evalScores: number[];
}

/**
 * Combine competency scores and quiz correctness into a group's weakest
 * competencies (weakest first), a suggested target difficulty, and overall
 * stats. Returns an explicit `insufficient_data` result rather than fabricating
 * weak areas when the group has essentially no activity.
 */
export function deriveGroupWeaknesses(
  input: DeriveWeaknessesInput,
): DeriveWeaknessesResult {
  const topN = input.topN ?? 3;

  // question_id → competency_ids[]
  const compsByQuestion = new Map<string, string[]>();
  for (const qc of input.questionCompetencies) {
    const list = compsByQuestion.get(qc.question_id) ?? [];
    list.push(qc.competency_id);
    compsByQuestion.set(qc.question_id, list);
  }

  // Overall correctness + per-competency MCQ tallies.
  let totalAnswers = 0;
  let correctAnswers = 0;
  const membersWithData = new Set<string>();
  const tallyByComp = new Map<string, CompetencyTally>();
  const ensure = (cid: string): CompetencyTally => {
    let t = tallyByComp.get(cid);
    if (!t) {
      t = { mcq_total: 0, mcq_correct: 0, evalScores: [] };
      tallyByComp.set(cid, t);
    }
    return t;
  };

  for (const qa of input.quizAnswers) {
    totalAnswers++;
    if (qa.is_correct) correctAnswers++;
    membersWithData.add(qa.user_id);
    for (const cid of compsByQuestion.get(qa.question_id) ?? []) {
      const t = ensure(cid);
      t.mcq_total++;
      if (qa.is_correct) t.mcq_correct++;
    }
  }

  // Evaluation competency scores across the group's latest evaluations.
  let evalScoreCount = 0;
  for (const es of input.evalScores) {
    if (es.score === null || es.score === undefined) continue;
    evalScoreCount++;
    membersWithData.add(es.user_id);
    ensure(es.competency_id).evalScores.push(es.score);
  }

  const percentCorrect = totalAnswers > 0
    ? Math.round((correctAnswers / totalAnswers) * 100)
    : null;

  const overall: OverallStats = {
    member_count: input.memberCount,
    members_with_data: membersWithData.size,
    total_answers: totalAnswers,
    correct_answers: correctAnswers,
    percent_correct: percentCorrect,
  };

  // Insufficient data: no evaluations at all AND too few quiz answers.
  if (evalScoreCount === 0 && totalAnswers < MIN_ANSWERS_WITHOUT_EVALS) {
    return {
      insufficient_data: true,
      reason:
        "This group has no evaluations and too few quiz answers to identify weak areas.",
      suggested_difficulty: null,
      overall,
      weak_competencies: [],
    };
  }

  const competencyById = new Map(input.competencies.map((c) => [c.id, c]));
  const chapterById = new Map(input.chapters.map((c) => [c.id, c]));

  const scored: WeakCompetency[] = [];
  for (const [cid, tally] of tallyByComp) {
    const meta = competencyById.get(cid);
    if (!meta) continue; // competency not in this course's catalog — skip

    const hasMcq = tally.mcq_total > 0;
    const hasEval = tally.evalScores.length > 0;
    if (!hasMcq && !hasEval) continue; // no signal

    const mcqPercent = hasMcq
      ? (tally.mcq_correct / tally.mcq_total) * 100
      : null;
    const evalAvg = hasEval
      ? tally.evalScores.reduce((a, b) => a + b, 0) / tally.evalScores.length
      : null;

    let mastery: number;
    if (evalAvg !== null && mcqPercent !== null) {
      mastery = EVAL_WEIGHT * evalAvg + (1 - EVAL_WEIGHT) * mcqPercent;
    } else if (evalAvg !== null) {
      mastery = evalAvg;
    } else {
      mastery = mcqPercent!;
    }

    // Roll up competency → chapters, preserving order and dropping unknowns.
    const seen = new Set<string>();
    const chapters: ChapterMeta[] = [];
    for (const chId of meta.chapter_ids) {
      if (seen.has(chId)) continue;
      seen.add(chId);
      const ch = chapterById.get(chId);
      if (ch) chapters.push(ch);
    }

    scored.push({
      competency_id: cid,
      title: meta.title,
      mastery: Math.round(mastery),
      eval_avg: evalAvg === null ? null : Math.round(evalAvg),
      mcq_correct: tally.mcq_correct,
      mcq_total: tally.mcq_total,
      mcq_percent: mcqPercent === null ? null : Math.round(mcqPercent),
      chapters,
    });
  }

  // Weakest first; tie-break by title for stable, deterministic ordering.
  scored.sort((a, b) =>
    a.mastery - b.mastery || a.title.localeCompare(b.title)
  );

  return {
    insufficient_data: false,
    suggested_difficulty: suggestDifficulty(percentCorrect),
    overall,
    weak_competencies: scored.slice(0, topN),
  };
}
