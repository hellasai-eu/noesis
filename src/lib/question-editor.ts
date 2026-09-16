/**
 * Shared, UI-agnostic core for the unified per-type question editor (#1001).
 *
 * `parseEditModel` turns a stored question (`UnifiedQuestionRaw` + difficulty)
 * into a flat, editable form model. `buildAndValidate` turns that model back
 * into the `question` / `payload` / `answer_key` / `explanation` / `difficulty`
 * columns, going through the same `to*Unified` writers every other writer uses
 * (`src/lib/question-payload.ts`) and validating the result against the Zod
 * schemas + cross-field validators in `src/types/question.ts`.
 *
 * Keeping this logic out of the React components is deliberate: it is the piece
 * the AC requires per-type Vitest coverage for (a valid edit and a rejected one
 * for each of the five types), and it never touches the DOM or Supabase.
 *
 * Round-tripping: the editor only edits answer content + explanation +
 * difficulty. Everything else a payload/answer_key can carry — the optional
 * `diagram` (all types), and for `open` the `answering_mode` plus the
 * `answer_key.rubric` / `answer_key.explanation` fields — is read out here into
 * `PreservedFields` and fed back through the writers on save, so an edit never
 * silently drops it.
 */
import type { Json } from "@/integrations/supabase/types";
import type { UnifiedQuestionRaw } from "@/lib/unified-question";
import {
  toMcqUnified,
  toOpenUnified,
  toFillGapsUnified,
  toOrderingUnified,
  toClassificationUnified,
  mcqOptionsFromPayload,
  mcqCorrectIndicesFromAnswerKey,
  openModelAnswerFromAnswerKey,
  openAnsweringModeFromPayload,
  fillGapsStemFromPayload,
  fillGapsAcceptableAnswersFromAnswerKey,
  orderingPromptFromPayload,
  orderingItemsFromPayload,
  classificationPromptFromPayload,
  classificationCategoriesFromPayload,
  classificationItemsFromPayload,
  classificationAssignmentsFromAnswerKey,
  questionDiagramFromPayload,
  type QuestionDiagramShape,
  type OpenAnsweringMode,
  type ClassificationCategory,
  type ClassificationItem,
} from "@/lib/question-payload";
import {
  QuestionPayloadByType,
  QuestionAnswerKeyByType,
  validateMcqQuestion,
  validateFillGapsQuestion,
  validateClassificationQuestion,
  type QuestionType,
  type McqPayload,
  type McqAnswerKey,
  type FillGapsPayload,
  type FillGapsAnswerKey,
  type ClassificationPayload,
  type ClassificationAnswerKey,
} from "@/types/question";

// ---------------------------------------------------------------------------
// Difficulty — the `questions.difficulty` column is CHECK-constrained to these.
// ---------------------------------------------------------------------------

