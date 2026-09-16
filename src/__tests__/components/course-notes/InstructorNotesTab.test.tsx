/**
 * InstructorNotesTab — the write paths that can leave the bucket and the table
 * disagreeing.
 *
 * What is worth pinning:
 *
 *  - ORDER on create: the object is uploaded BEFORE the row, and if the row
 *    insert fails the object is removed again. Skipping that leaves an orphan
 *    in a private bucket that nothing will ever reference or clean up.
 *  - ORDER on replace: the OLD object is removed only AFTER the row points at
 *    the new one. Reversed, a failed update leaves a row pointing at a deleted
 *    file — a broken download for every targeted student.
 *  - ORDER on delete: the row goes first, for the same reason.
 *  - The DRAFT state. Zero targets means students see nothing, and the RLS
 *    policy enforces that, so the list has to say so out loud.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { InstructorNotesTab } from "@/components/course-notes/InstructorNotesTab";

const db = vi.hoisted(() => ({
  notes: [] as Record<string, unknown>[],
  calls: [] as string[],
  inserts: [] as Array<{ table: string; values: unknown }>,
  updates: [] as Array<{ table: string; values: unknown }>,
  deletes: [] as Array<{ table: string; filters: unknown[] }>,
  removed: [] as string[][],
  uploaded: [] as string[],
  noteSelects: 0,
  /** Fires immediately AFTER the component reads the row's current file_path. */
  onNoteRead: null as null | (() => void),
  insertError: null as { message: string } | null,
  targetInsertError: null as { message: string } | null,
  uploadError: null as { message: string } | null,
  removeError: null as { message: string } | null,
}));

vi.mock("@/integrations/supabase/client", () => {
  const buildChain = (table: string) => {
    const filters: unknown[] = [];
    let mode: "select" | "insert" | "update" | "delete" = "select";
    let values: unknown = null;

    const idFilter = () =>
      (filters.find((f) => (f as { col: string }).col === "id") as
        | { val: string }
        | undefined)?.val;

    /** The row the filters name, as the database would resolve it. */
    const target = () => db.notes.find((n) => n.id === idFilter());

    const result = () => {
      if (mode === "select") {
        if (table === "course_notes") db.noteSelects += 1;
        return { data: db.notes, error: null, count: db.notes.length };
      }
      if (mode === "insert") {
        if (db.insertError) return { data: null, error: db.insertError };
        if (table === "course_note_offerings" && db.targetInsertError) {
          return { data: null, error: db.targetInsertError };
        }
        db.calls.push(`db:insert:${table}`);
        db.inserts.push({ table, values });
        return { data: { id: "new-note" }, error: null };
      }
      if (mode === "update") {
        const row = target();
        const cas = filters.find(
          (f) => (f as { col: string }).col === "file_path",
        ) as { val: string } | undefined;
        // Compare-and-swap miss: the row moved on, so the update matches nothing.
        if (cas && row && row.file_path !== cas.val) {
          db.calls.push(`db:update-miss:${table}`);
          return { data: [], error: null };
        }
        db.calls.push(`db:update:${table}`);
        db.updates.push({ table, values });
        if (row) Object.assign(row, values as Record<string, unknown>);
        return { data: row ? [{ id: row.id }] : [], error: null };
      }
      db.calls.push(`db:delete:${table}`);
      db.deletes.push({ table, filters });
      return { data: null, error: null };
    };

    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.insert = (v: unknown) => {
      mode = "insert";
      values = v;
      return chain;
    };
    chain.update = (v: unknown) => {
      mode = "update";
      values = v;
      return chain;
    };
    chain.delete = () => {
      mode = "delete";
      return chain;
    };
    chain.eq = (col: string, val: unknown) => {
      filters.push({ col, val });
      return chain;
    };
    chain.in = (col: string, val: unknown) => {
      filters.push({ col, val });
      return chain;
    };
    chain.order = () => chain;
    chain.single = async () => {
      if (mode === "select") {
        if (table === "course_notes") db.noteSelects += 1;
        const row = target();
        const snapshot = row ? { ...row } : null;
        // The window a concurrent writer gets: the caller has its value, and
        // the row can now move under it before the update goes out.
        if (snapshot && db.onNoteRead) db.onNoteRead();
        return snapshot
          ? { data: snapshot, error: null }
          : { data: null, error: { message: "no rows" } };
      }
      return result();
    };
    chain.maybeSingle = async () => (chain.single as () => Promise<unknown>)();
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(resolve(result()));
    return chain;
  };

  return {
    supabase: {
      from: vi.fn((table: string) => buildChain(table)),
      storage: {
        from: vi.fn(() => ({
          upload: vi.fn(async (path: string) => {
            if (db.uploadError) return { data: null, error: db.uploadError };
            db.calls.push("storage:upload");
            db.uploaded.push(path);
            return { data: { path }, error: null };
          }),
          remove: vi.fn(async (paths: string[]) => {
            db.calls.push("storage:remove");
            db.removed.push(paths);
            if (db.removeError) return { data: null, error: db.removeError };
            return { data: null, error: null };
          }),
          createSignedUrl: vi.fn(async () => ({
            data: { signedUrl: "https://signed.test/note.pdf" },
            error: null,
          })),
        })),
      },
    },
  };
});

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "instructor-1" } }),
}));

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: toastMocks }));

