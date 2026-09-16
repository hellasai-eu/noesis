/**
 * Resolving a request's `materialIds` into whole-document generation sources.
 *
 * The generators are built around chapters: a chapter carries its own
 * `openai_file_id` (the split PDF), its own page range, and the id a generated
 * question is linked back to. A material of type `other` has none of that — it
 * is never split (`is_chapterless_material_type`, enforced by trigger), so
 * there is no chapter to select, no per-chapter file, and nothing for
 * `question_chapters` to point at.
 *
 * So it enters generation as a SOURCE OF ITS OWN, alongside the selected
 * chapters: its `openai_file_id` is attached whole, exactly as the study-guide
 * functions already attach it, and questions generated from it simply carry no
 * chapter links. `question_chapters` rows are optional — `chapter_ids` is
 * already allowed to be empty in both writers — so nothing downstream needs a
 * material-shaped junction to exist.
 *
 * Requests are not trusted: `courseId` filtering happens here rather than at
 * the call sites, because every one of the five question handlers would
 * otherwise have to repeat it, and one that forgot would attach another
 * institution's document to its prompt.
 */
import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isWholeDocumentMaterial } from "./material-types.ts";

export interface WholeMaterialSource {
  id: string;
  title: string;
  /** Never null — an unsynced material cannot be attached, so it is dropped. */
  openaiFileId: string;
  /** Best-effort, for the same page/size budget the chapters are held to. */
  pageCount: number;
  sizeBytes: number;
}

/**
 * A material that carries no `openai_file_id` has not finished syncing to
 * OpenAI. There is nothing to attach and no chapter text to fall back on, so it
 * is dropped rather than silently contributing nothing to the prompt. The
 * caller decides whether the remaining sources are enough.
 */
export function normalizeMaterialIds(materialIds: unknown): string[] {
  if (!Array.isArray(materialIds)) return [];
  return [
    ...new Set(
      materialIds.filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ];
}

export async function fetchWholeMaterialSources(
  // deno-lint-ignore no-explicit-any
  supabase: SupabaseClient<any, any, any>,
  courseId: string,
  materialIds: unknown,
): Promise<WholeMaterialSource[]> {
  const ids = normalizeMaterialIds(materialIds);
  if (ids.length === 0) return [];

  const { data, error } = await supabase
    .from("course_materials")
    .select("id, title, file_name, course_id, material_type, openai_file_id, page_count, file_size")
    .in("id", [...new Set(ids)]);

  if (error) throw new Error("Failed to fetch whole-document materials: " + error.message);

  return (data ?? [])
    .filter((m: Record<string, unknown>) =>
      m.course_id === courseId &&
      isWholeDocumentMaterial(m.material_type as string | null) &&
      typeof m.openai_file_id === "string" && m.openai_file_id.length > 0
    )
    .map((m: Record<string, unknown>) => ({
      id: m.id as string,
      title: (m.title as string) || (m.file_name as string) || "Untitled document",
      openaiFileId: m.openai_file_id as string,
      pageCount: (m.page_count as number) || 0,
      sizeBytes: (m.file_size as number) || 0,
    }));
}

/**
 * How these documents are described to the model.
 *
 * Kept separate from the chapter list and stated explicitly, because the
 * prompts ask the model to attribute each question to a chapter it was given.
 * Without being told how to attribute these, it invents chapter ids for them —
 * which the handlers then discard, losing the attribution.
 *
 * Attribution reuses the existing `chapter_ids` output channel: the model puts
 * the document's id there and `splitReturnedSourceIds` partitions the returned
 * ids back into chapter links and whole-document links, so no generator output
 * schema has to change.
 */
export function wholeMaterialPromptLines(sources: WholeMaterialSource[]): string {
  return sources
    .map((m) =>
      `- The whole document "${m.title}" (document id: ${m.id}) — it has no chapters; for questions drawn from it, put this document id in chapter_ids`
    )
    .join("\n");
}

export interface LinkedSourceIds {
  chapterIds: string[];
  materialIds: string[];
}

/**
 * Partition the model-returned `chapter_ids` of one question into real chapter
 * links and whole-document links, dropping anything that was not a source of
 * this generation run.
 *
 * Fallbacks mirror the long-standing chapters-only behavior (pin to the first
 * chapter when the model attributed nothing), extended symmetrically: a batch
 * whose ONLY sources were whole documents pins an unattributed question to the
 * first document. A mixed batch gets no fallback — guessing between a chapter
 * and a document would file the question under material it may not have come
 * from.
 *
 * `wholeMaterialsSelected` is the pre-truncation selection count, matching the
 * condition the chapter fallback has always used.
 */
export function splitReturnedSourceIds(
  returnedIds: string[] | undefined,
  attachedChapterIds: string[],
  attachedWholeMaterials: WholeMaterialSource[],
  wholeMaterialsSelected: number,
): LinkedSourceIds {
  const validChapterIds = new Set(attachedChapterIds);
  const validMaterialIds = new Set(attachedWholeMaterials.map((m) => m.id));
  const ids = returnedIds ?? [];
  let chapterIds = [...new Set(ids.filter((id) => validChapterIds.has(id)))];
  let materialIds = [...new Set(ids.filter((id) => validMaterialIds.has(id)))];

  if (chapterIds.length === 0 && attachedChapterIds.length > 0 && wholeMaterialsSelected === 0) {
    chapterIds = [attachedChapterIds[0]];
  }
  if (
    chapterIds.length === 0 &&
    materialIds.length === 0 &&
    attachedChapterIds.length === 0 &&
    attachedWholeMaterials.length > 0
  ) {
    materialIds = [attachedWholeMaterials[0].id];
  }

  return { chapterIds, materialIds };
}
