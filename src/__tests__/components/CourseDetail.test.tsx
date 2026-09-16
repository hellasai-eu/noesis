/**
 * #1100 — CourseDetail: the instructor's materials drawer.
 *
 * Most of this file is layout, but three rules live nowhere else:
 *
 *  - the RECLASSIFICATION GATE (#1019). `blockedReclassificationReason` decides
 *    whether a material may move into a chapterless type; this component has to
 *    ask it BEFORE the update and abandon the write when it answers. A gate
 *    that is consulted after the write, or whose answer is only logged, strands
 *    chapters and their split PDFs with no UI left to manage them.
 *  - CHAPTERLESS materials have no expand control at all, so nothing ever
 *    queries chapters for them — the same #1019 rule, expressed in the tree.
 *  - the ADMIN SURFACE. Upload, delete, retype and OpenAI sync are admin-only;
 *    preview and download are not. Everything is rendered from one `isAdmin`
 *    prop, so a regression here quietly hands a viewer destructive controls.
 *
 * Also pinned: chapters are fetched once per material and re-read only when a
 * child edit forces it, because the expand toggle is on the hot path of a
 * drawer an instructor opens and closes repeatedly.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

type Filter = { op: string; col: string; val: unknown };

const db = vi.hoisted(() => ({
  materials: [] as Array<Record<string, unknown>>,
  chapters: [] as Array<Record<string, unknown>>,
  errors: {} as Record<string, { message: string } | undefined>,
  updateError: null as { message: string } | null,
  deleteError: null as { message: string } | null,
  storageRemoveError: null as { message: string } | null,
  invokeResult: { data: null, error: null } as {
    data: { openaiFileId?: string } | null;
    error: { message: string } | null;
  },
  updates: [] as Array<{ values: Record<string, unknown>; filters: Filter[] }>,
  deletes: [] as Array<{ filters: Filter[] }>,
  storageRemoved: [] as string[][],
  invocations: [] as Array<{ fn: string; body: unknown }>,
  queries: [] as Array<{ table: string; filters: Filter[]; order: Array<[string, unknown]> }>,
}));

vi.mock("@/integrations/supabase/client", () => {
  const buildChain = (table: string) => {
    const filters: Filter[] = [];
    const order: Array<[string, unknown]> = [];
    const chain: Record<string, unknown> = {};
    let mode: "select" | "update" | "delete" = "select";
    let values: Record<string, unknown> = {};

    chain.select = () => {
      mode = "select";
      return chain;
    };
    chain.update = (v: Record<string, unknown>) => {
      mode = "update";
      values = v;
      return chain;
    };
    chain.delete = () => {
      mode = "delete";
      return chain;
    };
    chain.order = (col: string, opts?: unknown) => {
      order.push([col, opts]);
      return chain;
    };
    chain.eq = (col: string, val: unknown) => {
      filters.push({ op: "eq", col, val });
      return chain;
    };
    chain.then = (resolve: (v: unknown) => unknown) => {
      if (mode === "update") {
        db.updates.push({ values, filters });
        return Promise.resolve(resolve({ data: null, error: db.updateError }));
      }
      if (mode === "delete") {
        db.deletes.push({ filters });
        return Promise.resolve(resolve({ data: null, error: db.deleteError }));
      }
      db.queries.push({ table, filters, order });
      const failure = db.errors[table];
      if (failure) return Promise.resolve(resolve({ data: null, error: failure }));
      if (table === "course_materials") {
        return Promise.resolve(resolve({ data: db.materials.map((m) => ({ ...m })), error: null }));
      }
      if (table === "material_chapters") {
        const mat = filters.find((f) => f.col === "material_id");
        const rows = db.chapters.filter((c) => !mat || c.material_id === mat.val);
        return Promise.resolve(resolve({ data: rows.map((c) => ({ ...c })), error: null }));
      }
      return Promise.resolve(resolve({ data: [], error: null }));
    };
    return chain;
  };

  return {
    supabase: {
      from: vi.fn((table: string) => buildChain(table)),
      functions: {
        invoke: vi.fn(async (fn: string, opts: { body: unknown }) => {
          db.invocations.push({ fn, body: opts.body });
          return db.invokeResult;
        }),
      },
      storage: {
        from: vi.fn(() => ({
          remove: vi.fn(async (paths: string[]) => {
            db.storageRemoved.push(paths);
            return { data: null, error: db.storageRemoveError };
          }),
          download: vi.fn(async () => ({ data: new Blob(["x"]), error: null })),
        })),
      },
    },
  };
});

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: toastMocks }));

const auth = vi.hoisted(() => ({ user: { id: "instructor-1" } }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => auth }));

/**
 * The gate itself has lib tests; what is under test here is whether this
 * component asks it, with what, and whether it obeys the answer.
 */
