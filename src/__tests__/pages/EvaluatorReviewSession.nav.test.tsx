/**
 * #680 — EvaluatorReviewSession navigation / keyboard / progress tests.
 *
 * Mocks Supabase + auth + the unified-question hook so the page can mount
 * with a deterministic 3-question bank, then verifies:
 *   - keyboard shortcuts (j/k, Cmd+Enter, 1/2/3) drive selection / form
 *   - clicking Next/Prev / "jump to next unevaluated" works
 *   - auto-advance after save moves to the next unevaluated, and the toggle
 *     disables that
 *   - the progress bar reflects evaluatedCount/total
 *   - selectedQuestionId is persisted to localStorage and restored on remount
 *
 * The form itself is stubbed so the test owns the `onSaved` trigger surface
 * and isn't slowed by Radix portals; the imperative handle is tested in
 * QuestionEvaluationForm.test.tsx.
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
    preview: "Question A preview",
    searchText: "A",
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
      question: "A",
      payload: null,
      answer_key: null,
      explanation: null,
      generation_rationale: null,
    },
  },
  {
    id: "q-b",
    type: "mcq",
    preview: "Question B preview",
    searchText: "B",
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
      question: "B",
      payload: null,
      answer_key: null,
      explanation: null,
      generation_rationale: null,
    },
  },
  {
    id: "q-c",
    type: "mcq",
    preview: "Question C preview",
    searchText: "C",
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
      question: "C",
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

// Stub Supabase — session lookup returns a fresh session id, evaluation
// fetch returns empty. The chain mock is permissive: every transitional
// method returns `this` and terminals resolve a sensible default.
vi.mock("@/integrations/supabase/client", () => {
  const sessionLookup = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: { id: "sess-1" }, error: null }),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
  };
  // First call: lookup existing → null. Second: insert new → returns id.
  // Course title fetch: maybeSingle → null is fine.
  // Evaluations fetch (`in("question_id", ids)`) → empty array.
  const make = () => {
    const obj = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      insert: vi.fn().mockReturnThis(),
      in: vi.fn().mockResolvedValue({ data: [], error: null }),
      single: vi.fn().mockResolvedValue({ data: { id: "sess-1" }, error: null }),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    };
    return obj;
  };
  return {
    supabase: {
      from: vi.fn(() => make()),
    },
    __sessionLookup: sessionLookup,
  };
});

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

// Stub the form so the test owns the onSaved trigger and isn't dragged into
// Radix-portal / textarea internals. The stub honors the ref-handle contract
// (`submit()` calls a no-op spy, `setVerdict()` records the picked code) so
// the Ctrl+Enter and 1/2/3 keyboard paths are still exercised end-to-end.
const formSubmitSpy = vi.hoisted(() => vi.fn());
const formSetVerdictSpy = vi.hoisted(() => vi.fn());
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
          submit: () => formSubmitSpy(question.id),
          setVerdict: (code) => formSetVerdictSpy(code, question.id),
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
  formSubmitSpy.mockReset();
  formSetVerdictSpy.mockReset();
  lastOnSaved = null;
  lastQuestionId = null;
  window.localStorage.clear();
});

describe("EvaluatorReviewSession — navigation, keyboard, progress (#680)", () => {
  it("starts on the first question and advances with the j key", async () => {
    renderPage();
    await waitForReady();
    expect(lastQuestionId).toBe("q-a");
    fireEvent.keyDown(window, { key: "j" });
    await waitFor(() => expect(lastQuestionId).toBe("q-b"));
    fireEvent.keyDown(window, { key: "j" });
    await waitFor(() => expect(lastQuestionId).toBe("q-c"));
    // No wrap on next — stays on last.
    fireEvent.keyDown(window, { key: "j" });
    await waitFor(() => expect(lastQuestionId).toBe("q-c"));
  });

  it("goes backward with the k key", async () => {
    renderPage();
    await waitForReady();
    fireEvent.keyDown(window, { key: "j" });
    fireEvent.keyDown(window, { key: "j" });
    await waitFor(() => expect(lastQuestionId).toBe("q-c"));
    fireEvent.keyDown(window, { key: "k" });
    await waitFor(() => expect(lastQuestionId).toBe("q-b"));
    fireEvent.keyDown(window, { key: "k" });
    await waitFor(() => expect(lastQuestionId).toBe("q-a"));
    // No wrap on prev either.
    fireEvent.keyDown(window, { key: "k" });
    await waitFor(() => expect(lastQuestionId).toBe("q-a"));
  });

  it("Cmd/Ctrl+Enter calls submit() on the form handle", async () => {
    renderPage();
    await waitForReady();
    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });
    expect(formSubmitSpy).toHaveBeenCalledWith("q-a");
  });

  it("1/2/3 set the verdict via the form handle", async () => {
    renderPage();
    await waitForReady();
    fireEvent.keyDown(window, { key: "1" });
    fireEvent.keyDown(window, { key: "2" });
    fireEvent.keyDown(window, { key: "3" });
    expect(formSetVerdictSpy).toHaveBeenNthCalledWith(1, "good", "q-a");
    expect(formSetVerdictSpy).toHaveBeenNthCalledWith(2, "needs_fixing", "q-a");
    expect(formSetVerdictSpy).toHaveBeenNthCalledWith(3, "reject", "q-a");
  });

  it("does NOT fire shortcuts while typing in a text input", async () => {
    renderPage();
    await waitForReady();
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    fireEvent.keyDown(input, { key: "j" });
    fireEvent.keyDown(input, { key: "1" });
    // Selection didn't change; verdict not set.
    expect(lastQuestionId).toBe("q-a");
    expect(formSetVerdictSpy).not.toHaveBeenCalled();
    // Ctrl+Enter STILL works inside text inputs — that's the whole point.
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    expect(formSubmitSpy).toHaveBeenCalledWith("q-a");
    document.body.removeChild(input);
  });

  it("Next/Prev buttons in the nav bar move between questions", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForReady();
    await user.click(screen.getByTestId("nav-next"));
    await waitFor(() => expect(lastQuestionId).toBe("q-b"));
    await user.click(screen.getByTestId("nav-prev"));
    await waitFor(() => expect(lastQuestionId).toBe("q-a"));
  });

  it("jump-to-next-unevaluated skips already-saved questions and wraps", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForReady();
    // Disable auto-advance so save doesn't double up with the jump.
    await user.click(screen.getByTestId("nav-auto-advance"));
    // Save q-a (still selected since auto-advance is off); jump → q-b.
    simulateSave("q-a");
    fireEvent.keyDown(window, { key: "u" });
    await waitFor(() => expect(lastQuestionId).toBe("q-b"));
    // Save q-b and jump again → q-c (the only remaining unevaluated).
    simulateSave("q-b");
    fireEvent.keyDown(window, { key: "u" });
    await waitFor(() => expect(lastQuestionId).toBe("q-c"));
    // Save q-c then jump — none remain; the toast fires and we stay put.
    simulateSave("q-c");
    fireEvent.keyDown(window, { key: "u" });
    await new Promise((r) => setTimeout(r, 10));
    expect(lastQuestionId).toBe("q-c");
  });

  it("auto-advances after save when the toggle is on (default)", async () => {
    renderPage();
    await waitForReady();
    expect(lastQuestionId).toBe("q-a");
    simulateSave("q-a");
    await waitFor(() => expect(lastQuestionId).toBe("q-b"));
  });

  it("stays put after save when auto-advance is disabled", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForReady();
    await user.click(screen.getByTestId("nav-auto-advance"));
    simulateSave("q-a");
    // Give React a tick to settle.
    await new Promise((r) => setTimeout(r, 10));
    expect(lastQuestionId).toBe("q-a");
  });

  it("renders a progress bar reflecting evaluatedCount / total", async () => {
    renderPage();
    await waitForReady();
    expect(screen.getByTestId("session-progress-label")).toHaveTextContent("0 / 3");
    expect(screen.getByTestId("session-progress")).toHaveAttribute(
      "aria-label",
      "Πρόοδος αξιολόγησης: 0 από 3",
    );
    simulateSave("q-a");
    await waitFor(() => {
      expect(screen.getByTestId("session-progress-label")).toHaveTextContent("1 / 3");
    });
    expect(screen.getByTestId("session-progress")).toHaveAttribute(
      "aria-label",
      "Πρόοδος αξιολόγησης: 1 από 3",
    );
  });

  it("persists selection to localStorage so a remount restores it", async () => {
    const { unmount } = renderPage();
    await waitForReady();
    fireEvent.keyDown(window, { key: "j" });
    await waitFor(() => expect(lastQuestionId).toBe("q-b"));
    expect(window.localStorage.getItem("evaluator:lastQuestion:sess-1")).toBe("q-b");
    unmount();

    // Re-render — selection should restore to q-b instead of defaulting to q-a.
    renderPage();
    await waitFor(() => expect(lastQuestionId).toBe("q-b"));
  });
});
