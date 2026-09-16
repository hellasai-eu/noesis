import { supabase } from "@/integrations/supabase/client";
import { COURSE_NOTES_BUCKET } from "./note-files";

/**
 * Open a note in a new tab via a short-lived signed URL. Used by both the
 * instructor list and the student list, so the expiry lives in one place.
 */
export async function openNoteFile(filePath: string): Promise<void> {
  const { data, error } = await supabase.storage
    .from(COURSE_NOTES_BUCKET)
    .createSignedUrl(filePath, 60 * 10);
  if (error) throw error;
  if (!data?.signedUrl) throw new Error("Could not create a download link");
  window.open(data.signedUrl, "_blank", "noopener,noreferrer");
}
