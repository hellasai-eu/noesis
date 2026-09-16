/**
 * #668 + #683 — End-of-session summary dialog tests.
 *
 * Verifies the two-step (review → finalize) flow:
 *   - flagged questions render with their problem categories
 *   - the auto-fill button populates `recurring_problems` from the tally
 *   - submit is only reachable on the finalize step, and only with would_use set
 *   - submit writes overall_quality, recurring_problems, would_use, ended_at
 *     onto the session row
 *   - back/forward step navigation doesn't commit a finish
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  EvaluationSessionSummaryDialog,
  type FlaggedQuestion,
} from "@/components/evaluator/EvaluationSessionSummaryDialog";

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

const updateMock = vi.hoisted(() => vi.fn());
const eqMock = vi.hoisted(() => vi.fn());

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: vi.fn(() => ({
      update: updateMock,
    })),
  },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

beforeEach(() => {
  updateMock.mockReset();
  eqMock.mockReset();
  updateMock.mockImplementation(() => {
    eqMock.mockImplementation(async () => ({ data: null, error: null }));
    return { eq: eqMock };
  });
});

const FLAGGED: FlaggedQuestion[] = [
  {
    questionId: "q-1",
    preview: "Question one preview",
    verdict: "needs_fixing",
    problemCategories: ["wrong_stated_answer", "unclear_stem"],
  },
  {
    questionId: "q-2",
    preview: "Question two preview",
    verdict: "reject",
    problemCategories: ["wrong_stated_answer"],
  },
  {
    questionId: "q-3",
    preview: "Question three preview",
    verdict: "needs_fixing",
    problemCategories: ["weak_distractors"],
  },
];

describe("EvaluationSessionSummaryDialog", () => {
  it("opens on the review step and shows flagged questions + tally", async () => {
    render(
      <EvaluationSessionSummaryDialog
        open
        onOpenChange={() => {}}
        sessionId="sess-1"
        flaggedQuestions={FLAGGED}
        onFinished={() => {}}
      />,
    );

    expect(screen.getByTestId("flagged-list")).toBeInTheDocument();
    expect(screen.getByTestId("flagged-item-q-1")).toBeInTheDocument();
    expect(screen.getByTestId("flagged-item-q-2")).toBeInTheDocument();
    expect(screen.getByTestId("flagged-item-q-3")).toBeInTheDocument();
    expect(screen.getByTestId("flagged-count")).toHaveTextContent("3");
    // Most-frequent problem category first (wrong_stated_answer × 2).
    const tally = screen.getByTestId("flagged-tally");
    expect(tally).toHaveTextContent(/×2/);
    expect(screen.queryByTestId("submit-summary")).not.toBeInTheDocument();
  });

  it("renders the empty state when no questions were flagged", () => {
    render(
      <EvaluationSessionSummaryDialog
        open
        onOpenChange={() => {}}
        sessionId="sess-1"
        flaggedQuestions={[]}
        onFinished={() => {}}
      />,
    );
    expect(screen.getByTestId("flagged-empty")).toBeInTheDocument();
    expect(
      screen.queryByTestId("autofill-recurring-problems"),
    ).not.toBeInTheDocument();
  });

  it("auto-fills recurring_problems from the tally", async () => {
    const user = userEvent.setup();
    render(
      <EvaluationSessionSummaryDialog
        open
        onOpenChange={() => {}}
        sessionId="sess-1"
        flaggedQuestions={FLAGGED}
        onFinished={() => {}}
      />,
    );

    await user.click(screen.getByTestId("autofill-recurring-problems"));
    const textarea = screen.getByTestId("recurring-problems") as HTMLTextAreaElement;
    expect(textarea.value).toMatch(/×2/);
  });

  it("requires would_use on the finalize step and submits the four session fields", async () => {
    const user = userEvent.setup();
    const onFinished = vi.fn();
    render(
      <EvaluationSessionSummaryDialog
        open
        onOpenChange={() => {}}
        sessionId="sess-1"
        flaggedQuestions={FLAGGED}
        onFinished={onFinished}
      />,
    );

    await user.type(
      screen.getByTestId("recurring-problems"),
      "weak distractors recurring",
    );
    await user.click(screen.getByTestId("continue-summary"));

    // On finalize, submit is disabled until would_use is picked.
    const submit = screen.getByTestId("submit-summary");
    expect(submit).toBeDisabled();
    await user.click(screen.getByLabelText("Ναι με διορθώσεις"));
    expect(submit).not.toBeDisabled();
    await user.click(submit);

    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
    const payload = updateMock.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      overall_quality: 3,
      recurring_problems: "weak distractors recurring",
      would_use: "yes_with_fixes",
    });
    expect(typeof payload.ended_at).toBe("string");
    await waitFor(() => expect(eqMock).toHaveBeenCalledWith("id", "sess-1"));
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
  });

  it("lets the user step back from finalize without committing", async () => {
    const user = userEvent.setup();
    render(
      <EvaluationSessionSummaryDialog
        open
        onOpenChange={() => {}}
        sessionId="sess-1"
        flaggedQuestions={FLAGGED}
        onFinished={() => {}}
      />,
    );
    await user.click(screen.getByTestId("continue-summary"));
    expect(screen.getByTestId("submit-summary")).toBeInTheDocument();
    await user.click(screen.getByTestId("back-summary"));
    expect(screen.getByTestId("flagged-list")).toBeInTheDocument();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("nulls recurring_problems when the textarea is left blank", async () => {
    const user = userEvent.setup();
    render(
      <EvaluationSessionSummaryDialog
        open
        onOpenChange={() => {}}
        sessionId="sess-1"
        flaggedQuestions={[]}
        onFinished={() => {}}
      />,
    );
    await user.click(screen.getByTestId("continue-summary"));
    await user.click(screen.getByLabelText("Όχι"));
    await user.click(screen.getByTestId("submit-summary"));

    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
    expect(updateMock.mock.calls[0][0]).toMatchObject({
      recurring_problems: null,
      would_use: "no",
    });
  });
});