const blockedReason = vi.hoisted(() => ({
  fn: vi.fn(async () => null as string | null),
}));
vi.mock("@/lib/material-chapters", () => ({
  blockedReclassificationReason: (...args: unknown[]) =>
    (blockedReason.fn as unknown as (...a: unknown[]) => Promise<string | null>)(...args),
}));

// Keep the real type labels and the real chapterless list — the component's
// behaviour is defined against them — but stub the dialog itself.
vi.mock("@/components/MaterialUploadDialog", async () => {
  const actual = await vi.importActual<typeof import("@/components/MaterialUploadDialog")>(
    "@/components/MaterialUploadDialog",
  );
  return { ...actual, MaterialUploadDialog: () => <div data-testid="upload-dialog" /> };
});
vi.mock("@/components/ImageUploadDialog", () => ({
  ImageUploadDialog: () => <div data-testid="image-upload-dialog" />,
}));
vi.mock("@/components/ChapterStudyMaterialsManager", () => ({
  ChapterStudyMaterialsManager: ({ chapterId }: { chapterId: string }) => (
    <div data-testid={`study-materials-${chapterId}`} />
  ),
}));
vi.mock("@/components/EditableChapterTitle", () => ({
  EditableChapterTitle: ({ title }: { title: string }) => <span>{title}</span>,
}));

import { CourseDetail } from "@/components/CourseDetail";

const COURSE = {
  id: "course-1",
  title: "Algebra I",
  description: "Numbers and letters",
  theme: null,
  institution_id: "inst-1",
  language: "en",
};

function material(overrides: Record<string, unknown> = {}) {
  return {
    id: "mat-1",
    file_name: "algebra.pdf",
    file_url: "inst-1/algebra.pdf",
    file_size: 2 * 1024 * 1024,
    created_at: "2026-05-01T10:00:00.000Z",
    title: "Algebra Textbook",
    author: "A. Author",
    thumbnail_url: null,
    material_type: "textbook",
    openai_file_id: null,
    ai_description: null,
    is_moderated: false,
    ...overrides,
  };
}

function chapter(overrides: Record<string, unknown> = {}) {
  return {
    id: "ch-1",
    material_id: "mat-1",
    chapter_number: 1,
    title: "Fractions",
    content_type: "text",
    content: "body",
    file_url: null,
    file_name: null,
    cheat_sheet: null,
    flashcards: null,
    cheat_sheet_visible: true,
    flashcards_visible: true,
    ...overrides,
  };
}

async function renderDetail(props: { isAdmin?: boolean; open?: boolean } = {}) {
  const onOpenChange = vi.fn();
  render(
    <CourseDetail
      course={COURSE}
      open={props.open ?? true}
      onOpenChange={onOpenChange}
      isAdmin={props.isAdmin ?? true}
    />,
  );
  return { onOpenChange };
}

/** The row wrapper for a material, found via its displayed name. */
function materialRow(name: string) {
  const row = screen.getByText(name).closest(".rounded-xl");
  if (!row) throw new Error(`no material row for "${name}"`);
  return row as HTMLElement;
}

/**
 * The chevron toggle carries no label of its own, so it is identified by its
 * icon — excluding the material-type select, whose trigger is also a button
 * with a chevron in it.
 */
function expandToggle(name: string) {
  const row = materialRow(name);
  return (
    Array.from(row.querySelectorAll("button")).find(
      (b) =>
        b.getAttribute("role") !== "combobox" &&
        !b.hasAttribute("title") &&
        b.querySelector(".lucide-chevron-right, .lucide-chevron-down"),
    ) ?? null
  );
}

