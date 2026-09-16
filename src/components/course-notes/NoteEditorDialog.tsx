import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { FileText, Loader2, Upload, X } from "lucide-react";
import {
  ALLOWED_NOTE_EXTENSIONS,
  MAX_NOTE_BYTES,
  NOTE_FILE_ACCEPT,
  formatNoteSize,
  validateNoteFile,
} from "./note-files";

const noteSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(200, "Title is too long"),
  description: z.string().trim().max(5000, "Description is too long"),
});

export interface NoteSectionOption {
  offeringId: string;
  label: string;
}

export interface NoteEditorValues {
  title: string;
  description: string;
  offeringIds: string[];
  /** Null when editing and the instructor left the existing file in place. */
  file: File | null;
}

export interface NoteEditorInitialValues {
  title: string;
  description: string;
  offeringIds: string[];
  /** Shown so the instructor knows what they are about to replace. */
  fileName: string;
}

interface NoteEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Null for an upload, populated for an edit. */
  initialValues?: NoteEditorInitialValues | null;
  sections?: NoteSectionOption[];
  onSubmit: (values: NoteEditorValues) => Promise<void> | void;
  submitting?: boolean;
}

export function NoteEditorDialog({
  open,
  onOpenChange,
  initialValues,
  sections = [],
  onSubmit,
  submitting = false,
}: NoteEditorDialogProps) {
  const isEdit = Boolean(initialValues);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [offeringIds, setOfferingIds] = useState<Set<string>>(new Set());
  const [file, setFile] = useState<File | null>(null);
  const [errors, setErrors] = useState<{
    title?: string;
    description?: string;
    file?: string;
  }>({});

  useEffect(() => {
    if (!open) return;
    setTitle(initialValues?.title ?? "");
    setDescription(initialValues?.description ?? "");
    setOfferingIds(new Set(initialValues?.offeringIds ?? []));
    setFile(null);
    setErrors({});
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [open, initialValues]);

  const toggleOffering = (id: string, checked: boolean) => {
    setOfferingIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0] ?? null;
    if (!picked) {
      setFile(null);
      return;
    }
    const problem = validateNoteFile(picked);
    if (problem) {
      setErrors((prev) => ({ ...prev, file: problem }));
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    setErrors((prev) => ({ ...prev, file: undefined }));
    // Default the title to the file name the first time a file is picked, so
    // the common case is "pick file, press upload".
    setTitle((prev) => (prev.trim() ? prev : picked.name.replace(/\.[^.]+$/, "")));
    setFile(picked);
  };

  const clearFile = () => {
    setFile(null);
    setErrors((prev) => ({ ...prev, file: undefined }));
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = noteSchema.safeParse({ title, description });
    const fieldErrors = parsed.success ? {} : parsed.error.flatten().fieldErrors;
    const fileError = !isEdit && !file ? "Choose a file to upload" : undefined;
    if (!parsed.success || fileError) {
      setErrors({
        title: fieldErrors.title?.[0],
        description: fieldErrors.description?.[0],
        file: fileError,
      });
      return;
    }
    setErrors({});
    // Trimmed locals rather than `parsed.data`: this project compiles with
    // `strictNullChecks: false`, under which zod infers its output fields as
    // optional. Trimming is the schema's only transform.
    await onSubmit({
      title: title.trim(),
      description: description.trim(),
      offeringIds: Array.from(offeringIds),
      file,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit note" : "Upload note"}</DialogTitle>
          <DialogDescription>
            Share a document with your students. Allowed:{" "}
            {ALLOWED_NOTE_EXTENSIONS.join(", ")} — up to {formatNoteSize(MAX_NOTE_BYTES)}.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="note-file">
              {isEdit ? "Replace file (optional)" : "File"}
            </Label>
            {isEdit && !file && (
              <p className="text-xs text-muted-foreground">
                Currently: <span className="font-medium">{initialValues?.fileName}</span>
              </p>
            )}
            <div className="flex items-center gap-2">
              <Input
                id="note-file"
                ref={fileInputRef}
                type="file"
                accept={NOTE_FILE_ACCEPT}
                onChange={handleFileChange}
                disabled={submitting}
              />
              {file && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={clearFile}
                  disabled={submitting}
                  aria-label="Clear selected file"
                >
                  <X className="w-4 h-4" />
                </Button>
              )}
            </div>
            {file && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <FileText className="w-3.5 h-3.5" />
                {file.name} · {formatNoteSize(file.size)}
              </p>
            )}
            {errors.file && <p className="text-xs text-destructive">{errors.file}</p>}
          </div>

          <div className="space-y-2">
            <Label htmlFor="note-title">Title</Label>
            <Input
              id="note-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Chapter 3 — lecture notes"
              maxLength={200}
              disabled={submitting}
            />
            {errors.title && <p className="text-xs text-destructive">{errors.title}</p>}
          </div>

          <div className="space-y-2">
            <Label htmlFor="note-description">Description (optional)</Label>
            <Textarea
              id="note-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What is in this document, and what should students do with it?"
              rows={4}
              disabled={submitting}
            />
            {errors.description && (
              <p className="text-xs text-destructive">{errors.description}</p>
            )}
          </div>

          {sections.length > 0 && (
            <div className="space-y-2">
              <Label>Distribute to sections</Label>
              <p className="text-xs text-muted-foreground">
                Leave all unchecked to keep the note to yourself (saves as a draft).
              </p>
              <div className="grid sm:grid-cols-2 gap-2 pt-1">
                {sections.map((s) => (
                  <label
                    key={s.offeringId}
                    className="flex items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm cursor-pointer"
                  >
                    <Checkbox
                      checked={offeringIds.has(s.offeringId)}
                      onCheckedChange={(v) => toggleOffering(s.offeringId, Boolean(v))}
                      disabled={submitting}
                      aria-label={`Distribute to section ${s.label}`}
                    />
                    <span className="truncate">{s.label}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Upload className="w-4 h-4 mr-2" />
              )}
              {isEdit ? "Save changes" : "Upload note"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
