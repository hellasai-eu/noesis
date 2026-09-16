/**
 * Draft autosave storage for the evaluator rubric form (#682).
 *
 * Drafts let an evaluator survive a refresh, accidental navigation, or a
 * crashed tab without losing partially-filled rubric input. Storage is
 * localStorage-only — the data is single-machine, ~20 fields per question,
 * and never load-bearing for grading (the source of truth is still an
 * explicit save into `question_evaluations`).
 *
 * Keys are namespaced by evaluator so two evaluators sharing a browser don't
 * leak into each other. The serialized shape is the form's `FormState` with
 * `problem_categories: Set` flattened to a string array — JSON.stringify on
 * a Set would silently emit `{}`.
 */
import type {
  CognitiveLevelCode,
  DifficultyCode,
  ProblemCategoryCode,
  RatingQuestionKey,
  VerdictCode,
  YesNoQuestionKey,
} from "./rubric";

/**
 * Mirrors the form's internal FormState but with `problem_categories` as an
 * array — Sets don't round-trip through JSON.stringify. Kept separate from
 * the form's type so the form owns its in-memory shape and we own the wire
 * shape.
 */
export interface FormDraft {
  verdict: VerdictCode | null;
  difficulty_confirmation: DifficultyCode | null;
  yesNo: Record<YesNoQuestionKey, boolean | null>;
  ratings: Record<RatingQuestionKey, number | null>;
  problem_categories: ProblemCategoryCode[];
  comment: string;
  cognitive_level: CognitiveLevelCode | null;
}

const PREFIX = "evaluator:draft";

function key(evaluatorId: string, questionId: string): string {
  return `${PREFIX}:${evaluatorId}:${questionId}`;
}

export function loadDraft(
  evaluatorId: string,
  questionId: string,
): FormDraft | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key(evaluatorId, questionId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as FormDraft;
    // Cheap shape gate — anything older or corrupted just gets ignored, the
    // user falls back to whatever the server has.
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveDraft(
  evaluatorId: string,
  questionId: string,
  draft: FormDraft,
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key(evaluatorId, questionId), JSON.stringify(draft));
  } catch {
    // Quota exceeded / private mode — drafting is best-effort.
  }
}

export function clearDraft(evaluatorId: string, questionId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key(evaluatorId, questionId));
  } catch {
    // ignore
  }
}

/**
 * Scan storage for all question ids that have an active draft for this
 * evaluator. Used by the session page to render the "unsaved changes" dot
 * next to questions the evaluator has touched but not yet committed.
 */
export function listDraftQuestionIds(evaluatorId: string): string[] {
  if (typeof window === "undefined") return [];
  const prefix = `${PREFIX}:${evaluatorId}:`;
  const out: string[] = [];
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(prefix)) {
        out.push(k.slice(prefix.length));
      }
    }
  } catch {
    // ignore
  }
  return out;
}