beforeAll(() => {
  if (!Element.prototype.hasPointerCapture) {
    (Element.prototype as unknown as { hasPointerCapture: () => boolean }).hasPointerCapture =
      () => false;
  }
  if (!Element.prototype.setPointerCapture) {
    (Element.prototype as unknown as { setPointerCapture: () => void }).setPointerCapture =
      () => {};
  }
  if (!Element.prototype.releasePointerCapture) {
    (
      Element.prototype as unknown as { releasePointerCapture: () => void }
    ).releasePointerCapture = () => {};
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("confirm", vi.fn(() => true));
  db.materials = [];
  db.chapters = [];
  db.errors = {};
  db.updateError = null;
  db.deleteError = null;
  db.storageRemoveError = null;
  db.invokeResult = { data: null, error: null };
  db.updates = [];
  db.deletes = [];
  db.storageRemoved = [];
  db.invocations = [];
  db.queries = [];
  blockedReason.fn.mockResolvedValue(null);
});

describe("CourseDetail — loading materials", () => {
  it("reads this course's materials newest first", async () => {
    db.materials = [material()];

    await renderDetail();

    expect(await screen.findByText("Algebra Textbook")).toBeInTheDocument();
    const query = db.queries.find((q) => q.table === "course_materials")!;
    expect(query.filters).toEqual([{ op: "eq", col: "course_id", val: COURSE.id }]);
    expect(query.order).toEqual([["created_at", { ascending: false }]]);
  });

  it("does not read anything while the drawer is closed", async () => {
    db.materials = [material()];

    await renderDetail({ open: false });

    await waitFor(() => expect(screen.queryByText("Algebra Textbook")).not.toBeInTheDocument());
    expect(db.queries).toHaveLength(0);
  });

  it("says so when a course has no materials", async () => {
    await renderDetail();

    expect(await screen.findByText("No materials uploaded yet")).toBeInTheDocument();
  });

  it("reports a failed read", async () => {
    db.errors.course_materials = { message: "denied" };

    await renderDetail();

    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith("Failed to load materials"),
    );
  });

  it("falls back to the file name when a material has no title", async () => {
    db.materials = [material({ title: null })];

    await renderDetail();

    expect(await screen.findByText("algebra.pdf")).toBeInTheDocument();
  });

  it("shows the file size in the largest unit that fits", async () => {
    db.materials = [
      material({ id: "m-b", title: "Tiny", file_size: 512 }),
      material({ id: "m-kb", title: "Small", file_size: 4096 }),
      material({ id: "m-mb", title: "Big", file_size: 3 * 1024 * 1024 }),
      material({ id: "m-none", title: "Unknown", file_size: null }),
    ];

    await renderDetail();

    await screen.findByText("Tiny");
    expect(within(materialRow("Tiny")).getByText(/512 B/)).toBeInTheDocument();
    expect(within(materialRow("Small")).getByText(/4\.0 KB/)).toBeInTheDocument();
    expect(within(materialRow("Big")).getByText(/3\.0 MB/)).toBeInTheDocument();
    expect(within(materialRow("Unknown")).getByText(/Unknown size/)).toBeInTheDocument();
  });
});

describe("CourseDetail — the reclassification gate", () => {
  async function retype(to: string) {
    const user = userEvent.setup();
    await screen.findByText("Algebra Textbook");
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: to }));
    return user;
  }

  it("abandons the write and explains why when the move would strand chapters", async () => {
    db.materials = [material()];
    blockedReason.fn.mockResolvedValue("This material has 4 chapters. …");

    await renderDetail();
    await retype("Other");

    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith("This material has 4 chapters. …"),
    );
    expect(db.updates).toHaveLength(0);
    // The control still shows the type the material actually has.
    expect(screen.getByRole("combobox")).toHaveTextContent("Textbook");
    expect(toastMocks.success).not.toHaveBeenCalled();
  });

  it("asks the gate about the move that is actually being made", async () => {
    db.materials = [material({ material_type: "teacher_companion" })];

    await renderDetail();
    await retype("Other");

    await waitFor(() => expect(blockedReason.fn).toHaveBeenCalled());
    expect(blockedReason.fn).toHaveBeenCalledWith("mat-1", "teacher_companion", "other");
  });

  it("writes the new type against that material once the gate clears it", async () => {
    db.materials = [material()];

    await renderDetail();
    await retype("Reference Exercises");

    await waitFor(() => expect(db.updates).toHaveLength(1));
    expect(db.updates[0]).toEqual({
      values: { material_type: "reference_exercises" },
      filters: [{ op: "eq", col: "id", val: "mat-1" }],
    });
    expect(toastMocks.success).toHaveBeenCalledWith("Material type updated");
    expect(screen.getByRole("combobox")).toHaveTextContent("Reference Exercises");
  });

  it("leaves the shown type alone when the write itself fails", async () => {
    db.materials = [material()];
    db.updateError = { message: "nope" };

    await renderDetail();
    await retype("Other");

    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith("Failed to update material type"),
    );
    expect(screen.getByRole("combobox")).toHaveTextContent("Textbook");
  });
});

