/**
 * Shared loading and authorization for the three study guide generation
 * functions (#1004).
 *
 * Generation is instructor-driven and synchronous: an outline call, then a
 * theory call per piece, then a questions call per piece. Each is its own
 * request, so each has to re-establish the same context and re-check the same
 * permission — hence this module rather than three copies.
 *
 * Replaces the loader that lived inside the deleted `study_guide_generation`
 * job handler.
 */

import { getEffectiveLanguage } from "./language-utils.ts";
import {
  checkActiveCourseInstructor,
  checkInstitutionAdmin,
} from "./institution-authz.ts";

export interface StudyGuideRow {
  id: string;
  course_id: string;
  material_id: string | null;
  title: string;
  brief: string | null;
  target_piece_count: number;
  target_questions_per_piece: number;
}

export interface GuideContext {
  guide: StudyGuideRow;
  courseTitle: string;
  institutionId: string;
  materialTitle: string;
  chapters: Array<{
    id: string;
    chapter_number: number;
    title: string;
    openai_file_id: string | null;
  }>;
  /**
   * Files attached to the model — chapter-level PDF slices, or the whole
   * material when it has no chapters. Never empty.
   */
  fileIds: string[];
  chapterList: string;
  language: string;
}

export interface PieceRow {
  id: string;
  study_guide_id: string;
  position: number;
  title: string;
  theory_html: string | null;
}

export interface PieceContext {
  piece: PieceRow;
  siblings: PieceRow[];
  /** `  1. Title` per line, in order — identical across every call for a guide. */
  outlineSummary: string;
  pieceTotal: number;
}

/**
 * Verifies the caller may manage the course. Each generation function calls it
 * after resolving the course FROM THE GUIDE, never from the request body —
 * otherwise a caller could authorize against a course they manage while
 * generating into one they do not.
 *
 * Both branches go through `institution-authz.ts` so that a suspended member is
 * excluded (#1152). This function previously read `user_institutions.role`
 * directly, which is the pattern #1082 closed elsewhere — and checked
 * `course_instructors` with no membership check at all, which is worse in a
 * quiet way: that table carries no suspension column, so a suspended user keeps
 * every course assignment they had. These handlers run on the service-role key,
 * so RLS never evaluates and this check is the only boundary.
 *
 * `isInstitutionAdmin` ORs in `is_super_admin`, so there is deliberately no
 * separate super-admin branch above it.
 */
export async function isAuthorizedCourseManager(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  userId: string,
  courseId: string,
): Promise<
  { ok: true; institutionId: string } | { ok: false; status: number; error: string }
> {
  const { data: course, error: courseErr } = await supabase
    .from("courses")
    .select("id, institution_id")
    .eq("id", courseId)
    .maybeSingle();
  if (courseErr || !course) {
    return { ok: false, status: 404, error: "Course not found" };
  }
  const institutionId = (course as { institution_id: string }).institution_id;

  // A check that could not be PERFORMED is not one that said no (#1155).
  const admin = await checkInstitutionAdmin(supabase, userId, institutionId);
  if (!admin.ok) {
    return { ok: false, status: 500, error: "Failed to check authorization" };
  }
  if (admin.allowed) return { ok: true, institutionId };

  const instructor = await checkActiveCourseInstructor(
    supabase,
    userId,
    courseId,
    institutionId,
  );
  if (!instructor.ok) {
    return { ok: false, status: 500, error: "Failed to check authorization" };
  }
  if (instructor.allowed) return { ok: true, institutionId };

  return { ok: false, status: 403, error: "Not authorized for this course" };
}

/**
 * Everything the model needs about a guide: its brief, its course, and the
 * chapter PDF slices to attach.
 *
 * Chapters come from `study_guide_source_chapters`; when the instructor
 * selected none, the whole material is used. There is no text extraction
 * anywhere in this codebase — chapters reach the model as attached PDFs via
 * `material_chapters.openai_file_id`.
 *
 * A guide can legitimately have NO chapters: an "Other" material (#1019) is a
 * standalone PDF that is never split, so it is attached whole via
 * `course_materials.openai_file_id`. What is always required is at least one
 * OpenAI file id, from either source.
 */
