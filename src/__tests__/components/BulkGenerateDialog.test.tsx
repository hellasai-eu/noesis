/**
 * #698 — BulkGenerateDialog: type/scope/count config + estimate, then a
 * POST to the `enqueue-bulk-generation` edge function. The dialog must
 * NOT touch the `jobs` table from the browser (no INSERT RLS); it relies
 * entirely on the function.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const invokeMock = vi.hoisted(() => vi.fn());

const tableResponses = vi.hoisted(
  () =>
    ({
      material_chapters: { data: [], error: null },
    }) as Record<string, { data: unknown; error: unknown }>,
);

vi.mock("@/integrations/supabase/client", () => {
  const buildChain = (table: string) => {
    const chain: Record<string, (...a: unknown[]) => unknown> = {};
    const passThrough = () => chain;
    chain.select = passThrough;
    chain.eq = passThrough;
    // #1019 — the chapter query excludes chapterless "Other" materials.
    chain.neq = passThrough;
    // Chainable, not terminal: the real builder allows repeated .order() calls
    // and the chapter query now passes a tiebreak (#1065). `chain.then` below is
    // what actually resolves the query when it is awaited.
    chain.order = passThrough;
    chain.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(
        resolve(tableResponses[table] ?? { data: [], error: null }),
      );
    return chain;
  };

  return {
    supabase: {
      from: vi.fn((t: string) => buildChain(t)),
      auth: {
        getSession: vi.fn(async () => ({
          data: { session: { access_token: "tok" } },
        })),
        getUser: vi.fn(async () => ({ data: { user: { id: "user-1" } } })),
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

// jsdom shims for Radix.
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

import { BulkGenerateDialog } from "@/components/BulkGenerateDialog";

beforeEach(() => {
  invokeMock.mockReset();
  toastMocks.success.mockClear();
  toastMocks.error.mockClear();
  toastMocks.warning.mockClear();
  tableResponses.material_chapters = {
    data: [
      {
        id: "ch-1",
        title: "Mitosis",
        material_id: "mat-1",
        course_materials: { title: "Biology", file_name: "bio.pdf" },
      },
      {
        id: "ch-2",
        title: "Meiosis",
        material_id: "mat-1",
        course_materials: { title: "Biology", file_name: "bio.pdf" },
      },
    ],
    error: null,
  };
});

describe("BulkGenerateDialog (#698)", () => {
  it("posts to enqueue-bulk-generation with the configured params on Start", async () => {
    invokeMock.mockResolvedValueOnce({
      data: { jobId: "job-123", itemCount: 4 },
      error: null,
    });

    const onOpenChange = vi.fn();
    const onEnqueued = vi.fn();
    render(
      <BulkGenerateDialog
        open
        onOpenChange={onOpenChange}
        courseId="course-1"
        onEnqueued={onEnqueued}
      />,
    );

    // Wait for chapters to load.
    await screen.findByText(/Mitosis/i);

    // The draft checkbox defaults to unchecked, so questions are visible.
    expect(
      screen.getByTestId("bulk-start-hidden").getAttribute("data-state"),
    ).toBe("unchecked");

    // Defaults: mcq + open selected, all chapters, count=3, mixed, off, visible.
    await userEvent.setup().click(screen.getByTestId("bulk-start"));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "enqueue-bulk-generation",
        expect.objectContaining({
          body: expect.objectContaining({
            courseId: "course-1",
            types: ["mcq", "open"],
            chapterIds: ["ch-1", "ch-2"],
            countPerType: 3,
            difficulty: undefined,
            startHidden: false,
            diagramMode: "off",
          }),
        }),
      );
    });

    expect(onEnqueued).toHaveBeenCalledWith("job-123");
    expect(toastMocks.success).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("blocks submission when no types are selected", async () => {
    render(
      <BulkGenerateDialog
        open
        onOpenChange={() => {}}
        courseId="course-1"
      />,
    );

    await screen.findByText(/Mitosis/i);
    const user = userEvent.setup();

    // Untick both default types (mcq + open). They render as buttons that
    // wrap the checkbox, so clicking the chip toggles selection.
    await user.click(screen.getByTestId("bulk-type-mcq"));
    await user.click(screen.getByTestId("bulk-type-open"));

    const start = screen.getByTestId("bulk-start") as HTMLButtonElement;
    expect(start.disabled).toBe(true);
  });

  it("surfaces an over-cap warning when chapters × types blows the limit", async () => {
    // Build 200 fake chapters so 200 × 2 types = 400 > 300 cap.
    tableResponses.material_chapters = {
      data: Array.from({ length: 200 }, (_, i) => ({
        id: `ch-${i}`,
        title: `Chapter ${i}`,
        material_id: "mat-1",
        course_materials: { title: "Bio", file_name: "bio.pdf" },
      })),
      error: null,
    };

    render(
      <BulkGenerateDialog
        open
        onOpenChange={() => {}}
        courseId="course-1"
      />,
    );

    await screen.findByText(/Chapter 0/i);
    await waitFor(() => {
      expect(screen.getByTestId("bulk-over-cap")).toBeInTheDocument();
    });
    const start = screen.getByTestId("bulk-start") as HTMLButtonElement;
    expect(start.disabled).toBe(true);
  });

  it("toasts the server error when the enqueue function rejects", async () => {
    invokeMock.mockResolvedValueOnce({
      data: null,
      error: {
        message: "FunctionsHttpError",
        // supabase-js stashes the raw Response on `.context`; the dialog must
        // read its JSON body to recover the handler's real message.
        context: new Response(
          JSON.stringify({
            error: "A bulk generation job is already running for this course",
          }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        ),
      },
    });

    render(
      <BulkGenerateDialog
        open
        onOpenChange={() => {}}
        courseId="course-1"
      />,
    );

    await screen.findByText(/Mitosis/i);
    await userEvent.setup().click(screen.getByTestId("bulk-start"));

    await waitFor(() => {
      expect(toastMocks.error).toHaveBeenCalledWith(
        "A bulk generation job is already running for this course",
      );
    });
  });

  it("honours a chapter subset selection when 'All chapters' is unchecked", async () => {
    invokeMock.mockResolvedValueOnce({
      data: { jobId: "job-456" },
      error: null,
    });

    render(
      <BulkGenerateDialog
        open
        onOpenChange={() => {}}
        courseId="course-1"
      />,
    );

    await screen.findByText(/Mitosis/i);
    const user = userEvent.setup();
    await user.click(screen.getByTestId("bulk-all-chapters"));
    await user.click(screen.getByTestId("bulk-chapter-ch-2"));

    await user.click(screen.getByTestId("bulk-start"));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "enqueue-bulk-generation",
        expect.objectContaining({
          body: expect.objectContaining({ chapterIds: ["ch-2"] }),
        }),
      );
    });
  });
});
