/**
 * #754 — UnifiedPracticeQuestionsList tests.
 *
 * Mocks the data hook (#753, covered separately) and asserts the surface this
 * component owns: type/status badges, action labels, filter behaviour, and
 * the two empty-state variants (nothing assigned vs. nothing matches).
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const hookMock = vi.hoisted(() => ({ useStudentPracticeQuestions: vi.fn() }));

vi.mock("@/hooks/useStudentPracticeQuestions", () => ({
  useStudentPracticeQuestions: hookMock.useStudentPracticeQuestions,
}));

// The list now embeds the answering dispatcher (#756) when a row is selected.
// Stub it so the list tests stay focused on list behaviour and don't drag in
// supabase / useAuth wiring required by the real per-type panels.
const dispatcherProps = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/components/student/PracticeAnsweringDispatcher", async () => {
  const React = await import("react");
  return {
    PracticeAnsweringDispatcher: (props: {
      question: { id: string; type: string };
      hasNext: boolean;
      onBack: () => void;
      onNext: () => void;
      onCompleted?: () => void;
    }) => {
      dispatcherProps.current = props;
      return React.createElement(
        "div",
        { "data-testid": "dispatcher", "data-question-id": props.question.id },
        React.createElement(
          "button",
          { onClick: props.onBack, "data-testid": "dispatcher-back" },
          "back",
        ),
        React.createElement(
          "button",
          { onClick: () => props.onCompleted?.(), "data-testid": "dispatcher-complete" },
          "complete",
        ),
        React.createElement(
          "button",
          { onClick: props.onNext, "data-testid": "dispatcher-next" },
          "next",
        ),
      );
    },
  };
});

// PracticeRandomRun (#776) is exercised by its own test file. Stub it here
// so the list integration tests stay focused on CTA wiring.
const randomRunProps = vi.hoisted(() => ({
  current: null as null | {
    questionsInRun: { id: string }[];
    onExit: () => void;
    onQuestionStatusChange?: (q: { id: string }, status: string) => void;
  },
}));
vi.mock("@/components/student/PracticeRandomRun", async () => {
  const React = await import("react");
  return {
    PracticeRandomRun: (props: {
      questionsInRun: { id: string }[];
      onExit: () => void;
      onQuestionStatusChange?: (q: { id: string }, status: string) => void;
    }) => {
      randomRunProps.current = props;
      return React.createElement(
        "div",
        {
          "data-testid": "random-run",
          "data-count": String(props.questionsInRun.length),
          "data-ids": props.questionsInRun.map((q) => q.id).join(","),
        },
        React.createElement(
          "button",
          { onClick: props.onExit, "data-testid": "random-run-exit" },
          "exit",
        ),
      );
    },
  };
});

// Keep the LaTeX pipeline as a passthrough so we can assert on raw preview text.
vi.mock("@/lib/latex-utils", () => ({
  formatQuestionText: (text: string) => text ?? "",
  processLatexContent: (text: string) => text ?? "",
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { UnifiedPracticeQuestionsList } from "@/components/student/UnifiedPracticeQuestionsList";
import type { StudentPracticeQuestion } from "@/hooks/useStudentPracticeQuestions";

beforeAll(() => {
  // Radix Select needs the same pointer/observer shims used elsewhere in the suite.
  if (!Element.prototype.hasPointerCapture) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Element.prototype as any).hasPointerCapture = () => false;
  }
  if (!Element.prototype.setPointerCapture) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Element.prototype as any).setPointerCapture = () => {};
  }
  if (!Element.prototype.releasePointerCapture) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Element.prototype as any).releasePointerCapture = () => {};
  }
  if (!Element.prototype.scrollIntoView) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Element.prototype as any).scrollIntoView = () => {};
  }
  if (typeof globalThis.ResizeObserver === "undefined") {
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).ResizeObserver = ResizeObserverStub;
  }
});

const mkQ = (over: Partial<StudentPracticeQuestion>): StudentPracticeQuestion => ({
  id: over.id ?? "q",
  type: over.type ?? "mcq",
  stemPreview: over.stemPreview ?? "preview",
  difficulty: over.difficulty ?? "medium",
  status: over.status ?? "not_started",
  offeringId: over.offeringId ?? "off-1",
  chapters: over.chapters ?? [],
  ...(over.grade !== undefined ? { grade: over.grade } : {}),
  ...(over.answeringMode !== undefined ? { answeringMode: over.answeringMode } : {}),
});

const ALL_FIVE: StudentPracticeQuestion[] = [
  mkQ({ id: "q-mcq", type: "mcq", stemPreview: "What is 2 + 2?", status: "not_started" }),
  mkQ({
    id: "q-open",
    type: "open",
    stemPreview: "Explain photosynthesis.",
    status: "in_progress",
    grade: 40,
  }),
  mkQ({
    id: "q-fill",
    type: "fill_gaps",
    stemPreview: "The capital of France is ‗‗‗.",
    status: "completed",
    grade: 100,
    difficulty: "easy",
  }),
  mkQ({
    id: "q-order",
    type: "ordering",
    stemPreview: "Order the planets — Mercury → Venus → Earth",
    status: "not_started",
    difficulty: "hard",
  }),
  mkQ({
    id: "q-class",
    type: "classification",
    stemPreview: "Sort animals — Mammals / Birds",
    status: "completed",
    grade: 75,
  }),
];

const defaultProps = {
  courseId: "course-1",
  courseTitle: "Test Course",
  onSelectQuestion: vi.fn(),
  onBack: vi.fn(),
};

beforeEach(() => {
  hookMock.useStudentPracticeQuestions.mockReset();
  defaultProps.onSelectQuestion = vi.fn();
  defaultProps.onBack = vi.fn();
});

describe("UnifiedPracticeQuestionsList", () => {
  it("renders one row per question across all five types with the right type badge", () => {
    hookMock.useStudentPracticeQuestions.mockReturnValue({
      questions: ALL_FIVE,
      loading: false,
      refetch: vi.fn(),
    });

    render(<UnifiedPracticeQuestionsList {...defaultProps} />);

    const list = screen.getByTestId("practice-list");
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(5);

    expect(within(list).getByText("MCQ")).toBeInTheDocument();
    expect(within(list).getByText("Open")).toBeInTheDocument();
    expect(within(list).getByText("Fill the Gaps")).toBeInTheDocument();
    expect(within(list).getByText("Ordering")).toBeInTheDocument();
    expect(within(list).getByText("Classification")).toBeInTheDocument();

    expect(within(list).getByText("What is 2 + 2?")).toBeInTheDocument();
    expect(within(list).getByText("Explain photosynthesis.")).toBeInTheDocument();
  });

  it("shows a binary Start / View action label for every type (answered → View, else → Start)", () => {
    hookMock.useStudentPracticeQuestions.mockReturnValue({
      questions: ALL_FIVE,
      loading: false,
      refetch: vi.fn(),
    });

    render(<UnifiedPracticeQuestionsList {...defaultProps} />);

    // Only two labels exist: completed → View (2), everything else → Start
    // (2 not_started + 1 in_progress = 3). No "Continue".
    expect(screen.getAllByRole("button", { name: /^Start$/ })).toHaveLength(3);
    expect(screen.getAllByRole("button", { name: /^View$/ })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /^Continue$/ })).not.toBeInTheDocument();
  });

  it("does not render the completion grade percent in the list", () => {
    hookMock.useStudentPracticeQuestions.mockReturnValue({
      questions: ALL_FIVE,
      loading: false,
      refetch: vi.fn(),
    });

    render(<UnifiedPracticeQuestionsList {...defaultProps} />);

    // Grade % was removed from the menu (#consistency request).
    expect(screen.queryByText("100%")).not.toBeInTheDocument();
    expect(screen.queryByText("75%")).not.toBeInTheDocument();
    expect(screen.queryByText(/%$/)).not.toBeInTheDocument();
  });

  it("invokes onSelectQuestion with the row's question when the action is clicked", async () => {
    const user = userEvent.setup();
    hookMock.useStudentPracticeQuestions.mockReturnValue({
      questions: ALL_FIVE,
      loading: false,
      refetch: vi.fn(),
    });

    render(<UnifiedPracticeQuestionsList {...defaultProps} />);

    // q-open is in_progress → now shows "Start"; scope to its row.
    const openRow = screen.getByText("Explain photosynthesis.").closest("li") as HTMLElement;
    await user.click(within(openRow).getByRole("button"));
    expect(defaultProps.onSelectQuestion).toHaveBeenCalledTimes(1);
    expect(defaultProps.onSelectQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ id: "q-open", type: "open" }),
    );
  });

  it("filters by type when the type select is changed", async () => {
    const user = userEvent.setup();
    hookMock.useStudentPracticeQuestions.mockReturnValue({
      questions: ALL_FIVE,
      loading: false,
      refetch: vi.fn(),
    });

    render(<UnifiedPracticeQuestionsList {...defaultProps} />);

    const typeTrigger = screen.getByRole("combobox", { name: /Filter by type/ });
    await user.click(typeTrigger);
    // Radix Select renders options in a portal; pick by role.
    const openOption = await screen.findByRole("option", { name: "Open" });
    await user.click(openOption);

    const list = screen.getByTestId("practice-list");
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(1);
    expect(within(list).getByText("Explain photosynthesis.")).toBeInTheDocument();
  });

  it("filters by status and shows the filtered empty state with a Clear filters CTA", async () => {
    const user = userEvent.setup();
    hookMock.useStudentPracticeQuestions.mockReturnValue({
      // Only completed questions exist — filtering to In progress yields nothing.
      questions: [
        mkQ({ id: "a", type: "mcq", status: "completed", grade: 100 }),
        mkQ({ id: "b", type: "open", status: "completed", grade: 90 }),
      ],
      loading: false,
      refetch: vi.fn(),
    });

    render(<UnifiedPracticeQuestionsList {...defaultProps} />);

    const statusTrigger = screen.getByRole("combobox", { name: /Filter by status/ });
    await user.click(statusTrigger);
    const inProgress = await screen.findByRole("option", { name: /In progress/ });
    await user.click(inProgress);

    await waitFor(() => {
      expect(screen.getByText(/No questions match these filters/)).toBeInTheDocument();
    });

    // Clearing filters should bring the rows back.
    await user.click(screen.getByRole("button", { name: /Clear filters/ }));
    const list = screen.getByTestId("practice-list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
  });

  it("shows the assigned-nothing empty state when the hook returns no questions", () => {
    hookMock.useStudentPracticeQuestions.mockReturnValue({
      questions: [],
      loading: false,
      refetch: vi.fn(),
    });

    render(<UnifiedPracticeQuestionsList {...defaultProps} />);

    expect(screen.getByText(/No practice questions yet/)).toBeInTheDocument();
    expect(screen.queryByTestId("practice-list")).not.toBeInTheDocument();
    // The filtered-empty-state CTA must NOT appear when nothing is assigned.
    expect(screen.queryByRole("button", { name: /Clear filters/ })).not.toBeInTheDocument();
  });

  it("renders a spinner while the hook is loading", () => {
    hookMock.useStudentPracticeQuestions.mockReturnValue({
      questions: [],
      loading: true,
      refetch: vi.fn(),
    });

    const { container } = render(<UnifiedPracticeQuestionsList {...defaultProps} />);
    // Loader2 from lucide-react renders an <svg> with the `animate-spin` class.
    expect(container.querySelector(".animate-spin")).toBeInTheDocument();
  });

  it("calls onBack when the back button is clicked", async () => {
    const user = userEvent.setup();
    hookMock.useStudentPracticeQuestions.mockReturnValue({
      questions: [],
      loading: false,
      refetch: vi.fn(),
    });

    render(<UnifiedPracticeQuestionsList {...defaultProps} />);
    await user.click(screen.getByRole("button", { name: /Back to course/ }));
    expect(defaultProps.onBack).toHaveBeenCalledTimes(1);
  });

  it("renders a soft fallback when stemPreview is empty (malformed payload)", () => {
    hookMock.useStudentPracticeQuestions.mockReturnValue({
      questions: [mkQ({ id: "broken", type: "mcq", stemPreview: "" })],
      loading: false,
      refetch: vi.fn(),
    });

    render(<UnifiedPracticeQuestionsList {...defaultProps} />);
    expect(screen.getByText(/Question content unavailable/)).toBeInTheDocument();
  });

  it("mounts the answering dispatcher when a row is selected and returns to the list on back", async () => {
    const user = userEvent.setup();
    hookMock.useStudentPracticeQuestions.mockReturnValue({
      questions: ALL_FIVE,
      loading: false,
      refetch: vi.fn(),
    });

    render(<UnifiedPracticeQuestionsList {...defaultProps} />);

    // q-open is in_progress → now shows "Start"; scope to its row.
    const openRow = screen.getByText("Explain photosynthesis.").closest("li") as HTMLElement;
    await user.click(within(openRow).getByRole("button"));
    const dispatcher = await screen.findByTestId("dispatcher");
    expect(dispatcher).toHaveAttribute("data-question-id", "q-open");

    await user.click(screen.getByTestId("dispatcher-back"));
    await waitFor(() => {
      expect(screen.queryByTestId("dispatcher")).not.toBeInTheDocument();
    });
    // Returning to the list — the practice rows are visible again.
    expect(screen.getByTestId("practice-list")).toBeInTheDocument();
  });

  it("calls hook.refetch when the dispatcher reports completion", async () => {
    const user = userEvent.setup();
    const refetch = vi.fn();
    hookMock.useStudentPracticeQuestions.mockReturnValue({
      questions: ALL_FIVE,
      loading: false,
      refetch,
    });

    render(<UnifiedPracticeQuestionsList {...defaultProps} />);
    await user.click(screen.getAllByRole("button", { name: /^Start$/ })[0]);
    await user.click(screen.getByTestId("dispatcher-complete"));

    expect(refetch).toHaveBeenCalled();
  });

  it("does not render the chapter filter when no question has any chapter tag (#774)", () => {
    hookMock.useStudentPracticeQuestions.mockReturnValue({
      // ALL_FIVE has empty chapters arrays for every row.
      questions: ALL_FIVE,
      loading: false,
      refetch: vi.fn(),
    });

    render(<UnifiedPracticeQuestionsList {...defaultProps} />);
    expect(
      screen.queryByRole("combobox", { name: /Filter by chapter/ }),
    ).not.toBeInTheDocument();
  });

  it("renders the chapter filter with course chapters sorted by label (#774)", async () => {
    const user = userEvent.setup();
    hookMock.useStudentPracticeQuestions.mockReturnValue({
      questions: [
        mkQ({
          id: "q1",
          chapters: [
            {
              id: "ch-b",
              title: "Respiration",
              materialId: "mat-1",
              materialTitle: "Biology Book",
            },
          ],
        }),
        mkQ({
          id: "q2",
          chapters: [
            {
              id: "ch-a",
              title: "Photosynthesis",
              materialId: "mat-1",
              materialTitle: "Biology Book",
            },
          ],
        }),
      ],
      loading: false,
      refetch: vi.fn(),
    });

    render(<UnifiedPracticeQuestionsList {...defaultProps} />);

    const chapterTrigger = screen.getByRole("combobox", { name: /Filter by chapter/ });
    await user.click(chapterTrigger);
    const options = await screen.findAllByRole("option");
    // First option is "All chapters", then chapter labels alphabetized.
    expect(options.map((o) => o.textContent)).toEqual([
      "All chapters",
      "Biology Book — Photosynthesis",
      "Biology Book — Respiration",
    ]);
  });

  it("filters by chapter when one is selected (#774)", async () => {
    const user = userEvent.setup();
    const chA = {
      id: "ch-a",
      title: "Photosynthesis",
      materialId: "mat-1",
      materialTitle: "Biology Book",
    };
    const chB = {
      id: "ch-b",
      title: "Respiration",
      materialId: "mat-1",
      materialTitle: "Biology Book",
    };
    hookMock.useStudentPracticeQuestions.mockReturnValue({
      questions: [
        mkQ({ id: "q-a", stemPreview: "About photosynthesis", chapters: [chA] }),
        mkQ({ id: "q-b", stemPreview: "About respiration", chapters: [chB] }),
        mkQ({ id: "q-both", stemPreview: "About both", chapters: [chA, chB] }),
      ],
      loading: false,
      refetch: vi.fn(),
    });

    render(<UnifiedPracticeQuestionsList {...defaultProps} />);

    const chapterTrigger = screen.getByRole("combobox", { name: /Filter by chapter/ });
    await user.click(chapterTrigger);
    const opt = await screen.findByRole("option", {
      name: "Biology Book — Photosynthesis",
    });
    await user.click(opt);

    const list = screen.getByTestId("practice-list");
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(list).getByText("About photosynthesis")).toBeInTheDocument();
    expect(within(list).getByText("About both")).toBeInTheDocument();
    expect(within(list).queryByText("About respiration")).not.toBeInTheDocument();
  });

  it("combines type + status + chapter filters and resets all three with Clear filters (#774)", async () => {
    const user = userEvent.setup();
    const chA = {
      id: "ch-a",
      title: "Photosynthesis",
      materialId: "mat-1",
      materialTitle: "Biology Book",
    };
    hookMock.useStudentPracticeQuestions.mockReturnValue({
      questions: [
        mkQ({
          id: "q1",
          type: "mcq",
          status: "completed",
          grade: 100,
          chapters: [chA],
        }),
      ],
      loading: false,
      refetch: vi.fn(),
    });

    render(<UnifiedPracticeQuestionsList {...defaultProps} />);

    // Pick a chapter — q1 matches.
    await user.click(screen.getByRole("combobox", { name: /Filter by chapter/ }));
    await user.click(
      await screen.findByRole("option", { name: "Biology Book — Photosynthesis" }),
    );
    expect(within(screen.getByTestId("practice-list")).getAllByRole("listitem")).toHaveLength(1);

    // Narrow to In progress — q1 is completed, so combined filter empties the list.
    await user.click(screen.getByRole("combobox", { name: /Filter by status/ }));
    await user.click(await screen.findByRole("option", { name: /In progress/ }));

    await waitFor(() => {
      expect(screen.getByText(/No questions match these filters/)).toBeInTheDocument();
    });

    // Clear filters resets type + status + chapter and the row returns.
    await user.click(screen.getByRole("button", { name: /Clear filters/ }));
    expect(within(screen.getByTestId("practice-list")).getAllByRole("listitem")).toHaveLength(1);
  });

  // #775 — client-side pagination over the filtered list.
  describe("client-side pagination (#775)", () => {
    const makeMany = (n: number, base: Partial<StudentPracticeQuestion> = {}) =>
      Array.from({ length: n }, (_, i) =>
        mkQ({ id: `q-${i}`, stemPreview: `Question ${i}`, ...base }),
      );

    it("renders at most one page of rows (default 25) when more questions exist", () => {
      hookMock.useStudentPracticeQuestions.mockReturnValue({
        questions: makeMany(30),
        loading: false,
        refetch: vi.fn(),
      });

      render(<UnifiedPracticeQuestionsList {...defaultProps} />);

      const list = screen.getByTestId("practice-list");
      expect(within(list).getAllByRole("listitem")).toHaveLength(25);
      expect(screen.getByTestId("bank-page-indicator")).toHaveTextContent(
        /Page 1 of 2/,
      );
      // Prev disabled on first page; Next enabled when more remain.
      expect(screen.getByTestId("bank-page-prev")).toBeDisabled();
      expect(screen.getByTestId("bank-page-next")).toBeEnabled();
    });

    it("advances to the next page when Next is clicked and shows the remaining rows", async () => {
      const user = userEvent.setup();
      hookMock.useStudentPracticeQuestions.mockReturnValue({
        questions: makeMany(30),
        loading: false,
        refetch: vi.fn(),
      });

      render(<UnifiedPracticeQuestionsList {...defaultProps} />);
      await user.click(screen.getByTestId("bank-page-next"));

      const list = screen.getByTestId("practice-list");
      expect(within(list).getAllByRole("listitem")).toHaveLength(5);
      expect(screen.getByTestId("bank-page-indicator")).toHaveTextContent(
        /Page 2 of 2/,
      );
      // Page 2 surfaces questions 25..29; question 0 is no longer visible.
      expect(within(list).getByText("Question 25")).toBeInTheDocument();
      expect(within(list).queryByText("Question 0")).not.toBeInTheDocument();
    });

    it("resets to page 1 when a filter changes", async () => {
      const user = userEvent.setup();
      hookMock.useStudentPracticeQuestions.mockReturnValue({
        // 30 MCQ + 30 Open → ensure both filters yield multiple pages so the
        // reset is observable in the indicator, not just because the new
        // filter narrows the set to a single page.
        questions: [
          ...makeMany(30, { type: "mcq" }).map((q, i) => ({
            ...q,
            id: `mcq-${i}`,
          })),
          ...makeMany(30, { type: "open" }).map((q, i) => ({
            ...q,
            id: `open-${i}`,
          })),
        ],
        loading: false,
        refetch: vi.fn(),
      });

      render(<UnifiedPracticeQuestionsList {...defaultProps} />);
      // Move to page 2 first.
      await user.click(screen.getByTestId("bank-page-next"));
      expect(screen.getByTestId("bank-page-indicator")).toHaveTextContent(
        /Page 2 of 3/,
      );

      // Now filter by type Open — must reset to page 1 of the new total.
      await user.click(screen.getByRole("combobox", { name: /Filter by type/ }));
      await user.click(await screen.findByRole("option", { name: "Open" }));

      await waitFor(() => {
        expect(screen.getByTestId("bank-page-indicator")).toHaveTextContent(
          /Page 1 of 2/,
        );
      });
      // First Open row visible on page 1 of the filtered set.
      const list = screen.getByTestId("practice-list");
      expect(within(list).getByText("Question 0")).toBeInTheDocument();
    });

    it("does not render the pagination footer in the empty states", async () => {
      const user = userEvent.setup();

      // Nothing assigned → no footer.
      hookMock.useStudentPracticeQuestions.mockReturnValue({
        questions: [],
        loading: false,
        refetch: vi.fn(),
      });
      const { rerender } = render(<UnifiedPracticeQuestionsList {...defaultProps} />);
      expect(screen.queryByTestId("bank-pagination-footer")).not.toBeInTheDocument();

      // Assigned but filtered-empty → no footer either.
      // Rerender with 1 MCQ question; applying "Open" type filter produces zero rows.
      hookMock.useStudentPracticeQuestions.mockReturnValue({
        questions: [mkQ({ id: "a", type: "mcq", status: "completed" })],
        loading: false,
        refetch: vi.fn(),
      });
      rerender(<UnifiedPracticeQuestionsList {...defaultProps} />);

      // Footer is present before filtering.
      expect(screen.getByTestId("bank-pagination-footer")).toBeInTheDocument();

      // Filter by "Open" type → MCQ doesn't match → filtered-empty state → no footer.
      await user.click(screen.getByRole("combobox", { name: /Filter by type/ }));
      await user.click(await screen.findByRole("option", { name: "Open" }));

      expect(screen.queryByTestId("bank-pagination-footer")).not.toBeInTheDocument();
      expect(screen.getByText("No questions match these filters")).toBeInTheDocument();
    });

    it("re-paginates when the page size is changed", async () => {
      const user = userEvent.setup();
      hookMock.useStudentPracticeQuestions.mockReturnValue({
        questions: makeMany(30),
        loading: false,
        refetch: vi.fn(),
      });

      render(<UnifiedPracticeQuestionsList {...defaultProps} />);
      // Default 25/page → Page 1 of 2.
      expect(screen.getByTestId("bank-page-indicator")).toHaveTextContent(
        /Page 1 of 2/,
      );

      // Shrink to 10 per page — Page 1 of 3.
      await user.click(screen.getByTestId("bank-page-size"));
      await user.click(await screen.findByRole("option", { name: "10" }));

      await waitFor(() => {
        expect(screen.getByTestId("bank-page-indicator")).toHaveTextContent(
          /Page 1 of 3/,
        );
      });
      const list = screen.getByTestId("practice-list");
      expect(within(list).getAllByRole("listitem")).toHaveLength(10);
    });

    it("advances to the next unanswered question across pages", async () => {
      const user = userEvent.setup();
      // 26 questions: first 25 completed → page 1 entirely answered, only the
      // last one (page 2) is still pending. Starting the first row should let
      // the dispatcher's Next jump straight to it.
      const questions = [
        ...Array.from({ length: 25 }, (_, i) =>
          mkQ({ id: `done-${i}`, status: "completed", grade: 100 }),
        ),
        mkQ({ id: "pending", status: "not_started", stemPreview: "Final" }),
      ];
      hookMock.useStudentPracticeQuestions.mockReturnValue({
        questions,
        loading: false,
        refetch: vi.fn(),
      });

      render(<UnifiedPracticeQuestionsList {...defaultProps} />);
      // Click the first completed row's "View" — dispatcher mounts on done-0.
      const firstRow = screen.getByTestId("practice-list").querySelector("li") as HTMLElement;
      await user.click(within(firstRow).getByRole("button"));
      expect(screen.getByTestId("dispatcher")).toHaveAttribute(
        "data-question-id",
        "done-0",
      );

      await user.click(screen.getByTestId("dispatcher-next"));
      await waitFor(() => {
        expect(screen.getByTestId("dispatcher")).toHaveAttribute(
          "data-question-id",
          "pending",
        );
      });
    });
  });

  it("advances to the next unanswered question when Next is fired", async () => {
    const user = userEvent.setup();
    hookMock.useStudentPracticeQuestions.mockReturnValue({
      // Two not-started questions side by side.
      questions: [
        mkQ({ id: "q-1", type: "mcq", status: "not_started" }),
        mkQ({ id: "q-2", type: "open", status: "not_started" }),
      ],
      loading: false,
      refetch: vi.fn(),
    });

    render(<UnifiedPracticeQuestionsList {...defaultProps} />);
    await user.click(screen.getAllByRole("button", { name: /^Start$/ })[0]);

    // Dispatcher mounted for q-1; advance to q-2.
    expect(screen.getByTestId("dispatcher")).toHaveAttribute(
      "data-question-id",
      "q-1",
    );
    await user.click(screen.getByTestId("dispatcher-next"));
    await waitFor(() => {
      expect(screen.getByTestId("dispatcher")).toHaveAttribute(
        "data-question-id",
        "q-2",
      );
    });
  });

  // #776 — "Practice 10 random" CTA + serial run host integration.
  describe("Practice random run (#776)", () => {
    beforeEach(() => {
      randomRunProps.current = null;
    });

    it("does not render the CTA when no questions are assigned", () => {
      hookMock.useStudentPracticeQuestions.mockReturnValue({
        questions: [],
        loading: false,
        refetch: vi.fn(),
      });
      render(<UnifiedPracticeQuestionsList {...defaultProps} />);
      expect(
        screen.queryByTestId("practice-random-run-cta"),
      ).not.toBeInTheDocument();
    });

    it("does not render the CTA while loading", () => {
      hookMock.useStudentPracticeQuestions.mockReturnValue({
        questions: [],
        loading: true,
        refetch: vi.fn(),
      });
      render(<UnifiedPracticeQuestionsList {...defaultProps} />);
      expect(
        screen.queryByTestId("practice-random-run-cta"),
      ).not.toBeInTheDocument();
    });

    it("renders the CTA when there are filtered rows", () => {
      hookMock.useStudentPracticeQuestions.mockReturnValue({
        questions: ALL_FIVE,
        loading: false,
        refetch: vi.fn(),
      });
      render(<UnifiedPracticeQuestionsList {...defaultProps} />);
      const cta = screen.getByTestId("practice-random-run-cta");
      expect(cta).toBeEnabled();
      // 5 filtered questions → label caps at 5.
      expect(cta).toHaveTextContent(/Practice 5 random/);
    });

    it("disables the CTA when the current filter yields zero rows", async () => {
      const user = userEvent.setup();
      hookMock.useStudentPracticeQuestions.mockReturnValue({
        questions: [mkQ({ id: "a", type: "mcq", status: "completed" })],
        loading: false,
        refetch: vi.fn(),
      });
      render(<UnifiedPracticeQuestionsList {...defaultProps} />);
      // Filter to "In progress" → no rows match → CTA disabled.
      await user.click(screen.getByRole("combobox", { name: /Filter by status/ }));
      await user.click(await screen.findByRole("option", { name: /In progress/ }));
      await waitFor(() => {
        expect(screen.getByTestId("practice-random-run-cta")).toBeDisabled();
      });
    });

    it("starts a run of up to 10 from the filtered list when clicked", async () => {
      const user = userEvent.setup();
      const many = Array.from({ length: 25 }, (_, i) =>
        mkQ({ id: `q-${i}`, type: "mcq", status: "not_started" }),
      );
      hookMock.useStudentPracticeQuestions.mockReturnValue({
        questions: many,
        loading: false,
        refetch: vi.fn(),
      });
      render(<UnifiedPracticeQuestionsList {...defaultProps} />);
      await user.click(screen.getByTestId("practice-random-run-cta"));

      const run = await screen.findByTestId("random-run");
      expect(run).toHaveAttribute("data-count", "10");
      // Picked ids are all from the filtered set.
      const ids = run.getAttribute("data-ids")!.split(",");
      expect(ids).toHaveLength(10);
      const valid = new Set(many.map((q) => q.id));
      for (const id of ids) expect(valid.has(id)).toBe(true);
    });

    it("draws only from the current filter (e.g. selected chapter)", async () => {
      const user = userEvent.setup();
      const chA = {
        id: "ch-a",
        title: "Photosynthesis",
        materialId: "mat-1",
        materialTitle: "Biology Book",
      };
      const chB = {
        id: "ch-b",
        title: "Respiration",
        materialId: "mat-1",
        materialTitle: "Biology Book",
      };
      hookMock.useStudentPracticeQuestions.mockReturnValue({
        questions: [
          ...Array.from({ length: 12 }, (_, i) =>
            mkQ({ id: `a-${i}`, chapters: [chA] }),
          ),
          ...Array.from({ length: 12 }, (_, i) =>
            mkQ({ id: `b-${i}`, chapters: [chB] }),
          ),
        ],
        loading: false,
        refetch: vi.fn(),
      });
      render(<UnifiedPracticeQuestionsList {...defaultProps} />);

      // Pick chapter A then start the run — only `a-*` ids must appear.
      await user.click(screen.getByRole("combobox", { name: /Filter by chapter/ }));
      await user.click(
        await screen.findByRole("option", { name: "Biology Book — Photosynthesis" }),
      );
      await user.click(screen.getByTestId("practice-random-run-cta"));

      const run = await screen.findByTestId("random-run");
      const ids = run.getAttribute("data-ids")!.split(",");
      expect(ids).toHaveLength(10);
      for (const id of ids) expect(id.startsWith("a-")).toBe(true);
    });

    // #821 — the type filter must NOT scope the random draw: a "random" run
    // always spans all question types even when a specific type is selected.
    it("draws across all types even when a type filter is active", async () => {
      const user = userEvent.setup();
      // Two questions per type, all not-started — a full 10-question pool.
      const byType = (["mcq", "open", "fill_gaps", "ordering", "classification"] as const)
        .flatMap((type) =>
          Array.from({ length: 2 }, (_, i) =>
            mkQ({ id: `${type}-${i}`, type, status: "not_started" }),
          ),
        );
      hookMock.useStudentPracticeQuestions.mockReturnValue({
        questions: byType,
        loading: false,
        refetch: vi.fn(),
      });
      render(<UnifiedPracticeQuestionsList {...defaultProps} />);

      // Narrow the visible list to Classification only…
      await user.click(screen.getByRole("combobox", { name: /Filter by type/ }));
      await user.click(await screen.findByRole("option", { name: /Classification/ }));

      // …but the random run still draws from every type.
      await user.click(screen.getByTestId("practice-random-run-cta"));
      const run = await screen.findByTestId("random-run");
      const ids = run.getAttribute("data-ids")!.split(",");
      expect(ids).toHaveLength(10);
      const types = new Set(ids.map((id) => id.replace(/-\d+$/, "")));
      // More than the single selected type is represented.
      expect(types.size).toBeGreaterThan(1);
      expect(types.has("mcq")).toBe(true);
      expect(types.has("classification")).toBe(true);
    });

    // #821 — the CTA count and enabled state track the type-agnostic pool, not
    // the type-filtered list.
    it("keeps the CTA count type-agnostic when a type filter is active", async () => {
      const user = userEvent.setup();
      hookMock.useStudentPracticeQuestions.mockReturnValue({
        questions: [
          mkQ({ id: "m-1", type: "mcq", status: "not_started" }),
          mkQ({ id: "m-2", type: "mcq", status: "not_started" }),
          mkQ({ id: "c-1", type: "classification", status: "not_started" }),
        ],
        loading: false,
        refetch: vi.fn(),
      });
      render(<UnifiedPracticeQuestionsList {...defaultProps} />);

      await user.click(screen.getByRole("combobox", { name: /Filter by type/ }));
      await user.click(await screen.findByRole("option", { name: /Classification/ }));

      // Only one classification row is listed, but the CTA still counts all 3.
      const cta = screen.getByTestId("practice-random-run-cta");
      expect(cta).toBeEnabled();
      expect(cta).toHaveTextContent(/Practice 3 random/);
    });

    it("hides the list while a run is in progress and restores + refetches on exit", async () => {
      const user = userEvent.setup();
      const refetch = vi.fn();
      hookMock.useStudentPracticeQuestions.mockReturnValue({
        questions: ALL_FIVE,
        loading: false,
        refetch,
      });
      render(<UnifiedPracticeQuestionsList {...defaultProps} />);
      await user.click(screen.getByTestId("practice-random-run-cta"));

      // List is hidden (aria-hidden ancestor) while the run host is mounted.
      expect(screen.getByTestId("random-run-host")).toBeInTheDocument();

      // Exit returns to the list and triggers a refetch.
      await user.click(screen.getByTestId("random-run-exit"));
      await waitFor(() => {
        expect(screen.queryByTestId("random-run-host")).not.toBeInTheDocument();
      });
      expect(refetch).toHaveBeenCalled();
      expect(screen.getByTestId("practice-list")).toBeInTheDocument();
    });

    it("renders fewer than 10 when the filtered set is smaller", async () => {
      const user = userEvent.setup();
      hookMock.useStudentPracticeQuestions.mockReturnValue({
        questions: [
          mkQ({ id: "only-1", type: "mcq", status: "not_started" }),
          mkQ({ id: "only-2", type: "open", status: "in_progress" }),
        ],
        loading: false,
        refetch: vi.fn(),
      });
      render(<UnifiedPracticeQuestionsList {...defaultProps} />);
      await user.click(screen.getByTestId("practice-random-run-cta"));
      const run = await screen.findByTestId("random-run");
      expect(run).toHaveAttribute("data-count", "2");
    });
  });
});
