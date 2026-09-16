import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Minimal Supabase mock — each table returns a thenable chain whose final
// resolve uses the per-table `responses` slot, mirroring the pattern in
// StudentOpenQuestions.test.tsx.
type Result = { data: unknown; error: unknown };
const responses: Record<string, Result> = {
  questions: { data: null, error: null },
  open_question_grades: { data: null, error: null },
};

vi.mock("@/integrations/supabase/client", () => {
  const buildChain = (table: string) => {
    const chain: Record<string, (...a: unknown[]) => unknown> = {};
    const passThrough = () => chain;
    chain.select = passThrough;
    chain.eq = passThrough;
    chain.in = passThrough;
    chain.is = passThrough;
    chain.not = passThrough;
    chain.order = passThrough;
    chain.insert = passThrough;
    chain.update = passThrough;
    chain.delete = passThrough;
    chain.upsert = passThrough;
    chain.single = () => Promise.resolve(responses[table] || { data: null, error: null });
    chain.maybeSingle = chain.single;
    chain.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(resolve(responses[table] || { data: [], error: null }));
    return chain;
  };
  return {
    supabase: {
      from: vi.fn((table: string) => buildChain(table)),
      auth: {
        getUser: vi.fn(async () => ({ data: { user: { id: "stu-1" } } })),
        getSession: vi.fn(async () => ({ data: { session: { access_token: "tok" } } })),
      },
    },
  };
});

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/lib/latex-utils", () => ({
  formatQuestionText: (s: string) => s,
  processLatexContent: (s: string) => s,
}));

vi.stubEnv("VITE_SUPABASE_URL", "https://test.supabase.co");
vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "anon-test");

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { SingleFillGapsAnsweringPanel } from "@/components/student-answering";

beforeEach(() => {
  for (const key of Object.keys(responses)) {
    responses[key] = { data: null, error: null };
  }
  fetchMock.mockReset();
});

describe("SingleFillGapsAnsweringPanel (#755)", () => {
  it("loads a single fill_gaps question, submits via grade-deterministic-answer, and fires onCompleted", async () => {
    responses.questions = {
      data: {
        id: "q1",
        payload: { stem: "Hello {{1}} world {{2}}" },
        answer_key: {
          gaps: [
            { ordinal: 1, acceptable: ["foo"] },
            { ordinal: 2, acceptable: ["bar"] },
          ],
        },
        explanation: "Because.",
        difficulty: "easy",
        hidden: false,
        type: "fill_gaps",
      },
      error: null,
    };

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        grade: 100,
        gapResults: { perGap: [true, true], allCorrect: true },
      }),
    });

    const onCompleted = vi.fn();
    const onStatusChange = vi.fn();
    const onBack = vi.fn();

    render(
      <SingleFillGapsAnsweringPanel
        questionId="q1"
        courseId="course-1"
        offeringId="off-1"
        onBack={onBack}
        onCompleted={onCompleted}
        onStatusChange={onStatusChange}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Gap 1")).toBeInTheDocument();
    });
    expect(onStatusChange).toHaveBeenCalledWith("not_started");

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Gap 1"), "foo");
    await user.type(screen.getByLabelText("Gap 2"), "bar");
    await user.click(screen.getByRole("button", { name: /Submit/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({
      questionId: "q1",
      courseId: "course-1",
      questionType: "fill_gaps",
      submittedAnswer: ["foo", "bar"],
    });

    await waitFor(() => {
      expect(onCompleted).toHaveBeenCalledWith({ grade: 100, allCorrect: true });
    });
    expect(onStatusChange).toHaveBeenLastCalledWith("completed");
  });

  it("hydrates an existing grade into the read-only view", async () => {
    responses.questions = {
      data: {
        id: "q1",
        payload: { stem: "X {{1}}" },
        answer_key: { gaps: [{ ordinal: 1, acceptable: ["yes"] }] },
        explanation: "",
        difficulty: "medium",
        hidden: false,
        type: "fill_gaps",
      },
      error: null,
    };
    responses.open_question_grades = {
      data: {
        grade: 50,
        submitted_answer: JSON.stringify(["no"]),
        gap_results: { perGap: [false], allCorrect: false },
      },
      error: null,
    };

    const onStatusChange = vi.fn();

    render(
      <SingleFillGapsAnsweringPanel
        questionId="q1"
        courseId="course-1"
        onBack={() => {}}
        onStatusChange={onStatusChange}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("0 of 1 gaps correct")).toBeInTheDocument();
    });
    // Practice hides the numeric grade.
    expect(screen.queryByText(/Grade:/i)).not.toBeInTheDocument();
    expect(onStatusChange).toHaveBeenCalledWith("completed");
    // Submit button should not appear in read-only view.
    expect(screen.queryByRole("button", { name: /Submit/i })).not.toBeInTheDocument();
  });
});
