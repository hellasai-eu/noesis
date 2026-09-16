/**
 * Unified question schema — per-type payload and answer_key shapes.
 *
 * These mirror the `payload` and `answer_key` JSONB columns on
 * `public.questions` (see migration 20260613000000_expand_questions_schema.sql
 * and 20260621000000_multi_correct_mcq.sql for the multi-correct extension).
 */
import { z } from "zod";

export const QUESTION_TYPES = [
  "mcq",
  "open",
  "fill_gaps",
  "ordering",
  "classification",
] as const;
export const QuestionTypeSchema = z.enum(QUESTION_TYPES);
export type QuestionType = z.infer<typeof QuestionTypeSchema>;

// ---------------------------------------------------------------------------
// Diagram — optional SVG figure displayed above a question's stem (#627)
// ---------------------------------------------------------------------------

// 50 KB cap matches the prompt rules sent to the LLM and bounds the JSONB
// column comfortably for ~5–15 KB typical geometry sketches.
export const QUESTION_DIAGRAM_MAX_SOURCE_LENGTH = 50_000;
export const QUESTION_DIAGRAM_MAX_ALT_LENGTH = 500;

export const QuestionDiagramSchema = z.object({
  format: z.literal("svg"),
  source: z.string().min(1).max(QUESTION_DIAGRAM_MAX_SOURCE_LENGTH),
  alt: z.string().max(QUESTION_DIAGRAM_MAX_ALT_LENGTH).optional(),
});

export type QuestionDiagram = z.infer<typeof QuestionDiagramSchema>;

// ---------------------------------------------------------------------------
// MCQ — supports one or more correct options (multi-correct introduced #592)
// ---------------------------------------------------------------------------

export const McqPayloadSchema = z.object({
  options: z.array(z.string()).min(2),
  diagram: QuestionDiagramSchema.optional(),
});

// `correct_indices` is the multi-correct field (#592). The legacy single
// `correct_index` is dual-written by writers during this release so reads
// still pass on a pre-#592 frontend; readers prefer `correct_indices`.
export const McqAnswerKeySchema = z.object({
  correct_indices: z
    .array(z.number().int().nonnegative())
    .min(1)
    .refine(
      (arr) => new Set(arr).size === arr.length,
      { message: "correct_indices must not contain duplicates" },
    ),
  correct_index: z.number().int().nonnegative().optional(),
});

export type McqPayload = z.infer<typeof McqPayloadSchema>;
export type McqAnswerKey = z.infer<typeof McqAnswerKeySchema>;

// ---------------------------------------------------------------------------
// Open — free-text question graded against a model answer
// ---------------------------------------------------------------------------

// #596 introduced `payload.answering_mode` ("interactive" | "single") but the
// schema deliberately omitted it for backward compatibility — readers default
// missing values via `openAnsweringModeFromPayload`. #627 adds an optional
// `diagram`, so the schema is no longer `.strict()`; additional payload-side
// fields stay readable via their dedicated reader helpers.
export const OpenPayloadSchema = z.object({
  diagram: QuestionDiagramSchema.optional(),
});

export const OpenAnswerKeySchema = z.object({
  model_answer: z.string().min(1),
});

export type OpenPayload = z.infer<typeof OpenPayloadSchema>;
export type OpenAnswerKey = z.infer<typeof OpenAnswerKeySchema>;

// ---------------------------------------------------------------------------
// Fill the Gaps — cloze-style item (#604)
// ---------------------------------------------------------------------------

// Caps chosen so a misbehaving instructor / model can't write a single row
// large enough to blow up the renderer or the JSONB column. They match the
// numbers documented in #604.
export const FILL_GAPS_MAX_GAPS = 8;
// Must not sit below the generator's own cap (MAX_ACCEPTABLE_PER_GAP in
// supabase/functions/generate-fill-gaps-questions/handler.ts). This schema
// gates the question EDITOR, so a key the generator happily persists but this
// rejects is a question an instructor can open and never save again — the
// generated row is not rewritten on save, so the failure fires even on an edit
// that never touched the gaps. Raised 5 -> 8 with #1042, which asks the
// generator for every filler the source licenses plus their inflections.
export const FILL_GAPS_MAX_ACCEPTABLE_PER_GAP = 8;
export const FILL_GAPS_MAX_ACCEPTABLE_LENGTH = 64;

