import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useDateFnsLocale } from "@/i18n/formatters";
import { format } from "date-fns";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Download, FileText, Loader2, StickyNote } from "lucide-react";
import { toast } from "sonner";
import { formatNoteSize, noteFileExtension } from "./note-files";
import { openNoteFile } from "./open-note-file";
import { errorMessage } from "./error-message";

interface StudentNotesListProps {
  courseId: string;
}

interface StudentNote {
  id: string;
  title: string;
  description: string | null;
  file_path: string;
  file_name: string;
  file_size: number;
  created_at: string;
}

/**
 * The student-facing view of instructor notes. There is no offering filter
 * here on purpose: `course_notes` RLS already returns only notes targeted at a
 * section this student belongs to, so filtering client-side would only risk
 * disagreeing with the database.
 */
export function StudentNotesList({ courseId }: StudentNotesListProps) {
  const { t } = useTranslation("student");
  const dateFnsLocale = useDateFnsLocale();
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const { data: notes, isLoading } = useQuery({
    queryKey: ["student-course-notes", courseId],
    enabled: Boolean(courseId),
    queryFn: async (): Promise<StudentNote[]> => {
      const { data, error } = await supabase
        .from("course_notes")
        .select("id, title, description, file_path, file_name, file_size, created_at")
        .eq("course_id", courseId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const handleOpen = async (note: StudentNote) => {
    setDownloadingId(note.id);
    try {
      await openNoteFile(note.file_path);
    } catch (err: unknown) {
      toast.error(errorMessage(err, t("course.notes.openFailed")));
    } finally {
      setDownloadingId(null);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-10">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!notes || notes.length === 0) {
    return (
      <div className="py-12 text-center">
        <StickyNote className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
        <p className="text-sm text-muted-foreground">{t("course.notes.empty")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {notes.map((note) => (
        <Card key={note.id} data-testid={`student-note-${note.id}`}>
          <CardContent className="flex items-start gap-3 p-3 sm:p-4">
            <div className="flex-shrink-0 rounded-lg bg-muted p-2">
              <FileText className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-sm font-medium">{note.title}</h3>
              <p className="truncate text-xs text-muted-foreground">
                {noteFileExtension(note.file_name).toUpperCase()} ·{" "}
                {formatNoteSize(note.file_size)} ·{" "}
                {format(new Date(note.created_at), "PP", { locale: dateFnsLocale })}
              </p>
              {note.description && (
                <p className="mt-1 text-xs text-muted-foreground">{note.description}</p>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-8 flex-shrink-0 text-xs"
              disabled={downloadingId === note.id}
              onClick={() => handleOpen(note)}
            >
              {downloadingId === note.id ? (
                <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
              ) : (
                <Download className="w-3.5 h-3.5 mr-1.5" />
              )}
              {t("course.notes.download")}
            </Button>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
