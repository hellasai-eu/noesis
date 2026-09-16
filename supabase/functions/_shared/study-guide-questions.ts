/**
 * Converts the flat question objects the study guide generator returns into
 * the unified `public.questions` row shape (#978).
 *
 * The model answers with ONE object shape for all five question types rather
 * than a discriminated union, because OpenAI strict structured output requires
 * every property to be listed in `required` — variants are expressed as
 * nullable fields instead. This module is where that flat shape is validated
 * and narrowed back into a real typed question.
 *
 * Validation is deliberately strict: a malformed question is dropped with a
 * reason rather than written half-formed, because a study guide question is
 * immediately answerable by students and a broken one cannot be corrected
 * after the fact (answers are immutable — see #977).
 *
 * Mirrors the caps in `src/types/question.ts`, which the frontend Zod schemas
 * enforce on read. Keep the two in sync.
 */

import {
  toMcqUnified,
  toOpenUnified,
  toFillGapsUnified,
  toOrderingUnified,
  toClassificationUnified,
  fillGapsStemOrdinals,
  type QuestionType,
  type UnifiedQuestionShape,
} from "./question-payload.ts";

// Mirrors src/types/question.ts.
export const FILL_GAPS_MAX_GAPS = 8;
// Mirrors FILL_GAPS_MAX_ACCEPTABLE_PER_GAP there. This path had no cap at all,
// so a long key reached the questions table and then failed the editor's schema
// the first time an instructor saved the question (#1042). Rejecting here drops
// the one question, and the caller reports it with its reason.
export const FILL_GAPS_MAX_ACCEPTABLE_PER_GAP = 8;
export const ORDERING_MIN_ITEMS = 3;
export const ORDERING_MAX_ITEMS = 8;
export const CLASSIFICATION_MIN_CATEGORIES = 2;
export const CLASSIFICATION_MAX_CATEGORIES = 5;
export const CLASSIFICATION_MIN_ITEMS = 4;
export const CLASSIFICATION_MAX_ITEMS = 12;
// Not enforced by a Zod schema, but a 2-option "multiple choice" is a
// true/false in disguise and a 6-option one is unreadable on mobile.
export const MCQ_MIN_OPTIONS = 3;
export const MCQ_MAX_OPTIONS = 5;

export const STUDY_GUIDE_QUESTION_TYPES: readonly QuestionType[] = [
  "mcq",
  "open",
  "fill_gaps",
  "ordering",
  "classification",
] as const;

const DIFFICULTIES = ["easy", "medium", "hard"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

/** One gap's accepted answers, in the order the gaps appear in the stem. */
export interface RawGap {
  accepted: string[] | null;
}

export interface RawClassificationItem {
  text: string | null;
  category: string | null;
}

/** The flat shape the model returns. Every field is present; unused ones null. */
export interface RawStudyGuideQuestion {
  type: string | null;
  question: string | null;
  difficulty: string | null;
  explanation: string | null;
  competency_id: string | null;
  mcq_options: string[] | null;
  mcq_correct_indices: number[] | null;
  open_model_answer: string | null;
  fill_gaps_stem: string | null;
  fill_gaps_gaps: RawGap[] | null;
  ordering_prompt: string | null;
  ordering_items: string[] | null;
  classification_prompt: string | null;
  classification_categories: string[] | null;
  classification_items: RawClassificationItem[] | null;
}

/** A row ready for the `replace_study_guide_piece_questions` RPC. */
export interface StudyGuideQuestionRow extends UnifiedQuestionShape {
  question: string;
  explanation: string;
  difficulty: Difficulty;
  competency_id: string | null;
  competency_ids: string[];
  chapter_ids: string[];
  hidden: boolean;
  is_user_generated: false;
}

export type ConversionResult =
  | { ok: true; row: StudyGuideQuestionRow }
  | { ok: false; error: string };

/**
 * The model writes questions next to theory that is legitimately HTML, and the
 * habit bleeds over: it emits <br/> in question fields — sometimes inside the
 * $…$ delimiters, where KaTeX typesets a literal "< br/ >" for students.
 * Question fields are plain text + LaTeX, so the tags carry no meaning worth
 * keeping; a space preserves the token boundary they stood on.
 */
function stripBreakTags<T>(v: T): T {
  if (typeof v === "string") {
    // Each tag is replaced together with its surrounding whitespace by one
    // space; a string with no tag passes through byte-identical.
    const replaced = v.replace(/\s*<\/?br\s*\/?>\s*/gi, " ");
    return (replaced === v ? v : replaced.trim()) as T;
  }
  if (Array.isArray(v)) return v.map(stripBreakTags) as T;
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, stripBreakTags(x)]),
    ) as T;
  }
  return v;
}

function nonEmptyStrings(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out = v.filter((s): s is string => typeof s === "string" && s.trim().length > 0);
  return out.length === v.length ? out : null;
}

function slug(prefix: string, index: number): string {
  return `${prefix}${index + 1}`;
}

