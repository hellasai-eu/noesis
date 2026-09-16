import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

type Result = { data: unknown; error: unknown };

const responses: Record<string, Result> = {
  quiz_questions: { data: [], error: null },
  quiz_answers: { data: [], error: null },
};

vi.mock("@/integrations/supabase/client", () => {
  const buildChain = (table: string) => {
    const chain: Record<string, (...a: unknown[]) => unknown> = {};
    const passThrough = () => chain;
    chain.select = passThrough;
    chain.eq = passThrough;
    chain.in = passThrough;
    chain.order = passThrough;
    chain.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(resolve(responses[table] || { data: [], error: null }));
    return chain;
  };
  return {
    supabase: {
      from: vi.fn((table: string) => buildChain(table)),
    },
  };
});

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

vi.mock("@/lib/latex-utils", () => ({
  processLatexContent: (text: string) => text,
}));

import { StudentAnswerDrillDown } from "@/components/quiz/StudentAnswerDrillDown";

beforeEach(() => {
  for (const key of Object.keys(responses)) {
    responses[key] = { data: [], error: null };
  }
});

describe("StudentAnswerDrillDown", () => {
  it("renders per-question correctness for a student's submission", async () => {
    responses.quiz_questions = {
      data: [
        {
          order_num: 0,
          question_id: "q1",
          questions: {
            id: "q1",
            question: "What is 2+2?",
            payload: { options: ["3", "4", "5", "6"] },
            answer_key: { correct_indices: [1], correct_index: 1 },
            explanation: null,
          },
        },
        {
          order_num: 1,
          question_id: "q2",
          questions: {
            id: "q2",
            question: "What is the capital of France?",
            payload: { options: ["London", "Berlin", "Paris", "Madrid"] },
            answer_key: { correct_indices: [2], correct_index: 2 },
            explanation: null,
          },
        },
      ],
      error: null,
    };
    responses.quiz_answers = {
      data: [
        {
          question_id: "q1",
          selected_answer: 1,
          is_correct: true,
          answered_at: "2026-04-10T10:00:00Z",
        },
        {
          question_id: "q2",
          selected_answer: 1,
          is_correct: false,
          answered_at: "2026-04-10T10:05:00Z",
        },
      ],
      error: null,
    };

    render(
      <StudentAnswerDrillDown
        open={true}
        onOpenChange={() => {}}
        quizId="quiz-1"
        userId="stu-1"
        offeringId="off-1"
        studentName="Alice"
        quizTitle="Math Quiz"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("What is 2+2?")).toBeInTheDocument();
    });
    expect(screen.getByText("What is the capital of France?")).toBeInTheDocument();
    expect(screen.getByText(/Alice's Answers/i)).toBeInTheDocument();

    // An Incorrect badge should be present for the wrong answer on q2
    expect(screen.getByText(/^Incorrect$/)).toBeInTheDocument();

    // Multiple "Correct" labels appear (summary label + badge + option badges)
    expect(screen.getAllByText(/^Correct$/).length).toBeGreaterThan(0);

    // Score: 1/2 = 50%
    expect(screen.getByText("1/2")).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();
  });

  it("handles a student who did not submit (no answers)", async () => {
    responses.quiz_questions = {
      data: [
        {
          order_num: 0,
          question_id: "q1",
          questions: {
            id: "q1",
            question: "Any question",
            payload: { options: ["A", "B"] },
            answer_key: { correct_indices: [0], correct_index: 0 },
            explanation: null,
          },
        },
      ],
      error: null,
    };
    responses.quiz_answers = { data: [], error: null };

    render(
      <StudentAnswerDrillDown
        open={true}
        onOpenChange={() => {}}
        quizId="quiz-1"
        userId="stu-1"
        offeringId="off-1"
        studentName="Bob"
        quizTitle="Math Quiz"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Any question")).toBeInTheDocument();
    });
    expect(screen.getByText(/No answer/i)).toBeInTheDocument();
  });
});
