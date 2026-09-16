/**
 * Pure aggregation for the instructor study-guide results view (#981).
 *
 * The raw statistics on that surface are deterministic — they are arithmetic
 * over `study_guide_progress` and `study_guide_answers`, not a model call — so
 * they live here, testable without React or a Supabase client. The component
 * fetches rows, subscribes to realtime, and re-runs these functions.
 *
 * The one thing that is NOT obvious arithmetic: a study guide is an ordered,
 * GATED sequence, so a later piece is thin because fewer students have reached
 * it, not because it is easy or hard. Every per-piece and per-competency
 * aggregate therefore carries the response count it rests on, and
 * {@link LOW_CONFIDENCE_RESPONSES} marks the ones too thin to read as a signal.
 * Presenting a piece answered by one student next to one answered by thirty,
 * with no distinction, is the specific way this view would mislead.
 */
import type { QuestionType } from "@/types/question";
import { collatorFor, currentLocale } from "@/i18n/formatters";
import type { AnalysisCluster } from "@/lib/analysis-clusters";

/**
 * Below this many distinct responders, a piece or competency is a thin signal
 * rather than a finding. Mirrors LOW_CONFIDENCE_RESPONSES in the
 * `analyze-study-guide` edge function so the raw table and the AI assessment
 * caveat the same rows.
 */
export const LOW_CONFIDENCE_RESPONSES = 3;

/** A passing open-answer grade counts as "got it" in the objective tally. */
export const OPEN_PASS_GRADE = 50;

/** Bucket key for questions with no `competency_id`. */
export const UNATTRIBUTED_COMPETENCY = "__unattributed__";

// ---------------------------------------------------------------------------
// Inputs — the shapes the component reads out of the database
// ---------------------------------------------------------------------------

export interface AnalyticsPiece {
  id: string;
  position: number;
  title: string;
}

export interface AnalyticsQuestion {
  id: string;
  pieceId: string;
  /** Order within the piece. */
  position: number;
  type: QuestionType;
  text: string;
  options: string[];
  competencyId: string | null;
}

export interface AnalyticsStudent {
  userId: string;
  fullName: string;
}

export interface AnalyticsProgress {
  userId: string;
  currentPiecePosition: number;
  completedAt: string | null;
}

