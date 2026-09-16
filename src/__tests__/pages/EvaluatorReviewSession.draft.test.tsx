/**
 * #682 — EvaluatorReviewSession draft + sampling persistence tests.
 *
 * Verifies the page-level wiring around draft autosave & resilient sampling:
 *   - the question list shows a "dirty" dot for questions with active
 *     local drafts (seeded from localStorage on mount)
 *   - sampling decisions persist across remount via localStorage so a
 *     refreshed session shows the same sampled/unsampled questions
 *   - on save failure the page rolls back the optimistic row via
 *     onSaveFailed and the dirty dot reappears
 *
 * The form is stubbed (same shape as the #680/#681 suites) so the test
 * owns the onSaved/onSaveFailed/onDirtyChange surface and doesn't drag in
 * Radix portals.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
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

// Stub the form so the test owns the onDirtyChange / onSaveFailed / showSampling
// inputs and isn't dragged into Radix portals.
let lastDirtyChange: ((dirty: boolean) => void) | null = null;
let lastOnSaved: ((row: unknown) => void) | null = null;
let lastOnSaveFailed: ((prev: unknown) => void) | null = null;
let lastShowSampling: boolean | null = null;
let lastQuestionId: string | null = null;

vi.mock("@/components/evaluator/QuestionEvaluationForm", () => {
  type StubProps = {
    question: { id: string };
    showSampling: boolean;
    onSaved: (row: unknown) => void;
    onSaveFailed?: (prev: unknown) => void;
    onDirtyChange?: (dirty: boolean) => void;
  };
  const QuestionEvaluationForm = forwardRef<QuestionEvaluationFormHandle, StubProps>(
    function StubForm(
      { question, showSampling, onSaved, onSaveFailed, onDirtyChange },
      ref,
    ) {
      lastQuestionId = question.id;
      lastShowSampling = showSampling;
      useEffect(() => {
        lastDirtyChange = onDirtyChange ?? null;
        lastOnSaved = onSaved;
        lastOnSaveFailed = onSaveFailed ?? null;
      }, [onDirtyChange, onSaved, onSaveFailed]);
      useImperativeHandle(ref, () => ({ submit: () => {}, setVerdict: () => {} }), []);
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
  lastDirtyChange = null;
  lastOnSaved = null;
  lastOnSaveFailed = null;
  lastShowSampling = null;
  lastQuestionId = null;
  window.localStorage.clear();
});

describe("EvaluatorReviewSession — drafts + sampling persistence (#682)", () => {
  it("shows a dirty dot in the question list when the form reports dirty", async () => {
    renderPage();
    await waitForReady();
    // No dot yet for the active question.
    expect(screen.queryAllByTestId("question-dirty-q-a")).toHaveLength(0);

    act(() => lastDirtyChange?.(true));
    await waitFor(() => {
      expect(screen.getAllByTestId("question-dirty-q-a").length).toBeGreaterThan(0);
    });

    // Clearing the dirty flag removes the dot.
    act(() => lastDirtyChange?.(false));
    await waitFor(() => {
      expect(screen.queryAllByTestId("question-dirty-q-a")).toHaveLength(0);
    });
  });

  it("seeds dirty dots from localStorage drafts on mount", async () => {
    // A stale draft for q-b exists before the page mounts. The page should
    // pick it up via listDraftQuestionIds() and render the dot immediately.
    window.localStorage.setItem(
      "evaluator:draft:evaluator-1:q-b",
      JSON.stringify({ verdict: "good" }),
    );
    renderPage();
    await waitForReady();
    await waitFor(() => {
      expect(screen.getAllByTestId("question-dirty-q-b").length).toBeGreaterThan(0);
    });
  });

  it("persists sampling decisions across remount so the same questions stay sampled", async () => {
    // First mount: the page rolls the dice for q-a (its sampling decision
    // is consulted because the form is rendered). We can't observe the
    // boolean directly without instrumentation, so we read the localStorage
    // key the page writes.
    const { unmount } = renderPage();
    await waitForReady();
    // showSampling for q-a has now been decided. The page wrote the
    // record under `evaluator:sampling:sess-1`.
    await waitFor(() => {
      const raw = window.localStorage.getItem("evaluator:sampling:sess-1");
      expect(raw).not.toBeNull();
    });
    const firstDecisions = JSON.parse(
      window.localStorage.getItem("evaluator:sampling:sess-1") ?? "{}",
    );
    expect("q-a" in firstDecisions).toBe(true);
    const firstSamplingForA = firstDecisions["q-a"];

    unmount();

    // Remount — the page should re-use the stored decision instead of
    // re-rolling. We assert by reading the same key after the remount
    // settles: the value for q-a must be byte-equal.
    renderPage();
    await waitForReady();
    await waitFor(() => {
      const raw = window.localStorage.getItem("evaluator:sampling:sess-1");
      expect(raw).not.toBeNull();
    });
    const secondDecisions = JSON.parse(
      window.localStorage.getItem("evaluator:sampling:sess-1") ?? "{}",
    );
    expect(secondDecisions["q-a"]).toBe(firstSamplingForA);
    // Form prop also reflects the persisted value.
    expect(lastShowSampling).toBe(firstSamplingForA);
  });

  it("rolls back the optimistic row when the form reports onSaveFailed", async () => {
    renderPage();
    await waitForReady();
    expect(lastQuestionId).toBe("q-a");
    // Snapshot the q-a callbacks BEFORE triggering the optimistic save —
    // auto-advance flips the selection to q-b and the stub form remounts,
    // which would replace the live `lastOnSaveFailed` reference. In the
    // real app the form captures `onSaveFailed` in its `handleSubmit`
    // closure at submit time, so the callback that actually fires after
    // a server rejection is always the one bound to the question the
    // user clicked Save on — what we mirror here with a local snapshot.
    const savedOnSaved = lastOnSaved!;
    const savedOnSaveFailed = lastOnSaveFailed!;
    act(() => {
      savedOnSaved({
        id: "row-q-a",
        session_id: "sess-1",
        question_id: "q-a",
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
    await waitFor(() => {
      expect(screen.getAllByTestId("question-done-q-a").length).toBeGreaterThan(0);
    });

    // Then the server fails → rollback through the *snapshotted* callback
    // (bound to q-a, regardless of where the user has since navigated).
    act(() => savedOnSaveFailed(null));
    await waitFor(() => {
      expect(screen.queryAllByTestId("question-done-q-a")).toHaveLength(0);
    });
    await waitFor(() => {
      expect(screen.getAllByTestId("question-dirty-q-a").length).toBeGreaterThan(0);
    });
  });
});
