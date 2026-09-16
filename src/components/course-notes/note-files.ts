/** Private bucket holding the note documents. Keys are `<courseId>/<uuid>-<name>`. */
export const COURSE_NOTES_BUCKET = "course-notes";

/**
 * The document types an instructor may distribute. Kept as extensions rather
 * than MIME types on purpose: browsers disagree wildly about the MIME type of
 * a .doc (`application/msword`, `application/octet-stream`, or empty), so the
 * extension is the only reliable signal — and it is what the `file_name` CHECK
 * on `course_notes` enforces server-side.
 */
export const ALLOWED_NOTE_EXTENSIONS = [
  "pdf",
  "doc",
  "docx",
  "odt",
  "rtf",
  "txt",
  "md",
] as const;

/** `accept` attribute for the file input. */
export const NOTE_FILE_ACCEPT = ALLOWED_NOTE_EXTENSIONS.map((e) => `.${e}`).join(",");

/** 25 MiB — the same ceiling the bucket and the `file_size` CHECK enforce. */
export const MAX_NOTE_BYTES = 25 * 1024 * 1024;

export function noteFileExtension(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot === -1 ? "" : fileName.slice(dot + 1).toLowerCase();
}

export function isAllowedNoteFile(fileName: string): boolean {
  return (ALLOWED_NOTE_EXTENSIONS as readonly string[]).includes(
    noteFileExtension(fileName),
  );
}

/**
 * Storage keys must be ASCII-safe. The stem and the extension are sanitised
 * separately and the extension is always kept: a wholly non-Latin name \u2014 Greek
 * is the common case here \u2014 sanitises down to nothing, and a key that ended up
 * as bare "pdf" would make the browser save an extensionless file. The
 * original name is preserved in `course_notes.file_name` for display.
 */
export function sanitizeNoteFileName(name: string): string {
  const dot = name.lastIndexOf(".");
  const rawStem = dot === -1 ? name : name.slice(0, dot);
  const ext = (dot === -1 ? "" : name.slice(dot + 1))
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 10);

  const stem =
    rawStem
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "") // drop diacritics before transliterating
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^[._-]+|[._-]+$/g, "")
      .slice(0, 100) || "note";

  return ext ? `${stem}.${ext}` : stem;
}

export function formatNoteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Validate a picked file. Returns an error message, or null when it is fine.
 * Callers translate/toast it; the strings are English to match the rest of the
 * instructor surface, and the student surface never uploads.
 */
export function validateNoteFile(file: File): string | null {
  if (!isAllowedNoteFile(file.name)) {
    return `Unsupported file type. Allowed: ${ALLOWED_NOTE_EXTENSIONS.join(", ")}.`;
  }
  if (file.size === 0) return "That file is empty.";
  if (file.size > MAX_NOTE_BYTES) {
    return `File is too large (${formatNoteSize(file.size)}). Maximum is ${formatNoteSize(MAX_NOTE_BYTES)}.`;
  }
  return null;
}
