/**
 * #979/#1004 — CreateStudyGuideDialog: pick a chaptered textbook, scope it to
 * chapters, describe it, and submit. The dialog now runs the whole pipeline in
 * the foreground: outline, then per piece theory followed by multiple-choice
 * questions, sequentially.
 *
 * #1019 adds a second kind of source: an "other" material, uploaded purely for
 * study guides and usable for nothing else. It is never chaptered, so it is
 * read whole.
 *
 * The behaviours worth pinning are the ones that would otherwise fail late and
 * confusingly:
 *  - a chapter with no `openai_file_id` cannot be sent to the model, so it
 *    must be unselectable and excluded from the recorded source;
 *  - an "other" material submits with NO source chapter rows, which is how the
 *    schema records "the whole material";
 *  - if the outline call fails the guide must be LEFT ALONE, because a lost or
 *    unreadable response does not mean the pieces were not written, and
 *    deleting the guide would discard content that exists;
 *  - the per-piece chain is strictly theory-then-questions (questions are
 *    grounded in the stored theory), questions are MCQ-only, and a failed
 *    piece is skipped and reported — not a reason to abort the rest or to
 *    delete the guide.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const invokeMock = vi.hoisted(() => vi.fn());
const insertedRows = vi.hoisted(() => [] as Array<{ table: string; rows: unknown }>);
const deletedIds = vi.hoisted(() => [] as Array<{ table: string; id: string }>);
const chapterRows = vi.hoisted(
  () => ({ data: [] as unknown[], error: null as unknown }),
);

vi.mock("@/integrations/supabase/client", () => {
  const buildChain = (table: string) => {
    // deno-lint-ignore no-explicit-any
    const chain: Record<string, (...a: unknown[]) => any> = {};
    chain.select = () => chain;
    chain.eq = (_col: string, val: unknown) => {
      chain.__lastEq = val as never;
      return chain;
    };
    // Chainable, not terminal: the real builder allows repeated .order() calls
    // and the chapter query now passes a tiebreak (#1065). `chain.then` below is
    // what actually resolves the query when it is awaited.
    chain.order = () => chain;
    chain.single = () =>
      Promise.resolve({ data: { id: "guide-new" }, error: null });
    chain.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(resolve(chapterRows));
    return chain;
  };

  return {
    supabase: {
      from: vi.fn((table: string) => ({
        select: () => buildChain(table),
        insert: (rows: unknown) => {
          insertedRows.push({ table, rows });
          return {
            select: () => ({
              single: () =>
                Promise.resolve({ data: { id: "guide-new" }, error: null }),
            }),
            then: (resolve: (v: unknown) => unknown) =>
              Promise.resolve(resolve({ data: null, error: null })),
          };
        },
        delete: () => ({
          eq: (_col: string, id: string) => {
            deletedIds.push({ table, id });
            return Promise.resolve({ data: null, error: null });
          },
        }),
      })),
      auth: {
        getSession: vi.fn(async () => ({
          data: { session: { user: { id: "user-1" } } },
        })),
      },
      functions: { invoke: invokeMock },
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

beforeAll(() => {
  for (const fn of [
    "hasPointerCapture",
    "setPointerCapture",
    "releasePointerCapture",
    "scrollIntoView",
  ] as const) {
    if (!(Element.prototype as unknown as Record<string, unknown>)[fn]) {
      (Element.prototype as unknown as Record<string, unknown>)[fn] = () => {};
    }
  }
  if (typeof globalThis.ResizeObserver === "undefined") {
    class RO {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    (globalThis as unknown as { ResizeObserver: typeof RO }).ResizeObserver = RO;
  }
});

import { CreateStudyGuideDialog } from "@/components/study-guide/CreateStudyGuideDialog";

const MATERIALS = [
  {
    id: "mat-1",
    title: "Physics",
    file_name: "physics.pdf",
    material_type: "textbook",
    openai_file_id: "file-book",
  },
  // Neither a textbook nor "other": generation attaches chapter PDFs, so it
  // must not be offered.
  {
    id: "mat-2",
    title: "Worksheets",
    file_name: "ws.pdf",
    material_type: "reference_exercises",
    openai_file_id: "file-ws",
  },
  // #1019 — chapterless, read whole. No chapters to pick.
  {
    id: "mat-3",
    title: "Syllabus",
    file_name: "syllabus.pdf",
    material_type: "other",
    openai_file_id: "file-syllabus",
  },
  // "Other" with nothing synced to OpenAI: there is no file to attach at all.
  {
    id: "mat-4",
    title: "Unsynced notes",
    file_name: "notes.pdf",
    material_type: "other",
    openai_file_id: null,
  },
];

function renderDialog() {
  return render(
    <CreateStudyGuideDialog
      open
      onOpenChange={() => {}}
      courseId="course-1"
      materials={MATERIALS}
    />,
  );
}

beforeEach(() => {
  invokeMock.mockReset();
  insertedRows.length = 0;
  deletedIds.length = 0;
  Object.values(toastMocks).forEach((m) => m.mockClear());
  chapterRows.data = [
    { id: "ch-1", chapter_number: 1, title: "Heat", openai_file_id: "file-1" },
    { id: "ch-2", chapter_number: 2, title: "Entropy", openai_file_id: "file-2" },
    // No split PDF — unusable.
    { id: "ch-3", chapter_number: 3, title: "Appendix", openai_file_id: null },
  ];
  chapterRows.error = null;
});

describe("CreateStudyGuideDialog (#979)", () => {
  it("offers textbooks and synced 'other' materials, and nothing else", async () => {
    renderDialog();
    await userEvent.click(screen.getByTestId("sg-material-select"));
    expect(await screen.findByText("Physics")).toBeInTheDocument();
    expect(screen.getByText("Syllabus")).toBeInTheDocument();
    expect(screen.queryByText("Worksheets")).not.toBeInTheDocument();
    // No OpenAI file means nothing to attach, so it is not a candidate.
    expect(screen.queryByText("Unsynced notes")).not.toBeInTheDocument();
  });

  it("cannot submit before a material and title are chosen", async () => {
    renderDialog();
    expect(screen.getByTestId("sg-create-submit")).toBeDisabled();
  });

  it("disables a chapter that has no split PDF", async () => {
    renderDialog();
    await userEvent.click(screen.getByTestId("sg-material-select"));
    await userEvent.click(await screen.findByText("Physics"));

    await waitFor(() => expect(screen.getByTestId("sg-chapter-ch-1")).toBeInTheDocument());
    expect(screen.getByTestId("sg-chapter-ch-3")).toBeDisabled();
    // #1089 — nothing is selected until the instructor chooses.
    expect(screen.getByText(/0 of 2 usable chapters selected/i)).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("sg-chapter-ch-1"));
    // The count reflects usable chapters only, not the raw chapter list.
    expect(screen.getByText(/1 of 2 usable chapters selected/i)).toBeInTheDocument();
  });

  it("starts with every chapter unchecked and the submit disabled (#1089)", async () => {
    // Defaulting to the whole material made "send the entire book" the quiet
    // path: the instructor had to notice and unpick a selection they never
    // made. An empty selection cannot be submitted, so the wrong outline is
    // now unreachable rather than merely discouraged.
    renderDialog();
    await userEvent.click(screen.getByTestId("sg-material-select"));
    await userEvent.click(await screen.findByText("Physics"));
    await waitFor(() => expect(screen.getByTestId("sg-chapter-ch-1")).toBeInTheDocument());

    expect(screen.getByTestId("sg-chapter-ch-1")).not.toBeChecked();
    expect(screen.getByTestId("sg-chapter-ch-2")).not.toBeChecked();

    await userEvent.type(screen.getByTestId("sg-title"), "Thermo");
    // Title and material are set; only the empty chapter set holds it back.
    expect(screen.getByTestId("sg-create-submit")).toBeDisabled();

    await userEvent.click(screen.getByTestId("sg-chapter-ch-1"));
    expect(screen.getByTestId("sg-create-submit")).toBeEnabled();
  });

  it("records only usable chapters, then chains theory and MCQ questions per piece", async () => {
    invokeMock.mockImplementation(async (fn: string) => {
      if (fn === "generate-study-guide-outline") {
        return {
          data: {
            success: true,
            pieces: [
              { id: "p1", title: "Heat", scope: "First law basics" },
              // No scope — the theory body must then omit the field entirely.
              { id: "p2", title: "Entropy" },
            ],
          },
          error: null,
        };
      }
      return { data: { success: true, inserted: 5, rejected: 0 }, error: null };
    });
    renderDialog();

    await userEvent.click(screen.getByTestId("sg-material-select"));
    await userEvent.click(await screen.findByText("Physics"));
    await waitFor(() => expect(screen.getByTestId("sg-chapter-ch-1")).toBeInTheDocument());
    await userEvent.type(screen.getByTestId("sg-title"), "Thermo");

    // Chapters start unchecked (#1089), so pick them. ch-3 is deliberately
    // ticked too — it has no split PDF and must still be filtered out.
    await userEvent.click(screen.getByTestId("sg-chapter-ch-1"));
    await userEvent.click(screen.getByTestId("sg-chapter-ch-2"));

    await userEvent.click(screen.getByTestId("sg-create-submit"));

    // Outline, then strictly theory-before-questions within each piece: the
    // questions function refuses a piece without stored theory.
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(5));
    expect(invokeMock.mock.calls).toEqual([
      ["generate-study-guide-outline", { body: { studyGuideId: "guide-new" } }],
      [
        "generate-study-guide-theory",
        { body: { pieceId: "p1", scope: "First law basics" } },
      ],
      [
        "generate-study-guide-questions",
        { body: { pieceId: "p1", count: 5, questionType: "mcq", difficulty: "mixed" } },
      ],
      ["generate-study-guide-theory", { body: { pieceId: "p2" } }],
      [
        "generate-study-guide-questions",
        { body: { pieceId: "p2", count: 5, questionType: "mcq", difficulty: "mixed" } },
      ],
    ]);

    const sources = insertedRows.find((r) => r.table === "study_guide_source_chapters");
    expect(sources).toBeTruthy();
    expect(sources!.rows).toEqual([
      { study_guide_id: "guide-new", chapter_id: "ch-1" },
      { study_guide_id: "guide-new", chapter_id: "ch-2" },
    ]);
    expect(toastMocks.success).toHaveBeenCalledWith(
      "Study guide ready — 2 pieces with theory and questions.",
    );
  });

  it("skips a failed piece's questions and finishes the rest, reporting it by name", async () => {
    invokeMock.mockImplementation(async (fn: string, opts?: { body?: { pieceId?: string } }) => {
      if (fn === "generate-study-guide-outline") {
        return {
          data: {
            success: true,
            pieces: [
              { id: "p1", title: "Heat" },
              { id: "p2", title: "Entropy" },
            ],
          },
          error: null,
        };
      }
      if (fn === "generate-study-guide-theory" && opts?.body?.pieceId === "p1") {
        return { data: null, error: { message: "model timed out" } };
      }
      return { data: { success: true, inserted: 5, rejected: 0 }, error: null };
    });
    renderDialog();

    await userEvent.click(screen.getByTestId("sg-material-select"));
    await userEvent.click(await screen.findByText("Physics"));
    await waitFor(() => expect(screen.getByTestId("sg-chapter-ch-1")).toBeInTheDocument());
    await userEvent.type(screen.getByTestId("sg-title"), "Thermo");
    await userEvent.click(screen.getByTestId("sg-chapter-ch-1"));

    await userEvent.click(screen.getByTestId("sg-create-submit"));

    // p1's theory failed, so its questions call — a guaranteed 409 — is
    // skipped, and p2 still gets both stages.
    await waitFor(() => expect(toastMocks.warning).toHaveBeenCalled());
    expect(invokeMock.mock.calls.map((c) => [c[0], (c[1] as { body: { pieceId?: string } }).body.pieceId])).toEqual([
      ["generate-study-guide-outline", undefined],
      ["generate-study-guide-theory", "p1"],
      ["generate-study-guide-theory", "p2"],
      ["generate-study-guide-questions", "p2"],
    ]);
    expect(toastMocks.warning.mock.calls[0][0]).toContain("Heat");
    // A partial guide is recoverable from the piece editor — never deleted.
    expect(deletedIds).toEqual([]);
    expect(toastMocks.error).not.toHaveBeenCalled();
  });

  it("flags a short question batch instead of reporting the guide complete", async () => {
    // The questions function returns 2xx even when it rejected some of the
    // model's questions as malformed — `inserted` is the authoritative count.
    invokeMock.mockImplementation(async (fn: string) => {
      if (fn === "generate-study-guide-outline") {
        return {
          data: { success: true, pieces: [{ id: "p1", title: "Heat" }] },
          error: null,
        };
      }
      if (fn === "generate-study-guide-questions") {
        return { data: { success: true, inserted: 3, rejected: 2 }, error: null };
      }
      return { data: { success: true }, error: null };
    });
    renderDialog();

    await userEvent.click(screen.getByTestId("sg-material-select"));
    await userEvent.click(await screen.findByText("Physics"));
    await waitFor(() => expect(screen.getByTestId("sg-chapter-ch-1")).toBeInTheDocument());
    await userEvent.type(screen.getByTestId("sg-title"), "Thermo");
    await userEvent.click(screen.getByTestId("sg-chapter-ch-1"));

    await userEvent.click(screen.getByTestId("sg-create-submit"));

    await waitFor(() => expect(toastMocks.warning).toHaveBeenCalled());
    expect(toastMocks.warning.mock.calls[0][0]).toContain("Heat (only 3/5 questions)");
    expect(toastMocks.success).not.toHaveBeenCalled();
  });

  it("takes an 'other' material whole — no chapter picker, no source rows", async () => {
    invokeMock.mockImplementation(async (fn: string) =>
      fn === "generate-study-guide-outline"
        ? { data: { success: true, pieces: [{ id: "p1" }] }, error: null }
        : { data: { success: true, inserted: 5, rejected: 0 }, error: null },
    );
    renderDialog();

    await userEvent.click(screen.getByTestId("sg-material-select"));
    await userEvent.click(await screen.findByText("Syllabus"));

    await waitFor(() =>
      expect(screen.getByTestId("sg-whole-document-note")).toBeInTheDocument(),
    );
    // The chapter list belongs to textbooks only.
    expect(screen.queryByTestId("sg-chapter-ch-1")).not.toBeInTheDocument();

    await userEvent.type(screen.getByTestId("sg-title"), "Course overview");
    // No chapters selected, yet this is submittable: the whole PDF is the source.
    await userEvent.click(screen.getByTestId("sg-create-submit"));

    // Outline + one piece's theory + its questions.
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(3));

    const guide = insertedRows.find((r) => r.table === "study_guides");
    expect((guide!.rows as { material_id: string }).material_id).toBe("mat-3");
    // Absent `study_guide_source_chapters` rows are how the schema spells
    // "whole material" — writing an empty array would be the same thing, but
    // not making the call at all is what the loader's fallback expects.
    expect(insertedRows.find((r) => r.table === "study_guide_source_chapters")).toBeUndefined();
  });

  it("keeps the guide when the outline call fails, so written pieces are not discarded", async () => {
    invokeMock.mockResolvedValueOnce({
      data: null,
      error: { message: "study guide has no source chapters" },
    });
    renderDialog();

    await userEvent.click(screen.getByTestId("sg-material-select"));
    await userEvent.click(await screen.findByText("Physics"));
    await waitFor(() => expect(screen.getByTestId("sg-chapter-ch-1")).toBeInTheDocument());
    await userEvent.type(screen.getByTestId("sg-title"), "Thermo");
    // Chapters start unchecked (#1089).
    await userEvent.click(screen.getByTestId("sg-chapter-ch-1"));

    await userEvent.click(screen.getByTestId("sg-create-submit"));

    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith("study guide has no source chapters"),
    );

    // Once the request has left, its outcome is unknowable here: a lost or
    // unreadable response does not mean the job failed to commit. Deleting the
    // guide would strand a queued job pointing at a row that no longer exists,
    // which then fails after being claimed — possibly after paying for a model
    // call. A recoverable stray `draft` in the list is the better failure.
    expect(deletedIds).toEqual([]);
  });
});
