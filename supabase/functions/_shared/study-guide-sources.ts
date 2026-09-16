/**
 * Resolving a request's `studyGuideIds` into question-generation sources.
 *
 * A study guide enters generation the way its own question writer works
 * (#1004): grounded in the STORED theory, not the source PDF. The instructor
 * may have rewritten the theory after it was drafted, so the theory is the
 * source of truth and is passed inline — no OpenAI file is attached.
 *
 * Only a COMPLETE guide may be used: every piece must have theory and
 * questions. An incomplete guide is a guide still being authored, and its
 * theory is not yet something an instructor has signed off on end to end —
 * the same reason `guideIsAssignable` blocks handing one to a class. The
 * check lives here, server-side, because the dialog's client-side filter is
 * UX, not enforcement.
 *
 * The guide's existing questions ride along as dedup input: they were already
 * asked of students inside the guide, and a bank question that repeats one
 * verbatim tests nothing new.
 *
 * Requests are not trusted: `courseId` filtering happens here rather than at
 * the call site, mirroring `whole-material-sources.ts` — a body id must not
 * reach another institution's guide.
 */
import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * Mirrors the refusal threshold in `generate-study-guide-questions`: a piece
 * whose stripped theory is shorter than this is treated as having no theory.
 * Also mirrored client-side in `src/lib/study-guide.ts` for the dialog filter.
 */
export const MIN_GUIDE_THEORY_CHARS = 50;

export interface StudyGuideSection {
  pieceTitle: string;
  /** Theory with tags stripped — the prose the questions are written about. */
  text: string;
}

export interface StudyGuideSource {
  id: string;
  title: string;
  /** Position-ordered piece theories. Never empty for a complete guide. */
  sections: StudyGuideSection[];
  /** Question stems the guide already asks, for the dedup list. */
  askedQuestions: string[];
  /** Chapters the guide was drafted from; generated questions link to them. */
  sourceChapterIds: string[];
  /**
   * The guide's material, set ONLY when the guide reads it whole — an empty
   * `study_guide_source_chapters` is exactly how the schema spells "whole
   * material" (see CreateStudyGuideDialog). Such a guide has no chapter ids to
   * link a question to, so this is its provenance channel instead, via
   * `question_materials` (#1019).
   */
  sourceMaterialId: string | null;
}

export type StudyGuideSourcesResult =
  | { ok: true; sources: StudyGuideSource[] }
  | { ok: false; error: string };

