/**
 * Helpers that translate raw MCQ / open question inputs into the unified
 * `type` / `payload` / `answer_key` columns on `public.questions` (see
 * migration 20260613000000_expand_questions_schema.sql and the Zod schemas
 * in `src/types/question.ts`).
 *
 * Used by every writer of `questions` so the unified shape is identical
 * across the frontend (this file) and the Deno edge runtime
 * (`supabase/functions/_shared/question-payload.ts`).
 */
import type { Json } from "@/integrations/supabase/types";
import { fillGapsOrdinalsInStem, type QuestionType } from "@/types/question";

/**
 * Optional SVG diagram (#627). Stored on every question payload type; the
 * writer drops the field entirely when undefined so pre-#627 rows round-trip
 * byte-for-byte.
 */
export interface QuestionDiagramShape {
  source: string;
  alt?: string;
}

function buildDiagram(d: QuestionDiagramShape | undefined): Record<string, Json> | undefined {
  if (!d || !d.source) return undefined;
  return d.alt ? { format: "svg", source: d.source, alt: d.alt } : { format: "svg", source: d.source };
}

export interface McqQuestionShape {
  options: string[];
  // Multi-correct shape (#592). Single-correct items pass a 1-element array.
  // Element order is insignificant; downstream grading is set-based.
  correct_answers: number[];
  // #627 — optional SVG figure rendered above the stem.
  diagram?: QuestionDiagramShape;
}

export type OpenAnsweringMode = "interactive" | "single";

export interface OpenQuestionShape {
  model_answer: string;
  rubric?: string | null;
  explanation?: string | null;
  // #596 — per-question toggle between the Socratic chat ("AI Interactive
  // Learning") and a one-shot "submit your answer" surface. New questions
  // default to "single" at the UI layer; omitting the field writes an empty
  // `payload` and the reader falls back to "interactive" so pre-#596 rows
  // keep their original behavior without a backfill.
  answering_mode?: OpenAnsweringMode;
  diagram?: QuestionDiagramShape;
}

export interface UnifiedQuestionShape {
  type: QuestionType;
  payload: Json;
  answer_key: Json;
}

export function toMcqUnified(q: McqQuestionShape): UnifiedQuestionShape {
  // Dual-write the legacy `correct_index` alongside the unified
  // `correct_indices` for one release so readers that still call
  // `mcqCorrectIndexFromAnswerKey` on a pre-#592 build keep grading
  // single-correct rows correctly. The follow-up contract migration drops
  // `correct_index`.
  const correctIndices = [...q.correct_answers];
  // `multi_correct` is PRESENTATION, not answer: it is the one thing a
  // renderer needs before the student answers ("Select all that apply."),
  // and deriving it from `correct_indices.length` forced every answering
  // surface to hold the key just to size a hint (#1011). One bit — whether
  // more than one option is right — rather than which, or how many.
  const payload: Record<string, Json> = {
    options: q.options,
    multi_correct: correctIndices.length > 1,
  };
  const diagram = buildDiagram(q.diagram);
  if (diagram) payload.diagram = diagram;
  return {
    type: "mcq",
    payload,
    answer_key: {
      correct_indices: correctIndices,
      correct_index: correctIndices[0] ?? 0,
    },
  };
}

export interface FillGapsGap {
  ordinal: number;
  acceptable: string[];
}

export interface FillGapsQuestionShape {
  stem: string;
  gaps: FillGapsGap[];
  diagram?: QuestionDiagramShape;
}

export function toFillGapsUnified(q: FillGapsQuestionShape): UnifiedQuestionShape {
  const payload: Record<string, Json> = { stem: q.stem };
  const diagram = buildDiagram(q.diagram);
  if (diagram) payload.diagram = diagram;
  return {
    type: "fill_gaps",
    payload,
    answer_key: {
      // Sort by ordinal so the JSONB shape is stable regardless of input order.
      gaps: [...q.gaps]
        .sort((a, b) => a.ordinal - b.ordinal)
        .map((g) => ({ ordinal: g.ordinal, acceptable: [...g.acceptable] })),
    },
  };
}