describe("CourseDetail — chapters", () => {
  it("loads a material's chapters the first time it is expanded, and not again", async () => {
    db.materials = [material()];
    db.chapters = [chapter()];
    const user = userEvent.setup();

    await renderDetail();
    await screen.findByText("Algebra Textbook");

    await user.click(expandToggle("Algebra Textbook")!);
    expect(await screen.findByText("Fractions")).toBeInTheDocument();
    const reads = db.queries.filter((q) => q.table === "material_chapters").length;
    expect(reads).toBe(1);

    // Collapse and expand again: the already-loaded chapters are reused.
    await user.click(expandToggle("Algebra Textbook")!);
    await waitFor(() => expect(screen.queryByText("Fractions")).not.toBeInTheDocument());
    await user.click(expandToggle("Algebra Textbook")!);
    expect(await screen.findByText("Fractions")).toBeInTheDocument();
    expect(db.queries.filter((q) => q.table === "material_chapters")).toHaveLength(reads);
  });

  it("counts the chapters it loaded in the material's summary line", async () => {
    db.materials = [material()];
    db.chapters = [chapter({ id: "ch-1" }), chapter({ id: "ch-2", chapter_number: 2 })];
    const user = userEvent.setup();

    await renderDetail();
    await screen.findByText("Algebra Textbook");
    await user.click(expandToggle("Algebra Textbook")!);

    expect(await screen.findByText(/2 chapters/)).toBeInTheDocument();
  });

  it("points an instructor at the course page when a material has no chapters yet", async () => {
    db.materials = [material()];
    const user = userEvent.setup();

    await renderDetail();
    await screen.findByText("Algebra Textbook");
    await user.click(expandToggle("Algebra Textbook")!);

    expect(await screen.findByText("No chapters defined")).toBeInTheDocument();
  });

  it("gives a chapterless material no way to ask for chapters", async () => {
    db.materials = [
      material({ id: "m-img", title: "Diagrams", material_type: "images" }),
      material({ id: "m-other", title: "Syllabus", material_type: "other" }),
      material({ id: "m-book", title: "Algebra Textbook" }),
    ];

    await renderDetail();
    await screen.findByText("Diagrams");

    expect(expandToggle("Diagrams")).toBeNull();
    expect(expandToggle("Syllabus")).toBeNull();
    // The chaptered material still has one, so this is not a blanket absence.
    expect(expandToggle("Algebra Textbook")).not.toBeNull();
    expect(db.queries.some((q) => q.table === "material_chapters")).toBe(false);
  });

  it("offers per-chapter study materials only on a textbook, and only to an admin", async () => {
    db.materials = [
      material({ id: "mat-1", title: "Algebra Textbook", material_type: "textbook" }),
      material({ id: "mat-2", title: "Companion", material_type: "teacher_companion" }),
    ];
    db.chapters = [
      chapter({ id: "ch-1", material_id: "mat-1" }),
      chapter({ id: "ch-2", material_id: "mat-2", title: "Notes" }),
    ];
    const user = userEvent.setup();

    await renderDetail({ isAdmin: true });
    await screen.findByText("Algebra Textbook");
    await user.click(expandToggle("Algebra Textbook")!);
    await user.click(expandToggle("Companion")!);

    expect(await screen.findByTestId("study-materials-ch-1")).toBeInTheDocument();
    expect(screen.queryByTestId("study-materials-ch-2")).not.toBeInTheDocument();
  });

  it("hides study materials from a non-admin viewer", async () => {
    db.materials = [material()];
    db.chapters = [chapter()];
    const user = userEvent.setup();

    await renderDetail({ isAdmin: false });
    await screen.findByText("Algebra Textbook");
    await user.click(expandToggle("Algebra Textbook")!);

    expect(await screen.findByText("Fractions")).toBeInTheDocument();
    expect(screen.queryByTestId("study-materials-ch-1")).not.toBeInTheDocument();
  });
});

