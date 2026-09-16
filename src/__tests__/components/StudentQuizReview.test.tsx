import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

type Result = { data: unknown; error: unknown };

const responses: Record<string, Result[]> = {
  quiz_questions: [],
  quiz_answers: [],
};

// Persists across multiple from() calls within the same test so queued
// responses are consumed in order (fixes the fallback-path test).
const callCounts: Record<string, number> = {};

vi.mock("@/integrations/supabase/client", () => {
  const buildChain = (table: string) => {
    if (!(table in callCounts)) callCounts[table] = 0;
    const resolveFor = () => {
      const queue = responses[table] || [];
      const idx = Math.min(callCounts[table], queue.length - 1);
      callCounts[table]++;
      return queue[idx < 0 ? 0 : idx] || { data: [], error: null };
    };
    const chain: Record<string, (...a: unknown[]) => unknown> = {};
    const passThrough = () => chain;
    chain.select = passThrough;
    chain.eq = passThrough;
    chain.in = passThrough;
    chain.is = passThrough;
    chain.order = passThrough;
    chain.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(resolve(resolveFor()));
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

import { StudentQuizReview } from "@/components/student/StudentQuizReview";
import i18n from "@/i18n";

beforeEach(() => {
  responses.quiz_questions = [{ data: [], error: null }];
  responses.quiz_answers = [{ data: [], error: null }];
  Object.keys(callCounts).forEach((k) => delete callCounts[k]);
});

describe("StudentQuizReview", () => {
  it("renders the student's own answers with correct/incorrect badges and summary", async () => {
    responses.quiz_questions = [
      {
        data: [
          {
            order_num: 0,
            question_id: "q1",
            questions: {
              id: "q1",
              question: "What is 2+2?",
              payload: { options: ["3", "4", "5", "6"] },
              answer_key: { correct_indices: [1], correct_index: 1 },
              explanation: "Addition.",
            },
          },
          {
            order_num: 1,
            question_id: "q2",
            questions: {
              id: "q2",
              question: "Capital of France?",
              payload: { options: ["London", "Berlin", "Paris", "Madrid"] },
              answer_key: { correct_indices: [2], correct_index: 2 },
              explanation: null,
            },
          },
        ],
        error: null,
      },
    ];
    responses.quiz_answers = [
      {
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
      },
    ];

    render(
      <StudentQuizReview
        open={true}
        onOpenChange={() => {}}
        quizId="quiz-1"
        sessionId="sess-1"
        userId="stu-1"
        quizTitle="Math Quiz"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("What is 2+2?")).toBeInTheDocument();
    });
    expect(screen.getByText("Capital of France?")).toBeInTheDocument();
    expect(screen.getByText(/Your Answers/i)).toBeInTheDocument();

    // Explanation should surface for q1
    expect(screen.getByText(/^Explanation$/)).toBeInTheDocument();

    // Student-facing labels on options
    expect(screen.getAllByText(/^Your answer$/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/^Correct answer$/).length).toBeGreaterThan(0);

    // Incorrect badge for q2
    expect(screen.getByText(/^Incorrect$/)).toBeInTheDocument();

    // Score: 1/2 = 50%
    expect(screen.getByText("1/2")).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();
  });

  it("falls back to quiz-level answers when session has none", async () => {
    responses.quiz_questions = [
      {
        data: [
          {
            order_num: 0,
            question_id: "q1",
            questions: {
              id: "q1",
              question: "Only question",
              payload: { options: ["A", "B"] },
              answer_key: { correct_indices: [0], correct_index: 0 },
              explanation: null,
            },
          },
        ],
        error: null,
      },
    ];
    // First call (session-filtered) returns empty; fallback returns the answer.
    responses.quiz_answers = [
      { data: [], error: null },
      {
        data: [
          {
            question_id: "q1",
            selected_answer: 0,
            is_correct: true,
            answered_at: "2026-04-10T10:00:00Z",
          },
        ],
        error: null,
      },
    ];

    render(
      <StudentQuizReview
        open={true}
        onOpenChange={() => {}}
        quizId="quiz-1"
        sessionId="sess-1"
        userId="stu-1"
        quizTitle="Legacy Quiz"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Only question")).toBeInTheDocument();
    });

    // Verifies fallback path took effect: Correct badge for the answered question
    expect(screen.getAllByText(/^Correct$/).length).toBeGreaterThan(0);
  });

  it("renders 'No answer' when the user never submitted any question", async () => {
    responses.quiz_questions = [
      {
        data: [
          {
            order_num: 0,
            question_id: "q1",
            questions: {
              id: "q1",
              question: "Unanswered question",
              payload: { options: ["A", "B"] },
              answer_key: { correct_indices: [0], correct_index: 0 },
              explanation: null,
            },
          },
        ],
        error: null,
      },
    ];
    responses.quiz_answers = [
      { data: [], error: null },
      { data: [], error: null },
    ];

    render(
      <StudentQuizReview
        open={true}
        onOpenChange={() => {}}
        quizId="quiz-1"
        sessionId="sess-1"
        userId="stu-1"
        quizTitle="Math Quiz"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Unanswered question")).toBeInTheDocument();
    });
    expect(screen.getByText(/No answer/i)).toBeInTheDocument();
  });
});