export const DIFFICULTIES = ["easy", "medium", "hard"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export function normalizeDifficulty(value: string | null | undefined): Difficulty {
  return (DIFFICULTIES as readonly string[]).includes(value ?? "")
    ? (value as Difficulty)
    : "medium";
}

// ---------------------------------------------------------------------------
// Form models — one flat, plain-value shape per type that the forms bind to.
// ---------------------------------------------------------------------------

export interface McqEditModel {
  kind: "mcq";
  stem: string;
  options: string[];
  correctIndices: number[];
}

export interface OpenEditModel {
  kind: "open";
  stem: string;
  modelAnswer: string;
}

export interface FillGapEntry {
  ordinal: number;
  acceptable: string[];
}

export interface FillGapsEditModel {
  kind: "fill_gaps";
  stem: string;
  gaps: FillGapEntry[];
}

export interface OrderingEditModel {
  kind: "ordering";
  prompt: string;
  items: string[];
}

export interface ClassificationEditModel {
  kind: "classification";
  prompt: string;
  categories: ClassificationCategory[];
  items: ClassificationItem[];
  /** item.id -> category.id */
  assignments: Record<string, string>;
}

export type TypeSpecificEditModel =
  | McqEditModel
  | OpenEditModel
  | FillGapsEditModel
  | OrderingEditModel
  | ClassificationEditModel;

export interface SharedEditFields {
  explanation: string;
  difficulty: Difficulty;
}

/**
 * Fields the editor does not expose but must not drop on save. Fed straight
 * back into the `to*Unified` writers by `buildAndValidate`.
 */
export interface PreservedFields {
  diagram?: QuestionDiagramShape;
  /** open only */
  answeringMode?: OpenAnsweringMode;
  /** open only — `answer_key.rubric` */
  rubric?: string | null;
  /** open only — `answer_key.explanation` (distinct from the top-level column) */
  openAnswerKeyExplanation?: string | null;
  /**
   * The original `questions.question` column. Only mcq/open store the stem
   * there; for the other three types it round-trips unchanged (usually null),
   * because their stem/prompt lives in `payload`.
   */
  originalQuestionColumn: string | null;
}

export interface QuestionEditModel {
  shared: SharedEditFields;
  typed: TypeSpecificEditModel;
  preserved: PreservedFields;
}

// ---------------------------------------------------------------------------
// parseEditModel — stored row -> editable model
// ---------------------------------------------------------------------------

function readOpenAnswerKeyString(
  answerKey: Json | null | undefined,
  key: "rubric" | "explanation",
): string | null {
  if (!answerKey || typeof answerKey !== "object" || Array.isArray(answerKey)) return null;
  const v = (answerKey as Record<string, unknown>)[key];
  return typeof v === "string" ? v : null;
}

export function parseEditModel(
  type: QuestionType,
  raw: UnifiedQuestionRaw,
  difficulty: string | null | undefined,
): QuestionEditModel {
  const shared: SharedEditFields = {
    explanation: raw.explanation ?? "",
    difficulty: normalizeDifficulty(difficulty),
  };
  const diagram = questionDiagramFromPayload(raw.payload) ?? undefined;
  const preserved: PreservedFields = {
    diagram,
    originalQuestionColumn: raw.question,
  };

  let typed: TypeSpecificEditModel;
  switch (type) {
    case "mcq":
      typed = {
        kind: "mcq",
        stem: raw.question ?? "",
        options: mcqOptionsFromPayload(raw.payload),
        correctIndices: mcqCorrectIndicesFromAnswerKey(raw.answer_key),
      };
      break;
    case "open":
      typed = {
        kind: "open",
        stem: raw.question ?? "",
        modelAnswer: openModelAnswerFromAnswerKey(raw.answer_key),
      };
      preserved.answeringMode = openAnsweringModeFromPayload(raw.payload);
      preserved.rubric = readOpenAnswerKeyString(raw.answer_key, "rubric");
      preserved.openAnswerKeyExplanation = readOpenAnswerKeyString(raw.answer_key, "explanation");
      break;
    case "fill_gaps":
      typed = {
        kind: "fill_gaps",
        stem: fillGapsStemFromPayload(raw.payload),
        gaps: fillGapsAcceptableAnswersFromAnswerKey(raw.answer_key).map((g) => ({
          ordinal: g.ordinal,
          acceptable: [...g.acceptable],
        })),
      };
      break;
    case "ordering":
      typed = {
        kind: "ordering",
        prompt: orderingPromptFromPayload(raw.payload),
        items: orderingItemsFromPayload(raw.payload),
      };
      break;
    case "classification":
      typed = {
        kind: "classification",
        prompt: classificationPromptFromPayload(raw.payload),
        categories: classificationCategoriesFromPayload(raw.payload),
        items: classificationItemsFromPayload(raw.payload),
        assignments: classificationAssignmentsFromAnswerKey(raw.answer_key),
      };
      break;
  }

  return { shared, typed, preserved };
}

// ---------------------------------------------------------------------------
// buildAndValidate — editable model -> validated DB columns
// ---------------------------------------------------------------------------

export interface EditError {
  field?: string;
  message: string;
}

export interface QuestionColumns {
  question: string | null;
  payload: Json;
  answer_key: Json;
  explanation: string;
  difficulty: Difficulty;
}

export type BuildResult =
  | { ok: true; columns: QuestionColumns }
  | { ok: false; errors: EditError[] };

function zodErrors(prefix: string, issues: { path: (string | number)[]; message: string }[]): EditError[] {
  return issues.map((i) => ({
    field: [prefix, ...i.path].filter((p) => p !== "").join("."),
    message: i.message,
  }));
}

/**
 * Build the unified columns from an editable model and validate them against
 * the per-type Zod schemas + cross-field validators. Returns every error found
 * (not just the first) so the form can surface them together.
 *
 * The schemas enforce the documented caps (option/item counts, per-gap
 * acceptable counts and lengths, category/item counts, label lengths). This
 * function adds only the checks the schemas can't express because they permit
 * empty strings inside arrays (e.g. a blank MCQ option) or don't cover the
 * free-text `question` column (the mcq/open stem).
 */
export function buildAndValidate(model: QuestionEditModel): BuildResult {
  const errors: EditError[] = [];
  const { typed, shared, preserved } = model;

  let questionColumn: string | null = preserved.originalQuestionColumn;
  let payload: Json;
  let answer_key: Json;

  switch (typed.kind) {
    case "mcq": {
      const stem = typed.stem.trim();
      if (stem === "") errors.push({ field: "stem", message: "The question stem cannot be empty." });
      const options = typed.options.map((o) => o.trim());
      options.forEach((o, i) => {
        if (o === "") errors.push({ field: `options.${i}`, message: `Option ${i + 1} cannot be empty.` });
      });
      if (typed.correctIndices.length === 0) {
        errors.push({ field: "correctIndices", message: "Mark at least one option correct." });
      }
      questionColumn = typed.stem;
      const built = toMcqUnified({
        options,
        correct_answers: typed.correctIndices,
        diagram: preserved.diagram,
      });
      payload = built.payload;
      answer_key = built.answer_key;
      break;
    }
    case "open": {
      const stem = typed.stem.trim();
      if (stem === "") errors.push({ field: "stem", message: "The question stem cannot be empty." });
      if (typed.modelAnswer.trim() === "") {
        errors.push({ field: "modelAnswer", message: "The model answer cannot be empty." });
      }
      questionColumn = typed.stem;
      const built = toOpenUnified({
        model_answer: typed.modelAnswer,
        rubric: preserved.rubric ?? null,
        explanation: preserved.openAnswerKeyExplanation ?? null,
        answering_mode: preserved.answeringMode,
        diagram: preserved.diagram,
      });
      payload = built.payload;
      answer_key = built.answer_key;
      break;
    }
    case "fill_gaps": {
      const built = toFillGapsUnified({
        stem: typed.stem,
        gaps: typed.gaps.map((g) => ({ ordinal: g.ordinal, acceptable: g.acceptable.map((a) => a.trim()) })),
        diagram: preserved.diagram,
      });
      payload = built.payload;
      answer_key = built.answer_key;
      break;
    }
    case "ordering": {
      const built = toOrderingUnified({
        prompt: typed.prompt,
        items: typed.items.map((it) => it.trim()),
        diagram: preserved.diagram,
      });
      payload = built.payload;
      answer_key = built.answer_key;
      break;
    }
    case "classification": {
      const built = toClassificationUnified({
        prompt: typed.prompt,
        categories: typed.categories.map((c) => ({ id: c.id, label: c.label.trim() })),
        items: typed.items.map((it) => ({ id: it.id, text: it.text.trim() })),
        assignments: typed.assignments,
        diagram: preserved.diagram,
      });
      payload = built.payload;
      answer_key = built.answer_key;
      break;
    }
  }

  // Schema validation on the built columns (enforces every documented cap).
  const payloadResult = QuestionPayloadByType[typed.kind].safeParse(payload);
  if (!payloadResult.success) {
    errors.push(...zodErrors("payload", payloadResult.error.issues));
  }
  const answerKeyResult = QuestionAnswerKeyByType[typed.kind].safeParse(answer_key);
  if (!answerKeyResult.success) {
    errors.push(...zodErrors("answer_key", answerKeyResult.error.issues));
  }

  // Cross-field validators — only run when both sides parsed, since they read
  // the typed shapes.
  if (payloadResult.success && answerKeyResult.success) {
    switch (typed.kind) {
      case "mcq":
        if (!validateMcqQuestion(payloadResult.data as McqPayload, answerKeyResult.data as McqAnswerKey)) {
          errors.push({ field: "correctIndices", message: "A correct answer points to an option that does not exist." });
        }
        break;
      case "fill_gaps":
        if (
          !validateFillGapsQuestion(
            payloadResult.data as FillGapsPayload,
            answerKeyResult.data as FillGapsAnswerKey,
          )
        ) {
          errors.push({
            field: "gaps",
            message:
              "The stem's {{1}}, {{2}}, … placeholders must be numbered 1..N with no gaps and match exactly one entry each.",
          });
        }
        break;
      case "classification":
        if (
          !validateClassificationQuestion(
            payloadResult.data as ClassificationPayload,
            answerKeyResult.data as ClassificationAnswerKey,
          )
        ) {
          errors.push({
            field: "assignments",
            message:
              "Every item must be assigned to one of the categories, category labels and item texts must be distinct.",
          });
        }
        break;
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    columns: {
      question: questionColumn,
      payload,
      answer_key,
      explanation: shared.explanation,
      difficulty: shared.difficulty,
    },
  };
}