export function toOpenUnified(q: OpenQuestionShape): UnifiedQuestionShape {
  // Write `answering_mode` whenever the caller provided one (single OR
  // interactive). Callers that omit it produce an empty `payload` — the
  // reader still defaults missing values to "interactive" so every
  // pre-#596 row (whose payload is `{}`) keeps its original behavior
  // without a backfill.
  const payload: Record<string, Json> = q.answering_mode
    ? { answering_mode: q.answering_mode }
    : {};
  const diagram = buildDiagram(q.diagram);
  if (diagram) payload.diagram = diagram;
  return {
    type: "open",
    payload,
    answer_key: {
      model_answer: q.model_answer,
      rubric: q.rubric ?? null,
      explanation: q.explanation ?? null,
    },
  };
}

export interface OrderingQuestionShape {
  prompt: string;
  // `items` is stored in CANONICAL (correct) order. The student renderer
  // shuffles per (question, user) at display time; the canonical order IS
  // the answer key, so `answer_key` is intentionally empty.
  items: string[];
  diagram?: QuestionDiagramShape;
}

export function toOrderingUnified(q: OrderingQuestionShape): UnifiedQuestionShape {
  const payload: Record<string, Json> = { prompt: q.prompt, items: [...q.items] };
  const diagram = buildDiagram(q.diagram);
  if (diagram) payload.diagram = diagram;
  return {
    type: "ordering",
    payload,
    answer_key: {},
  };
}

export interface ClassificationCategory {
  id: string;
  label: string;
}

export interface ClassificationItem {
  id: string;
  text: string;
}

export interface ClassificationQuestionShape {
  prompt: string;
  categories: ClassificationCategory[];
  items: ClassificationItem[];
  // item_id → category_id. The student-facing `payload.items` carries only
  // {id, text}; the correct category lives in `answer_key.assignments` so
  // the renderer can't accidentally leak the answer.
  assignments: Record<string, string>;
  diagram?: QuestionDiagramShape;
}

export function toClassificationUnified(
  q: ClassificationQuestionShape,
): UnifiedQuestionShape {
  const payload: Record<string, Json> = {
    prompt: q.prompt,
    categories: q.categories.map((c) => ({ id: c.id, label: c.label })),
    items: q.items.map((it) => ({ id: it.id, text: it.text })),
  };
  const diagram = buildDiagram(q.diagram);
  if (diagram) payload.diagram = diagram;
  return {
    type: "classification",
    payload,
    answer_key: { assignments: { ...q.assignments } },
  };
}

// ---------------------------------------------------------------------------
// Readers — extract typed values from the unified `payload` / `answer_key`
// jsonb columns. Used by every reader migrated in #580.
//
// All defend against a misshapen jsonb (e.g. backfilled rows with the
// default `{}`) by returning a safe sentinel: empty array for options /
// correct_indices, -1 for the legacy single index so callers don't
// accidentally treat a missing answer as option A, empty string for the
// model answer.
// ---------------------------------------------------------------------------

function asObject(j: Json | null | undefined): Record<string, unknown> | null {
  return j && typeof j === "object" && !Array.isArray(j)
    ? (j as Record<string, unknown>)
    : null;
}

export function mcqOptionsFromPayload(payload: Json | null | undefined): string[] {
  const obj = asObject(payload);
  if (!obj) return [];
  const options = obj.options;
  return Array.isArray(options) ? options.map((o) => String(o)) : [];
}

/**
 * Whether more than one option is correct, from the student-facing `payload`.
 *
 * Backfilled onto every pre-existing MCQ row by the migration that introduced
 * the field, so a missing value means "not an MCQ payload" rather than "not
 * yet backfilled". Absent or malformed reads as `false`, which renders the
 * question as single-correct — the safe direction: a student told nothing
 * still sees every option and can pick more than one.
 */
export function mcqIsMultiCorrectFromPayload(
  payload: Json | null | undefined,
): boolean {
  const obj = asObject(payload);
  return obj?.multi_correct === true;
}

/**
 * Read the set of correct option indices for an MCQ from the unified
 * `answer_key`. Prefers the multi-correct `correct_indices` array (added in
 * #592) and falls back to the legacy single `correct_index` so rows authored
 * on pre-#592 builds keep grading correctly until the contract migration.
 *
 * Returns an empty array for malformed shapes — callers should treat that as
 * "no correct answer defined" and short-circuit grading to incorrect.
 */
