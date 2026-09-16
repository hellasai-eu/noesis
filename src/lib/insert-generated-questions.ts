/**
 * Shared writer for question rows returned by the
 * `generate-{open,fill-gaps,ordering,classification}-questions` edge functions.
 *
 * The edge functions only GENERATE + RETURN question objects; they do not
 * persist anything. Every entry-point that calls them owns the insert into
 * `questions` plus the chapter / competency junctions and the optional
 * auto-assignment to an individually targeted student.
 *
 * Before #630 each per-type tab inlined this flow. `UnifiedGenerateDialog`
 * (#621) didn't, so generated open / fill-gaps / ordering / classification
 * questions never reached the bank. This module factors the canonical
 * writer so the unified dialog and any future caller share it.
 */
import { supabase } from "@/integrations/supabase/client";
import { toOpenUnified, questionDiagramFromPayload } from "@/lib/question-payload";
import type { Json } from "@/integrations/supabase/types";
import type { AudienceSelection } from "@/components/TargetAudienceSelector";
import type { QuestionType } from "@/types/question";

export type GeneratableType = Exclude<QuestionType, "mcq">;

/**
 * The shape the four edge functions emit per question. They all attach
 * `chapter_ids` / `competency_ids` as extras on top of the unified row
 * (type / payload / answer_key / etc.) so the client can write the
 * junction tables in the same trip.
 */
export interface GeneratedRow {
  id: string;
  course_id: string;
  question: string;
  type?: QuestionType;
  payload?: Json;
  answer_key?: Json;
  explanation?: string | null;
  difficulty: string;
  hidden: boolean;
  upvotes?: number;
  downvotes?: number;
  competency_id?: string | null;
  generation_rationale?: string | null;
  chapter_ids?: string[];
  competency_ids?: string[];
  /** Whole-document sources (#1019) — written to `question_materials`. */
  material_ids?: string[];
  /** Provenance column on `questions` — passes straight through into the row. */
  generated_for_group_id?: string | null;
  // Open returns `model_answer` separately because its `toOpenUnified`
  // call on the server omits `answering_mode` (so payload comes back `{}`
  // and the answer key holds the model answer). The unified dialog
  // re-runs `toOpenUnified` with the desired mode, so we need the raw
  // model answer back.
  model_answer?: string;
}

export interface InsertGeneratedQuestionsParams {
  type: GeneratableType;
  courseId: string;
  generated: GeneratedRow[];
  /** Resolved student-target metadata returned by the edge function. */
  target?: {
    kind?: string;
    offering_id?: string;
    group_id?: string;
    student_full_name?: string | null;
  } | null;
  audience: AudienceSelection;
}

export interface InsertGeneratedQuestionsResult {
  insertedCount: number;
  autoAssignedLabel: string | null;
  /** Non-fatal warning (e.g. auto-assign failed) — the rows still landed. */
  warning: string | null;
}

/**
 * Insert generated questions + junctions + (optional) auto-assignment.
 *
 * Throws if the main `questions` insert fails. Junction / auto-assign
 * failures are surfaced via `warning` so the caller can toast a soft
 * warning without losing the inserted rows.
 */