export function normalizeStudyGuideIds(studyGuideIds: unknown): string[] {
  if (!Array.isArray(studyGuideIds)) return [];
  return [
    ...new Set(
      studyGuideIds.filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ];
}

/** Strips tags so the model reads the prose, not the markup. */
export function theoryHtmlAsText(html: string | null): string {
  return (html ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface PieceCompleteness {
  theoryTextLength: number;
  hasQuestions: boolean;
}

/**
 * Why a guide cannot be a generation source yet, or null when it can.
 * Theory is reported before questions: questions are generated FROM theory,
 * so a piece missing both is fixed by writing the theory first.
 */
export function guideIncompleteReason(pieces: PieceCompleteness[]): string | null {
  if (pieces.length === 0) return "it has no pieces";
  const withoutTheory = pieces.filter((p) => p.theoryTextLength < MIN_GUIDE_THEORY_CHARS).length;
  if (withoutTheory > 0) {
    return `${withoutTheory} of ${pieces.length} pieces have no theory`;
  }
  const withoutQuestions = pieces.filter((p) => !p.hasQuestions).length;
  if (withoutQuestions > 0) {
    return `${withoutQuestions} of ${pieces.length} pieces have no questions`;
  }
  return null;
}

/** Source-list lines for the prompt, alongside the chapter lines. */
export function studyGuidePromptLines(sources: StudyGuideSource[]): string {
  return sources
    .map(
      (g) =>
        `- Study guide "${g.title}" (${g.sections.length} piece${
          g.sections.length === 1 ? "" : "s"
        } of instructor-approved theory, provided inline)`,
    )
    .join("\n");
}

/** The inline theory itself, piece by piece, in reading order. */
export function studyGuideTheoryBlocks(sources: StudyGuideSource[]): string {
  return sources
    .map((g) =>
      g.sections
        .map(
          (s, i) =>
            `=== Study guide "${g.title}" — piece ${i + 1}: ${s.pieceTitle} ===\n${s.text}`,
        )
        .join("\n\n")
    )
    .join("\n\n");
}

export async function fetchStudyGuideSources(
  // deno-lint-ignore no-explicit-any
  supabase: SupabaseClient<any, any, any>,
  courseId: string,
  studyGuideIds: unknown,
): Promise<StudyGuideSourcesResult> {
  const ids = normalizeStudyGuideIds(studyGuideIds);
  if (ids.length === 0) return { ok: true, sources: [] };

  const { data: guides, error: guidesError } = await supabase
    .from("study_guides")
    .select("id, title, material_id")
    .eq("course_id", courseId)
    .in("id", ids);
  if (guidesError) throw new Error(`Failed to fetch study guides: ${guidesError.message}`);
  const guideRows = (guides ?? []) as Array<{
    id: string;
    title: string;
    material_id: string | null;
  }>;

  // A missing id is refused, not skipped: the caller selected a specific
  // guide, and silently generating from the remainder would attribute the
  // batch to sources it never used.
  if (guideRows.length < ids.length) {
    return { ok: false, error: "One or more selected study guides were not found in this course" };
  }

  const guideIdList = guideRows.map((g) => g.id);
  const { data: pieces, error: piecesError } = await supabase
    .from("study_guide_pieces")
    .select("id, study_guide_id, title, position, theory_html")
    .in("study_guide_id", guideIdList)
    .order("position", { ascending: true });
  if (piecesError) throw new Error(`Failed to fetch study guide pieces: ${piecesError.message}`);
  const pieceRows = (pieces ?? []) as Array<{
    id: string;
    study_guide_id: string;
    title: string;
    position: number;
    theory_html: string | null;
  }>;

  const pieceIds = pieceRows.map((p) => p.id);
  let questionRows: Array<{ piece_id: string; questions: { question: string } | null }> = [];
  if (pieceIds.length > 0) {
    const { data: links, error: linksError } = await supabase
      .from("study_guide_piece_questions")
      .select("piece_id, questions(question)")
      .in("piece_id", pieceIds);
    if (linksError) {
      throw new Error(`Failed to fetch study guide questions: ${linksError.message}`);
    }
    questionRows = (links ?? []) as unknown as typeof questionRows;
  }
  const questionsByPiece = new Map<string, string[]>();
  for (const link of questionRows) {
    const stem = link.questions?.question;
    const list = questionsByPiece.get(link.piece_id) ?? [];
    if (typeof stem === "string" && stem.trim().length > 0) list.push(stem);
    // An empty list still marks the piece as having questions when the join
    // returned a row — but a row with no readable stem should not, so only
    // set the key when something was pushed or the key already exists.
    if (list.length > 0) questionsByPiece.set(link.piece_id, list);
  }

  const { data: sourceChapters, error: chaptersError } = await supabase
    .from("study_guide_source_chapters")
    .select("study_guide_id, chapter_id")
    .in("study_guide_id", guideIdList);
  if (chaptersError) {
    throw new Error(`Failed to fetch study guide source chapters: ${chaptersError.message}`);
  }
  const chaptersByGuide = new Map<string, string[]>();
  for (const row of (sourceChapters ?? []) as Array<{ study_guide_id: string; chapter_id: string }>) {
    const list = chaptersByGuide.get(row.study_guide_id) ?? [];
    list.push(row.chapter_id);
    chaptersByGuide.set(row.study_guide_id, list);
  }

  const sources: StudyGuideSource[] = [];
  for (const guide of guideRows) {
    const guidePieces = pieceRows.filter((p) => p.study_guide_id === guide.id);
    const withText = guidePieces.map((p) => ({
      piece: p,
      text: theoryHtmlAsText(p.theory_html),
      asked: questionsByPiece.get(p.id) ?? [],
    }));

    const reason = guideIncompleteReason(
      withText.map((p) => ({
        theoryTextLength: p.text.length,
        hasQuestions: p.asked.length > 0,
      })),
    );
    if (reason) {
      return {
        ok: false,
        error:
          `Study guide "${guide.title}" is not complete (${reason}). ` +
          "Only completed study guides can be used to generate questions.",
      };
    }

    const sourceChapterIds = chaptersByGuide.get(guide.id) ?? [];
    sources.push({
      id: guide.id,
      title: guide.title,
      sections: withText.map((p) => ({ pieceTitle: p.piece.title, text: p.text })),
      askedQuestions: withText.flatMap((p) => p.asked),
      sourceChapterIds,
      sourceMaterialId: sourceChapterIds.length === 0 ? guide.material_id ?? null : null,
    });
  }

  return { ok: true, sources };
}