export async function loadGuideContext(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  studyGuideId: string,
): Promise<GuideContext> {
  const { data: guide, error: guideError } = await supabase
    .from("study_guides")
    .select(
      "id, course_id, material_id, title, brief, target_piece_count, target_questions_per_piece",
    )
    .eq("id", studyGuideId)
    .single();
  if (guideError || !guide) {
    throw new Error(`study guide ${studyGuideId} not found: ${guideError?.message ?? "no row"}`);
  }

  const { data: course, error: courseError } = await supabase
    .from("courses")
    .select("title, institution_id")
    .eq("id", guide.course_id)
    .single();
  if (courseError || !course) {
    throw new Error(`course ${guide.course_id} not found: ${courseError?.message ?? "no row"}`);
  }

  const { data: selected, error: selectedError } = await supabase
    .from("study_guide_source_chapters")
    .select("chapter_id")
    .eq("study_guide_id", studyGuideId);
  if (selectedError) {
    throw new Error(`failed to read source chapters: ${selectedError.message}`);
  }
  const selectedIds = (selected ?? []).map((r: { chapter_id: string }) => r.chapter_id);

  // No selected rows and no material at all leaves nothing to query for.
  let chapters: GuideContext["chapters"] = [];
  if (selectedIds.length > 0 || guide.material_id) {
    let chapterQuery = supabase
      .from("material_chapters")
      .select("id, chapter_number, title, openai_file_id, material_id")
      .order("chapter_number", { ascending: true }).order("id");
    chapterQuery = selectedIds.length > 0
      ? chapterQuery.in("id", selectedIds)
      : chapterQuery.eq("material_id", guide.material_id);

    const { data, error: chaptersError } = await chapterQuery;
    if (chaptersError) throw new Error(`failed to read chapters: ${chaptersError.message}`);
    chapters = data ?? [];
  }

  // An empty chapter set is NOT an error: an "Other" material (#1019) is never
  // split, and the whole-document fallback below supplies its file. The real
  // requirement is having at least one file id, checked once, further down.

  let materialTitle = "";
  if (guide.material_id) {
    const { data: material } = await supabase
      .from("course_materials")
      .select("title, file_name")
      .eq("id", guide.material_id)
      .single();
    materialTitle = material?.title || material?.file_name || "";
  }

  const fileIds = chapters
    .map((c: { openai_file_id: string | null }) => c.openai_file_id)
    .filter((id: string | null): id is string => !!id);

  // Whole-material fallback only when no chapter has its own slice.
  if (fileIds.length === 0 && guide.material_id) {
    const { data: material } = await supabase
      .from("course_materials")
      .select("openai_file_id")
      .eq("id", guide.material_id)
      .single();
    if (material?.openai_file_id) fileIds.push(material.openai_file_id);
  }
  if (fileIds.length === 0) {
    throw new Error(
      "no OpenAI file ids on the selected chapters or their material — split the material into chapters first",
    );
  }

  const chapterList = chapters.length > 0
    ? chapters
      .map((c: { chapter_number: number; title: string }) => `  ${c.chapter_number}. ${c.title}`)
      .join("\n")
    : "  (the whole document — it is not split into chapters)";

  return {
    guide,
    courseTitle: course.title,
    institutionId: course.institution_id,
    materialTitle,
    chapters,
    fileIds,
    chapterList,
    language: await getEffectiveLanguage(supabase, guide.course_id),
  };
}

/**
 * One piece plus the sequence it sits in. The outline summary is rebuilt from
 * the stored pieces rather than carried around: the stored pieces ARE the
 * outline once stage 1 has run.
 */
export async function loadPieceContext(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  pieceId: string,
): Promise<PieceContext> {
  const { data: piece, error: pieceError } = await supabase
    .from("study_guide_pieces")
    .select("id, study_guide_id, position, title, theory_html")
    .eq("id", pieceId)
    .single();
  if (pieceError || !piece) {
    throw new Error(`study guide piece ${pieceId} not found: ${pieceError?.message ?? "no row"}`);
  }

  const { data: siblings, error: siblingsError } = await supabase
    .from("study_guide_pieces")
    .select("id, study_guide_id, position, title, theory_html")
    .eq("study_guide_id", piece.study_guide_id)
    .order("position", { ascending: true });
  if (siblingsError) throw new Error(`failed to read pieces: ${siblingsError.message}`);

  const all = (siblings ?? []) as PieceRow[];
  return {
    piece: piece as PieceRow,
    siblings: all,
    outlineSummary: all.map((p, i) => `  ${i + 1}. ${p.title}`).join("\n"),
    pieceTotal: all.length,
  };
}

/** Marks the piece being worked on inside the shared outline summary. */
export function markCurrentPiece(outlineSummary: string, position: number): string {
  return outlineSummary
    .split("\n")
    .map((line, i) => (i === position ? `${line}   <-- HERE` : line))
    .join("\n");
}