export interface AnalyticsAnswer {
  userId: string;
  questionId: string;
  pieceId: string;
  /** Option indices for MCQ; ignored for every other type. */
  selectedIndices: number[];
  isCorrect: boolean | null;
  grade: number | null;
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

export type StudentStatus = "not_started" | "in_progress" | "completed";

export interface StudentRow {
  userId: string;
  fullName: string;
  status: StudentStatus;
  /** Position of the piece they are on, clamped to the guide's length. */
  currentPiecePosition: number;
  piecesCompleted: number;
  answered: number;
  correct: number;
  /** Open answers recorded but not yet graded by the instructor. */
  pendingReview: number;
  /** Mean of the per-answer grades, 0-100, or null when nothing is answered. */
  meanScore: number | null;
}

export interface QuestionAggregate {
  questionId: string;
  pieceId: string;
  position: number;
  type: QuestionType;
  text: string;
  answered: number;
  correct: number;
  incorrect: number;
  /** Open answers recorded but not yet graded by the instructor. */
  pendingReview: number;
  meanScore: number | null;
  /** Present only for MCQ questions that have option text. */
  optionDistribution?: Array<{ option: string; count: number }>;
}

export interface PieceAggregate {
  pieceId: string;
  position: number;
  title: string;
  /** Distinct students who have answered at least one question in the piece. */
  respondents: number;
  /** Distinct students who have moved PAST this piece. */
  completed: number;
  meanScore: number | null;
  /** True when too few students have reached the piece to read anything into it. */
  lowConfidence: boolean;
  /** Weakest questions in the piece, worst first. Only answered ones appear. */
  hardestQuestions: QuestionAggregate[];
}

export interface CompetencyAggregate {
  /** The competency id, or {@link UNATTRIBUTED_COMPETENCY}. */
  competencyId: string;
  title: string;
  /** True for the synthetic bucket holding questions with no competency. */
  unattributed: boolean;
  answered: number;
  correct: number;
  /** Open answers recorded but not yet graded by the instructor. */
  pendingReview: number;
  respondents: number;
  meanScore: number | null;
  lowConfidence: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Rounded mean of a grade list, or null when there is nothing to average. */
function meanOf(grades: number[]): number | null {
  if (grades.length === 0) return null;
  return Math.round(grades.reduce((sum, g) => sum + g, 0) / grades.length);
}

/**
 * Whether an answer counts as "got it".
 *
 * Objective questions carry `is_correct`. Open answers carry only a 0-100
 * `grade` with `is_correct === null`, so a pass mark stands in — otherwise
 * every open answer would silently count as wrong. Matches the same rule in
 * the `analyze-study-guide` handler.
 */
export function answerCountsAsCorrect(answer: AnalyticsAnswer): boolean {
  if (answer.isCorrect !== null) return answer.isCorrect;
  return typeof answer.grade === "number" && answer.grade >= OPEN_PASS_GRADE;
}

/**
 * An open answer recorded but not yet graded by the instructor. It must count
 * as neither correct nor incorrect — open answers are held for review, never
 * auto-scored — so every correctness rate excludes it from the denominator.
 * Matches the same rule in the `analyze-study-guide` handler.
 */
export function answerIsPendingReview(answer: AnalyticsAnswer): boolean {
  return answer.isCorrect === null && typeof answer.grade !== "number";
}

/** Grades that can be averaged (an ungraded row must not count as a zero). */
function gradesOf(answers: AnalyticsAnswer[]): number[] {
  return answers.map((a) => a.grade).filter((g): g is number => typeof g === "number");
}

// ---------------------------------------------------------------------------
// Aggregations
// ---------------------------------------------------------------------------

/**
 * One row per enrolled student, including students who have not started.
 *
 * Absent progress means "not started" — the player creates the progress row on
 * first open, so a missing row is a student who has never opened the guide.
 * A student with a progress row but no answers has opened it without
 * submitting; they still read as `in_progress`, which is the honest answer to
 * "has this student engaged at all".
 */
export function buildStudentRows(
  roster: AnalyticsStudent[],
  progress: AnalyticsProgress[],
  answers: AnalyticsAnswer[],
  pieceCount: number,
): StudentRow[] {
  const progressByUser = new Map(progress.map((p) => [p.userId, p]));
  const answersByUser = new Map<string, AnalyticsAnswer[]>();
  for (const a of answers) {
    const list = answersByUser.get(a.userId);
    if (list) list.push(a);
    else answersByUser.set(a.userId, [a]);
  }

  return roster.map((student) => {
    const p = progressByUser.get(student.userId);
    const mine = answersByUser.get(student.userId) ?? [];
    const position = Math.min(p?.currentPiecePosition ?? 0, pieceCount);
    const completed = !!p?.completedAt || (pieceCount > 0 && position >= pieceCount);
    const status: StudentStatus = !p
      ? "not_started"
      : completed
        ? "completed"
        : "in_progress";
    return {
      userId: student.userId,
      fullName: student.fullName,
      status,
      currentPiecePosition: position,
      piecesCompleted: position,
      answered: mine.length,
      correct: mine.filter(answerCountsAsCorrect).length,
      pendingReview: mine.filter(answerIsPendingReview).length,
      meanScore: meanOf(gradesOf(mine)),
    };
  });
}

/** Per-question tallies, in piece then question order. */
export function buildQuestionAggregates(
  questions: AnalyticsQuestion[],
  answers: AnalyticsAnswer[],
): QuestionAggregate[] {
  const answersByQuestion = new Map<string, AnalyticsAnswer[]>();
  for (const a of answers) {
    const list = answersByQuestion.get(a.questionId);
    if (list) list.push(a);
    else answersByQuestion.set(a.questionId, [a]);
  }

  return questions.map((q) => {
    const qAnswers = answersByQuestion.get(q.id) ?? [];
    const correct = qAnswers.filter(answerCountsAsCorrect).length;
    const pendingReview = qAnswers.filter(answerIsPendingReview).length;
    let optionDistribution: Array<{ option: string; count: number }> | undefined;
    if (q.type === "mcq" && q.options.length > 0) {
      const counts = new Array(q.options.length).fill(0);
      for (const a of qAnswers) {
        for (const idx of a.selectedIndices) {
          if (idx >= 0 && idx < counts.length) counts[idx]++;
        }
      }
      optionDistribution = q.options.map((option, i) => ({ option, count: counts[i] }));
    }
    return {
      questionId: q.id,
      pieceId: q.pieceId,
      position: q.position,
      type: q.type,
      text: q.text,
      answered: qAnswers.length,
      correct,
      incorrect: qAnswers.length - pendingReview - correct,
      pendingReview,
      meanScore: meanOf(gradesOf(qAnswers)),
      ...(optionDistribution ? { optionDistribution } : {}),
    };
  });
}

/**
 * Per-piece aggregates in sequence order.
 *
 * `completed` counts students whose progress has moved PAST the piece, which is
 * the only reliable completion signal: a student may have answered some of a
 * piece's questions in an earlier version of the guide, and the progress
 * pointer is what the player itself gates on.
 *
 * @param hardestLimit how many weakest questions to surface per piece.
 */
export function buildPieceAggregates(
  pieces: AnalyticsPiece[],
  questions: AnalyticsQuestion[],
  answers: AnalyticsAnswer[],
  progress: AnalyticsProgress[],
  hardestLimit = 3,
): PieceAggregate[] {
  const questionAggregates = buildQuestionAggregates(questions, answers);
  const aggregatesByPiece = new Map<string, QuestionAggregate[]>();
  for (const qa of questionAggregates) {
    const list = aggregatesByPiece.get(qa.pieceId);
    if (list) list.push(qa);
    else aggregatesByPiece.set(qa.pieceId, [qa]);
  }

  const answersByPiece = new Map<string, AnalyticsAnswer[]>();
  for (const a of answers) {
    const list = answersByPiece.get(a.pieceId);
    if (list) list.push(a);
    else answersByPiece.set(a.pieceId, [a]);
  }

  return [...pieces]
    .sort((a, b) => a.position - b.position)
    .map((piece) => {
      const pieceAnswers = answersByPiece.get(piece.id) ?? [];
      const respondents = new Set(pieceAnswers.map((a) => a.userId)).size;
      const completed = progress.filter((p) => p.currentPiecePosition > piece.position).length;
      const hardest = (aggregatesByPiece.get(piece.id) ?? [])
        // Rates are over gradable answers only — a pending open answer is
        // neither evidence of difficulty nor of mastery.
        .filter((qa) => qa.answered - qa.pendingReview > 0)
        // Worst first. Ties break on the larger sample, which is the more
        // trustworthy of two equally-bad-looking questions.
        .sort((a, b) => {
          const aRate = a.correct / (a.answered - a.pendingReview);
          const bRate = b.correct / (b.answered - b.pendingReview);
          if (aRate !== bRate) return aRate - bRate;
          return b.answered - a.answered;
        })
        .slice(0, hardestLimit);
      return {
        pieceId: piece.id,
        position: piece.position,
        title: piece.title,
        respondents,
        completed,
        meanScore: meanOf(gradesOf(pieceAnswers)),
        lowConfidence: respondents < LOW_CONFIDENCE_RESPONSES,
        hardestQuestions: hardest,
      };
    });
}

/**
 * Class mastery per competency, weakest first.
 *
 * Questions with no `competency_id` are collected into a single unattributed
 * bucket rather than dropped: silently omitting them would make the roll-up
 * look like it covers the whole guide when it covers only the attributed part.
 * The bucket sorts last regardless of score — it is a coverage gap to fix, not
 * a competency to reteach.
 */
export function buildCompetencyAggregates(
  questions: AnalyticsQuestion[],
  answers: AnalyticsAnswer[],
  competencyTitles: Map<string, string>,
  unattributedLabel = "Not linked to a competency",
  /** Locale for the title tie-break. Defaults to the active one. */
  locale: string = currentLocale(),
): CompetencyAggregate[] {
  const competencyByQuestion = new Map(questions.map((q) => [q.id, q.competencyId]));

  const buckets = new Map<string, AnalyticsAnswer[]>();
  for (const a of answers) {
    if (!competencyByQuestion.has(a.questionId)) continue; // not part of this guide
    const key = competencyByQuestion.get(a.questionId) ?? UNATTRIBUTED_COMPETENCY;
    const list = buckets.get(key);
    if (list) list.push(a);
    else buckets.set(key, [a]);
  }

  // Every competency referenced by the guide gets a row even with zero answers,
  // so "nobody has reached this yet" is visible rather than absent.
  for (const q of questions) {
    const key = q.competencyId ?? UNATTRIBUTED_COMPETENCY;
    if (!buckets.has(key)) buckets.set(key, []);
  }

  const rows: CompetencyAggregate[] = [];
  for (const [key, bucketAnswers] of buckets) {
    const unattributed = key === UNATTRIBUTED_COMPETENCY;
    const respondents = new Set(bucketAnswers.map((a) => a.userId)).size;
    rows.push({
      competencyId: key,
      title: unattributed ? unattributedLabel : competencyTitles.get(key) ?? "Untitled competency",
      unattributed,
      answered: bucketAnswers.length,
      correct: bucketAnswers.filter(answerCountsAsCorrect).length,
      pendingReview: bucketAnswers.filter(answerIsPendingReview).length,
      respondents,
      meanScore: meanOf(gradesOf(bucketAnswers)),
      lowConfidence: respondents < LOW_CONFIDENCE_RESPONSES,
    });
  }

  return rows.sort((a, b) => {
    if (a.unattributed !== b.unattributed) return a.unattributed ? 1 : -1;
    // Unscored rows sort last within their group — there is nothing to act on.
    if (a.meanScore === null && b.meanScore === null) {
      return collatorFor(locale).compare(a.title, b.title);
    }
    if (a.meanScore === null) return 1;
    if (b.meanScore === null) return -1;
    return a.meanScore - b.meanScore;
  });
}

// ---------------------------------------------------------------------------
// The cached AI assessment
//
// Its shape mirrors what `analyze-study-guide` writes into
// `study_guide_analyses.report`. It lives here rather than in the panel so the
// defensive reader below can be tested on its own: the column is JSONB written
// by a model-driven function, so the panel must survive a row from an older
// schema, a partial write, or a field the model omitted — rendering what it
// can rather than throwing.
// ---------------------------------------------------------------------------

export interface StudyGuideFinding {
  topic: string;
  description: string;
  piece_positions: number[];
  competency_ids: string[];
}

export interface StudyGuideMisconception {
  title: string;
  description: string;
  evidence: string;
  piece_positions: number[];
}

export interface StudyGuideAction {
  action: string;
  rationale: string;
  piece_positions: number[];
}

export interface StudyGuideReport {
  overall_narrative: string;
  strengths: StudyGuideFinding[];
  weaknesses: StudyGuideFinding[];
  misconceptions: StudyGuideMisconception[];
  suggested_actions: StudyGuideAction[];
  summary: string;
  low_confidence_piece_positions: number[];
  low_confidence_competency_ids: string[];
}

export interface StudyGuideAnalysis {
  report: StudyGuideReport;
  /**
   * Students grouped by the conceptual struggle they share, as
   * `analyze-study-guide` wrote them. Same shape as `quiz_analyses.clusters`,
   * which is why the type is imported rather than redeclared: both panels feed
   * the same editing section, and a drift between the two shapes would show up
   * as a runtime surprise there rather than a type error here.
   */
  clusters: AnalysisCluster[];
  submission_count: number;
  low_confidence: boolean;
  generated_at: string | null;
  model: string | null;
}

/** Normalize a persisted row or an edge-function payload into a StudyGuideAnalysis. */
export function normalizeStudyGuideAnalysis(row: unknown): StudyGuideAnalysis {
  const r = (row ?? {}) as Record<string, unknown>;
  const report = (r.report ?? {}) as Record<string, unknown>;
  const objects = <T,>(value: unknown): T[] =>
    Array.isArray(value)
      ? value.filter((v): v is T => !!v && typeof v === "object" && !Array.isArray(v))
      : [];
  const numbers = (value: unknown): number[] =>
    Array.isArray(value) ? value.filter((v): v is number => typeof v === "number") : [];
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

  return {
    report: {
      overall_narrative:
        typeof report.overall_narrative === "string" ? report.overall_narrative : "",
      strengths: objects<StudyGuideFinding>(report.strengths),
      weaknesses: objects<StudyGuideFinding>(report.weaknesses),
      misconceptions: objects<StudyGuideMisconception>(report.misconceptions),
      suggested_actions: objects<StudyGuideAction>(report.suggested_actions),
      summary: typeof report.summary === "string" ? report.summary : "",
      low_confidence_piece_positions: numbers(report.low_confidence_piece_positions),
      low_confidence_competency_ids: strings(report.low_confidence_competency_ids),
    },
    // A row written before clusters existed has no `clusters` key at all, and a
    // model that returned a malformed member list must not take the panel down
    // with it — every level is filtered rather than trusted.
    clusters: objects<Record<string, unknown>>(r.clusters).map((c) => ({
      label: typeof c.label === "string" && c.label.trim() ? c.label : "Group",
      rationale: typeof c.rationale === "string" ? c.rationale : "",
      summary: typeof c.summary === "string" ? c.summary : "",
      member_user_ids: strings(c.member_user_ids),
      // The created-group markers the clusters section stamps after turning a
      // cluster into a real group — dropped here, a reopened panel would
      // forget the group exists and create a duplicate.
      ...(typeof c.created_group_id === "string" && c.created_group_id
        ? {
            created_group_id: c.created_group_id,
            ...(typeof c.created_group_name === "string" && c.created_group_name
              ? { created_group_name: c.created_group_name }
              : {}),
          }
        : {}),
    })),
    submission_count: typeof r.submission_count === "number" ? r.submission_count : 0,
    low_confidence: !!r.low_confidence,
    generated_at: typeof r.generated_at === "string" ? r.generated_at : null,
    model: typeof r.model === "string" ? r.model : null,
  };
}
