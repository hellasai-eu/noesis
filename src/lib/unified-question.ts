/**
 * Shared types and helpers for the unified Question Bank surface (#621).
 *
 * The unified bank renders every `public.questions` row regardless of `type`.
 * Per-type fields live under `raw` so the expanded-row panels can read the
 * exact shape they need; the columns of the unified table read the
 * type-agnostic projections (`preview`, `searchText`, etc.).
 */
import {
  mcqOptionsFromPayload,
  fillGapsStemFromPayload,
  fillGapsAcceptableAnswersFromAnswerKey,
  orderingPromptFromPayload,
  orderingItemsFromPayload,
  classificationPromptFromPayload,
  classificationCategoriesFromPayload,
  classificationItemsFromPayload,
  classificationAssignmentsFromAnswerKey,
  mcqCorrectIndicesFromAnswerKey,
  openModelAnswerFromAnswerKey,
  openAnsweringModeFromPayload,
  questionDiagramFromPayload,
  type ClassificationCategory,
  type ClassificationItem,
  type OpenAnsweringMode,
} from "@/lib/question-payload";
import type { QuestionType } from "@/types/question";
import type { Json } from "@/integrations/supabase/types";

export interface ChapterReference {
  id: string;
  title: string;
  materialId: string;
  materialTitle: string;
}

/**
 * A whole-document generation source (#1019): a chapterless "Other" material
 * the question was generated from, linked via `question_materials`.
 */
export interface MaterialReference {
  id: string;
  title: string;
}

/** The student group a question batch was generated for (provenance, not assignment). */
export interface GeneratedForGroup {
  id: string;
  name: string;
}

export interface Competency {
  id: string;
  title: string;
}

export interface UnifiedQuestionRaw {
  /** Legacy `questions.question` column (only populated for mcq / open). */
  question: string | null;
  payload: Json | null;
  answer_key: Json | null;
  explanation: string | null;
  generation_rationale: string | null;
}

export interface UnifiedQuestion {
  id: string;
  type: QuestionType;
  /** Type-agnostic short preview shown in the unified table's Question column. */
  preview: string;
  /** Normalized text used for cross-type search (and the basis of cross-type similarity). */
  searchText: string;
  difficulty: "easy" | "medium" | "hard";
  authorName: string | null;
  createdBy: string | null;
  createdAt: string;
  hidden: boolean;
  upvotes: number;
  downvotes: number;
  chapters: ChapterReference[];
  competencies: Competency[];
  /**
   * Whole-document generation sources. Optional so surfaces that build
   * `UnifiedQuestion` without loading the junction keep compiling; treat
   * `undefined` as "not loaded", same as an empty list.
   */
  materials?: MaterialReference[];
  /**
   * The group the question was generated for (`questions.generated_for_group_id`
   * resolved to a name). Optional for the same reason as `materials`.
   */
  generatedForGroup?: GeneratedForGroup | null;
  /**
   * Populated for `type === "open"` only. `undefined` for every other type.
   * #624 — surfaced so consumers (e.g. the Question Bank) can exclude
   * interactive-mode opens, which live in their own "AI Interactive" tab.
   */
  answeringMode?: OpenAnsweringMode;
  raw: UnifiedQuestionRaw;
}

const MAX_PREVIEW_LENGTH = 180;

function truncate(s: string, n = MAX_PREVIEW_LENGTH): string {
  if (s.length <= n) return s;
  return s.slice(0, n).trimEnd() + "…";
}

function stripPlaceholders(stem: string): string {
  // U+2017 (DOUBLE LOW LINE, ‗) instead of ASCII underscore so that two
  // adjacent placeholders don't form a `__bold__` pair when the preview
  // text is fed through formatQuestionText's markdown step. Same fix
  // class as #609 (FillGapsTable + StudentFillGapsQuestions); this was
  // the last surviving callsite still using ASCII underscores.
  return stem.replace(/\{\{\d+\}\}/g, "‗‗‗");
}

/**
 * Build the type-agnostic preview rendered in the unified table's Question column.
 * Markup-free string — the renderer wraps it in a `<span>` and may apply LaTeX.
 */
