import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Loader2, Pencil, Trash2, Save, X } from "lucide-react";
import { formatDate, formatTime, useFormatters } from "@/i18n/formatters";

export const NOTE_MAX_LENGTH = 10_000;

interface NoteRow {
  id: string;
  body: string;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}

interface StudentNotesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  studentUserId: string;
  studentFullName: string | null;
  institutionId: string;
  mode: "read-write" | "read-only";
  onNotesChanged?: () => void;
}

const formatTimestamp = (iso: string) =>
  `${formatDate(iso)} ${formatTime(iso, { hour: "2-digit", minute: "2-digit" })}`;

export function StudentNotesDialog({
  open,
  onOpenChange,
  studentUserId,
  studentFullName,
  institutionId,
  mode,
  onNotesChanged,
}: StudentNotesDialogProps) {
  const { formatNumber } = useFormatters();
  const { user } = useAuth();
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [authors, setAuthors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [newBody, setNewBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");
  const [savingEditId, setSavingEditId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<NoteRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  const readOnly = mode === "read-only";

  const fetchNotes = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("student_admin_notes" as any)
        .select("id, body, created_at, updated_at, created_by, updated_by")
        .eq("student_user_id", studentUserId)
        .eq("institution_id", institutionId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      const rows = ((data as any[]) || []) as NoteRow[];
      setNotes(rows);

      const ids = Array.from(
        new Set(
          rows
            .flatMap(n => [n.created_by, n.updated_by])
            .filter((v): v is string => !!v),
        ),
      );
      if (ids.length > 0) {
        const { data: profileRows, error: pErr } = await supabase
          .from("profiles")
          .select("user_id, full_name, email")
          .in("user_id", ids);
        if (pErr) throw pErr;
        const map: Record<string, string> = {};
        for (const p of profileRows || []) {
          map[p.user_id] = p.full_name || p.email || "Unknown";
        }
        setAuthors(map);
      } else {
        setAuthors({});
      }
    } catch (error: any) {
      console.error("Error loading notes:", error);
      toast.error(error.message || "Failed to load notes");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setEditingId(null);
    setEditBody("");
    setNewBody("");
    fetchNotes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, studentUserId, institutionId]);

  const handleAdd = async () => {
    const body = newBody.trim();
    if (!body) {
      toast.error("Note cannot be empty");
      return;
    }
    if (body.length > NOTE_MAX_LENGTH) {
      toast.error(`Note must be at most ${formatNumber(NOTE_MAX_LENGTH)} characters`);
      return;
    }
    setSubmitting(true);
    try {
      const { error } = await supabase
        .from("student_admin_notes" as any)
        .insert({
          student_user_id: studentUserId,
          institution_id: institutionId,
          body,
          created_by: user?.id ?? null,
          updated_by: user?.id ?? null,
        });
      if (error) throw error;
      toast.success("Note added");
      setNewBody("");
      await fetchNotes();
      onNotesChanged?.();
    } catch (error: any) {
      console.error("Error adding note:", error);
      toast.error(error.message || "Failed to add note");
    } finally {
      setSubmitting(false);
    }
  };

  const startEdit = (note: NoteRow) => {
    setEditingId(note.id);
    setEditBody(note.body);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditBody("");
  };

  const saveEdit = async (note: NoteRow) => {
    const body = editBody.trim();
    if (!body) {
      toast.error("Note cannot be empty");
      return;
    }
    if (body.length > NOTE_MAX_LENGTH) {
      toast.error(`Note must be at most ${formatNumber(NOTE_MAX_LENGTH)} characters`);
      return;
    }
    setSavingEditId(note.id);
    try {
      const { error } = await supabase
        .from("student_admin_notes" as any)
        .update({
          body,
          updated_by: user?.id ?? null,
        })
        .eq("id", note.id);
      if (error) throw error;
      toast.success("Note updated");
      setEditingId(null);
      setEditBody("");
      await fetchNotes();
      onNotesChanged?.();
    } catch (error: any) {
      console.error("Error updating note:", error);
      toast.error(error.message || "Failed to update note");
    } finally {
      setSavingEditId(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const { error } = await supabase
        .from("student_admin_notes" as any)
        .delete()
        .eq("id", deleteTarget.id);
      if (error) throw error;
      toast.success("Note deleted");
      setDeleteTarget(null);
      await fetchNotes();
      onNotesChanged?.();
    } catch (error: any) {
      console.error("Error deleting note:", error);
      toast.error(error.message || "Failed to delete note");
    } finally {
      setDeleting(false);
    }
  };

  const counterColor = (length: number) => {
    if (length > NOTE_MAX_LENGTH) return "text-destructive";
    if (length > NOTE_MAX_LENGTH * 0.9) return "text-amber-600";
    return "text-muted-foreground";
  };

  const titleName = studentFullName?.trim() || "this student";

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Notes for {titleName}</DialogTitle>
            <DialogDescription>
              {readOnly
                ? "Private notes shared with admins and instructors who teach this student."
                : "Private notes about this student. Visible to admins and instructors who teach them — never to the student."}
            </DialogDescription>
          </DialogHeader>

          {!readOnly && (
            <div className="space-y-2">
              <Textarea
                value={newBody}
                onChange={(e) => setNewBody(e.target.value)}
                placeholder="Add a note (e.g. medical condition, accommodation, observation)…"
                rows={4}
                className="resize-none"
                disabled={submitting}
              />
              <div className="flex items-center justify-between gap-2">
                <span className={`text-xs ${counterColor(newBody.length)}`}>
                  {formatNumber(newBody.length)} / {formatNumber(NOTE_MAX_LENGTH)}
                </span>
                <Button
                  size="sm"
                  onClick={handleAdd}
                  disabled={
                    submitting ||
                    newBody.trim().length === 0 ||
                    newBody.length > NOTE_MAX_LENGTH
                  }
                >
                  {submitting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                  Add note
                </Button>
              </div>
            </div>
          )}

          <div className="border-t pt-3">
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
              </div>
            ) : notes.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6">
                No notes yet.
              </p>
            ) : (
              <ScrollArea className="max-h-[420px] pr-3">
                <div className="space-y-3">
                  {notes.map((note) => {
                    const isEditing = editingId === note.id;
                    const authorName =
                      (note.created_by && authors[note.created_by]) || "Unknown author";
                    const edited =
                      note.updated_at && note.updated_at !== note.created_at;
                    return (
                      <div
                        key={note.id}
                        className="rounded-md border bg-muted/30 p-3 space-y-2"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="text-xs text-muted-foreground">
                            <span className="font-medium text-foreground">{authorName}</span>
                            <span> • </span>
                            <span title={note.created_at}>{formatTimestamp(note.created_at)}</span>
                            {edited && (
                              <span className="italic"> (edited {formatTimestamp(note.updated_at)})</span>
                            )}
                          </div>
                          {!readOnly && !isEditing && (
                            <div className="flex items-center gap-1 shrink-0">
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2"
                                title="Edit note"
                                onClick={() => startEdit(note)}
                              >
                                <Pencil className="w-3.5 h-3.5" />
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2 text-destructive hover:text-destructive"
                                title="Delete note"
                                onClick={() => setDeleteTarget(note)}
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </Button>
                            </div>
                          )}
                        </div>
                        {isEditing ? (
                          <div className="space-y-2">
                            <Textarea
                              value={editBody}
                              onChange={(e) => setEditBody(e.target.value)}
                              rows={4}
                              className="resize-none"
                              disabled={savingEditId === note.id}
                            />
                            <div className="flex items-center justify-between gap-2">
                              <span className={`text-xs ${counterColor(editBody.length)}`}>
                                {formatNumber(editBody.length)} / {formatNumber(NOTE_MAX_LENGTH)}
                              </span>
                              <div className="flex items-center gap-1">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={cancelEdit}
                                  disabled={savingEditId === note.id}
                                >
                                  <X className="w-3.5 h-3.5 mr-1" />
                                  Cancel
                                </Button>
                                <Button
                                  size="sm"
                                  onClick={() => saveEdit(note)}
                                  disabled={
                                    savingEditId === note.id ||
                                    editBody.trim().length === 0 ||
                                    editBody.length > NOTE_MAX_LENGTH
                                  }
                                >
                                  {savingEditId === note.id ? (
                                    <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                                  ) : (
                                    <Save className="w-3.5 h-3.5 mr-1" />
                                  )}
                                  Save
                                </Button>
                              </div>
                            </div>
                          </div>
                        ) : (
                          <p className="text-sm text-foreground whitespace-pre-wrap break-words">
                            {note.body}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </ScrollArea>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this note?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the note. The action is recorded in the audit log.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                confirmDelete();
              }}
              disabled={deleting}
            >
              {deleting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
