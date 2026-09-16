import { describe, it, expect } from "vitest";
import {
  MAX_NOTE_BYTES,
  NOTE_FILE_ACCEPT,
  formatNoteSize,
  isAllowedNoteFile,
  noteFileExtension,
  sanitizeNoteFileName,
  validateNoteFile,
} from "@/components/course-notes/note-files";

describe("note-files", () => {
  it("accepts the document types instructors distribute", () => {
    for (const name of ["a.pdf", "a.doc", "a.docx", "a.txt", "a.md", "a.rtf", "a.odt"]) {
      expect(isAllowedNoteFile(name)).toBe(true);
    }
  });

  it("rejects everything else, case-insensitively and on the LAST extension", () => {
    expect(isAllowedNoteFile("a.exe")).toBe(false);
    expect(isAllowedNoteFile("a.png")).toBe(false);
    expect(isAllowedNoteFile("noextension")).toBe(false);
    // The dangerous shape: a permitted extension that is not the final one.
    expect(isAllowedNoteFile("report.pdf.exe")).toBe(false);
    expect(isAllowedNoteFile("REPORT.PDF")).toBe(true);
  });

  it("advertises every allowed extension in the input's accept attribute", () => {
    expect(NOTE_FILE_ACCEPT.split(",")).toContain(".pdf");
    expect(NOTE_FILE_ACCEPT.split(",")).toContain(".docx");
    expect(NOTE_FILE_ACCEPT).not.toContain(".exe");
  });

  it("reads the extension off the last dot", () => {
    expect(noteFileExtension("a.b.PDF")).toBe("pdf");
    expect(noteFileExtension("plain")).toBe("");
  });

  describe("sanitizeNoteFileName", () => {
    it("keeps a plain ASCII name intact", () => {
      expect(sanitizeNoteFileName("chapter-3_notes.pdf")).toBe("chapter-3_notes.pdf");
    });

    it("transliterates accents rather than blanking them", () => {
      // Greek is the common case; accents are stripped, letters still become
      // underscores, but the extension survives so the key stays meaningful.
      expect(sanitizeNoteFileName("café.pdf")).toBe("cafe.pdf");
    });

    it("replaces characters that are unsafe in a storage key", () => {
      expect(sanitizeNoteFileName("a b/c?.txt")).toBe("a_b_c.txt");
    });

    it("keeps the extension even when the stem sanitises away entirely", () => {
      // A key of bare "pdf" would make the browser save an extensionless file.
      expect(sanitizeNoteFileName("Σημειώσεις.pdf")).toBe("note.pdf");
      expect(sanitizeNoteFileName("....pdf")).toBe("note.pdf");
    });

    it("never returns an empty key", () => {
      expect(sanitizeNoteFileName("...")).toBe("note");
      expect(sanitizeNoteFileName("Σημειώσεις")).toBe("note");
    });

    it("bounds the key length", () => {
      expect(sanitizeNoteFileName("x".repeat(500) + ".pdf")).toBe(
        "x".repeat(100) + ".pdf",
      );
    });
  });

  describe("validateNoteFile", () => {
    const makeFile = (name: string, size: number) => {
      const file = new File(["x"], name, { type: "application/pdf" });
      Object.defineProperty(file, "size", { value: size });
      return file;
    };

    it("passes a reasonable PDF", () => {
      expect(validateNoteFile(makeFile("notes.pdf", 1024))).toBeNull();
    });

    it("rejects a disallowed type", () => {
      expect(validateNoteFile(makeFile("notes.exe", 1024))).toMatch(/Unsupported file type/);
    });

    it("rejects an empty file", () => {
      expect(validateNoteFile(makeFile("notes.pdf", 0))).toMatch(/empty/);
    });

    it("rejects a file over the bucket limit", () => {
      expect(validateNoteFile(makeFile("notes.pdf", MAX_NOTE_BYTES + 1))).toMatch(
        /too large/,
      );
    });

    it("accepts a file exactly at the limit", () => {
      expect(validateNoteFile(makeFile("notes.pdf", MAX_NOTE_BYTES))).toBeNull();
    });
  });

  it("formats sizes at each unit boundary", () => {
    expect(formatNoteSize(512)).toBe("512 B");
    expect(formatNoteSize(2048)).toBe("2 KB");
    expect(formatNoteSize(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