describe("StudentQuizReview — locale", () => {
  afterEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("renders its labels in Greek", async () => {
    responses.quiz_questions = [
      {
        data: [
          {
            order_num: 0,
            question_id: "q1",
            questions: {
              id: "q1",
              question: "What is 2+2?",
              payload: { options: ["3", "4", "5", "6"] },
              answer_key: { correct_indices: [1], correct_index: 1 },
              explanation: "Addition.",
            },
          },
        ],
        error: null,
      },
    ];
    responses.quiz_answers = [
      {
        data: [
          {
            question_id: "q1",
            selected_answer: 1,
            is_correct: true,
            answered_at: "2026-04-10T10:00:00Z",
          },
        ],
        error: null,
      },
    ];

    await i18n.changeLanguage("el");
    render(
      <StudentQuizReview
        open={true}
        onOpenChange={() => {}}
        quizId="quiz-1"
        sessionId="sess-1"
        userId="stu-1"
        quizTitle="Math Quiz"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Οι απαντήσεις σου")).toBeInTheDocument();
    });
    // The description keeps the quiz title as a placeholder rather than
    // concatenating it onto an English frame.
    expect(
      screen.getByText(/Math Quiz — δες κάθε ερώτηση/),
    ).toBeInTheDocument();
    expect(screen.getByText("Ερ.1")).toBeInTheDocument();
    expect(screen.getByText("Σωστές")).toBeInTheDocument();
    expect(screen.getByText("Βαθμολογία")).toBeInTheDocument();
    expect(screen.getByText("Ερωτήσεις")).toBeInTheDocument();
    expect(screen.getByText("Επεξήγηση")).toBeInTheDocument();
    expect(screen.getAllByText("Η απάντησή σου").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Σωστή απάντηση").length).toBeGreaterThan(0);
    expect(screen.queryByText("Your Answers")).not.toBeInTheDocument();
  });

  it("translates the no-answer badge", async () => {
    responses.quiz_questions = [
      {
        data: [
          {
            order_num: 0,
            question_id: "q1",
            questions: {
              id: "q1",
              question: "What is 2+2?",
              payload: { options: ["3", "4"] },
              answer_key: { correct_indices: [1], correct_index: 1 },
              explanation: null,
            },
          },
        ],
        error: null,
      },
    ];
    responses.quiz_answers = [{ data: [], error: null }];

    await i18n.changeLanguage("el");
    render(
      <StudentQuizReview
        open={true}
        onOpenChange={() => {}}
        quizId="quiz-1"
        sessionId="sess-1"
        userId="stu-1"
        quizTitle="Math Quiz"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Καμία απάντηση")).toBeInTheDocument();
    });
  });
});