/**
 * Narrow one raw question into a unified row.
 *
 * @param raw               the model's flat object
 * @param validCompetencyIds ids belonging to this course; anything else is
 *                           dropped rather than trusted, since a hallucinated
 *                           id would either break the FK or silently attach
 *                           the question to another course's competency
 * @param chapterIds        chapters this piece draws on, linked via
 *                          `question_chapters`
 */
export function toStudyGuideQuestionRow(
  rawInput: RawStudyGuideQuestion,
  validCompetencyIds: ReadonlySet<string>,
  chapterIds: string[],
): ConversionResult {
  const raw = stripBreakTags(rawInput);
  const type = raw.type as QuestionType;
  if (!STUDY_GUIDE_QUESTION_TYPES.includes(type)) {
    return { ok: false, error: `unsupported question type: ${String(raw.type)}` };
  }

  const question = typeof raw.question === "string" ? raw.question.trim() : "";
  if (question.length === 0) return { ok: false, error: "question text is empty" };

  const difficulty: Difficulty =
    DIFFICULTIES.includes(raw.difficulty as Difficulty)
      ? (raw.difficulty as Difficulty)
      : "medium";

  const competencyId =
    raw.competency_id && validCompetencyIds.has(raw.competency_id) ? raw.competency_id : null;

  const explanation = typeof raw.explanation === "string" ? raw.explanation : "";

  let unified: UnifiedQuestionShape;

  switch (type) {
    case "mcq": {
      const options = nonEmptyStrings(raw.mcq_options);
      if (!options) return { ok: false, error: "mcq_options missing or contains blanks" };
      if (options.length < MCQ_MIN_OPTIONS || options.length > MCQ_MAX_OPTIONS) {
        return {
          ok: false,
          error: `mcq needs ${MCQ_MIN_OPTIONS}-${MCQ_MAX_OPTIONS} options, got ${options.length}`,
        };
      }
      const indices = Array.isArray(raw.mcq_correct_indices) ? raw.mcq_correct_indices : null;
      if (!indices || indices.length === 0) {
        return { ok: false, error: "mcq_correct_indices missing or empty" };
      }
      const unique = [...new Set(indices)];
      if (unique.length !== indices.length) {
        return { ok: false, error: "mcq_correct_indices contains duplicates" };
      }
      if (unique.some((i) => !Number.isInteger(i) || i < 0 || i >= options.length)) {
        return { ok: false, error: "mcq_correct_indices out of range" };
      }
      if (unique.length === options.length) {
        return { ok: false, error: "every mcq option marked correct" };
      }
      unified = toMcqUnified({ options, correct_answers: unique.sort((a, b) => a - b) });
      break;
    }

    case "open": {
      const modelAns =
        typeof raw.open_model_answer === "string" ? raw.open_model_answer.trim() : "";
      if (modelAns.length === 0) return { ok: false, error: "open_model_answer is empty" };
      // answering_mode is always "single": study guides never use the Socratic
      // interactive surface (#977 decision).
      unified = toOpenUnified({
        model_answer: modelAns,
        rubric: null,
        explanation: explanation || null,
        answering_mode: "single",
      });
      break;
    }

    case "fill_gaps": {
      const stem = typeof raw.fill_gaps_stem === "string" ? raw.fill_gaps_stem.trim() : "";
      if (stem.length === 0) return { ok: false, error: "fill_gaps_stem is empty" };
      const gapsRaw = Array.isArray(raw.fill_gaps_gaps) ? raw.fill_gaps_gaps : null;
      if (!gapsRaw || gapsRaw.length === 0) return { ok: false, error: "fill_gaps_gaps is empty" };
      if (gapsRaw.length > FILL_GAPS_MAX_GAPS) {
        return { ok: false, error: `fill_gaps allows at most ${FILL_GAPS_MAX_GAPS} gaps` };
      }
      const gaps = [];
      for (let i = 0; i < gapsRaw.length; i++) {
        const accepted = nonEmptyStrings(gapsRaw[i]?.accepted);
        if (!accepted || accepted.length === 0) {
          return { ok: false, error: `gap ${i + 1} has no accepted answers` };
        }
        if (accepted.length > FILL_GAPS_MAX_ACCEPTABLE_PER_GAP) {
          return {
            ok: false,
            error:
              `gap ${i + 1} has ${accepted.length} accepted answers ` +
              `(max ${FILL_GAPS_MAX_ACCEPTABLE_PER_GAP})`,
          };
        }
        gaps.push({ ordinal: i + 1, acceptable: accepted });
      }
      // The gaps above are numbered by POSITION, so the stem must declare
      // exactly {{1}}..{{N}} for the answer key to line up with the inputs the
      // renderer draws. Nothing downstream re-checks this: a stem with no
      // placeholders renders as prose with no inputs, which cannot be answered
      // and therefore locks every later piece of the guide behind it (#1035).
      const stemOrdinals = fillGapsStemOrdinals(stem);
      if (stemOrdinals.length === 0) {
        return {
          ok: false,
          error: "fill_gaps_stem marks no gaps — it must contain {{1}}, {{2}}, … placeholders",
        };
      }
      const distinct = new Set(stemOrdinals);
      if (distinct.size !== stemOrdinals.length) {
        return { ok: false, error: "fill_gaps_stem repeats a {{N}} placeholder" };
      }
      if (distinct.size !== gaps.length) {
        return {
          ok: false,
          error:
            `fill_gaps_stem has ${distinct.size} placeholder(s) but ${gaps.length} gap(s) were supplied`,
        };
      }
      for (const g of gaps) {
        if (!distinct.has(g.ordinal)) {
          return {
            ok: false,
            error: `fill_gaps_stem is missing placeholder {{${g.ordinal}}}`,
          };
        }
      }
      unified = toFillGapsUnified({ stem, gaps });
      break;
    }

    case "ordering": {
      const prompt = typeof raw.ordering_prompt === "string" ? raw.ordering_prompt.trim() : "";
      if (prompt.length === 0) return { ok: false, error: "ordering_prompt is empty" };
      const items = nonEmptyStrings(raw.ordering_items);
      if (!items) return { ok: false, error: "ordering_items missing or contains blanks" };
      if (items.length < ORDERING_MIN_ITEMS || items.length > ORDERING_MAX_ITEMS) {
        return {
          ok: false,
          error: `ordering needs ${ORDERING_MIN_ITEMS}-${ORDERING_MAX_ITEMS} items, got ${items.length}`,
        };
      }
      if (new Set(items).size !== items.length) {
        return { ok: false, error: "ordering_items contains duplicates" };
      }
      unified = toOrderingUnified({ prompt, items });
      break;
    }

    case "classification": {
      const prompt =
        typeof raw.classification_prompt === "string" ? raw.classification_prompt.trim() : "";
      if (prompt.length === 0) return { ok: false, error: "classification_prompt is empty" };
      const categoryLabels = nonEmptyStrings(raw.classification_categories);
      if (!categoryLabels) {
        return { ok: false, error: "classification_categories missing or contains blanks" };
      }
      if (
        categoryLabels.length < CLASSIFICATION_MIN_CATEGORIES ||
        categoryLabels.length > CLASSIFICATION_MAX_CATEGORIES
      ) {
        return {
          ok: false,
          error:
            `classification needs ${CLASSIFICATION_MIN_CATEGORIES}-${CLASSIFICATION_MAX_CATEGORIES} categories, got ${categoryLabels.length}`,
        };
      }
      if (new Set(categoryLabels).size !== categoryLabels.length) {
        return { ok: false, error: "classification_categories contains duplicates" };
      }
      const itemsRaw = Array.isArray(raw.classification_items) ? raw.classification_items : null;
      if (!itemsRaw) return { ok: false, error: "classification_items missing" };
      if (
        itemsRaw.length < CLASSIFICATION_MIN_ITEMS ||
        itemsRaw.length > CLASSIFICATION_MAX_ITEMS
      ) {
        return {
          ok: false,
          error:
            `classification needs ${CLASSIFICATION_MIN_ITEMS}-${CLASSIFICATION_MAX_ITEMS} items, got ${itemsRaw.length}`,
        };
      }

      const categories = categoryLabels.map((label, i) => ({ id: slug("c", i), label }));
      const idByLabel = new Map(categoryLabels.map((label, i) => [label, slug("c", i)]));

      const items = [];
      const assignments: Record<string, string> = {};
      for (let i = 0; i < itemsRaw.length; i++) {
        const text = typeof itemsRaw[i]?.text === "string" ? itemsRaw[i].text!.trim() : "";
        if (text.length === 0) return { ok: false, error: `classification item ${i + 1} is empty` };
        const categoryId = idByLabel.get(itemsRaw[i]?.category ?? "");
        if (!categoryId) {
          return {
            ok: false,
            error: `classification item ${i + 1} names unknown category "${itemsRaw[i]?.category}"`,
          };
        }
        const itemId = slug("i", i);
        items.push({ id: itemId, text });
        assignments[itemId] = categoryId;
      }

      // A category nobody belongs to makes the question trivially easier.
      const usedCategories = new Set(Object.values(assignments));
      if (usedCategories.size !== categories.length) {
        return { ok: false, error: "at least one classification category has no items" };
      }

      unified = toClassificationUnified({ prompt, categories, items, assignments });
      break;
    }

    default:
      return { ok: false, error: `unhandled type: ${String(type)}` };
  }

  return {
    ok: true,
    row: {
      ...unified,
      question,
      explanation,
      difficulty,
      competency_id: competencyId,
      competency_ids: competencyId ? [competencyId] : [],
      chapter_ids: [...chapterIds],
      hidden: false,
      is_user_generated: false,
    },
  };
}
