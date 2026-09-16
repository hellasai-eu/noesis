import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

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

import { SingleOpenAnsweringPanel } from "@/components/student-answering";
import { AI_DISCLAIMER_MIXED_EL, AI_DISCLAIMER_MIXED_EN } from "@/components/AiDisclaimer";

beforeEach(() => {
  for (const key of Object.keys(responses)) {
    responses[key] = { data: null, error: null };
  }
  fetchMock.mockReset();
});

describe("SingleOpenAnsweringPanel (#755)", () => {
  it("submits to submit-open-answer and completes pending review, with no grade", async () => {
    responses.questions = {
      data: {
        id: "q-open-1",
        question: "Why is the sky blue?",
        payload: { answering_mode: "single", model_answer: "Rayleigh scattering" },
        difficulty: "easy",
        hidden: false,
        type: "open",
      },
      error: null,
    };

    // The recorder returns no verdict of any kind — the answer is held for
    // instructor review.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, pendingReview: true }),
    });

    const onCompleted = vi.fn();
    const onStatusChange = vi.fn();

    render(
      <SingleOpenAnsweringPanel
        questionId="q-open-1"
        courseId="course-1"
        onBack={() => {}}
        onCompleted={onCompleted}
        onStatusChange={onStatusChange}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText(/Your answer/i)).toBeInTheDocument();
    });
    expect(onStatusChange).toHaveBeenCalledWith("not_started");

    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText(/Your answer/i),
      "Light scatters more at shorter wavelengths.",
    );
    await user.click(screen.getByRole("button", { name: /Submit/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/submit-open-answer");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.questionId).toBe("q-open-1");
    expect(body.courseId).toBe("course-1");
    expect(body.studentAnswer).toBe("Light scatters more at shorter wavelengths.");

    await waitFor(() => {
      expect(onCompleted).toHaveBeenCalledWith();
    });
    expect(onStatusChange).toHaveBeenLastCalledWith("completed");
    // Pending instructor review: no grade anywhere, and no AI notice — there
    // is nothing model-authored on screen.
    expect(screen.queryByText(/Grade:/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId("ai-disclaimer")).toBeNull();
  });

  it("shows the pending-review note for a recorded but ungraded answer", async () => {
    responses.questions = {
      data: {
        id: "q-open-1",
        question: "Why is the sky blue?",
        payload: { answering_mode: "single", model_answer: "Rayleigh scattering" },
        difficulty: "easy",
        hidden: false,
        type: "open",
      },
      error: null,
    };
    responses.open_question_grades = {
      data: {
        grade: null,
        feedback: null,
        strengths: null,
        areas_for_improvement: null,
        submitted_answer: "Light scatters more at shorter wavelengths.",
      },
      error: null,
    };

    const onStatusChange = vi.fn();
    render(
      <SingleOpenAnsweringPanel
        questionId="q-open-1"
        courseId="course-1"
        onBack={() => {}}
        onStatusChange={onStatusChange}
      />,
    );

    await waitFor(() => {
      expect(onStatusChange).toHaveBeenCalledWith("completed");
    });
    expect(
      screen.getByText(/Light scatters more at shorter wavelengths./),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("ai-disclaimer")).toBeNull();
  });

  it("carries the mixed disclaimer once instructor feedback is on screen (#936)", async () => {
    responses.questions = {
      data: {
        id: "q-open-1",
        question: "Why is the sky blue?",
        payload: { answering_mode: "single", model_answer: "Rayleigh scattering" },
        difficulty: "easy",
        hidden: false,
        type: "open",
      },
      error: null,
    };
    // An already-graded answer loads straight into the submitted view, so the
    // notice must be there on arrival and not only after a fresh submission.
    responses.open_question_grades = {
      data: {
        grade: 88,
        feedback: "Good answer",
        strengths: [],
        areas_for_improvement: [],
        submitted_answer: "Light scatters more at shorter wavelengths.",
      },
      error: null,
    };

    render(
      <SingleOpenAnsweringPanel
        questionId="q-open-1"
        courseId="course-1"
        onBack={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Good answer")).toBeInTheDocument();
    });
    // Practice hides the numeric grade — only the qualitative feedback shows.
    expect(screen.queryByText(/Grade:/i)).not.toBeInTheDocument();
    // Feedback may be the instructor's own words or an adopted AI draft, and
    // nothing records which — the mixed wording is the honest one.
    expect(screen.getByTestId("ai-disclaimer")).toHaveTextContent(AI_DISCLAIMER_MIXED_EL);
    expect(screen.getByTestId("ai-disclaimer")).toHaveTextContent(AI_DISCLAIMER_MIXED_EN);
  });

  it("shows no disclaimer while the question is still unanswered (#936)", async () => {
    responses.questions = {
      data: {
        id: "q-open-1",
        question: "Why is the sky blue?",
        payload: { answering_mode: "single", model_answer: "Rayleigh scattering" },
        difficulty: "easy",
        hidden: false,
        type: "open",
      },
      error: null,
    };

    render(
      <SingleOpenAnsweringPanel
        questionId="q-open-1"
        courseId="course-1"
        onBack={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText(/Your answer/i)).toBeInTheDocument();
    });
    // Nothing on screen is model output yet — the question stem is the
    // instructor's bank. Labelling it would be the failure in reverse.
    expect(screen.queryByTestId("ai-disclaimer")).toBeNull();
  });

  it("refuses to render an interactive-mode question with a helpful message", async () => {
    responses.questions = {
      data: {
        id: "q-int",
        question: "Discuss Plato",
        payload: { answering_mode: "interactive" },
        difficulty: "medium",
        hidden: false,
        type: "open",
      },
      error: null,
    };

    render(
      <SingleOpenAnsweringPanel
        questionId="q-int"
        courseId="course-1"
        onBack={() => {}}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByText(/interactive .* mode/i),
      ).toBeInTheDocument();
    });
  });
});
