/**
 * Non-MCQ answer helpers for the formal quiz flow (#829).
 *
 * `StudentQuiz` renders MCQ natively (`selectedAnswers: number[]`). The other
 * four unified question types (`classification`, `ordering`, `fill_gaps`,
 * `open`) are represented by the discriminated {@link NonMcqAnswer} union and
 * share the helpers below so the quiz's many code paths (immediate submit,
 * deferred submit, auto-submit, resume, the "N of M answered" gate) each branch
 * on `question.type` in ONE place instead of inline per type.
 *
 * These helpers shape and gate an answer; they do not grade one. Since #1094
 * correctness is the server's: `nonMcqSubmission` produces the per-type
 * `submission` jsonb, `submitQuizAnswers` posts it, and the
 * `submit-quiz-answers` edge function decides `quiz_answers.is_correct` from
 * `answer_key` (`open` is recorded for review, never auto-scored). Every helper
 * mirrors the classification integration landed in #820.
 */
import type { Json } from "@/integrations/supabase/types";
import type { QuestionType } from "@/types/question";
import { gradeClassification } from "./grade-classification";
import { gradeOrdering } from "./grade-ordering";
import { gradeFillGaps } from "./grade-fill-gaps";
import { seededShuffle } from "./seeded-shuffle";

export type NonMcqAnswer =
  | { kind: "classification"; placements: Record<string, string> }
  // `touched` records that the student deliberately settled on this order —
  // either by dragging an item or by confirming the order they were shown.
  // Without it the seeded shuffle would be indistinguishable from an answer
  // (#1043).
  | { kind: "ordering"; order: string[]; touched: boolean }
  | { kind: "fill_gaps"; inputs: string[] }
  | { kind: "open"; text: string };

/**
 * The subset of a quiz `Question` the helpers need to initialise, gate,
 * grade, and serialise a non-MCQ answer. `StudentQuiz.Question` is a
 * structural superset, so it satisfies this without an explicit cast.
 */
export interface AnswerableQuestion {
  id: string;
  type: QuestionType;
  // classification (#610/#820)
  items?: { id: string; text: string }[];
  classificationAssignments?: Record<string, string>;
  // ordering (#606) — canonical (correct) order; the renderer shuffles.
  orderingItems?: string[];
  // fill_gaps (#604) — acceptable answers per gap, in ordinal order.
  fillGapsGaps?: { ordinal: number; acceptable: string[] }[];
}

/** True for every unified type whose answer surface is NOT the MCQ options grid. */
export function isNonMcqType(type: QuestionType): boolean {
  return type !== "mcq";
}

/**
 * The initial draft for a freshly-opened non-MCQ question. Ordering seeds a
 * deterministic per-(question, user) shuffle so the student sees a stable
 * order across re-renders (matching practice mode) — but seeds it `touched:
 * false`, because a shuffle nobody chose is not an answer; the other types
 * start empty.
 */
export function emptyNonMcqAnswer(
  q: AnswerableQuestion,
  userId: string,
): NonMcqAnswer {
  switch (q.type) {
    case "classification":
      return { kind: "classification", placements: {} };
    case "ordering": {
      const items = q.orderingItems ?? [];
      const order = userId ? seededShuffle(items, `${q.id}::${userId}`) : [...items];
      return { kind: "ordering", order, touched: false };
    }
    case "fill_gaps":
      return {
        kind: "fill_gaps",
        inputs: new Array((q.fillGapsGaps ?? []).length).fill(""),
      };
    case "open":
    default:
      return { kind: "open", text: "" };
  }
}

/**
 * Whether a non-MCQ answer counts toward the "answered" gate. Classification
 * needs every card placed; fill_gaps needs every blank non-empty; open needs
 * non-empty text.
 *
 * Ordering needs every item AND a `touched` flag (#1043). It used to accept
 * the seeded shuffle as-is, which made the question "answered" the instant it
 * rendered: a study-guide piece of four questions reported three unanswered,
 * and a student could submit a one-shot, immutable piece having never opened
 * the ordering question — then be graded all-or-nothing on an order they never
 * chose. Requiring `touched` costs a student who agrees with the order one
 * click on the field's "Keep this order" confirm, and costs everyone else
 * nothing, since a single drag sets it.
 */