export function mcqCorrectIndicesFromAnswerKey(
  answerKey: Json | null | undefined,
): number[] {
  const obj = asObject(answerKey);
  if (!obj) return [];
  const arr = obj.correct_indices;
  if (Array.isArray(arr)) {
    const numbers = arr.filter((v): v is number => typeof v === "number");
    if (numbers.length > 0) return numbers;
  }
  const idx = obj.correct_index;
  return typeof idx === "number" ? [idx] : [];
}

/**
 * @deprecated since #592 — multi-correct MCQs may have more than one correct
 * option. Use {@link mcqCorrectIndicesFromAnswerKey} and the `gradeMcq`
 * helper instead. Retained as a thin wrapper for review-surface code paths
 * still being migrated; returns the first correct index or -1.
 */
export function mcqCorrectIndexFromAnswerKey(
  answerKey: Json | null | undefined,
): number {
  const indices = mcqCorrectIndicesFromAnswerKey(answerKey);
  return indices.length > 0 ? indices[0] : -1;
}

export function openModelAnswerFromAnswerKey(
  answerKey: Json | null | undefined,
): string {
  const obj = asObject(answerKey);
  if (!obj) return "";
  const ma = obj.model_answer;
  return typeof ma === "string" ? ma : "";
}

/**
 * #596 — reads `payload.answering_mode` for open questions. Returns
 * `"interactive"` for null / `{}` / unknown values so every pre-#596 row
 * (whose `payload` is `{}`) keeps its Socratic behaviour without a DDL
 * migration.
 */
export function openAnsweringModeFromPayload(
  payload: Json | null | undefined,
): OpenAnsweringMode {
  const obj = asObject(payload);
  if (!obj) return "interactive";
  return obj.answering_mode === "single" ? "single" : "interactive";
}

// ---------------------------------------------------------------------------
// Fill the Gaps readers (#604)
// ---------------------------------------------------------------------------

export function fillGapsStemFromPayload(payload: Json | null | undefined): string {
  const obj = asObject(payload);
  if (!obj) return "";
  return typeof obj.stem === "string" ? obj.stem : "";
}

/**
 * The gap skeleton a fill-gaps question needs BEFORE it has been answered:
 * one entry per `{{N}}` placeholder in the stem, with `acceptable` empty.
 *
 * Exists because the acceptable answers and the gap *structure* share one
 * column. `emptyNonMcqAnswer` sizes the draft from `gaps.length` and
 * `FillGapsField` maps each placeholder to an input by `ordinal`, so a student
 * who is not shown the key would otherwise get a question with no inputs and no
 * way to satisfy the submit gate. Deriving the skeleton from `payload.stem`
 * supplies the structure without the answers (#1011).
 *
 * Delegates ordinal extraction to `fillGapsOrdinalsInStem`, the same reader
 * `validateFillGapsQuestion` uses, so the skeleton and the authoring-time
 * validator can never disagree about what counts as a blank. Ordinals come back
 * de-duplicated and sorted, so a stem repeating `{{1}}` yields one gap —
 * matching the single input `FillGapsField` renders per distinct ordinal.
 *
 * The #1035 guard survives in the case that actually occurred: a stem with no
 * placeholders yields `[]`, which still trips `gaps.length === 0` and shows the
 * "missing its blanks" alert. What it can no longer catch before submission is
 * a key declaring a gap the stem never places — the two are consistent by
 * construction here. The server remains the grader either way.
 */
export function fillGapsSkeletonFromStem(
  stem: string,
): { ordinal: number; acceptable: string[] }[] {
  return fillGapsOrdinalsInStem(stem).map((ordinal) => ({
    ordinal,
    acceptable: [],
  }));
}

/**
 * Returns the per-gap acceptable-answer lists, sorted by ordinal. Defends
 * against malformed JSONB (returns `[]`) so renderers and graders never
 * receive a partially-shaped record.
 */
// ---------------------------------------------------------------------------
// Ordering readers (#606)
// ---------------------------------------------------------------------------

export function orderingPromptFromPayload(payload: Json | null | undefined): string {
  const obj = asObject(payload);
  if (!obj) return "";
  return typeof obj.prompt === "string" ? obj.prompt : "";
}

/**
 * Returns the canonical (correct) order of items. Renderers MUST shuffle
 * before display. Returns [] for malformed JSONB so the renderer can guard
 * cleanly.
 */
export function orderingItemsFromPayload(payload: Json | null | undefined): string[] {
  const obj = asObject(payload);
  if (!obj) return [];
  const items = obj.items;
  if (!Array.isArray(items)) return [];
  return items
    .filter((v): v is string => typeof v === "string" && v.length > 0);
}