export const FillGapsPayloadSchema = z.object({
  // The stem is the cloze sentence; numbered placeholders `{{1}}`, `{{2}}`,
  // … mark each blank. Ordinals must be 1-indexed and contiguous.
  stem: z.string().min(1),
  diagram: QuestionDiagramSchema.optional(),
});

export const FillGapsAnswerKeySchema = z.object({
  gaps: z
    .array(
      z.object({
        ordinal: z.number().int().positive(),
        acceptable: z
          .array(z.string().min(1).max(FILL_GAPS_MAX_ACCEPTABLE_LENGTH))
          .min(1)
          .max(FILL_GAPS_MAX_ACCEPTABLE_PER_GAP),
      }),
    )
    .min(1)
    .max(FILL_GAPS_MAX_GAPS),
});

export type FillGapsPayload = z.infer<typeof FillGapsPayloadSchema>;
export type FillGapsAnswerKey = z.infer<typeof FillGapsAnswerKeySchema>;

// ---------------------------------------------------------------------------
// Ordering — drag items into the correct sequence (#606)
// ---------------------------------------------------------------------------

// Item count caps a runaway model / instructor from producing a row the
// student renderer can't comfortably show; per-item length cap protects the
// JSONB column and the drag-row from a 10kB string.
export const ORDERING_MIN_ITEMS = 3;
export const ORDERING_MAX_ITEMS = 8;
export const ORDERING_MAX_ITEM_LENGTH = 200;

// `items` is stored in the CANONICAL (correct) order. The student renderer
// shuffles at display time — the canonical order is also the answer key, so
// no separate `answer_key` payload is needed.
export const OrderingPayloadSchema = z.object({
  prompt: z.string().min(1),
  items: z
    .array(z.string().min(1).max(ORDERING_MAX_ITEM_LENGTH))
    .min(ORDERING_MIN_ITEMS)
    .max(ORDERING_MAX_ITEMS),
  diagram: QuestionDiagramSchema.optional(),
});

export const OrderingAnswerKeySchema = z.object({}).strict();

export type OrderingPayload = z.infer<typeof OrderingPayloadSchema>;
export type OrderingAnswerKey = z.infer<typeof OrderingAnswerKeySchema>;

// ---------------------------------------------------------------------------
// Classification — sort cards into category buckets (#610)
// ---------------------------------------------------------------------------

// 2-5 categories, 4-12 items, 120-char cap on labels/texts. Caps mirror the
// numbers documented in #610 and keep the JSONB column and the student
// renderer (one card at a time) within comfortable bounds.
export const CLASSIFICATION_MIN_CATEGORIES = 2;
export const CLASSIFICATION_MAX_CATEGORIES = 5;
export const CLASSIFICATION_MIN_ITEMS = 4;
export const CLASSIFICATION_MAX_ITEMS = 12;
export const CLASSIFICATION_MAX_LABEL_LENGTH = 120;

const ClassificationCategorySchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1).max(CLASSIFICATION_MAX_LABEL_LENGTH),
});

const ClassificationItemSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1).max(CLASSIFICATION_MAX_LABEL_LENGTH),
});

export const ClassificationPayloadSchema = z.object({
  prompt: z.string().min(1),
  categories: z
    .array(ClassificationCategorySchema)
    .min(CLASSIFICATION_MIN_CATEGORIES)
    .max(CLASSIFICATION_MAX_CATEGORIES),
  items: z
    .array(ClassificationItemSchema)
    .min(CLASSIFICATION_MIN_ITEMS)
    .max(CLASSIFICATION_MAX_ITEMS),
  diagram: QuestionDiagramSchema.optional(),
});

export const ClassificationAnswerKeySchema = z.object({
  // `assignments[item_id] = category_id` — every item has exactly one
  // correct category. Cross-validated against payload.{categories,items}
  // via validateClassificationQuestion below.
  assignments: z.record(z.string().min(1), z.string().min(1)),
});

export type ClassificationPayload = z.infer<typeof ClassificationPayloadSchema>;
export type ClassificationAnswerKey = z.infer<typeof ClassificationAnswerKeySchema>;

// ---------------------------------------------------------------------------
// Cross-type validators
// ---------------------------------------------------------------------------

/**
 * Returns true when every index in `answerKey.correct_indices` is a valid
 * index into `payload.options`. Must be called whenever both JSONB columns
 * are consumed together, because the individual Zod schemas cannot see
 * each other.
 */