export async function insertGeneratedQuestions(
  params: InsertGeneratedQuestionsParams,
): Promise<InsertGeneratedQuestionsResult> {
  const { type, courseId, generated, target, audience } = params;

  const { data: { user } } = await supabase.auth.getUser();
  const createdBy = user?.id || null;

  const rowsForInsert = generated.map((q) => {
    // Junction-only fields are stripped; `generated_for_group_id` IS a
    // column and stays in `rest`.
    const { competency_ids, chapter_ids, material_ids, model_answer, ...rest } = q;
    void material_ids;
    const base = {
      ...rest,
      course_id: courseId,
      created_by: createdBy,
      is_user_generated: false,
    };

    // #618 — questions generated from the unified Question Bank are
    // single-answer by default (the AI Interactive surface lives on its
    // own tab and has its own writer). Override the server's empty
    // `payload` so the row is filtered into the bank, not the chat tab.
    if (type === "open") {
      const answerKey = (q.answer_key as { model_answer?: string } | null) ?? null;
      const resolvedModelAnswer = model_answer ?? answerKey?.model_answer ?? "";
      // #627/#636 — toOpenUnified rebuilds `payload` from scratch (to force
      // answering_mode "single"), which would drop the diagram the server
      // already validated into `q.payload.diagram`. Re-read it and thread it
      // back through so open-question diagrams survive the insert.
      const diagram = questionDiagramFromPayload(q.payload as Json) ?? undefined;
      return {
        ...base,
        ...toOpenUnified({
          model_answer: resolvedModelAnswer,
          rubric: null,
          explanation: q.explanation ?? null,
          answering_mode: "single",
          diagram,
        }),
      };
    }

    return base;
  });

  const { data: insertedData, error: insertErr } = await supabase
    .from("questions")
    .insert(rowsForInsert)
    .select();
  if (insertErr) throw insertErr;

  const inserted = insertedData ?? [];

  const competencyLinks = generated.flatMap((q) =>
    (q.competency_ids ?? []).map((cid) => ({
      question_id: q.id,
      competency_id: cid,
    })),
  );
  if (competencyLinks.length > 0) {
    const { error: competencyLinkError } = await supabase
      .from("question_competencies")
      .insert(competencyLinks);
    if (competencyLinkError) throw competencyLinkError;
  }

  const chapterLinks = generated.flatMap((q) =>
    (q.chapter_ids ?? []).map((chId) => ({
      question_id: q.id,
      chapter_id: chId,
    })),
  );
  if (chapterLinks.length > 0) {
    const { error: chapterLinkError } = await supabase
      .from("question_chapters")
      .insert(chapterLinks);
    if (chapterLinkError) throw chapterLinkError;
  }

  // Whole-document sources (#1019). `question_materials` isn't in the
  // generated supabase types yet; the cast matches the `offering_questions`
  // write below.
  const materialLinks = generated.flatMap((q) =>
    (q.material_ids ?? []).map((mId) => ({
      question_id: q.id,
      material_id: mId,
    })),
  );
  // Partial success, not failure: the questions are already committed, and
  // throwing here would invite a retry that duplicates them. Mirrors the
  // server writer's materialLinksWarning.
  let materialLinksWarning: string | null = null;
  if (materialLinks.length > 0) {
    const { error: materialLinkError } = await supabase
      .from("question_materials" as never)
      .insert(materialLinks as never);
    if (materialLinkError) {
      materialLinksWarning = `Questions saved, but linking their source documents failed: ${materialLinkError.message}`;
    }
  }

  let autoAssignedLabel: string | null = null;
  let warning: string | null = null;
  let assignTarget:
    | { offering_id: string; group_id: string; label: string }
    | null = null;

  // Only an individually targeted student is auto-assigned. A group audience
  // steers the prompt and is recorded on the question row as
  // `generated_for_group_id`; publishing is a separate, deliberate act.
  if (audience.kind === "student") {
    if (target?.kind === "student" && target.offering_id && target.group_id) {
      assignTarget = {
        offering_id: target.offering_id,
        group_id: target.group_id,
        label: target.student_full_name || audience.label,
      };
    } else {
      warning = "Questions saved to the bank but could not be auto-assigned: student group was not resolved.";
    }
  }

  if (assignTarget) {
    const nowIso = new Date().toISOString();
    const assignRows = inserted.map((row) => ({
      offering_id: assignTarget!.offering_id,
      question_id: row.id,
      group_id: assignTarget!.group_id,
      published_at: nowIso,
    }));
    // `offering_questions` isn't in the generated supabase types yet; the
    // cast matches the per-type tabs that already write here.
    const { error: assignErr } = await supabase
      .from("offering_questions" as never)
      .insert(assignRows as never);
    if (assignErr) {
      warning = `Generated questions, but auto-assignment to ${assignTarget.label} failed: ${assignErr.message}`;
    } else {
      autoAssignedLabel = assignTarget.label;
    }
  }

  return {
    insertedCount: inserted.length,
    autoAssignedLabel,
    warning: [materialLinksWarning, warning].filter(Boolean).join(" ") || null,
  };
}