// ---------------------------------------------------------------------------
// Classification readers (#610) — defend against malformed JSONB and never
// throw. Renderers and graders treat empty arrays as "this question is
// unrecoverable" and short-circuit cleanly.
// ---------------------------------------------------------------------------

export function classificationPromptFromPayload(
  payload: Json | null | undefined,
): string {
  const obj = asObject(payload);
  if (!obj) return "";
  return typeof obj.prompt === "string" ? obj.prompt : "";
}

export function classificationCategoriesFromPayload(
  payload: Json | null | undefined,
): ClassificationCategory[] {
  const obj = asObject(payload);
  if (!obj) return [];
  const arr = obj.categories;
  if (!Array.isArray(arr)) return [];
  const out: ClassificationCategory[] = [];
  for (const c of arr) {
    if (!c || typeof c !== "object" || Array.isArray(c)) continue;
    const rec = c as Record<string, unknown>;
    const id = rec.id;
    const label = rec.label;
    if (typeof id !== "string" || id.length === 0) continue;
    if (typeof label !== "string" || label.length === 0) continue;
    out.push({ id, label });
  }
  return out;
}

export function classificationItemsFromPayload(
  payload: Json | null | undefined,
): ClassificationItem[] {
  const obj = asObject(payload);
  if (!obj) return [];
  const arr = obj.items;
  if (!Array.isArray(arr)) return [];
  const out: ClassificationItem[] = [];
  for (const it of arr) {
    if (!it || typeof it !== "object" || Array.isArray(it)) continue;
    const rec = it as Record<string, unknown>;
    const id = rec.id;
    const text = rec.text;
    if (typeof id !== "string" || id.length === 0) continue;
    if (typeof text !== "string" || text.length === 0) continue;
    out.push({ id, text });
  }
  return out;
}

export function classificationAssignmentsFromAnswerKey(
  answerKey: Json | null | undefined,
): Record<string, string> {
  const obj = asObject(answerKey);
  if (!obj) return {};
  const a = obj.assignments;
  if (!a || typeof a !== "object" || Array.isArray(a)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(a as Record<string, unknown>)) {
    if (typeof v === "string" && v.length > 0) out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Diagram reader (#627) — shared across every question type.
// ---------------------------------------------------------------------------

/**
 * Returns the diagram source + alt text from any question payload, or null
 * when the payload has no (well-formed) `diagram` field. Defends against
 * malformed JSONB so renderers can call this on every row without guarding.
 *
 * Note: the returned `source` is the RAW SVG markup as the model/instructor
 * supplied it. Callers must sanitize before injecting into the DOM
 * (`sanitizeDiagram` in `src/lib/latex-utils.ts`).
 */
export function questionDiagramFromPayload(
  payload: Json | null | undefined,
): { source: string; alt?: string } | null {
  const obj = asObject(payload);
  if (!obj) return null;
  const d = obj.diagram;
  if (!d || typeof d !== "object" || Array.isArray(d)) return null;
  const rec = d as Record<string, unknown>;
  if (rec.format !== "svg") return null;
  const source = rec.source;
  if (typeof source !== "string" || source.length === 0) return null;
  const alt = rec.alt;
  return typeof alt === "string" && alt.length > 0
    ? { source, alt }
    : { source };
}

export function fillGapsAcceptableAnswersFromAnswerKey(
  answerKey: Json | null | undefined,
): { ordinal: number; acceptable: string[] }[] {
  const obj = asObject(answerKey);
  if (!obj) return [];
  const gaps = obj.gaps;
  if (!Array.isArray(gaps)) return [];
  const out: { ordinal: number; acceptable: string[] }[] = [];
  for (const g of gaps) {
    if (!g || typeof g !== "object" || Array.isArray(g)) continue;
    const rec = g as Record<string, unknown>;
    const ordinal = rec.ordinal;
    const acceptable = rec.acceptable;
    if (typeof ordinal !== "number" || !Number.isInteger(ordinal) || ordinal <= 0) continue;
    if (!Array.isArray(acceptable)) continue;
    const strings = acceptable.filter((v): v is string => typeof v === "string" && v.length > 0);
    if (strings.length === 0) continue;
    out.push({ ordinal, acceptable: strings });
  }
  out.sort((a, b) => a.ordinal - b.ordinal);
  return out;
}