export function buildPreview(
  type: QuestionType,
  raw: UnifiedQuestionRaw,
): string {
  switch (type) {
    case "mcq": {
      const stem = raw.question || "";
      const options = mcqOptionsFromPayload(raw.payload);
      if (options.length === 0) return truncate(stem);
      const optsPreview = options
        .slice(0, 3)
        .map((opt, idx) => `${String.fromCharCode(65 + idx)}. ${truncate(opt, 40)}`)
        .join(" / ");
      const more = options.length > 3 ? ` / …(+${options.length - 3})` : "";
      return truncate(`${stem} — ${optsPreview}${more}`);
    }
    case "open":
      return truncate(raw.question || "");
    case "fill_gaps": {
      const stem = fillGapsStemFromPayload(raw.payload);
      return truncate(stripPlaceholders(stem));
    }
    case "ordering": {
      // Deliberately does NOT list the items (#1041). They are stored in the
      // correct sequence, and the player shuffles them at render time — so
      // joining them here printed the answer key straight into the practice
      // list. A student reading the row learned the order without opening the
      // question, and ordering is single-submission, so the leaked answer
      // became a recorded 100%.
      //
      // The count keeps the row identifiable and scannable without revealing
      // anything: the prompt already says what is being ordered.
      const prompt = orderingPromptFromPayload(raw.payload);
      const count = orderingItemsFromPayload(raw.payload).length;
      const items = count === 1 ? "1 item" : `${count} items`;
      return truncate(prompt ? `${prompt} — ${items}` : items);
    }
    case "classification": {
      const prompt = classificationPromptFromPayload(raw.payload);
      const categories = classificationCategoriesFromPayload(raw.payload)
        .map((c: ClassificationCategory) => c.label)
        .join(" / ");
      return truncate(prompt ? `${prompt} — ${categories}` : categories);
    }
  }
}

/**
 * Build the normalized text used for cross-type search and similarity.
 * Mirrors the rules described in the issue body so both the in-page filter
 * and the similarity edge function compare apples to apples.
 */
export function buildSearchText(
  type: QuestionType,
  raw: UnifiedQuestionRaw,
): string {
  switch (type) {
    case "mcq":
      // Stem only — options excluded per the issue spec.
      return raw.question || "";
    case "open": {
      const stem = raw.question || "";
      const model = openModelAnswerFromAnswerKey(raw.answer_key);
      return [stem, model].filter(Boolean).join(" ");
    }
    case "fill_gaps": {
      const stem = stripPlaceholders(fillGapsStemFromPayload(raw.payload));
      const firstAcceptable = fillGapsAcceptableAnswersFromAnswerKey(raw.answer_key)
        .map((g) => g.acceptable[0])
        .filter(Boolean)
        .join(" ");
      return [stem, firstAcceptable].filter(Boolean).join(" ");
    }
    case "ordering": {
      const prompt = orderingPromptFromPayload(raw.payload);
      const items = orderingItemsFromPayload(raw.payload).join(" ");
      return [prompt, items].filter(Boolean).join(" ");
    }
    case "classification": {
      const prompt = classificationPromptFromPayload(raw.payload);
      const labels = classificationCategoriesFromPayload(raw.payload)
        .map((c) => c.label)
        .join(" ");
      const items = classificationItemsFromPayload(raw.payload)
        .map((it: ClassificationItem) => it.text)
        .join(" ");
      return [prompt, labels, items].filter(Boolean).join(" ");
    }
  }
}

export const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  mcq: "MCQ",
  open: "Open",
  fill_gaps: "Fill the Gaps",
  ordering: "Ordering",
  classification: "Classification",
};

export const QUESTION_TYPE_DESCRIPTIONS: Record<QuestionType, string> = {
  mcq: "Multiple-choice question with one or more correct answers.",
  open: "Free-text question graded against a model answer.",
  fill_gaps: "Cloze-style sentence with one or more blanks to fill.",
  ordering: "Drag a set of items into the correct sequence.",
  classification: "Sort items into the correct category buckets.",
};

export const ALL_QUESTION_TYPES: QuestionType[] = [
  "mcq",
  "open",
  "fill_gaps",
  "ordering",
  "classification",
];

/**
 * Re-exports kept inside this module so callers can build expanded panels
 * without depending on the lower-level payload helpers directly.
 */
export {
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
};
export type { OpenAnsweringMode };
