import { supabase } from "@/integrations/supabase/client";
import {
  CHAPTERLESS_MATERIAL_TYPES,
  MATERIAL_TYPE_LABELS,
  type MaterialType,
} from "@/components/MaterialUploadDialog";

/**
 * Produces a friendly refusal when a material with chapters is about to be
 * reclassified into a chapterless type (#1019).
 *
 * "Images" and "Other" are never split, so the UI hides every chapter control
 * for them. Reclassifying an already-split textbook would therefore strand its
 * `material_chapters` rows and their uploaded split PDFs: still stored, still
 * costing space, and no longer reachable by anything that could delete them.
 *
 * THIS IS NOT THE ENFORCEMENT. A count followed by a separate update is not
 * atomic — one session can split a material while another reclassifies it after
 * observing zero chapters, and both commit. The invariant is enforced by
 * triggers in `20260729130000_guard_chapterless_material_types.sql`, which no
 * interleaving can get past. This runs first only so the common case produces a
 * sentence an instructor can act on instead of a raw database error.
 *
 * Neither layer deletes anything. A chapter owns its cheat sheet and flashcards
 * and is referenced by `question_chapters`, so a silent cleanup during what
 * reads as a metadata edit would destroy generated content the instructor never
 * agreed to lose. The write is refused instead, and they are told to delete the
 * chapters first — an action they already have a UI for, and one where the
 * consequences are visible.
 *
 * @returns a message to show the instructor, or null when the change may proceed.
 */
export async function blockedReclassificationReason(
  materialId: string,
  currentType: MaterialType,
  nextType: MaterialType,
): Promise<string | null> {
  if (nextType === currentType) return null;
  // Only moving INTO a chapterless type strands anything. Moving out of one
  // simply reveals controls for a material that has no chapters yet.
  if (!CHAPTERLESS_MATERIAL_TYPES.includes(nextType)) return null;
  if (CHAPTERLESS_MATERIAL_TYPES.includes(currentType)) return null;

  const { count, error } = await supabase
    .from("material_chapters")
    .select("id", { count: "exact", head: true })
    .eq("material_id", materialId);
  if (error) throw error;
  if (!count) return null;

  return (
    `This material has ${count} chapter${count === 1 ? "" : "s"}. ` +
    `"${MATERIAL_TYPE_LABELS[nextType]}" materials are never split into chapters, so those ` +
    `chapters and their split PDFs would stay in place with no way to manage them. ` +
    `Delete the chapters first, then change the type.`
  );
}