export function validateMcqQuestion(
  payload: McqPayload,
  answerKey: McqAnswerKey,
): boolean {
  const n = payload.options.length;
  return answerKey.correct_indices.every((i) => i >= 0 && i < n);
}

const PLACEHOLDER_RE = /\{\{(\d+)\}\}/g;

/**
 * Extract the sorted, de-duplicated list of placeholder ordinals from a
 * fill-gaps stem (e.g. "X is {{1}} than {{2}}" → [1, 2]).
 */
export function fillGapsOrdinalsInStem(stem: string): number[] {
  const found = new Set<number>();
  for (const m of stem.matchAll(PLACEHOLDER_RE)) {
    const ord = Number(m[1]);
    if (Number.isInteger(ord) && ord > 0) found.add(ord);
  }
  return Array.from(found).sort((a, b) => a - b);
}

/**
 * Cross-validates a fill-gaps payload + answer_key. Stem placeholders
 * must be contiguous 1..N and each must match exactly one gap entry (and
 * vice versa). Caller is expected to have already passed the individual
 * Zod schemas — this check is the cross-column invariant.
 */
export function validateFillGapsQuestion(
  payload: FillGapsPayload,
  answerKey: FillGapsAnswerKey,
): boolean {
  const stemRawCount = [...payload.stem.matchAll(/\{\{(\d+)\}\}/g)].length;
  const stemOrdinals = fillGapsOrdinalsInStem(payload.stem);
  if (stemRawCount !== stemOrdinals.length) return false; // duplicate ordinal in stem
  const gapOrdinals = answerKey.gaps.map((g) => g.ordinal).sort((a, b) => a - b);
  if (stemOrdinals.length !== gapOrdinals.length) return false;
  for (let i = 0; i < stemOrdinals.length; i++) {
    if (stemOrdinals[i] !== gapOrdinals[i]) return false;
    if (stemOrdinals[i] !== i + 1) return false; // contiguous from 1
  }
  // Reject duplicates in gaps[] (Zod's min(1) doesn't catch this).
  if (new Set(gapOrdinals).size !== gapOrdinals.length) return false;
  return true;
}

/**
 * Cross-validates a classification payload + answer_key:
 *   - every item.id is a key in assignments
 *   - every assignments value is one of categories[].id
 *   - category labels are distinct after NFC + lowercase
 *   - item texts are distinct after NFC + lowercase + trim
 *   - category ids are distinct
 *   - item ids are distinct
 * Caller is expected to have already passed the individual Zod schemas.
 */
export function validateClassificationQuestion(
  payload: ClassificationPayload,
  answerKey: ClassificationAnswerKey,
): boolean {
  const categoryIds = new Set<string>();
  const categoryLabels = new Set<string>();
  for (const c of payload.categories) {
    if (categoryIds.has(c.id)) return false;
    categoryIds.add(c.id);
    const key = c.label.normalize("NFC").trim().toLowerCase();
    if (categoryLabels.has(key)) return false;
    categoryLabels.add(key);
  }
  const itemIds = new Set<string>();
  const itemTexts = new Set<string>();
  for (const it of payload.items) {
    if (itemIds.has(it.id)) return false;
    itemIds.add(it.id);
    const key = it.text.normalize("NFC").trim().toLowerCase();
    if (itemTexts.has(key)) return false;
    itemTexts.add(key);
  }
  // Every item must have an assignment, and every assignment must point to
  // a declared category.
  for (const it of payload.items) {
    const catId = answerKey.assignments[it.id];
    if (!catId || !categoryIds.has(catId)) return false;
  }
  // Assignments must not reference items outside the declared item set.
  for (const itemId of Object.keys(answerKey.assignments)) {
    if (!itemIds.has(itemId)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Lookup maps keyed by `questions.type`
// ---------------------------------------------------------------------------

export const QuestionPayloadByType = {
  mcq: McqPayloadSchema,
  open: OpenPayloadSchema,
  fill_gaps: FillGapsPayloadSchema,
  ordering: OrderingPayloadSchema,
  classification: ClassificationPayloadSchema,
} as const satisfies Record<QuestionType, z.ZodTypeAny>;

export const QuestionAnswerKeyByType = {
  mcq: McqAnswerKeySchema,
  open: OpenAnswerKeySchema,
  fill_gaps: FillGapsAnswerKeySchema,
  ordering: OrderingAnswerKeySchema,
  classification: ClassificationAnswerKeySchema,
} as const satisfies Record<QuestionType, z.ZodTypeAny>;