describe("CourseDetail — what a non-admin may do", () => {
  it("withholds every destructive and authoring control", async () => {
    db.materials = [material()];

    await renderDetail({ isAdmin: false });
    await screen.findByText("Algebra Textbook");

    expect(screen.queryByRole("button", { name: /Add PDF/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add Image/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sync to OpenAI" })).not.toBeInTheDocument();
    // The type is shown, but as a label rather than an editable control.
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(within(materialRow("Algebra Textbook")).getByText("Textbook")).toBeInTheDocument();
  });

  it("still lets them read the material", async () => {
    db.materials = [material()];

    await renderDetail({ isAdmin: false });
    await screen.findByText("Algebra Textbook");

    expect(screen.getByRole("button", { name: "Preview" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download" })).toBeInTheDocument();
  });

  it("gives an admin the full set", async () => {
    db.materials = [material()];

    await renderDetail({ isAdmin: true });
    await screen.findByText("Algebra Textbook");

    expect(screen.getByRole("button", { name: /Add PDF/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Add Image/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });
});

describe("CourseDetail — syncing to OpenAI", () => {
  it("sends the material's storage path and name, then marks it synced", async () => {
    db.materials = [material()];
    db.invokeResult = { data: { openaiFileId: "file-xyz" }, error: null };
    const user = userEvent.setup();

    await renderDetail();
    await screen.findByText("Algebra Textbook");
    await user.click(screen.getByRole("button", { name: "Sync to OpenAI" }));

    await waitFor(() => expect(db.invocations).toHaveLength(1));
    expect(db.invocations[0]).toEqual({
      fn: "upload-to-openai",
      body: { materialId: "mat-1", filePath: "inst-1/algebra.pdf", fileName: "algebra.pdf" },
    });
    expect(await screen.findByRole("button", { name: "Synced to OpenAI" })).toBeDisabled();
    expect(toastMocks.success).toHaveBeenCalledWith("Synced to OpenAI successfully");
  });

  it("offers no re-sync for a material that already has a file id", async () => {
    db.materials = [material({ openai_file_id: "file-existing" })];

    await renderDetail();
    await screen.findByText("Algebra Textbook");

    expect(screen.getByRole("button", { name: "Synced to OpenAI" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Sync to OpenAI" })).not.toBeInTheDocument();
  });

  it("leaves the material unsynced when the function fails", async () => {
    db.materials = [material()];
    db.invokeResult = { data: null, error: { message: "openai down" } };
    const user = userEvent.setup();

    await renderDetail();
    await screen.findByText("Algebra Textbook");
    await user.click(screen.getByRole("button", { name: "Sync to OpenAI" }));

    await waitFor(() => expect(toastMocks.error).toHaveBeenCalledWith("openai down"));
    expect(screen.getByRole("button", { name: "Sync to OpenAI" })).toBeInTheDocument();
  });
});

describe("CourseDetail — deleting a material", () => {
  it("asks first, and does nothing if the instructor says no", async () => {
    db.materials = [material()];
    vi.stubGlobal("confirm", vi.fn(() => false));
    const user = userEvent.setup();

    await renderDetail();
    await screen.findByText("Algebra Textbook");
    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(db.deletes).toHaveLength(0);
    expect(db.storageRemoved).toHaveLength(0);
    expect(screen.getByText("Algebra Textbook")).toBeInTheDocument();
  });

  it("removes the stored file and the row, then drops it from the list", async () => {
    db.materials = [material(), material({ id: "mat-2", title: "Companion" })];
    const user = userEvent.setup();

    await renderDetail();
    await screen.findByText("Algebra Textbook");
    await user.click(within(materialRow("Algebra Textbook")).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(db.deletes).toHaveLength(1));
    expect(db.storageRemoved).toEqual([["inst-1/algebra.pdf"]]);
    expect(db.deletes[0].filters).toEqual([{ op: "eq", col: "id", val: "mat-1" }]);
    await waitFor(() =>
      expect(screen.queryByText("Algebra Textbook")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Companion")).toBeInTheDocument();
    expect(toastMocks.success).toHaveBeenCalledWith("File deleted");
  });

  it("still deletes the row when the stored file cannot be removed", async () => {
    db.materials = [material()];
    db.storageRemoveError = { message: "storage offline" };
    const user = userEvent.setup();

    await renderDetail();
    await screen.findByText("Algebra Textbook");
    await user.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(db.deletes).toHaveLength(1));
    expect(toastMocks.success).toHaveBeenCalledWith("File deleted");
  });

  it("keeps the material listed when the row delete fails", async () => {
    db.materials = [material()];
    db.deleteError = { message: "delete denied" };
    const user = userEvent.setup();

    await renderDetail();
    await screen.findByText("Algebra Textbook");
    await user.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(toastMocks.error).toHaveBeenCalledWith("delete denied"));
    expect(screen.getByText("Algebra Textbook")).toBeInTheDocument();
  });
});
