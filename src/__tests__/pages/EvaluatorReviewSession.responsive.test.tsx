/**
 * #681 — EvaluatorReviewSession responsive surface tests.
 *
 * Verifies the additions for phone/tablet ergonomics:
 *   - the mobile drawer opens from the top nav, lists the questions, and
 *     selecting one closes it (and updates the form selection)
 *   - the sticky mobile action bar mounts and its Save/Prev/Next dispatch
 *     through the same code paths as the desktop nav / form
 *   - the action bar mirrors the form's saving flag through `onSavingChange`
 *
 * The form is stubbed so the test owns the imperative-handle surface (#680)
 * the page calls into.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { forwardRef, useEffect, useImperativeHandle } from "react";
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

// Pointer-capture shim for Radix dialog/sheet.
beforeAll(() => {
  if (!Element.prototype.hasPointerCapture) {
    (Element.prototype as unknown as { hasPointerCapture: () => boolean }).hasPointerCapture =
      () => false;
  }
  if (!Element.prototype.setPointerCapture) {
    (Element.prototype as unknown as { setPointerCapture: () => void }).setPointerCapture =
      () => {};
  }
});

const formSubmitSpy = vi.hoisted(() => vi.fn());
let lastQuestionId: string | null = null;
let lastSavingChange: ((saving: boolean) => void) | null = null;

vi.mock("@/components/evaluator/QuestionEvaluationForm", () => {
  type StubProps = {
    question: { id: string };
    onSaved: (row: unknown) => void;
    onSavingChange?: (saving: boolean) => void;
  };
  const QuestionEvaluationForm = forwardRef<QuestionEvaluationFormHandle, StubProps>(
    function StubForm({ question, onSavingChange }, ref) {
      lastQuestionId = question.id;
      // Mirror prop into module state so the test can flip "saving" without
      // having to know the form's internals.
      useEffect(() => {
        lastSavingChange = onSavingChange ?? null;
      }, [onSavingChange]);
      useImperativeHandle(
        ref,
        () => ({
          submit: () => formSubmitSpy(question.id),
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

beforeEach(() => {
  formSubmitSpy.mockReset();
  lastQuestionId = null;
  lastSavingChange = null;
  window.localStorage.clear();
});

describe("EvaluatorReviewSession — responsive (#681)", () => {
  it("renders a mobile drawer trigger that opens a list of questions", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForReady();
    const trigger = screen.getByTestId("open-list-drawer");
    expect(trigger).toBeInTheDocument();
    await user.click(trigger);
    // Drawer mounts; both questions appear inside it.
    const drawer = await screen.findByTestId("question-list-drawer");
    expect(drawer).toBeInTheDocument();
    // Two list copies exist — one in the (hidden on mobile) desktop rail and
    // one in the drawer; just confirm at least one entry per question renders.
    expect(screen.getAllByTestId("question-list-item-q-a").length).toBeGreaterThan(0);
    expect(screen.getAllByTestId("question-list-item-q-b").length).toBeGreaterThan(0);
  });

  it("selecting a question from the drawer updates the form and closes the drawer", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForReady();
    expect(lastQuestionId).toBe("q-a");
    await user.click(screen.getByTestId("open-list-drawer"));
    await screen.findByTestId("question-list-drawer");
    // Pick the drawer-rendered q-b. Use the entry inside the drawer.
    const drawer = screen.getByTestId("question-list-drawer");
    const items = drawer.querySelectorAll<HTMLElement>(
      '[data-testid="question-list-item-q-b"]',
    );
    expect(items.length).toBeGreaterThan(0);
    await user.click(items[0]);
    await waitFor(() => expect(lastQuestionId).toBe("q-b"));
    // Drawer is gone.
    await waitFor(() => {
      expect(screen.queryByTestId("question-list-drawer")).toBeNull();
    });
  });

  it("renders a sticky mobile action bar with Prev/Next/Save", async () => {
    renderPage();
    await waitForReady();
    expect(screen.getByTestId("evaluator-mobile-action-bar")).toBeInTheDocument();
    expect(screen.getByTestId("mobile-action-prev")).toBeInTheDocument();
    expect(screen.getByTestId("mobile-action-next")).toBeInTheDocument();
    expect(screen.getByTestId("mobile-action-save")).toBeInTheDocument();
  });

  it("mobile action bar Save dispatches the form's submit handle", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForReady();
    await user.click(screen.getByTestId("mobile-action-save"));
    expect(formSubmitSpy).toHaveBeenCalledWith("q-a");
  });

  it("mobile action bar Prev/Next move the selection", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForReady();
    expect(lastQuestionId).toBe("q-a");
    await user.click(screen.getByTestId("mobile-action-next"));
    await waitFor(() => expect(lastQuestionId).toBe("q-b"));
    await user.click(screen.getByTestId("mobile-action-prev"));
    await waitFor(() => expect(lastQuestionId).toBe("q-a"));
  });

  it("mobile action bar Prev is disabled on the first question, Next on the last", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForReady();
    expect(screen.getByTestId("mobile-action-prev")).toBeDisabled();
    expect(screen.getByTestId("mobile-action-next")).not.toBeDisabled();
    await user.click(screen.getByTestId("mobile-action-next"));
    await waitFor(() => expect(lastQuestionId).toBe("q-b"));
    expect(screen.getByTestId("mobile-action-prev")).not.toBeDisabled();
    expect(screen.getByTestId("mobile-action-next")).toBeDisabled();
  });

  it("mobile action bar Save mirrors the form's saving flag through onSavingChange", async () => {
    renderPage();
    await waitForReady();
    // Initially the form mirrors saving=false; the Save button is enabled.
    const saveButton = screen.getByTestId("mobile-action-save");
    expect(saveButton).not.toBeDisabled();
    // Flip the mirror to true — the page should disable Save and swap label.
    expect(lastSavingChange).not.toBeNull();
    act(() => {
      lastSavingChange?.(true);
    });
    await waitFor(() =>
      expect(screen.getByTestId("mobile-action-save")).toBeDisabled(),
    );
    expect(screen.getByTestId("mobile-action-save")).toHaveTextContent(
      "Saving…",
    );
  });
});
