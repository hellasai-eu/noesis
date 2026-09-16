/**
 * Pure logic for the sequential study-guide player (#980).
 *
 * Two concerns live here so they can be unit-tested without React:
 *   1. The lock/unlock state machine — given the ordered pieces and the
 *      student's `current_piece_position`, which pieces are locked, which is
 *      current, which are completed.
 *   2. The per-piece "all questions answered" submit gate.
 *
 * The player represents a student's in-progress answer to a question with the
 * {@link PlayerAnswer} union — MCQ (option indices) plus the four
 * `NonMcqAnswer` shapes reused verbatim from the quiz flow (`quiz-non-mcq.ts`),
 * so the completeness gate and the submission/review round-trip come for free.
 */
import type { Json } from "@/integrations/supabase/types";
import type { QuestionType } from "@/types/question";
import {
  type AnswerableQuestion,
  type NonMcqAnswer,
  emptyNonMcqAnswer,
  isNonMcqComplete,
  nonMcqSubmission,
  readNonMcqAnswer,
} from "./quiz-non-mcq";

// ---------------------------------------------------------------------------
// Lock / unlock state machine
// ---------------------------------------------------------------------------

export type PieceStatus = "locked" | "current" | "completed";

export interface PieceLike {
  id: string;
  position: number;
}

export interface PieceState<P extends PieceLike = PieceLike> {
  piece: P;
  status: PieceStatus;
}

/**
 * Status of a single piece. `current_piece_position` is the furthest position
 * the student may open; it advances to `submittedPiece.position + 1` on submit.
 * So pieces below it are completed (submitted, openable for review), the piece
 * at it is the active one, and pieces above it are locked.
 */
export function pieceStatusForPosition(
  position: number,
  currentPiecePosition: number,
): PieceStatus {
  if (position < currentPiecePosition) return "completed";
  if (position === currentPiecePosition) return "current";
  return "locked";
}

/**
 * Per-piece status for the whole guide, in ascending `position` order. Pure —
 * derives everything from the pieces and `current_piece_position`.
 */
export function computePieceStates<P extends PieceLike>(
  pieces: P[],
  currentPiecePosition: number,
): PieceState<P>[] {
  return [...pieces]
    .sort((a, b) => a.position - b.position)
    .map((piece) => ({
      piece,
      status: pieceStatusForPosition(piece.position, currentPiecePosition),
    }));
}

/** A piece may be opened when it is the current one or already completed. */
export function isPieceOpenable(status: PieceStatus): boolean {
  return status !== "locked";
}

/**
 * The guide is complete once the current position has advanced past every
 * piece (i.e. the final piece has been submitted). Empty guides are never
 * "complete" — there is nothing to work through.
 */
export function isGuideComplete(
  pieces: PieceLike[],
  currentPiecePosition: number,
): boolean {
  if (pieces.length === 0) return false;
  const maxPosition = pieces.reduce((m, p) => Math.max(m, p.position), 0);
  return currentPiecePosition > maxPosition;
}

/**
 * Splits the pieces the student may open into those whose `answer_key` the
 * player is allowed to fetch and those it must not (#1011).
 *
 * `AnswerField` reveals correctness only for a `completed` piece
 * (`reveal={reviewing}`), so the key is needed exactly there. Fetching it for
 * the `current` piece put the answers in the network response and in memory
 * before the student had answered a single question — invisible on screen, one
 * DevTools panel away, and on a one-attempt immutable assessment.
 *
 * `locked` pieces appear in neither list: they are already withheld wholesale,
 * theory included.
 *
 * NOTE this narrows the client only. RLS grants students row access to
 * `questions` and no column privileges are applied, so the key remains readable
 * by a direct PostgREST request with the student's own JWT. Closing that needs
 * the database half of #1011.
 */
export function splitPieceIdsByReveal<P extends PieceLike>(
  pieces: P[],
  currentPiecePosition: number,
): { revealed: string[]; unrevealed: string[] } {
  const revealed: string[] = [];
  const unrevealed: string[] = [];
  for (const { piece, status } of computePieceStates(pieces, currentPiecePosition)) {
    if (status === "completed") revealed.push(piece.id);
    else if (status === "current") unrevealed.push(piece.id);
  }
  return { revealed, unrevealed };
}

/**
 * The `current_piece_position` a guide advances to after submitting the piece
 * at `submittedPosition`. Never regresses below the current value (a re-viewed
 * earlier piece must not pull the student back).
 */
export function nextPositionAfterSubmit(
  submittedPosition: number,
  currentPiecePosition: number,
): number {
  return Math.max(currentPiecePosition, submittedPosition + 1);
}

// ---------------------------------------------------------------------------
// Player answer union + the submit gate
// ---------------------------------------------------------------------------

export type PlayerAnswer =
  | { kind: "mcq"; selected: number[] }
  | NonMcqAnswer;

/** The subset of a study-guide question the player logic needs. */
export interface PlayerQuestion extends AnswerableQuestion {
  id: string;
  type: QuestionType;
}

/** The initial draft for a freshly-opened question. */
export function emptyPlayerAnswer(
  q: PlayerQuestion,
  userId: string,
): PlayerAnswer {
  if (q.type === "mcq") return { kind: "mcq", selected: [] };
  return emptyNonMcqAnswer(q, userId);
}

