/**
 * #669 — Sessions tab of the per-course evaluations report.
 * Verifies Greek `would_use` labels, "In progress" badge for open sessions,
 * and per-session evaluation counts.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  CourseEvaluationsSessionsTab,
  type SessionRow,
} from "@/components/course-evaluations/CourseEvaluationsSessionsTab";

function makeSession(overrides: Partial<SessionRow>): SessionRow {
  return {
    id: "s1",
    course_id: "c1",
    created_at: "2026-06-24T10:00:00Z",
    started_at: "2026-06-24T10:00:00Z",
    ended_at: "2026-06-24T11:00:00Z",
    evaluator_id: "u1",
    overall_quality: 4,
    recurring_problems: null,
    would_use: "yes_with_fixes",
    ...overrides,
  };
}

describe("CourseEvaluationsSessionsTab", () => {
  it("renders one row per session and maps would_use code to Greek label", () => {
    render(
      <CourseEvaluationsSessionsTab
        sessions={[
          makeSession({ id: "s1", evaluator_id: "u1", would_use: "yes_asis" }),
          makeSession({ id: "s2", evaluator_id: "u2", would_use: "no" }),
        ]}
        evaluatorNameById={
          new Map([
            ["u1", "Alice"],
            ["u2", "Bob"],
          ])
        }
        evaluationsCountBySession={new Map([["s1", 3], ["s2", 0]])}
      />,
    );

    expect(screen.getByTestId("session-row-s1")).toHaveTextContent("Alice");
    expect(screen.getByTestId("session-row-s1")).toHaveTextContent("Ναι ως έχει");
    expect(screen.getByTestId("session-row-s2")).toHaveTextContent("Bob");
    expect(screen.getByTestId("session-row-s2")).toHaveTextContent("Όχι");
  });

  it("shows 'In progress' for sessions with no ended_at", () => {
    render(
      <CourseEvaluationsSessionsTab
        sessions={[makeSession({ id: "s1", ended_at: null })]}
        evaluatorNameById={new Map([["u1", "Alice"]])}
        evaluationsCountBySession={new Map()}
      />,
    );
    expect(screen.getByTestId("session-row-s1")).toHaveTextContent(
      "In progress",
    );
  });

  it("renders an em-dash when overall_quality / recurring_problems are null", () => {
    render(
      <CourseEvaluationsSessionsTab
        sessions={[
          makeSession({
            id: "s1",
            overall_quality: null,
            recurring_problems: null,
            would_use: null,
          }),
        ]}
        evaluatorNameById={new Map([["u1", "Alice"]])}
        evaluationsCountBySession={new Map()}
      />,
    );
    expect(screen.getByTestId("overall-s1")).toHaveTextContent("—");
    expect(screen.getByTestId("recurring-s1")).toHaveTextContent("—");
  });

  it("shows an empty-state row when there are no sessions", () => {
    render(
      <CourseEvaluationsSessionsTab
        sessions={[]}
        evaluatorNameById={new Map()}
        evaluationsCountBySession={new Map()}
      />,
    );
    expect(
      screen.getByText("Δεν υπάρχουν συνεδρίες αξιολόγησης ακόμη."),
    ).toBeInTheDocument();
  });
});
