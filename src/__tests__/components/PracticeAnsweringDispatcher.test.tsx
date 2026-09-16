/**
 * #756 — PracticeAnsweringDispatcher tests.
 *
 * Each `Single*AnsweringPanel` is stubbed with a sentinel that surfaces the
 * `questionId` and the `onCompleted` callback so the assertions stay focused
 * on the dispatcher's responsibilities:
 *   - mapping `question.type` to the matching panel
 *   - graceful fallback for unsupported types
 *   - missing-offering warning
 *   - completion footer (Back to list / Next question) gating
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const panelCalls = vi.hoisted(() => ({
  mcq: vi.fn(),
  open: vi.fn(),
  fill_gaps: vi.fn(),
  ordering: vi.fn(),
  classification: vi.fn(),
}));

vi.mock("@/components/student-answering", async () => {
  const React = await import("react");
  function makeStub(type: keyof typeof panelCalls) {
    return function Stub(props: {
      questionId: string;
      offeringId: string | null;
      onBack: () => void;
      onCompleted?: (r?: { grade?: number }) => void;
    }) {
      panelCalls[type](props);
      return React.createElement(
        "div",
        { "data-testid": `panel-${type}`, "data-question-id": props.questionId },
        React.createElement(
          "button",
          { onClick: () => props.onCompleted?.({ grade: 100 }) },
          "fake-complete",
        ),
        React.createElement("span", null, `offering=${String(props.offeringId)}`),
      );
    };
  }
  return {
    SingleMcqAnsweringPanel: makeStub("mcq"),
    SingleOpenAnsweringPanel: makeStub("open"),
    SingleFillGapsAnsweringPanel: makeStub("fill_gaps"),
    SingleOrderingAnsweringPanel: makeStub("ordering"),
    SingleClassificationAnsweringPanel: makeStub("classification"),
  };
});

import { PracticeAnsweringDispatcher } from "@/components/student/PracticeAnsweringDispatcher";
import type { StudentPracticeQuestion } from "@/hooks/useStudentPracticeQuestions";

const mkQ = (over: Partial<StudentPracticeQuestion>): StudentPracticeQuestion => ({
  id: over.id ?? "q-1",
  type: over.type ?? "mcq",
  stemPreview: over.stemPreview ?? "preview",
  difficulty: over.difficulty ?? "medium",
  status: over.status ?? "not_started",
  offeringId: over.offeringId ?? "off-1",
  chapters: over.chapters ?? [],
  ...(over.grade !== undefined ? { grade: over.grade } : {}),
  ...(over.answeringMode !== undefined ? { answeringMode: over.answeringMode } : {}),
});

const defaultProps = {
  courseId: "course-1",
  hasNext: false,
  onBack: vi.fn(),
  onNext: vi.fn(),
  onCompleted: vi.fn(),
  onStatusChange: vi.fn(),
};

beforeEach(() => {
  for (const k of Object.keys(panelCalls) as (keyof typeof panelCalls)[]) {
    panelCalls[k].mockReset();
  }
  defaultProps.onBack = vi.fn();
  defaultProps.onNext = vi.fn();
  defaultProps.onCompleted = vi.fn();
  defaultProps.onStatusChange = vi.fn();
});

describe("PracticeAnsweringDispatcher", () => {
  it.each([
    ["mcq", "panel-mcq"],
    ["open", "panel-open"],
    ["fill_gaps", "panel-fill_gaps"],
    ["ordering", "panel-ordering"],
    ["classification", "panel-classification"],
  ] as const)("routes %s questions to %s", (type, testId) => {
    const question = mkQ({ id: `q-${type}`, type });
    render(
      <PracticeAnsweringDispatcher {...defaultProps} question={question} />,
    );
    expect(screen.getByTestId(testId)).toHaveAttribute(
      "data-question-id",
      `q-${type}`,
    );
  });

  it("forwards courseId and offeringId to the panel", () => {
    const question = mkQ({ id: "q-mcq", type: "mcq", offeringId: "off-42" });
    render(
      <PracticeAnsweringDispatcher {...defaultProps} question={question} />,
    );
    expect(panelCalls.mcq).toHaveBeenCalledWith(
      expect.objectContaining({
        questionId: "q-mcq",
        courseId: "course-1",
        offeringId: "off-42",
      }),
    );
  });

  it("renders the unsupported-type fallback for an unknown question type", async () => {
    const user = userEvent.setup();
    // Force an unknown type past the public type union.
    const question = mkQ({ id: "q-x", type: "fubar" as never });
    render(
      <PracticeAnsweringDispatcher {...defaultProps} question={question} />,
    );
    expect(
      screen.getByText(/can't be answered here yet/i),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("panel-mcq")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /back to list/i }));
    expect(defaultProps.onBack).toHaveBeenCalledTimes(1);
  });

  it("shows the missing-offering warning when offeringId is empty", () => {
    const question = mkQ({ id: "q-mcq", type: "mcq", offeringId: "" });
    render(
      <PracticeAnsweringDispatcher {...defaultProps} question={question} />,
    );
    expect(
      screen.getByText(/assignment may have changed/i),
    ).toBeInTheDocument();
    // Panel still renders so the student can read the question (view mode).
    expect(screen.getByTestId("panel-mcq")).toBeInTheDocument();
    // Panel receives null when the offering string is empty.
    expect(panelCalls.mcq).toHaveBeenCalledWith(
      expect.objectContaining({ offeringId: null }),
    );
  });

  it("does NOT show the completion footer before the panel reports completed", () => {
    const question = mkQ({ id: "q-mcq", type: "mcq" });
    render(
      <PracticeAnsweringDispatcher {...defaultProps} question={question} hasNext />,
    );
    expect(screen.queryByTestId("next-question")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^back to list$/i }),
    ).not.toBeInTheDocument();
  });

  it("shows the completion footer + bubbles onCompleted after the panel fires it", async () => {
    const user = userEvent.setup();
    const question = mkQ({ id: "q-mcq", type: "mcq" });
    render(
      <PracticeAnsweringDispatcher {...defaultProps} question={question} hasNext />,
    );

    await user.click(screen.getByText("fake-complete"));

    expect(defaultProps.onCompleted).toHaveBeenCalledWith({ grade: 100 });
    expect(screen.getByTestId("next-question")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^back to list$/i }),
    ).toBeInTheDocument();
  });

  it("omits the Next question CTA when hasNext is false", async () => {
    const user = userEvent.setup();
    const question = mkQ({ id: "q-mcq", type: "mcq" });
    render(
      <PracticeAnsweringDispatcher {...defaultProps} question={question} hasNext={false} />,
    );

    await user.click(screen.getByText("fake-complete"));

    expect(screen.queryByTestId("next-question")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^back to list$/i }),
    ).toBeInTheDocument();
  });

  it("fires onNext when the Next question CTA is clicked", async () => {
    const user = userEvent.setup();
    const question = mkQ({ id: "q-mcq", type: "mcq" });
    render(
      <PracticeAnsweringDispatcher {...defaultProps} question={question} hasNext />,
    );

    await user.click(screen.getByText("fake-complete"));
    await user.click(screen.getByTestId("next-question"));

    expect(defaultProps.onNext).toHaveBeenCalledTimes(1);
  });

  it("clears completion state when rotated to a new question id", async () => {
    const user = userEvent.setup();
    const q1 = mkQ({ id: "q-a", type: "mcq" });
    const q2 = mkQ({ id: "q-b", type: "open" });

    const { rerender } = render(
      <PracticeAnsweringDispatcher {...defaultProps} question={q1} hasNext />,
    );
    await user.click(screen.getByText("fake-complete"));
    expect(screen.getByTestId("next-question")).toBeInTheDocument();

    rerender(
      <PracticeAnsweringDispatcher {...defaultProps} question={q2} hasNext />,
    );
    // Footer was tied to q-a's completion — it should not carry over to q-b.
    expect(screen.queryByTestId("next-question")).not.toBeInTheDocument();
    expect(screen.getByTestId("panel-open")).toBeInTheDocument();
  });
});