const SECTIONS = [
  { id: "class-a", offeringId: "off-a", label: "Section A" },
  { id: "class-b", offeringId: "off-b", label: "Section B" },
];

function makeFile(name: string, size = 2048) {
  const file = new File(["x"], name, { type: "application/pdf" });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

function renderTab(sections = SECTIONS) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <InstructorNotesTab courseId="course-1" sections={sections} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  db.notes = [];
  db.calls = [];
  db.inserts = [];
  db.updates = [];
  db.deletes = [];
  db.removed = [];
  db.uploaded = [];
  db.noteSelects = 0;
  db.onNoteRead = null;
  db.insertError = null;
  db.targetInsertError = null;
  db.uploadError = null;
  db.removeError = null;
});

describe("InstructorNotesTab", () => {
  it("tells the instructor to assign a section before anything else", () => {
    renderTab([]);
    expect(
      screen.getByText(/Assign this course to a section to distribute notes/i),
    ).toBeInTheDocument();
  });

  it("shows the empty state when the course has no notes", async () => {
    renderTab();
    expect(await screen.findByText(/No notes yet/i)).toBeInTheDocument();
  });

  it("labels a note with no targets as a draft, and a targeted one by section", async () => {
    db.notes = [
      {
        id: "note-draft",
        title: "Draft note",
        description: null,
        file_path: "course-1/a-draft.pdf",
        file_name: "draft.pdf",
        file_size: 1024,
        created_at: "2026-08-01T00:00:00Z",
        course_note_offerings: [],
      },
      {
        id: "note-live",
        title: "Live note",
        description: "For everyone in A",
        file_path: "course-1/b-live.pdf",
        file_name: "live.pdf",
        file_size: 2048,
        created_at: "2026-08-02T00:00:00Z",
        course_note_offerings: [{ offering_id: "off-a" }],
      },
    ];
    renderTab();

    expect(await screen.findByText(/Draft — not visible to students/i)).toBeInTheDocument();
    expect(screen.getByText("Section A")).toBeInTheDocument();
    expect(screen.getByText(/live\.pdf · PDF · 2 KB/)).toBeInTheDocument();
  });

  it("uploads the file BEFORE inserting the row, then writes the targets", async () => {
    const user = userEvent.setup();
    renderTab();

    await user.click(await screen.findByRole("button", { name: /upload note/i }));
    await user.upload(screen.getByLabelText("File") as HTMLInputElement, makeFile("ch1.pdf"));
    await user.click(screen.getByLabelText("Distribute to section Section A"));
    await user.click(screen.getByRole("button", { name: /^upload note$/i }));

    await waitFor(() => expect(db.inserts).toHaveLength(2));

    expect(db.calls.slice(0, 3)).toEqual([
      "storage:upload",
      "db:insert:course_notes",
      "db:insert:course_note_offerings",
    ]);
    // The key is namespaced by course so the storage policy can authorise the
    // upload before any row exists to authorise against.
    // crypto.randomUUID is stubbed globally in vitest.setup.ts.
    expect(db.uploaded[0]).toBe("course-1/test-uuid-12345678-ch1.pdf");

    const row = db.inserts[0].values as Record<string, unknown>;
    expect(row).toMatchObject({
      course_id: "course-1",
      author_id: "instructor-1",
      title: "ch1",
      file_name: "ch1.pdf",
      mime_type: "application/pdf",
      file_size: 2048,
    });
    expect(row.file_path).toBe(db.uploaded[0]);

    expect(db.inserts[1].values).toEqual([
      { note_id: "new-note", offering_id: "off-a" },
    ]);
  });

  it("removes the just-uploaded object when the row insert fails", async () => {
    const user = userEvent.setup();
    db.insertError = { message: "row rejected" };
    renderTab();

    await user.click(await screen.findByRole("button", { name: /upload note/i }));
    await user.upload(screen.getByLabelText("File") as HTMLInputElement, makeFile("ch1.pdf"));
    await user.click(screen.getByRole("button", { name: /^upload note$/i }));

    await waitFor(() => expect(db.removed).toHaveLength(1));
    expect(db.removed[0]).toEqual([db.uploaded[0]]);
    expect(toastMocks.error).toHaveBeenCalledWith("row rejected");
  });

  it("keeps the new object when targeting fails after the row is written", async () => {
    // The rollback exists to avoid an orphan, and an orphan is the lesser evil:
    // once a row points at the object, deleting it turns a partial success into
    // a broken download for every targeted student.
    const user = userEvent.setup();
    db.targetInsertError = { message: 'targeting rejected' };
    renderTab();

    await user.click(await screen.findByRole("button", { name: /upload note/i }));
    await user.upload(screen.getByLabelText("File") as HTMLInputElement, makeFile("ch1.pdf"));
    await user.click(screen.getByLabelText("Distribute to section Section A"));
    await user.click(screen.getByRole("button", { name: /^upload note$/i }));

    await waitFor(() => expect(toastMocks.error).toHaveBeenCalledWith("targeting rejected"));
    // The note row survived and still points at its file.
    expect(db.inserts).toHaveLength(1);
    expect(db.removed).toHaveLength(0);
  });

  it("keeps the swapped-in file when targeting fails during an edit", async () => {
    const user = userEvent.setup();
    db.notes = [
      {
        id: "note-1",
        title: "Old title",
        description: null,
        file_path: "course-1/old-key.pdf",
        file_name: "old.pdf",
        file_size: 1024,
        created_at: "2026-08-01T00:00:00Z",
        course_note_offerings: [{ offering_id: "off-a" }],
      },
    ];
    db.targetInsertError = { message: 'targeting rejected' };
    renderTab();

    await user.click(await screen.findByRole("button", { name: /Edit Old title/i }));
    await user.upload(
      screen.getByLabelText(/Replace file/i) as HTMLInputElement,
      makeFile("new.pdf", 4096),
    );
    await user.click(screen.getByLabelText("Distribute to section Section B"));
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(toastMocks.error).toHaveBeenCalledWith("targeting rejected"));
    // The row already names the new object, so the rollback must not touch it —
    // that would break the row. The only thing removed is the file it
    // superseded, which nothing references any more.
    expect(db.updates[0].values).toMatchObject({ file_path: db.uploaded[0] });
    expect(db.removed).toEqual([["course-1/old-key.pdf"]]);
  });

  it("supersedes the live file, not the original, when a replacement is retried", async () => {
    // Targeting fails, the dialog stays open, the instructor tries again. The
    // second attempt must drop replacement A — the file the row actually names
    // by then — not the long-gone original, which would strand A in the bucket
    // once per failed attempt.
    const user = userEvent.setup();
    db.notes = [
      {
        id: "note-1",
        title: "Old title",
        description: null,
        file_path: "course-1/original.pdf",
        file_name: "old.pdf",
        file_size: 1024,
        created_at: "2026-08-01T00:00:00Z",
        course_note_offerings: [{ offering_id: "off-a" }],
      },
    ];
    db.targetInsertError = { message: "targeting rejected" };
    renderTab();

    await user.click(await screen.findByRole("button", { name: /Edit Old title/i }));
    await user.upload(
      screen.getByLabelText(/Replace file/i) as HTMLInputElement,
      makeFile("replacement-a.pdf"),
    );
    await user.click(screen.getByLabelText("Distribute to section Section B"));
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(db.removed).toHaveLength(1));
    expect(db.removed[0]).toEqual(["course-1/original.pdf"]);

    // Second attempt, still with the dialog open.
    db.targetInsertError = null;
    await user.upload(
      screen.getByLabelText(/Replace file/i) as HTMLInputElement,
      makeFile("replacement-b.pdf"),
    );
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(db.removed).toHaveLength(2));
    const replacementA = db.uploaded[0];
    expect(db.removed[1]).toEqual([replacementA]);
    // Nothing uploaded is left unreferenced: A was superseded, B is the row's.
    expect(db.uploaded).toHaveLength(2);
    expect(db.updates[1].values).toMatchObject({ file_path: db.uploaded[1] });
  });

  it("refetches after a failed submit, so a reopened editor sees the live file", async () => {
    // The dialog-local fix only covers a retry with the editor still open.
    // Close it and `openEdit` rebuilds `filePath` from the cached list — which
    // a partial success has made stale, since the row changed but the submit
    // threw. Without a refetch the next replacement supersedes the file the row
    // already stopped naming.
    const user = userEvent.setup();
    db.notes = [
      {
        id: "note-1",
        title: "Old title",
        description: null,
        file_path: "course-1/original.pdf",
        file_name: "old.pdf",
        file_size: 1024,
        created_at: "2026-08-01T00:00:00Z",
        course_note_offerings: [{ offering_id: "off-a" }],
      },
    ];
    db.targetInsertError = { message: "targeting rejected" };
    renderTab();

    await user.click(await screen.findByRole("button", { name: /Edit Old title/i }));
    await user.upload(
      screen.getByLabelText(/Replace file/i) as HTMLInputElement,
      makeFile("replacement-a.pdf"),
    );
    await user.click(screen.getByLabelText("Distribute to section Section B"));
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(toastMocks.error).toHaveBeenCalled());
    // The list was refetched even though the submit failed: the first read is
    // the initial mount, so anything beyond it is the invalidation landing.
    await waitFor(() => expect(db.noteSelects).toBeGreaterThan(1));
  });

  it("supersedes the row's file even when the editor's snapshot is stale", async () => {
    // The race the third review round found: the list is rendered, the row then
    // moves on (an earlier submit that failed after writing it), and the editor
    // is opened from the cache before any refetch lands. The snapshot names the
    // original; the row names replacement A. The delete target is read from the
    // row at submit time, so the snapshot being stale changes nothing.
    const user = userEvent.setup();
    db.notes = [
      {
        id: "note-1",
        title: "Old title",
        description: null,
        file_path: "course-1/original.pdf",
        file_name: "old.pdf",
        file_size: 1024,
        created_at: "2026-08-01T00:00:00Z",
        course_note_offerings: [{ offering_id: "off-a" }],
      },
    ];
    renderTab();
    // The list has rendered and cached `original.pdf`.
    const editButton = await screen.findByRole("button", { name: /Edit Old title/i });

    // The row moves on with no refetch: this is exactly the window the finding
    // describes, and the cached list item still carries the old path.
    db.notes[0].file_path = "course-1/replacement-a.pdf";

    await user.click(editButton);
    await user.upload(
      screen.getByLabelText(/Replace file/i) as HTMLInputElement,
      makeFile("replacement-b.pdf"),
    );
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(db.removed).toHaveLength(1));
    // Replacement A — what the row named — not the original the stale snapshot
    // was still carrying.
    expect(db.removed[0]).toEqual(["course-1/replacement-a.pdf"]);
    expect(db.notes[0].file_path).toBe(db.uploaded[0]);
  });

  it("refuses the swap, and strands nothing, when another manager replaced the file first", async () => {
    // Compare-and-swap: between the read and the update, someone else's
    // replacement lands. Deleting what we read would destroy the file their
    // row now names, so the update must match nothing instead — and our own
    // upload has to be rolled back, since no row ever referenced it.
    const user = userEvent.setup();
    db.notes = [
      {
        id: "note-1",
        title: "Old title",
        description: null,
        file_path: "course-1/original.pdf",
        file_name: "old.pdf",
        file_size: 1024,
        created_at: "2026-08-01T00:00:00Z",
        course_note_offerings: [{ offering_id: "off-a" }],
      },
    ];
    renderTab();

    await user.click(await screen.findByRole("button", { name: /Edit Old title/i }));
    await user.upload(
      screen.getByLabelText(/Replace file/i) as HTMLInputElement,
      makeFile("mine.pdf"),
    );

    // The other manager's write lands after our read of file_path but before
    // our update: the storage upload is the last thing to happen before it.
    db.onNoteRead = () => {
      db.notes[0].file_path = "course-1/theirs.pdf";
      db.onNoteRead = null;
    };
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(toastMocks.error).toHaveBeenCalled());
    expect(db.calls).toContain("db:update-miss:course_notes");
    // Their file is untouched; ours is rolled back rather than orphaned.
    expect(db.notes[0].file_path).toBe("course-1/theirs.pdf");
    expect(db.removed).toEqual([[db.uploaded[0]]]);
  });

  it("still reports success, but leaves a trace, when removing the old file fails", async () => {
    // The note is saved and correct by this point. Failing the submit would
    // tell the instructor their replacement did not happen when it did — so
    // the orphan is logged rather than escalated, matching handleDelete.
    const user = userEvent.setup();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    db.notes = [
      {
        id: "note-1",
        title: "Old title",
        description: null,
        file_path: "course-1/original.pdf",
        file_name: "old.pdf",
        file_size: 1024,
        created_at: "2026-08-01T00:00:00Z",
        course_note_offerings: [{ offering_id: "off-a" }],
      },
    ];
    db.removeError = { message: "storage unavailable" };
    renderTab();

    await user.click(await screen.findByRole("button", { name: /Edit Old title/i }));
    await user.upload(
      screen.getByLabelText(/Replace file/i) as HTMLInputElement,
      makeFile("new.pdf"),
    );
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(toastMocks.success).toHaveBeenCalledWith("Note updated"));
    expect(toastMocks.error).not.toHaveBeenCalled();
    // The row kept the new file — the failure is confined to the old object.
    expect(db.notes[0].file_path).toBe(db.uploaded[0]);
    expect(consoleError).toHaveBeenCalledWith(
      "[CourseNotes] Failed to remove superseded note file",
      "course-1/original.pdf",
      db.removeError,
    );
    consoleError.mockRestore();
  });

  it("replaces a file by updating the row first and only then dropping the old object", async () => {
    const user = userEvent.setup();
    db.notes = [
      {
        id: "note-1",
        title: "Old title",
        description: null,
        file_path: "course-1/old-key.pdf",
        file_name: "old.pdf",
        file_size: 1024,
        created_at: "2026-08-01T00:00:00Z",
        course_note_offerings: [{ offering_id: "off-a" }],
      },
    ];
    renderTab();

    await user.click(await screen.findByRole("button", { name: /Edit Old title/i }));
    await user.upload(
      screen.getByLabelText(/Replace file/i) as HTMLInputElement,
      makeFile("new.pdf", 4096),
    );
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(db.removed).toHaveLength(1));

    expect(db.calls).toEqual([
      "storage:upload",
      "db:update:course_notes",
      "storage:remove",
    ]);
    expect(db.updates[0].values).toMatchObject({
      file_path: db.uploaded[0],
      file_name: "new.pdf",
      file_size: 4096,
    });
    expect(db.removed[0]).toEqual(["course-1/old-key.pdf"]);
  });

  it("leaves the file alone on a metadata-only edit", async () => {
    const user = userEvent.setup();
    db.notes = [
      {
        id: "note-1",
        title: "Old title",
        description: null,
        file_path: "course-1/old-key.pdf",
        file_name: "old.pdf",
        file_size: 1024,
        created_at: "2026-08-01T00:00:00Z",
        course_note_offerings: [{ offering_id: "off-a" }],
      },
    ];
    renderTab();

    await user.click(await screen.findByRole("button", { name: /Edit Old title/i }));
    await user.clear(screen.getByLabelText("Title"));
    await user.type(screen.getByLabelText("Title"), "New title");
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(db.updates).toHaveLength(1));
    expect(db.uploaded).toHaveLength(0);
    expect(db.removed).toHaveLength(0);
    expect(db.updates[0].values).toEqual({ title: "New title", description: null });
  });

  it("untargets a section by deleting only the rows that were dropped", async () => {
    const user = userEvent.setup();
    db.notes = [
      {
        id: "note-1",
        title: "Old title",
        description: null,
        file_path: "course-1/old-key.pdf",
        file_name: "old.pdf",
        file_size: 1024,
        created_at: "2026-08-01T00:00:00Z",
        course_note_offerings: [{ offering_id: "off-a" }],
      },
    ];
    renderTab();

    await user.click(await screen.findByRole("button", { name: /Edit Old title/i }));
    await user.click(screen.getByLabelText("Distribute to section Section A"));
    await user.click(screen.getByLabelText("Distribute to section Section B"));
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(db.inserts).toHaveLength(1));
    // Removal first: a half-applied change must narrow the audience, not widen it.
    expect(db.calls).toEqual([
      "db:update:course_notes",
      "db:delete:course_note_offerings",
      "db:insert:course_note_offerings",
    ]);
    expect(db.deletes[0].filters).toEqual([
      { col: "note_id", val: "note-1" },
      { col: "offering_id", val: ["off-a"] },
    ]);
    expect(db.inserts[0].values).toEqual([
      { note_id: "note-1", offering_id: "off-b" },
    ]);
  });

  it("deletes the row before the object", async () => {
    const user = userEvent.setup();
    db.notes = [
      {
        id: "note-1",
        title: "Old title",
        description: null,
        file_path: "course-1/old-key.pdf",
        file_name: "old.pdf",
        file_size: 1024,
        created_at: "2026-08-01T00:00:00Z",
        course_note_offerings: [],
      },
    ];
    renderTab();

    await user.click(await screen.findByRole("button", { name: /Delete Old title/i }));
    await user.click(screen.getByRole("button", { name: /^Delete$/ }));

    await waitFor(() => expect(db.removed).toHaveLength(1));
    expect(db.calls).toEqual(["db:delete:course_notes", "storage:remove"]);
    expect(db.removed[0]).toEqual(["course-1/old-key.pdf"]);
  });
});
