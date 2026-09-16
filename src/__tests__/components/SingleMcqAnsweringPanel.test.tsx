import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

type Result = { data: unknown; error: unknown };
const responses: Record<string, Result> = {
  questions: { data: null, error: null },
  quiz_answers: { data: [], error: null },
  question_votes: { data: null, error: null },
};

const insertCalls: Array<{ table: string; payload: unknown }> = [];

// Every attempt now goes to the `submit-quiz-answers` edge function, which
// grades it (#1094). These capture what the panel sent and dictate the verdict
// it gets back, so the tests can prove the panel reports the SERVER's answer
// rather than one it worked out itself.
interface GradeCall {
  url: string;
  body: {
    courseId?: string;
    quizId?: string | null;
    offeringId?: string | null;
    sessionId?: string;
    answers?: Array<{ questionId: string; submission: unknown }>;
  };
}
const gradeCalls: GradeCall[] = [];
let gradeVerdict = true;

vi.stubGlobal(
  "fetch",
  vi.fn(async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    gradeCalls.push({ url: String(url), body });
    const results = (body.answers ?? []).map((a: { questionId: string }) => ({
      questionId: a.questionId,
      isCorrect: gradeVerdict,
      recordedNow: true,
    }));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        results,
        correctCount: results.filter((r: { isCorrect: boolean }) => r.isCorrect).length,
        totalCount: results.length,
      }),
    };
  }),
);

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
    chain.insert = (payload: unknown) => {
      insertCalls.push({ table, payload });
      return Promise.resolve({ data: null, error: null });
    };
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

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "stu-1" } }),
}));

vi.mock("@/lib/utils", () => ({
  formatExplanation: (s: string) => s,
  cn: (...a: unknown[]) => a.filter(Boolean).join(" "),
}));

vi.mock("@/lib/latex-utils", () => ({
  processLatexContent: (s: string) => s,
  formatQuestionText: (s: string) => s,
}));

vi.stubEnv("VITE_SUPABASE_URL", "https://test.supabase.co");
vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "anon-test");

// crypto.randomUUID is used by the panel for session_id. jsdom provides it,
// but stub deterministically so the assertion is stable.
vi.stubGlobal("crypto", {
  ...globalThis.crypto,
  randomUUID: () => "fixed-session-uuid",
});

import { SingleMcqAnsweringPanel } from "@/components/student-answering";

beforeEach(() => {
  for (const key of Object.keys(responses)) {
    if (key === "quiz_answers") responses[key] = { data: [], error: null };
    else responses[key] = { data: null, error: null };
  }
  insertCalls.length = 0;
  gradeCalls.length = 0;
  gradeVerdict = true;
});

describe("SingleMcqAnsweringPanel (#755)", () => {
  it("inserts a practice-mode (quiz_id=null) attempt and reports completion on correct", async () => {
    responses.questions = {
      data: {
        id: "mcq-1",
        question: "2 + 2 = ?",
        payload: { options: ["3", "4", "5"] },
        answer_key: { correct_indices: [1], correct_index: 1 },
        explanation: "Basic math",
        difficulty: "easy",
        is_user_generated: false,
        hidden: false,
        type: "mcq",
      },
      error: null,
    };

    const onCompleted = vi.fn();
    const onStatusChange = vi.fn();

    render(
      <SingleMcqAnsweringPanel
        questionId="mcq-1"
        courseId="course-1"
        offeringId="off-1"
        onBack={() => {}}
        onCompleted={onCompleted}
        onStatusChange={onStatusChange}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("4")).toBeInTheDocument();
    });
    expect(onStatusChange).toHaveBeenCalledWith("not_started");

    const user = userEvent.setup();
    await user.click(screen.getByText("4"));
    await user.click(screen.getByRole("button", { name: /Submit Answer/i }));

    await waitFor(() => {
      expect(gradeCalls.length).toBe(1);
    });
    const call = gradeCalls[0];
    expect(call.url).toContain("/functions/v1/submit-quiz-answers");
    expect(call.body).toMatchObject({
      courseId: "course-1",
      offeringId: "off-1",
      quizId: null,
      sessionId: "fixed-session-uuid",
      answers: [{ questionId: "mcq-1", submission: { selected_indices: [1] } }],
    });
    // The panel writes nothing itself, and offers no grade for the server to
    // take: `is_correct` is not part of what it sends.
    expect(insertCalls).toHaveLength(0);
    expect(JSON.stringify(call.body)).not.toContain("is_correct");

    await waitFor(() => {
      expect(onCompleted).toHaveBeenCalledWith({ grade: 100, allCorrect: true });
    });
    expect(onStatusChange).toHaveBeenLastCalledWith("completed");
  });

  it("on incorrect submit reports in_progress and does not fire onCompleted", async () => {
    responses.questions = {
      data: {
        id: "mcq-2",
        question: "Capital of France?",
        payload: { options: ["London", "Berlin", "Paris", "Madrid"] },
        answer_key: { correct_indices: [2], correct_index: 2 },
        explanation: "",
        difficulty: "medium",
        is_user_generated: false,
        hidden: false,
        type: "mcq",
      },
      error: null,
    };
    gradeVerdict = false;

    const onCompleted = vi.fn();
    const onStatusChange = vi.fn();

    render(
      <SingleMcqAnsweringPanel
        questionId="mcq-2"
        courseId="course-1"
        onBack={() => {}}
        onCompleted={onCompleted}
        onStatusChange={onStatusChange}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("London")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByText("London"));
    await user.click(screen.getByRole("button", { name: /Submit Answer/i }));

    await waitFor(() => {
      expect(gradeCalls.length).toBe(1);
    });
    expect(onCompleted).not.toHaveBeenCalled();
    expect(onStatusChange).toHaveBeenLastCalledWith("in_progress");
  });

  it("reports the server's verdict even when the loaded answer key disagrees", async () => {
    // The key the panel loaded says option 2 is right and the student picks it,
    // but the server — reading the question as it stands now — says no. What
    // the student is told is the server's answer, not the browser's.
    responses.questions = {
      data: {
        id: "mcq-3",
        question: "Capital of France?",
        payload: { options: ["London", "Berlin", "Paris", "Madrid"] },
        answer_key: { correct_indices: [2], correct_index: 2 },
        explanation: "",
        difficulty: "medium",
        is_user_generated: false,
        hidden: false,
        type: "mcq",
      },
      error: null,
    };
    gradeVerdict = false;

    const onCompleted = vi.fn();
    const onStatusChange = vi.fn();

    render(
      <SingleMcqAnsweringPanel
        questionId="mcq-3"
        courseId="course-1"
        onBack={() => {}}
        onCompleted={onCompleted}
        onStatusChange={onStatusChange}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Paris")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByText("Paris"));
    await user.click(screen.getByRole("button", { name: /Submit Answer/i }));

    await waitFor(() => {
      expect(gradeCalls.length).toBe(1);
    });
    expect(onCompleted).not.toHaveBeenCalled();
    expect(onStatusChange).toHaveBeenLastCalledWith("in_progress");
  });
});