/** Whether one answer counts toward the "answered" gate. */
export function isPlayerAnswerComplete(
  q: PlayerQuestion,
  answer: PlayerAnswer | undefined,
): boolean {
  if (!answer) return false;
  if (answer.kind === "mcq") return answer.selected.length > 0;
  return isNonMcqComplete(q, answer);
}

/**
 * The ids of the piece's questions that still have no acceptable answer. The
 * submit control is disabled while this is non-empty and can name the gaps.
 */
export function unansweredQuestionIds(
  questions: PlayerQuestion[],
  answers: Record<string, PlayerAnswer | undefined>,
): string[] {
  return questions
    .filter((q) => !isPlayerAnswerComplete(q, answers[q.id]))
    .map((q) => q.id);
}

/** True once every question in the piece has an acceptable answer. */
export function pieceSubmitReady(
  questions: PlayerQuestion[],
  answers: Record<string, PlayerAnswer | undefined>,
): boolean {
  return questions.length > 0 && unansweredQuestionIds(questions, answers).length === 0;
}

/**
 * The `submission` jsonb persisted for one answer. MCQ dual-writes nothing
 * legacy here — the study guide stores `{ selected_indices }`; the four
 * non-MCQ types reuse the quiz submission shapes so {@link readPlayerAnswer}
 * (and the quiz's `readNonMcqAnswer`) can reconstruct them.
 */
export function playerSubmission(answer: PlayerAnswer): Json {
  if (answer.kind === "mcq") return { selected_indices: answer.selected };
  return nonMcqSubmission(answer);
}

/**
 * The option indices a persisted MCQ `submission` records, or `[]` for any
 * shape we can't read.
 *
 * Exported so the instructor analytics (#981) can tally option distributions
 * without reconstructing a whole {@link PlayerAnswer} — it has no question to
 * hand, only rows. Keeping the `selected_indices` key known in exactly one
 * place is the point; two readers drifting apart is how an option histogram
 * silently reads zero.
 */
export function mcqSelectedIndices(submission: Json | null | undefined): number[] {
  const sub =
    submission && typeof submission === "object" && !Array.isArray(submission)
      ? (submission as Record<string, unknown>)
      : null;
  const raw = sub?.selected_indices;
  return Array.isArray(raw) ? raw.filter((v): v is number => typeof v === "number") : [];
}

/** Reconstruct a player answer from a persisted `submission` jsonb (review). */
export function readPlayerAnswer(
  q: PlayerQuestion,
  row: { submission?: Json | null },
  userId: string,
): PlayerAnswer {
  if (q.type === "mcq") {
    return { kind: "mcq", selected: mcqSelectedIndices(row.submission) };
  }
  return readNonMcqAnswer(q, row, userId);
}

// ---------------------------------------------------------------------------
// The in-progress draft codec (`study_guide_progress.draft_answers`)
// ---------------------------------------------------------------------------
//
// A draft entry is NOT a submission, even though it has carried the same
// shape until now. A submission is a decision the student has made; a draft is
// whatever the player is holding, decided or not. Ordering is where that gap
// bites (#1043): the seeded shuffle is a rendering default, and a draft that
// cannot say so reads back as an order the student chose.
//
// So drafts get their own codec. It reuses the submission shapes verbatim —
// one set of persisted key names — and adds the ordering-only
// `ordering_touched` stamp, which `playerSubmission` must never carry (the
// submission jsonb is the wire contract the edge function grades).
//
// This is the authoritative description of a draft entry's shape. The column
// comment on `study_guide_progress.draft_answers` (20260728220000) predates the
// stamp and still describes entries as plain submissions — harmlessly, since an
// unknown key is ignored by every reader, but refresh it in the next migration
// that touches that table.

/** The key a draft entry stamps the ordering gate flag under. */
const ORDERING_TOUCHED_KEY = "ordering_touched";

/**
 * The jsonb persisted for one in-progress draft answer.
 *
 * The `ordering_touched` stamp is what tells a restored ordering draft apart
 * from the seeded shuffle. An entry without it — a legacy draft written before
 * the flag existed, when the player persisted every question's seeded default
 * — resumes untouched, i.e. behind the submit gate, which is the safe reading:
 * the student may never have opened that question.
 */
export function playerDraftEntry(answer: PlayerAnswer): Json {
  const base = playerSubmission(answer);
  if (answer.kind !== "ordering") return base;
  // Spread rather than rebuild, so the `ordering` key stays defined in exactly
  // one place (`nonMcqSubmission`).
  return { ...(base as Record<string, Json>), [ORDERING_TOUCHED_KEY]: answer.touched };
}

/** Reconstruct a draft answer from a {@link playerDraftEntry}. */
export function readPlayerDraft(
  q: PlayerQuestion,
  entry: Json | null | undefined,
  userId: string,
): PlayerAnswer {
  const answer = readPlayerAnswer(q, { submission: entry ?? null }, userId);
  if (answer.kind !== "ordering") return answer;
  const obj =
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? (entry as Record<string, unknown>)
      : null;
  return { ...answer, touched: obj?.[ORDERING_TOUCHED_KEY] === true };
}
