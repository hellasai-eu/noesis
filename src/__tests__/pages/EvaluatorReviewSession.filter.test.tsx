/**
 * #683 — EvaluatorReviewSession triage filter/search tests.
 *
 * Mounts the page with a deterministic 5-question bank and verifies the
 * four filter axes (search / unevaluated-only / type / difficulty), the
 * visible count line, and the "no matches" empty state.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { forwardRef, useImperativeHandle } from "react";
import EvaluatorReviewSession from "@/pages/EvaluatorReviewSession";
import type { QuestionEvaluationFormHandle } from "@/components/evaluator/QuestionEvaluationForm";
import type { UnifiedQuestion } from "@/lib/unified-question";

const mockUser = vi.hoisted(() => ({ id: "evaluator-1", email: "e@test.local" }));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: mockUser, loading: false }),
}));

vi.mock("@/hooks/useUserInstitution", () => ({
  useUserInstitution: () => ({
    isAdmin: false,
    isInstructor: false,
    isEvaluator: true,
    loading: false,
  }),
}));

const mockQuestions: UnifiedQuestion[] = [
  {
    id: "q-a",
    type: "mcq",
    preview: "Alpha photosynthesis preview",
    searchText: "alpha photosynthesis",
    difficulty: "easy",
    authorName: null,
    createdBy: null,
    createdAt: "2026-06-01T00:00:00Z",
    hidden: false,
    upvotes: 0,
    downvotes: 0,
    competencies: [],
    chapters: [],
    raw: {
      question: "Alpha",
      payload: null,
      answer_key: null,
      explanation: null,
      generation_rationale: null,
    },
  },
  {
    id: "q-b",
    type: "open",
    preview: "Beta mitochondria preview",
    searchText: "beta mitochondria",
    difficulty: "medium",
    authorName: null,
    createdBy: null,
    createdAt: "2026-06-01T00:00:00Z",
    hidden: false,
    upvotes: 0,
    downvotes: 0,
    competencies: [],
    chapters: [],
    raw: {
      question: "Beta",
      payload: null,
      answer_key: null,
      explanation: null,
      generation_rationale: null,
    },
  },
  {
    id: "q-c",
    type: "fill_gaps",
    preview: "Gamma osmosis preview",
    searchText: "gamma osmosis",
    difficulty: "hard",
    authorName: null,
    createdBy: null,
    createdAt: "2026-06-01T00:00:00Z",
    hidden: false,
    upvotes: 0,
    downvotes: 0,
    competencies: [],
    chapters: [],
    raw: {
      question: "Gamma",
      payload: null,
      answer_key: null,
      explanation: null,
      generation_rationale: null,
    },
  },
  {
    id: "q-d",
    type: "mcq",
    preview: "Delta enzyme preview",
    searchText: "delta enzyme",
    difficulty: "easy",
    authorName: null,
    createdBy: null,
    createdAt: "2026-06-01T00:00:00Z",
    hidden: false,
    upvotes: 0,
    downvotes: 0,
    competencies: [],
    chapters: [],
    raw: {
      question: "Delta",
      payload: null,
      answer_key: null,
      explanation: null,
      generation_rationale: null,
    },
  },
  {
    id: "q-e",
    type: "ordering",
    preview: "Epsilon mitosis preview",
    searchText: "epsilon mitosis",
    difficulty: "medium",
    authorName: null,
    createdBy: null,
    createdAt: "2026-06-01T00:00:00Z",
    hidden: false,
    upvotes: 0,
    downvotes: 0,
    competencies: [],
    chapters: [],
    raw: {
      question: "Epsilon",
      payload: null,
      answer_key: null,
      explanation: null,
      generation_rationale: null,
    },
  },
];

vi.mock("@/hooks/useUnifiedQuestions", () => ({
  useUnifiedQuestions: () => ({
    questions: mockQuestions,
    loading: false,
    refetch: vi.fn(),
    setQuestions: vi.fn(),
  }),
}));

vi.mock("@/integrations/supabase/client", () => {
  const make = () => ({
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    in: vi.fn().mockResolvedValue({ data: [], error: null }),
    single: vi.fn().mockResolvedValue({ data: { id: "sess-1" }, error: null }),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
  });
  return { supabase: { from: vi.fn(() => make()) } };
});

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

// Stub the form so we don't drag the heavy QuestionExpandedPanel into the
// triage-only tests. The stub still exposes the imperative handle so any
// page-level keyboard wiring keeps working.
let lastOnSaved: ((row: unknown) => void) | null = null;
let lastQuestionId: string | null = null;

vi.mock("@/components/evaluator/QuestionEvaluationForm", () => {
  type StubProps = {
    question: { id: string };
    onSaved: (row: unknown) => void;
  };
  const QuestionEvaluationForm = forwardRef<QuestionEvaluationFormHandle, StubProps>(
    function StubForm({ question, onSaved }, ref) {
      lastOnSaved = onSaved;
      lastQuestionId = question.id;
      useImperativeHandle(
        ref,
        () => ({
          submit: () => {},
          setVerdict: () => {},
        }),
        [question.id],
      );
      return <div data-testid="form-stub">{question.id}</div>;
    },
  );
  return { QuestionEvaluationForm };
});

vi.mock("@/components/evaluator/EvaluationSessionSummaryDialog", () => ({
  EvaluationSessionSummaryDialog: () => null,
}));

vi.mock("@/components/UnifiedQuestionsTable", () => ({
  TypeBadge: ({ type }: { type: string }) => <span>{type}</span>,
}));

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/evaluator/course/c-1/review"]}>
      <Routes>
        <Route
          path="/evaluator/course/:courseId/review"
          element={<EvaluatorReviewSession />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

async function waitForReady() {
  await waitFor(() => {
    expect(screen.getByTestId("form-stub")).toBeInTheDocument();
  });
}

function visibleListItemIds(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid^="question-list-item-"]'),
  ).map((el) => el.dataset.testid!.replace("question-list-item-", ""));
}

function simulateSave(questionId: string) {
  act(() => {
    lastOnSaved?.({
      id: `row-${questionId}`,
      session_id: "sess-1",
      question_id: questionId,
      evaluator_id: "evaluator-1",
      verdict: "good",
      difficulty_confirmation: "correct",
      scientifically_accurate: true,
      stated_answer_correct: true,
      exactly_one_correct: true,
      distractors_wrong: true,
      clarity: 3,
      pedagogical_value: 3,
      distractor_quality: null,
      curriculum_alignment: null,
      question_bank_alignment: null,
      language_appropriateness: null,
      problem_categories: [],
      comment: null,
      was_sampled: false,
      cognitive_level: null,
      created_at: "2026-06-01T00:00:00Z",
      updated_at: "2026-06-01T00:00:00Z",
    });
  });
}

beforeEach(() => {
  lastOnSaved = null;
  lastQuestionId = null;
  window.localStorage.clear();
});

describe("EvaluatorReviewSession — triage filter/search (#683)", () => {
  it("renders all questions and the full count by default", async () => {
    renderPage();
    await waitForReady();
    expect(visibleListItemIds()).toEqual(["q-a", "q-b", "q-c", "q-d", "q-e"]);
    expect(screen.getByTestId("evaluator-list-visible-count-desktop")).toHaveTextContent(
      "5 / 5 visible",
    );
  });

  it("narrows the list to questions whose searchText contains the term", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForReady();

    await user.type(
      screen.getByTestId("evaluator-list-search-desktop"),
      "mitosis",
    );
    expect(visibleListItemIds()).toEqual(["q-e"]);
    expect(screen.getByTestId("evaluator-list-visible-count-desktop")).toHaveTextContent(
      "1 / 5 visible",
    );

    // Clear button restores the full list.
    await user.click(screen.getByTestId("evaluator-list-search-clear-desktop"));
    expect(visibleListItemIds()).toHaveLength(5);
  });

  it('shows only unsaved questions when the "unevaluated only" toggle is on', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForReady();
    simulateSave("q-a");
    simulateSave("q-c");

    await user.click(screen.getByTestId("evaluator-list-unevaluated-desktop"));
    const visible = visibleListItemIds();
    expect(visible).not.toContain("q-a");
    expect(visible).not.toContain("q-c");
    expect(visible).toEqual(expect.arrayContaining(["q-b", "q-d", "q-e"]));
    expect(screen.getByTestId("evaluator-list-visible-count-desktop")).toHaveTextContent(
      "3 / 5 visible",
    );
  });

  it("filters by question type", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForReady();

    await user.click(screen.getByTestId("evaluator-list-type-chip-mcq-desktop"));
    expect(visibleListItemIds()).toEqual(["q-a", "q-d"]);

    // Adding a second type extends the set.
    await user.click(screen.getByTestId("evaluator-list-type-chip-open-desktop"));
    expect(visibleListItemIds()).toEqual(["q-a", "q-b", "q-d"]);
  });

  it("filters by difficulty", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForReady();

    await user.click(screen.getByTestId("evaluator-list-difficulty-hard-desktop"));
    expect(visibleListItemIds()).toEqual(["q-c"]);
    expect(screen.getByTestId("evaluator-list-visible-count-desktop")).toHaveTextContent(
      "1 / 5 visible",
    );

    await user.click(screen.getByTestId("evaluator-list-difficulty-all-desktop"));
    expect(visibleListItemIds()).toHaveLength(5);
  });

  it("combines filters and reaches the empty state", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForReady();

    // mcq + hard difficulty + a search term that no mcq matches.
    await user.click(screen.getByTestId("evaluator-list-type-chip-mcq-desktop"));
    await user.click(screen.getByTestId("evaluator-list-difficulty-hard-desktop"));
    expect(visibleListItemIds()).toHaveLength(0);
    expect(screen.getByTestId("question-list-empty-desktop")).toBeInTheDocument();
    expect(screen.getByTestId("evaluator-list-visible-count-desktop")).toHaveTextContent(
      "0 / 5 visible",
    );

    // The "Clear" reset button restores everything.
    await user.click(screen.getByTestId("evaluator-list-clear-filters-desktop"));
    expect(visibleListItemIds()).toHaveLength(5);
  });

  it("keeps the form mounted on the selected question even when filtered out", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForReady();
    expect(lastQuestionId).toBe("q-a");

    // Narrow to "hard" — q-a is easy → drops out of the list, but the form
    // should still show q-a (filter is a discovery view, not a hard slice).
    await user.click(screen.getByTestId("evaluator-list-difficulty-hard-desktop"));
    expect(visibleListItemIds()).toEqual(["q-c"]);
    expect(lastQuestionId).toBe("q-a");
  });

  it("keyboard nav still walks the full list when filters are active", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForReady();
    await user.click(screen.getByTestId("evaluator-list-type-chip-fill_gaps-desktop"));
    // Only q-c visible, but j should still advance to q-b in the underlying
    // full ordering (q-a, q-b, q-c, …).
    fireEvent.keyDown(window, { key: "j" });
    await waitFor(() => expect(lastQuestionId).toBe("q-b"));
  });
});
