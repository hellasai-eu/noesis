import { supabase } from "@/integrations/supabase/client";
import { WHOLE_DOCUMENT_MATERIAL_TYPE } from "@/components/MaterialUploadDialog";

/**
 * An "Other" material offered as a generation source (#1019).
 *
 * Every other picker in the app selects CHAPTERS. These materials have none —
 * they are never split — so they are offered as themselves: one row, one
 * checkbox, the whole document. The edge functions take them the same way, as
 * `materialIds` alongside `chapterIds`.
 */
export interface WholeDocumentMaterial {
  id: string;
  title: string;
  page_count: number | null;
  file_size: number | null;
}

/**
 * The "Other" materials in a course that can actually be generated from.
 *
 * Only synced ones. A material with no `openai_file_id` has not finished
 * uploading to OpenAI, and unlike a chapter it has no extracted text to fall
 * back on — selecting it would send the model nothing. The study-guide picker
 * has always filtered on the same condition, for the same reason.
 */
export async function fetchWholeDocumentMaterials(
  courseId: string,
): Promise<WholeDocumentMaterial[]> {
  const { data, error } = await supabase
    .from("course_materials")
    .select("id, title, file_name, page_count, file_size")
    .eq("course_id", courseId)
    .eq("material_type", WHOLE_DOCUMENT_MATERIAL_TYPE)
    .not("openai_file_id", "is", null)
    .order("title");

  if (error) throw error;

  return (data ?? []).map((m) => ({
    id: m.id,
    title: m.title || m.file_name || "Untitled document",
    page_count: m.page_count,
    file_size: m.file_size,
  }));
}