export function isNonMcqComplete(
  q: AnswerableQuestion,
  answer: NonMcqAnswer | undefined,
): boolean {
  if (!answer) return false;
  switch (answer.kind) {
    case "classification": {
      const items = q.items ?? [];
      if (items.length === 0) return false;
      return items.every(
        (it) =>
          typeof answer.placements[it.id] === "string" &&
          answer.placements[it.id].length > 0,
      );
    }
    case "ordering": {
      const items = q.orderingItems ?? [];
      return (
        items.length > 0 && answer.order.length === items.length && answer.touched
      );
    }
    case "fill_gaps":
      return (
        answer.inputs.length > 0 &&
        answer.inputs.every((v) => typeof v === "string" && v.trim().length > 0)
      );
    case "open":
      return answer.text.trim().length > 0;
  }
}

/**
 * Correctness for a non-MCQ answer, by the same rules the server applies.
 *
 * No longer on the quiz submission path — `quiz_answers.is_correct` is decided
 * by `submit-quiz-answers` from the stored `answer_key`, and a verdict computed
 * here would not be trusted if it were sent (#1094). Kept for callers that need
 * the outcome for DISPLAY without a round trip, and as the reference the Deno
 * mirror of these graders is checked against.
 */
export function gradeNonMcq(
  q: AnswerableQuestion,
  answer: NonMcqAnswer,
): boolean {
  switch (answer.kind) {
    case "classification":
      return gradeClassification(
        answer.placements,
        q.classificationAssignments ?? {},
      ).allCorrect;
    case "ordering":
      return gradeOrdering(answer.order, q.orderingItems ?? []).allCorrect;
    case "fill_gaps":
      return gradeFillGaps(
        answer.inputs,
        (q.fillGapsGaps ?? []).map((g) => g.acceptable),
      ).allCorrect;
    case "open":
      return false;
  }
}

/**
 * The `quiz_answers.submission` jsonb for a non-MCQ answer. Each type uses a
 * distinct top-level key so the review surfaces and history readers can
 * discriminate. None of these carry `selected_indices`, so they satisfy the
 * `quiz_answers_submission_valid` CHECK (which only constrains a present
 * `selected_indices`; see migration 20260621000000).
 */
export function nonMcqSubmission(answer: NonMcqAnswer): Json {
  switch (answer.kind) {
    case "classification":
      return { classification: answer.placements };
    case "ordering":
      return { ordering: answer.order };
    case "fill_gaps":
      return { fill_gaps: answer.inputs };
    case "open":
      return { open_text: answer.text };
  }
}

/**
 * Reconstruct a non-MCQ answer from a persisted `quiz_answers` row so a
 * resumed / reviewed attempt shows what the student submitted. Defends
 * against malformed jsonb by falling back to an empty answer of the right
 * kind.
 */
export function readNonMcqAnswer(
  q: AnswerableQuestion,
  row: { submission?: Json | null },
  userId: string,
): NonMcqAnswer {
  const sub =
    row.submission && typeof row.submission === "object" && !Array.isArray(row.submission)
      ? (row.submission as Record<string, unknown>)
      : null;

  switch (q.type) {
    case "classification": {
      const cls = sub?.classification;
      const placements: Record<string, string> = {};
      if (cls && typeof cls === "object" && !Array.isArray(cls)) {
        for (const [k, v] of Object.entries(cls as Record<string, unknown>)) {
          if (typeof v === "string" && v.length > 0) placements[k] = v;
        }
      }
      return { kind: "classification", placements };
    }
    case "ordering": {
      const raw = sub?.ordering;
      const order = Array.isArray(raw)
        ? raw.filter((v): v is string => typeof v === "string")
        : [];
      // Fall back to the deterministic shuffle when nothing was stored so the
      // question still renders a valid order. A stored order is `touched` by
      // definition — it is what the student submitted — while the fallback is
      // not, so a resumed-but-unanswered question stays behind the gate.
      if (order.length > 0) return { kind: "ordering", order, touched: true };
      return emptyNonMcqAnswer(q, userId);
    }
    case "fill_gaps": {
      const raw = sub?.fill_gaps;
      const gapCount = (q.fillGapsGaps ?? []).length;
      const inputs = new Array(gapCount).fill("");
      if (Array.isArray(raw)) {
        raw.forEach((v, i) => {
          if (i < inputs.length && typeof v === "string") inputs[i] = v;
        });
      }
      return { kind: "fill_gaps", inputs };
    }
    case "open":
    default: {
      const raw = sub?.open_text;
      return { kind: "open", text: typeof raw === "string" ? raw : "" };
    }
  }
}
