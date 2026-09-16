/**
 * Deno mirror of `src/lib/question-payload.ts`. Keep the two in sync — both
 * are used by writers of `public.questions` so the unified
 * `type` / `payload` / `answer_key` shape is identical regardless of
 * which runtime created the row.
 */
export type QuestionType =
  | "mcq"
  | "open"
  | "fill_gaps"
  | "ordering"
  | "classification";

/**
 * Optional SVG diagram (#627). Stored on every question payload type. The
 * writer drops the field entirely when undefined so pre-#627 rows round-trip
 * byte-for-byte.
 */
export interface QuestionDiagramShape {
  source: string;
  alt?: string;
}

function buildDiagram(d: QuestionDiagramShape | undefined): Record<string, unknown> | undefined {
  if (!d || !d.source) return undefined;
  return d.alt ? { format: "svg", source: d.source, alt: d.alt } : { format: "svg", source: d.source };
}

export interface McqQuestionShape {
  options: string[];
  // Multi-correct shape (#592). Single-correct items pass a 1-element array.
  correct_answers: number[];
  diagram?: QuestionDiagramShape;
}

export type OpenAnsweringMode = "interactive" | "single";

export interface OpenQuestionShape {
  model_answer: string;
  rubric?: string | null;
  explanation?: string | null;
  // #596 — per-question toggle between the Socratic chat ("AI Interactive
  // Learning") and a one-shot "submit your answer" surface. Mirror of the
  // frontend type; new questions default to "single" at the UI layer,
  // omitting the field writes an empty `payload`, and the reader falls back
  // to "interactive" so pre-#596 rows keep their original behavior.
  answering_mode?: OpenAnsweringMode;
  diagram?: QuestionDiagramShape;
}

export interface UnifiedQuestionShape {
  type: QuestionType;
  payload: Record<string, unknown>;
  answer_key: Record<string, unknown>;
}

export function toMcqUnified(q: McqQuestionShape): UnifiedQuestionShape {
  // Dual-write the legacy `correct_index` for one release (#592 plan).
  const correctIndices = [...q.correct_answers];
  // Mirror of the frontend writer: `multi_correct` is presentation, so it
  // lives in `payload` and an answering surface can size the "Select all that
  // apply." hint without holding the key (#1011).
  const payload: Record<string, unknown> = {
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

/**
 * The placeholder ordinals a fill-gaps stem declares, in the order the `{{N}}`
 * markers appear (duplicates included, so callers can reject a repeated
 * ordinal by comparing against a Set).
 *
 * Deno mirror of `fillGapsOrdinalsInStem` in src/types/question.ts, and the one
 * definition of the regex every writer must agree with — the renderers split on
 * exactly this pattern, so a stem it finds nothing in has no inputs at all
 * (#1035).
 */
export function fillGapsStemOrdinals(stem: string): number[] {
  const out: number[] = [];
  for (const m of stem.matchAll(/\{\{(\d+)\}\}/g)) {
    out.push(Number(m[1]));
  }
  return out;
}

export function toFillGapsUnified(q: FillGapsQuestionShape): UnifiedQuestionShape {
  const payload: Record<string, unknown> = { stem: q.stem };
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
  const payload: Record<string, unknown> = q.answering_mode
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
  // Canonical (correct) order. The student renderer shuffles per (question,
  // user) at display time; the canonical order IS the answer key, so
  // `answer_key` is intentionally empty.
  items: string[];
  diagram?: QuestionDiagramShape;
}

export function toOrderingUnified(q: OrderingQuestionShape): UnifiedQuestionShape {
  const payload: Record<string, unknown> = { prompt: q.prompt, items: [...q.items] };
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
  // item_id → category_id. Student-facing `payload.items` carries only
  // {id, text}; the answer lives in `answer_key.assignments` so the
  // renderer can't accidentally leak the correct category.
  assignments: Record<string, string>;
  diagram?: QuestionDiagramShape;
}

export function toClassificationUnified(
  q: ClassificationQuestionShape,
): UnifiedQuestionShape {
  const payload: Record<string, unknown> = {
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
// jsonb columns. Deno mirror of the helpers in `src/lib/question-payload.ts`.
// Used by edge functions that read from `public.questions` after #580/#581.
// ---------------------------------------------------------------------------

type Json = unknown;

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

/** Mirror of the frontend reader: whether more than one option is correct. */
export function mcqIsMultiCorrectFromPayload(
  payload: Json | null | undefined,
): boolean {
  const obj = asObject(payload);
  return obj?.multi_correct === true;
}

/**
 * Prefers `correct_indices` (multi-correct, #592) and falls back to the
 * legacy single `correct_index` for rows authored on pre-#592 builds.
 * Returns `[]` for malformed shapes.
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
 * @deprecated Use {@link mcqCorrectIndicesFromAnswerKey} + `gradeMcq`.
 * Retained as a thin wrapper for callers being migrated; returns -1 if
 * no correct index is recorded.
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

export function openExplanationFromAnswerKey(
  answerKey: Json | null | undefined,
): string | null {
  const obj = asObject(answerKey);
  if (!obj) return null;
  const ex = obj.explanation;
  return typeof ex === "string" ? ex : null;
}

export function openRubricFromAnswerKey(
  answerKey: Json | null | undefined,
): string | null {
  const obj = asObject(answerKey);
  if (!obj) return null;
  const r = obj.rubric;
  return typeof r === "string" ? r : null;
}

/**
 * #596 — reads `payload.answering_mode`. Defaults missing / null / unknown
 * values to `"interactive"` so every pre-#596 row stays Socratic.
 */
export function openAnsweringModeFromPayload(
  payload: Json | null | undefined,
): OpenAnsweringMode {
  const obj = asObject(payload);
  if (!obj) return "interactive";
  return obj.answering_mode === "single" ? "single" : "interactive";
}

// ---------------------------------------------------------------------------
// Fill the Gaps readers (#604) — Deno mirror of src/lib/question-payload.ts
// ---------------------------------------------------------------------------

export function fillGapsStemFromPayload(payload: Json | null | undefined): string {
  const obj = asObject(payload);
  if (!obj) return "";
  return typeof obj.stem === "string" ? obj.stem : "";
}

// ---------------------------------------------------------------------------
// Ordering readers (#606) — Deno mirror
// ---------------------------------------------------------------------------

export function orderingPromptFromPayload(payload: Json | null | undefined): string {
  const obj = asObject(payload);
  if (!obj) return "";
  return typeof obj.prompt === "string" ? obj.prompt : "";
}

export function orderingItemsFromPayload(payload: Json | null | undefined): string[] {
  const obj = asObject(payload);
  if (!obj) return [];
  const items = obj.items;
  if (!Array.isArray(items)) return [];
  return items
    .filter((v): v is string => typeof v === "string" && v.length > 0);
}

// ---------------------------------------------------------------------------
// Classification readers (#610) — Deno mirror. Defend against malformed
// JSONB so renderers and graders never receive a partially-shaped record.
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
// Diagram reader (#627) — Deno mirror. Shared across every question type.
// ---------------------------------------------------------------------------

/**
 * Returns the diagram source + alt text from any question payload, or null
 * when the payload has no (well-formed) `diagram` field. The returned
 * `source` is the raw SVG markup — sanitization happens client-side before
 * injection into the DOM.
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
