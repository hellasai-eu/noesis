/**
 * #776 — PracticeRandomRun tests.
 *
 * The PracticeAnsweringDispatcher is stubbed so the tests focus on the run
 * host's responsibilities: progress indicator, advance-on-next, early exit
 * and the end-of-run summary.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const dispatcherCalls = vi.hoisted(() => ({ current: [] as unknown[] }));

vi.mock("@/components/student/PracticeAnsweringDispatcher", async () => {
  const React = await import("react");
  return {
    PracticeAnsweringDispatcher: (props: {
      question: { id: string; type: string };
      hasNext: boolean;
      onBack: () => void;
      onNext: () => void;
      onCompleted?: (r?: { grade?: number; allCorrect?: boolean }) => void;
      onStatusChange?: (s: string) => void;
    }) => {
      dispatcherCalls.current.push(props);
      return React.createElement(
        "div",
        {
          "data-testid": "dispatcher",
          "data-question-id": props.question.id,
          "data-has-next": String(props.hasNext),
        },
        React.createElement(
          "button",
          {
            onClick: () => props.onCompleted?.({ grade: 100, allCorrect: true }),
            "data-testid": "dispatcher-complete-correct",
          },
          "complete-correct",
        ),
        React.createElement(
          "button",
          {
            onClick: () =>
              props.onCompleted?.({ grade: 25, allCorrect: false }),
            "data-testid": "dispatcher-complete-wrong",
          },
          "complete-wrong",
        ),
        React.createElement(
          "button",
          {
            onClick: () => props.onCompleted?.({ grade: 60 }),
            "data-testid": "dispatcher-complete-graded",
          },
          "complete-graded",
        ),
        React.createElement(
          "button",
          { onClick: props.onNext, "data-testid": "dispatcher-next" },
          "next",
        ),
        React.createElement(
          "button",
          { onClick: props.onBack, "data-testid": "dispatcher-back" },
          "back",
        ),
        React.createElement(
          "button",
          {
            onClick: () => props.onStatusChange?.("in_progress"),
            "data-testid": "dispatcher-status-in-progress",
          },
          "status-in-progress",
        ),
      );
    },
  };
});

vi.mock("@/lib/latex-utils", () => ({
  formatQuestionText: (text: string) => text ?? "",
  processLatexContent: (text: string) => text ?? "",
}));

import { PracticeRandomRun } from "@/components/student/PracticeRandomRun";
import type { StudentPracticeQuestion } from "@/hooks/useStudentPracticeQuestions";

const mkQ = (
  over: Partial<StudentPracticeQuestion> & { id: string },
): StudentPracticeQuestion => ({
  type: over.type ?? "mcq",
  stemPreview: over.stemPreview ?? `preview-${over.id}`,
  difficulty: over.difficulty ?? "medium",
  status: over.status ?? "not_started",
  offeringId: over.offeringId ?? "off-1",
  chapters: over.chapters ?? [],
  ...over,
});

beforeEach(() => {
  dispatcherCalls.current = [];
});

describe("PracticeRandomRun", () => {
  it("renders the first question and a progress indicator", () => {
    const run = [mkQ({ id: "a" }), mkQ({ id: "b" }), mkQ({ id: "c" })];
    render(
      <PracticeRandomRun
        courseId="course-1"
        questionsInRun={run}
        onExit={vi.fn()}
      />,
    );

    expect(screen.getByTestId("dispatcher")).toHaveAttribute(
      "data-question-id",
      "a",
    );
    expect(screen.getByTestId("run-progress")).toHaveTextContent(
      "Question 1 / 3",
    );
  });

  it("advances to the next question and updates progress when Next fires", async () => {
    const user = userEvent.setup();
    const run = [mkQ({ id: "a" }), mkQ({ id: "b" })];
    render(
      <PracticeRandomRun
        courseId="course-1"
        questionsInRun={run}
        onExit={vi.fn()}
      />,
    );

    await user.click(screen.getByTestId("dispatcher-complete-correct"));
    await user.click(screen.getByTestId("dispatcher-next"));

    await waitFor(() => {
      expect(screen.getByTestId("dispatcher")).toHaveAttribute(
        "data-question-id",
        "b",
      );
    });
    expect(screen.getByTestId("run-progress")).toHaveTextContent(
      "Question 2 / 2",
    );
    // Last question — dispatcher should know there are no more after it.
    expect(screen.getByTestId("dispatcher")).toHaveAttribute(
      "data-has-next",
      "false",
    );
  });

  it("shows the summary with per-question outcomes after the last question", async () => {
    const user = userEvent.setup();
    const run = [
      mkQ({ id: "a", type: "mcq", stemPreview: "What is 1+1?" }),
      mkQ({ id: "b", type: "open", stemPreview: "Explain X" }),
    ];
    const onRunComplete = vi.fn();
    render(
      <PracticeRandomRun
        courseId="course-1"
        questionsInRun={run}
        onExit={vi.fn()}
        onRunComplete={onRunComplete}
      />,
    );

    // Q1: correct
    await user.click(screen.getByTestId("dispatcher-complete-correct"));
    await user.click(screen.getByTestId("dispatcher-next"));
    // Q2 mounts
    await waitFor(() => {
      expect(screen.getByTestId("dispatcher")).toHaveAttribute(
        "data-question-id",
        "b",
      );
    });
    // Q2: graded (no allCorrect)
    await user.click(screen.getByTestId("dispatcher-complete-graded"));
    await user.click(screen.getByTestId("run-finish"));

    // Summary card visible.
    const summary = await screen.findByTestId("run-summary");
    expect(summary).toBeInTheDocument();
    expect(onRunComplete).toHaveBeenCalledTimes(1);

    // Two summary rows for the two questions in the run.
    const items = within(summary).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(screen.getByTestId("summary-outcome-a")).toHaveTextContent("Correct");
    // Graded-but-not-boolean completions show a neutral "Submitted" — the
    // numeric grade is deliberately hidden on the practice surface.
    expect(screen.getByTestId("summary-outcome-b")).toHaveTextContent(
      "Submitted",
    );
  });

  it("marks not-completed rows in the summary as 'Not completed' on early exit", async () => {
    const user = userEvent.setup();
    const run = [mkQ({ id: "a" }), mkQ({ id: "b" }), mkQ({ id: "c" })];
    render(
      <PracticeRandomRun
        courseId="course-1"
        questionsInRun={run}
        onExit={vi.fn()}
      />,
    );

    // Complete the first question, then exit early via the header CTA.
    await user.click(screen.getByTestId("dispatcher-complete-correct"));
    await user.click(screen.getByTestId("run-exit"));

    const summary = await screen.findByTestId("run-summary");
    expect(within(summary).getByText(/You answered 1 of 3 questions/)).toBeInTheDocument();
    expect(screen.getByTestId("summary-outcome-a")).toHaveTextContent("Correct");
    expect(screen.getByTestId("summary-outcome-b")).toHaveTextContent(
      "Not completed",
    );
    expect(screen.getByTestId("summary-outcome-c")).toHaveTextContent(
      "Not completed",
    );
  });

  it("calls onExit when 'Back to list' is clicked from the summary", async () => {
    const user = userEvent.setup();
    const onExit = vi.fn();
    const run = [mkQ({ id: "a" })];
    render(
      <PracticeRandomRun
        courseId="course-1"
        questionsInRun={run}
        onExit={onExit}
      />,
    );

    await user.click(screen.getByTestId("dispatcher-complete-correct"));
    await user.click(screen.getByTestId("run-finish"));
    await user.click(screen.getByTestId("run-back-to-list"));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("forwards per-question status changes to the parent", async () => {
    const user = userEvent.setup();
    const onQuestionStatusChange = vi.fn();
    const run = [mkQ({ id: "a" })];
    render(
      <PracticeRandomRun
        courseId="course-1"
        questionsInRun={run}
        onExit={vi.fn()}
        onQuestionStatusChange={onQuestionStatusChange}
      />,
    );

    await user.click(screen.getByTestId("dispatcher-status-in-progress"));
    expect(onQuestionStatusChange).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a" }),
      "in_progress",
    );
  });

  it("renders a plain incorrect outcome without the grade when allCorrect=false", async () => {
    const user = userEvent.setup();
    const run = [mkQ({ id: "a" })];
    render(
      <PracticeRandomRun
        courseId="course-1"
        questionsInRun={run}
        onExit={vi.fn()}
      />,
    );

    await user.click(screen.getByTestId("dispatcher-complete-wrong"));
    await user.click(screen.getByTestId("run-finish"));

    // The completion carries a grade, but practice never surfaces the number.
    expect(screen.getByTestId("summary-outcome-a")).toHaveTextContent("Incorrect");
    expect(screen.getByTestId("summary-outcome-a")).not.toHaveTextContent("%");
  });

  it("renders the summary immediately when the run is empty", () => {
    render(
      <PracticeRandomRun
        courseId="course-1"
        questionsInRun={[]}
        onExit={vi.fn()}
      />,
    );
    expect(screen.getByTestId("run-summary")).toBeInTheDocument();
    expect(screen.queryByTestId("dispatcher")).not.toBeInTheDocument();
  });

  it("propagates hasNext=true to the dispatcher while more questions remain", () => {
    const run = [mkQ({ id: "a" }), mkQ({ id: "b" })];
    render(
      <PracticeRandomRun
        courseId="course-1"
        questionsInRun={run}
        onExit={vi.fn()}
      />,
    );
    expect(screen.getByTestId("dispatcher")).toHaveAttribute(
      "data-has-next",
      "true",
    );
  });
});
