/**
 * The `course_materials.material_type` vocabulary, server side (#1019).
 *
 * Mirrors `MATERIAL_TYPE_LABELS` in `src/components/MaterialUploadDialog.tsx`
 * and the `course_materials_type_check` CHECK constraint.
 */

/**
 * A standalone PDF an instructor uploads without splitting it into chapters —
 * a syllabus, a paper, a set of notes.
 *
 * It is never split, so everything that consumes it attaches the WHOLE document
 * via `course_materials.openai_file_id` rather than a chapter file. Study
 * guides were the first consumer; the question generators and tutoring sessions
 * take it the same way now, as a single unit with no chapter to link back to.
 *
 * Still excluded from flashcards and cheat sheets — both refuse anything that
 * is not a `textbook` outright, which is a stricter rule than this one and is
 * enforced in their own handlers, not here.
 */
export const WHOLE_DOCUMENT_MATERIAL_TYPE = "other";

/**
 * True when this material has no chapters and must be used whole.
 *
 * `images` is chapterless too, but it is not a document — it never carries an
 * `openai_file_id` to attach — so it is not one of these.
 */
export function isWholeDocumentMaterial(materialType: string | null | undefined): boolean {
  return (materialType ?? "textbook") === WHOLE_DOCUMENT_MATERIAL_TYPE;
}
