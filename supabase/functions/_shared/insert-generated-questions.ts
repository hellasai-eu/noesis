/**
 * Server-side mirror of `src/lib/insert-generated-questions.ts` for the
 * Deno/edge runtime. Background workers (notably the bulk-generation
 * job handler in #697) use this to persist rows produced by the
 * `generate-{questions,open-questions,fill-gaps-questions,ordering-questions,
 * classification-questions}` functions into the unified `questions`
 * table plus the canonical `question_chapters` / `question_competencies`
 * junctions — without the browser in the loop.
 *
 * Behavioral parity with the client writer:
 *   - For `type === "open"`, `toOpenUnified` is re-applied with
 *     `answering_mode: "single"` (per #618), pulling the diagram back out
 *     of the generator's `payload.diagram` (per #627/#636) so it survives.
 *   - All other types are already in the unified shape from the generator
 *     and pass through unchanged apart from system fields.
 *
 * Resilience: inserts are per-row rather than bulk so a single bad row
 * does not abort the whole batch. Question-insert failures are recorded in
 * `errors`; junction failures are surfaced as warnings on the inserted row
 * without dropping it (the question itself landed).
 */
import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  questionDiagramFromPayload,
  type QuestionType,
  toOpenUnified,
} from "./question-payload.ts";

export interface GeneratedRow {
  id?: string;
  question: string;
  type?: QuestionType;
  payload?: unknown;
  answer_key?: unknown;
  explanation?: string | null;
  difficulty?: string;
  hidden?: boolean;
  upvotes?: number;
  downvotes?: number;
  competency_id?: string | null;
  competency_ids?: string[];
  chapter_ids?: string[];
  /** Whole-document sources (#1019) — written to `question_materials`. */
  material_ids?: string[];
  /**
   * Provenance column on `questions` — passes straight through into the row.
   * Declared here so callers know the writer expects/preserves it.
   */
  generated_for_group_id?: string | null;
  generation_rationale?: string | null;
  validation_status?: string;
  validation_confidence?: number;
  validation_message?: string;
  validated_at?: string;
  /**
   * Open-only. The open generator returns the model answer alongside the
   * unified row because its server-side `toOpenUnified` call omits
   * `answering_mode`, producing an empty payload; this writer re-applies
   * `toOpenUnified` with `answering_mode: "single"` and needs the raw
   * model answer back. Falls back to `answer_key.model_answer`.
   */
  model_answer?: string;
  course_id?: string;
}

export interface InsertGeneratedQuestionsParams {
  type: QuestionType;
  courseId: string;
  createdBy: string | null;
  generated: GeneratedRow[];
}

export interface InsertedRow {
  index: number;
  id: string;
  question: string;
  /** Non-fatal: the question landed but its chapter links did not. */
  chapterLinksWarning?: string;
  /** Non-fatal: the question landed but its whole-document links did not. */
  materialLinksWarning?: string;
  /** Non-fatal: the question landed but its competency links did not. */
  competencyLinksWarning?: string;
  /** Non-fatal: open question inserted with a blank model_answer because neither q.model_answer nor answer_key.model_answer was present. */
  modelAnswerWarning?: string;
}

export interface FailedRow {
  index: number;
  id?: string;
  question?: string;
  error: string;
}

export interface InsertGeneratedQuestionsResult {
  inserted: InsertedRow[];
  errors: FailedRow[];
}

function buildOpenRow(
  row: Record<string, unknown>,
  q: GeneratedRow,
): { row: Record<string, unknown>; warning?: string } {
  const answerKey = (q.answer_key && typeof q.answer_key === "object" && !Array.isArray(q.answer_key))
    ? (q.answer_key as { model_answer?: unknown })
    : null;
  const fallbackModelAnswer =
    typeof answerKey?.model_answer === "string" ? answerKey.model_answer : "";
  const resolvedModelAnswer = q.model_answer ?? fallbackModelAnswer;
  const diagram = questionDiagramFromPayload(q.payload ?? null) ?? undefined;
  const warning = resolvedModelAnswer === ""
    ? "open question inserted with blank model_answer: neither q.model_answer nor answer_key.model_answer was present"
    : undefined;
  return {
    row: {
      ...row,
      ...toOpenUnified({
        model_answer: resolvedModelAnswer,
        rubric: null,
        explanation: q.explanation ?? null,
        answering_mode: "single",
        diagram,
      }),
    },
    warning,
  };
}

export async function insertGeneratedQuestions(
  // deno-lint-ignore no-explicit-any
  supabase: SupabaseClient<any, any, any>,
  params: InsertGeneratedQuestionsParams,
): Promise<InsertGeneratedQuestionsResult> {
  const { type, courseId, createdBy, generated } = params;
  const inserted: InsertedRow[] = [];
  const errors: FailedRow[] = [];

  for (let idx = 0; idx < generated.length; idx++) {
    const q = generated[idx];
    // Strip junction-only / open-only-input fields before building the
    // `questions` row — they are not columns on the table.
    // (`generated_for_group_id` IS a column and stays in `rest`.)
    const { competency_ids, chapter_ids, material_ids, model_answer, ...rest } = q;
    void competency_ids;
    void chapter_ids;
    void material_ids;
    void model_answer;

    let row: Record<string, unknown> = {
      ...rest,
      course_id: courseId,
      created_by: createdBy,
      is_user_generated: false,
    };
    let modelAnswerWarning: string | undefined;
    if (type === "open") {
      ({ row, warning: modelAnswerWarning } = buildOpenRow(row, q));
    }

    const { data: insertedRow, error: insertErr } = await supabase
      .from("questions")
      .insert(row)
      .select("id")
      .single();

    if (insertErr || !insertedRow) {
      errors.push({
        index: idx,
        id: q.id,
        question: q.question,
        error: insertErr?.message ?? "questions insert returned no data",
      });
      continue;
    }

    const questionId = (insertedRow as { id: string }).id;
    const result: InsertedRow = {
      index: idx,
      id: questionId,
      question: q.question,
      ...(modelAnswerWarning ? { modelAnswerWarning } : {}),
    };

    const chapterRows = (q.chapter_ids ?? []).map((chapter_id) => ({
      question_id: questionId,
      chapter_id,
    }));
    if (chapterRows.length > 0) {
      const { error: chErr } = await supabase
        .from("question_chapters")
        .insert(chapterRows);
      if (chErr) result.chapterLinksWarning = chErr.message;
    }

    const materialRows = (q.material_ids ?? []).map((material_id) => ({
      question_id: questionId,
      material_id,
    }));
    if (materialRows.length > 0) {
      const { error: matErr } = await supabase
        .from("question_materials")
        .insert(materialRows);
      if (matErr) result.materialLinksWarning = matErr.message;
    }

    const competencyRows = (q.competency_ids ?? []).map((competency_id) => ({
      question_id: questionId,
      competency_id,
    }));
    if (competencyRows.length > 0) {
      const { error: cmpErr } = await supabase
        .from("question_competencies")
        .insert(competencyRows);
      if (cmpErr) result.competencyLinksWarning = cmpErr.message;
    }

    inserted.push(result);
  }

  return { inserted, errors };
}
