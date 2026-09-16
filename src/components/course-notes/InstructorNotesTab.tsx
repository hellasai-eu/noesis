import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Download, FileText, Loader2, Pencil, Plus, StickyNote, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  NoteEditorDialog,
  type NoteEditorInitialValues,
  type NoteEditorValues,
} from "./NoteEditorDialog";
import {
  COURSE_NOTES_BUCKET,
  formatNoteSize,
  noteFileExtension,
  sanitizeNoteFileName,
} from "./note-files";
import { openNoteFile } from "./open-note-file";
import { errorMessage } from "./error-message";

export interface NotesSectionOption {
  id: string;
  offeringId: string;
  label: string;
}

interface InstructorNotesTabProps {
  courseId: string;
  sections: NotesSectionOption[];
}

interface NoteListItem {
  id: string;
  title: string;
  description: string | null;
  file_path: string;
  file_name: string;
  file_size: number;
  created_at: string;
  offeringIds: string[];
}

/**
 * Note that this carries no `file_path`. It used to, and three separate
 * review findings came out of code trusting that snapshot to decide which
 * object to DELETE. The current path is read from the row at submit time
 * instead; keeping a copy here would only invite a fourth.
 */
interface EditingState extends NoteEditorInitialValues {
  id: string;
}

export function InstructorNotesTab({ courseId, sections }: InstructorNotesTabProps) {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<NoteListItem | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const queryKey = useMemo(() => ["course-notes", "course", courseId] as const, [courseId]);

  const sectionLabelByOfferingId = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of sections) map.set(s.offeringId, s.label);
    return map;
  }, [sections]);

  const { data: notes, isLoading } = useQuery({
    queryKey,
    enabled: Boolean(courseId),
    queryFn: async (): Promise<NoteListItem[]> => {
      const { data, error } = await supabase
        .from("course_notes")
        .select(
          "id, title, description, file_path, file_name, file_size, created_at, course_note_offerings(offering_id)",
        )
        .eq("course_id", courseId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []).map((row) => ({
        id: row.id,
        title: row.title,
        description: row.description,
        file_path: row.file_path,
        file_name: row.file_name,
        file_size: row.file_size,
        created_at: row.created_at,
        offeringIds: (row.course_note_offerings ?? []).map(
          (o: { offering_id: string }) => o.offering_id,
        ),
      }));
    },
  });

  const openCreate = () => {
    setEditing(null);
    setEditorOpen(true);
  };

  const openEdit = (note: NoteListItem) => {
    setEditing({
      id: note.id,
      title: note.title,
      description: note.description ?? "",
      offeringIds: note.offeringIds,
      fileName: note.file_name,
    });
    setEditorOpen(true);
  };

  const writeTargets = useCallback(
    async (noteId: string, desired: string[], existing: string[]) => {
      const desiredSet = new Set(desired);
      const existingSet = new Set(existing);
      const toAdd = desired.filter((id) => !existingSet.has(id));
      const toRemove = existing.filter((id) => !desiredSet.has(id));

      // Remove first: a transient failure leaves the note visible to fewer
      // sections rather than more, which is the safer failure mode.
      if (toRemove.length > 0) {
        const { error } = await supabase
          .from("course_note_offerings")
          .delete()
          .eq("note_id", noteId)
          .in("offering_id", toRemove);
        if (error) throw error;
      }
      if (toAdd.length > 0) {
        const { error } = await supabase.from("course_note_offerings").insert(
          toAdd.map((offeringId) => ({ note_id: noteId, offering_id: offeringId })),
        );
        if (error) throw error;
      }
    },
    [],
  );

  const uploadFile = useCallback(
    async (file: File): Promise<string> => {
      const path = `${courseId}/${crypto.randomUUID()}-${sanitizeNoteFileName(file.name)}`;
      const { error } = await supabase.storage
        .from(COURSE_NOTES_BUCKET)
        .upload(path, file, { cacheControl: "3600", upsert: false });
      if (error) throw error;
      return path;
    },
    [courseId],
  );

  const handleSubmit = useCallback(
    async (values: NoteEditorValues) => {
      setSubmitting(true);
      // Set only while an uploaded object exists that NO row references yet.
      // Cleared the instant a row points at it: from then on the object is the
      // row's, and rolling it back would leave that row pointing at a deleted
      // file — a broken download for every targeted student, which is worse
      // than the orphan the rollback exists to avoid.
      let orphanPath: string | null = null;
      try {
        if (editing) {
          const newPath = values.file ? await uploadFile(values.file) : null;
          orphanPath = newPath;

          // Which file this replaces is read from the ROW, never from the open
          // editor. `editing.filePath` is a snapshot, and a snapshot drifts:
          // a previous submit that failed after writing the row, a refetch
          // still in flight, another manager replacing the file first. It is
          // the input to a DELETE, so it has to come from the authority rather
          // than from whatever the dialog last believed.
          let superseded: string | null = null;
          if (newPath) {
            const { data: current, error: readError } = await supabase
              .from("course_notes")
              .select("file_path")
              .eq("id", editing.id)
              .single();
            if (readError) throw readError;
            superseded = current?.file_path ?? null;
          }

          const patch = {
            title: values.title,
            description: values.description || null,
            ...(values.file && newPath
              ? {
                  file_path: newPath,
                  file_name: values.file.name,
                  mime_type: values.file.type || "application/octet-stream",
                  file_size: values.file.size,
                }
              : {}),
          };
          let update = supabase.from("course_notes").update(patch).eq("id", editing.id);
          if (newPath && superseded !== null) {
            // Compare-and-swap on the path we are about to delete. If another
            // manager replaced the file between the read above and here, this
            // matches no row — far better than deleting the file they just
            // installed and leaving their row pointing at nothing.
            update = update.eq("file_path", superseded);
          }
          const { data: updated, error } = await update.select("id");
          if (error) throw error;
          if (newPath && (updated?.length ?? 0) === 0) {
            throw new Error(
              "This note was changed by someone else. Reopen it and try again.",
            );
          }
          orphanPath = null;

          // The row names the new object now, so the one it replaced is
          // garbage. Settled before targeting: that is a second write, and a
          // failure there must not leave the swap half-done.
          if (superseded && superseded !== newPath) {
            const { error: removeError } = await supabase.storage
              .from(COURSE_NOTES_BUCKET)
              .remove([superseded]);
            // Logged, not thrown. The note is saved and correct at this point;
            // failing the submit over an unreferenced object would tell the
            // instructor their replacement did not happen when it did. Same
            // call as `handleDelete` makes, for the same reason — this leaves a
            // trace rather than pretending the removal succeeded.
            if (removeError) {
              console.error(
                "[CourseNotes] Failed to remove superseded note file",
                superseded,
                removeError,
              );
            }
          }
          await writeTargets(editing.id, values.offeringIds, editing.offeringIds);
          toast.success("Note updated");
        } else {
          if (!values.file) throw new Error("Choose a file to upload");
          const path = await uploadFile(values.file);
          orphanPath = path;
          const { data: inserted, error } = await supabase
            .from("course_notes")
            .insert({
              course_id: courseId,
              author_id: user?.id ?? null,
              title: values.title,
              description: values.description || null,
              file_path: path,
              file_name: values.file.name,
              mime_type: values.file.type || "application/octet-stream",
              file_size: values.file.size,
            })
            .select("id")
            .single();
          if (error) throw error;
          orphanPath = null;
          if (inserted && values.offeringIds.length > 0) {
            await writeTargets(inserted.id, values.offeringIds, []);
          }
          toast.success("Note uploaded");
        }
        setEditorOpen(false);
        setEditing(null);
      } catch (err: unknown) {
        if (orphanPath) {
          await supabase.storage.from(COURSE_NOTES_BUCKET).remove([orphanPath]);
        }
        toast.error(errorMessage(err, "Failed to save note"));
      } finally {
        // Refetch on the failure path too, not just on success: a submit can
        // fail *after* the row was written — targeting is a second write — so
        // the list is stale either way and the instructor should see what
        // actually landed.
        await queryClient.invalidateQueries({ queryKey });
        setSubmitting(false);
      }
    },
    [editing, courseId, user?.id, queryClient, queryKey, writeTargets, uploadFile],
  );

  const handleDelete = async () => {
    const note = confirmDelete;
    if (!note) return;
    try {
      const { error } = await supabase.from("course_notes").delete().eq("id", note.id);
      if (error) throw error;
      // Row first: an object left behind is invisible, whereas a row pointing
      // at a deleted object would render a broken download for students.
      const { error: storageError } = await supabase.storage
        .from(COURSE_NOTES_BUCKET)
        .remove([note.file_path]);
      if (storageError) {
        console.error("[CourseNotes] Failed to remove note file", storageError);
      }
      toast.success("Note deleted");
      await queryClient.invalidateQueries({ queryKey });
    } catch (err: unknown) {
      toast.error(errorMessage(err, "Failed to delete note"));
    } finally {
      setConfirmDelete(null);
    }
  };

  const handleDownload = async (note: NoteListItem) => {
    setDownloadingId(note.id);
    try {
      await openNoteFile(note.file_path);
    } catch (err: unknown) {
      toast.error(errorMessage(err, "Failed to open note"));
    } finally {
      setDownloadingId(null);
    }
  };

  if (sections.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-muted-foreground">
          No sections available. Assign this course to a section to distribute notes.
        </CardContent>
      </Card>
    );
  }

  const editorSections = sections.map((s) => ({ offeringId: s.offeringId, label: s.label }));

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="flex items-center gap-2">
              <StickyNote className="w-5 h-5" />
              Notes
            </CardTitle>
            <CardDescription>
              Distribute PDF, Word or text documents to your students. Assign to at least
              one section — leave all unchecked to keep it a draft.
            </CardDescription>
          </div>
          <Button onClick={openCreate}>
            <Plus className="w-4 h-4 mr-2" />
            Upload note
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : (notes ?? []).length === 0 ? (
          <div className="py-10 text-center">
            <StickyNote className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground">
              No notes yet. Upload one to share it with a section.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {(notes ?? []).map((note) => {
              const targetLabels = note.offeringIds
                .map((oid) => sectionLabelByOfferingId.get(oid))
                .filter((label): label is string => Boolean(label));
              return (
                <div
                  key={note.id}
                  className="flex items-start gap-3 rounded-lg border border-border p-3"
                  data-testid={`course-note-${note.id}`}
                >
                  <div className="flex-shrink-0 rounded-md bg-muted p-2">
                    <FileText className="w-4 h-4 text-muted-foreground" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{note.title}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {note.file_name} · {noteFileExtension(note.file_name).toUpperCase()} ·{" "}
                      {formatNoteSize(note.file_size)}
                    </p>
                    {note.description && (
                      <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
                        {note.description}
                      </p>
                    )}
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {targetLabels.length === 0 ? (
                        <Badge variant="outline" className="text-[10px]">
                          Draft — not visible to students
                        </Badge>
                      ) : (
                        targetLabels.map((label) => (
                          <Badge key={label} variant="secondary" className="text-[10px]">
                            {label}
                          </Badge>
                        ))
                      )}
                    </div>
                  </div>
                  <div className="flex flex-shrink-0 items-center">
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Download ${note.title}`}
                      disabled={downloadingId === note.id}
                      onClick={() => handleDownload(note)}
                    >
                      {downloadingId === note.id ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Download className="w-4 h-4" />
                      )}
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Edit ${note.title}`}
                      onClick={() => openEdit(note)}
                    >
                      <Pencil className="w-4 h-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Delete ${note.title}`}
                      onClick={() => setConfirmDelete(note)}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>

      <NoteEditorDialog
        open={editorOpen}
        onOpenChange={(open) => {
          setEditorOpen(open);
          if (!open) setEditing(null);
        }}
        initialValues={editing}
        sections={editorSections}
        onSubmit={handleSubmit}
        submitting={submitting}
      />

      <AlertDialog
        open={confirmDelete !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete note?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes the file as well and cannot be undone. Students will no longer
              see it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
