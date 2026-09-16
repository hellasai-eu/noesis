/**
 * #669 — CourseEvaluationsQuestionsTab: verdict filter, "has flagged
 * problems" filter, and avg-score sort. The component is presentational —
 * its parent owns data fetch — so the test just feeds it pre-built maps.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CourseEvaluationsQuestionsTab } from "@/components/course-evaluations/CourseEvaluationsQuestionsTab";
import {
  aggregateByQuestion,
  type EvaluationRow,
} from "@/components/course-evaluations/aggregate";
import type { UnifiedQuestion } from "@/lib/unified-question";

beforeAll(() => {
  if (!Element.prototype.hasPointerCapture) {
    (Element.prototype as unknown as { hasPointerCapture: () => boolean }).hasPointerCapture =
      () => false;
  }
  if (!Element.prototype.setPointerCapture) {
    (Element.prototype as unknown as { setPointerCapture: () => void }).setPointerCapture =
      () => {};
  }
  if (!Element.prototype.scrollIntoView) {
    (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView =
      () => {};
  }
});

// Mock the supabase client — imported transitively via UnifiedQuestionsTable
// (for TypeBadge). Tests never actually call it.
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: () => ({}) },
}));

// QuestionExpandedPanel walks a fairly deep type-specific tree; stub it out
// since the drill-in dialog is not exercised by these tests.
vi.mock("@/components/question-bank/expanded", () => ({
  QuestionExpandedPanel: () => null,
}));

function makeQuestion(id: string, preview: string): UnifiedQuestion {
  return {
    id,
    type: "mcq",
    preview,
    searchText: preview,
    difficulty: "medium",
    authorName: null,
    createdBy: null,
    createdAt: "2026-06-24T10:00:00Z",
    hidden: false,
    upvotes: 0,
    downvotes: 0,
    chapters: [],
    competencies: [],
    raw: {
      question: preview,
      payload: null,
      answer_key: null,
      explanation: null,
      generation_rationale: null,
    },
  };
}

function makeRow(overrides: Partial<EvaluationRow>): EvaluationRow {
  return {
    id: "r" + Math.random().toString(36).slice(2, 8),
    session_id: "s1",
    question_id: "qA",
    evaluator_id: "u1",
    verdict: "good",
    difficulty_confirmation: "correct",
    question_good: true,
    answer_good: true,
    clarity: 4,
    distractor_quality: 4,
    curriculum_alignment: 4,
    question_bank_alignment: 4,
    pedagogical_value: 4,
    language_appropriateness: 4,
    problem_categories: [],
    comment: null,
    was_sampled: false,
    cognitive_level: null,
    created_at: "2026-06-24T10:00:00Z",
    updated_at: "2026-06-24T10:00:00Z",
    ...overrides,
  };
}

describe("CourseEvaluationsQuestionsTab", () => {
  const questions = [
    makeQuestion("qA", "Question A about acids"),
    makeQuestion("qB", "Question B about bases"),
    makeQuestion("qC", "Question C about catalysis"),
  ];

  // qA: 2x good — avg 5, no flags
  // qB: 2x needs_fixing with flagged problems — avg 3
  // qC: 2x reject — avg 1, no flags
  const rows: EvaluationRow[] = [
    makeRow({
      question_id: "qA",
      evaluator_id: "u1",
      verdict: "good",
      clarity: 5,
      distractor_quality: 5,
      curriculum_alignment: 5,
      question_bank_alignment: 5,
      pedagogical_value: 5,
      language_appropriateness: 5,
    }),
    makeRow({
      question_id: "qA",
      evaluator_id: "u2",
      verdict: "good",
      clarity: 5,
      distractor_quality: 5,
      curriculum_alignment: 5,
      question_bank_alignment: 5,
      pedagogical_value: 5,
      language_appropriateness: 5,
    }),
    makeRow({
      question_id: "qB",
      evaluator_id: "u1",
      verdict: "needs_fixing",
      problem_categories: ["weak_distractors"],
      clarity: 3,
      distractor_quality: 3,
      curriculum_alignment: 3,
      question_bank_alignment: 3,
      pedagogical_value: 3,
      language_appropriateness: 3,
    }),
    makeRow({
      question_id: "qB",
      evaluator_id: "u2",
      verdict: "needs_fixing",
      problem_categories: ["unclear_stem"],
      clarity: 3,
      distractor_quality: 3,
      curriculum_alignment: 3,
      question_bank_alignment: 3,
      pedagogical_value: 3,
      language_appropriateness: 3,
    }),
    makeRow({
      question_id: "qC",
      evaluator_id: "u1",
      verdict: "reject",
      clarity: 1,
      distractor_quality: 1,
      curriculum_alignment: 1,
      question_bank_alignment: 1,
      pedagogical_value: 1,
      language_appropriateness: 1,
    }),
    makeRow({
      question_id: "qC",
      evaluator_id: "u2",
      verdict: "reject",
      clarity: 1,
      distractor_quality: 1,
      curriculum_alignment: 1,
      question_bank_alignment: 1,
      pedagogical_value: 1,
      language_appropriateness: 1,
    }),
  ];

  const aggregates = aggregateByQuestion(rows);
  const rowsByQuestion = new Map<string, EvaluationRow[]>();
  for (const r of rows) {
    const list = rowsByQuestion.get(r.question_id) ?? [];
    list.push(r);
    rowsByQuestion.set(r.question_id, list);
  }

  const renderTab = () =>
    render(
      <CourseEvaluationsQuestionsTab
        questions={questions}
        rowsByQuestionId={rowsByQuestion}
        aggregatesByQuestionId={aggregates}
        evaluatorNameById={
          new Map([
            ["u1", "Alice"],
            ["u2", "Bob"],
          ])
        }
      />,
    );

  it("lists all evaluated questions by default", () => {
    renderTab();
    expect(screen.getByTestId("evaluations-row-qA")).toBeInTheDocument();
    expect(screen.getByTestId("evaluations-row-qB")).toBeInTheDocument();
    expect(screen.getByTestId("evaluations-row-qC")).toBeInTheDocument();
  });

  it("displays avg score correctly", () => {
    renderTab();
    expect(screen.getByTestId("avg-score-qA")).toHaveTextContent("5.0");
    expect(screen.getByTestId("avg-score-qB")).toHaveTextContent("3.0");
    expect(screen.getByTestId("avg-score-qC")).toHaveTextContent("1.0");
  });

  it("filters by 'has flagged problems'", async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(screen.getByTestId("only-flagged-toggle"));
    expect(screen.queryByTestId("evaluations-row-qA")).not.toBeInTheDocument();
    expect(screen.getByTestId("evaluations-row-qB")).toBeInTheDocument();
    expect(screen.queryByTestId("evaluations-row-qC")).not.toBeInTheDocument();
  });

  it("sorts by avg score (default desc, toggles to asc)", () => {
    renderTab();
    // Default desc → qA (5.0), qB (3.0), qC (1.0)
    let rows = screen.getAllByTestId(/^evaluations-row-/);
    expect(rows[0]).toHaveAttribute("data-testid", "evaluations-row-qA");
    expect(rows[2]).toHaveAttribute("data-testid", "evaluations-row-qC");

    fireEvent.click(screen.getByTestId("sort-avg-score"));
    rows = screen.getAllByTestId(/^evaluations-row-/);
    expect(rows[0]).toHaveAttribute("data-testid", "evaluations-row-qC");
    expect(rows[2]).toHaveAttribute("data-testid", "evaluations-row-qA");
  });
});
