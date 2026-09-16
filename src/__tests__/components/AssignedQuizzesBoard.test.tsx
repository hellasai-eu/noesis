import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

type Result = { data: unknown; error: unknown };

const responses: Record<string, Result> = {
  offerings: { data: [], error: null },
  offering_quizzes: { data: [], error: null },
  offering_groups: { data: [], error: null },
  offering_group_members: { data: [], error: null },
  class_enrollments: { data: [], error: null },
  profiles: { data: [], error: null },
  quiz_sessions: { data: [], error: null },
  quiz_answers: { data: [], error: null },
  quiz_questions: { data: [], error: null },
  jobs: { data: [], error: null },
};

const updateCalls: Array<{
  table: string;
  values: unknown;
  id?: unknown;
  filters?: string[];
}> = [];
// Result returned to an .update() chain, when it must differ from the table's
// read result (e.g. a guarded update that matched zero rows).
const updateResponses: Record<string, Result> = {};
const rpcCalls: Array<{ name: string; args: unknown }> = [];
const rpcResponses: Record<string, Result> = {
  mark_offering_quiz_done: { data: "2026-06-05T00:00:00Z", error: null },
  reopen_offering_quiz: { data: null, error: null },
};

vi.mock("@/integrations/supabase/client", () => {
  const buildChain = (table: string) => {
    const chain: Record<string, (...a: unknown[]) => unknown> = {};
    const passThrough = () => chain;
    chain.select = passThrough;
    chain.eq = (_col: unknown, value: unknown) => {
      // Record the id on update chains so tests can assert which row was updated.
      const pending = (chain as any).__pendingUpdate;
      if (pending) {
        updateCalls.push({ table, values: pending, id: value });
        (chain as any).__pendingUpdate = undefined;
      }
      return chain;
    };
    chain.in = passThrough;
    chain.not = passThrough;
    chain.is = (col: unknown, value: unknown) => {
      // Guard filters on an update chain land on the record .eq() just pushed.
      if ((chain as any).__isUpdate) {
        const last = updateCalls[updateCalls.length - 1];
        if (last) (last.filters ||= []).push(`${col} is ${value}`);
      }
      return chain;
    };
    chain.or = passThrough;
    chain.order = passThrough;
    chain.limit = passThrough;
    chain.update = (values: unknown) => {
      (chain as any).__pendingUpdate = values;
      (chain as any).__isUpdate = true;
      return chain;
    };
    chain.then = (resolve: (v: unknown) => unknown) => {
      const result = (chain as any).__isUpdate
        ? updateResponses[table] || responses[table]
        : responses[table];
      return Promise.resolve(resolve(result || { data: [], error: null }));
    };
    chain.maybeSingle = () =>
      Promise.resolve(responses[table] || { data: null, error: null });
    chain.single = () =>
      Promise.resolve(responses[table] || { data: null, error: null });
    return chain;
  };
  return {
    supabase: {
      from: vi.fn((table: string) => buildChain(table)),
      rpc: vi.fn(async (name: string, args: unknown) => {
        rpcCalls.push({ name, args });
        return rpcResponses[name] || { data: null, error: null };
      }),
    },
  };
});

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

vi.mock("@/lib/latex-utils", () => ({
  processLatexContent: (text: string) => text,
}));

import { AssignedQuizzesBoard } from "@/components/quiz/AssignedQuizzesBoard";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

beforeEach(() => {
  for (const key of Object.keys(responses)) {
    responses[key] = { data: [], error: null };
  }
  updateCalls.length = 0;
  for (const key of Object.keys(updateResponses)) delete updateResponses[key];
  rpcCalls.length = 0;
  rpcResponses.mark_offering_quiz_done = { data: "2026-06-05T00:00:00Z", error: null };
  rpcResponses.reopen_offering_quiz = { data: null, error: null };
  (supabase.from as unknown as { mockClear: () => void }).mockClear();
  (toast.success as unknown as { mockClear: () => void }).mockClear();
  (toast.error as unknown as { mockClear: () => void }).mockClear();
});

describe("AssignedQuizzesBoard", () => {
  it("shows an empty state when no quizzes are assigned to any class", async () => {
    responses.offerings = {
      data: [
        {
          id: "off-1",
          class_id: "cls-1",
          classes: {
            id: "cls-1",
            name: "A",
            grade_level_id: null,
            section_name: null,
            category: null,
            academic_period: null,
          },
        },
      ],
      error: null,
    };

    render(<AssignedQuizzesBoard courseId="course-1" />);

    await waitFor(() => {
      expect(
        screen.getByText(/no quizzes have been assigned/i),
      ).toBeInTheDocument();
    });
  });

  it("renders assigned quizzes grouped by class with totals", async () => {
    responses.offerings = {
      data: [
        {
          id: "off-1",
          class_id: "cls-1",
          classes: {
            id: "cls-1",
            name: "A1",
            grade_level_id: null,
            section_name: null,
            category: null,
            academic_period: "2025-2026",
          },
        },
        {
          id: "off-2",
          class_id: "cls-2",
          classes: {
            id: "cls-2",
            name: "B1",
            grade_level_id: null,
            section_name: null,
            category: null,
            academic_period: "2025-2026",
          },
        },
      ],
      error: null,
    };
    responses.offering_quizzes = {
      data: [
        {
          id: "oq-1",
          offering_id: "off-1",
          quiz_id: "quiz-1",
          due_date: "2026-05-10T00:00:00Z",
          published_at: "2026-04-01T00:00:00Z",
          quizzes: {
            id: "quiz-1",
            title: "Quiz One",
            quiz_questions: [{ count: 5 }],
          },
        },
        {
          id: "oq-2",
          offering_id: "off-1",
          quiz_id: "quiz-2",
          due_date: null,
          published_at: null,
          quizzes: {
            id: "quiz-2",
            title: "Quiz Two",
            quiz_questions: [{ count: 3 }],
          },
        },
        {
          id: "oq-3",
          offering_id: "off-2",
          quiz_id: "quiz-3",
          due_date: null,
          published_at: null,
          quizzes: {
            id: "quiz-3",
            title: "Quiz Three",
            quiz_questions: [{ count: 7 }],
          },
        },
      ],
      error: null,
    };
    responses.class_enrollments = {
      data: [
        { class_id: "cls-1", user_id: "stu-1" },
        { class_id: "cls-1", user_id: "stu-2" },
        { class_id: "cls-2", user_id: "stu-3" },
      ],
      error: null,
    };
    responses.profiles = {
      data: [
        { user_id: "stu-1", full_name: "Alice", email: "alice@test" },
        { user_id: "stu-2", full_name: "Bob", email: "bob@test" },
        { user_id: "stu-3", full_name: "Carol", email: "carol@test" },
      ],
      error: null,
    };

    render(<AssignedQuizzesBoard courseId="course-1" />);

    // Wait for initial class triggers to render
    await waitFor(() => {
      expect(screen.getByText("A1")).toBeInTheDocument();
    });
    expect(screen.getByText("B1")).toBeInTheDocument();

    // Header summary: "3 total across 2 classes"
    expect(
      screen.getByText((content) => /3 total across 2 classes/i.test(content)),
    ).toBeInTheDocument();

    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText("Quiz One")).toBeInTheDocument();
    });
    expect(screen.getByText("Quiz Two")).toBeInTheDocument();
  });

  it("exposes inline due-date and time-limit editors when a quiz card is expanded", async () => {
    responses.offerings = {
      data: [
        {
          id: "off-1",
          class_id: "cls-1",
          classes: {
            id: "cls-1",
            name: "A1",
            grade_level_id: null,
            section_name: null,
            category: null,
            academic_period: null,
          },
        },
      ],
      error: null,
    };
    responses.offering_quizzes = {
      data: [
        {
          id: "oq-1",
          offering_id: "off-1",
          quiz_id: "quiz-1",
          due_date: null,
          published_at: null,
          time_limit_override: 30,
          quizzes: {
            id: "quiz-1",
            title: "Quiz One",
            quiz_questions: [{ count: 2 }],
          },
        },
      ],
      error: null,
    };
    responses.class_enrollments = { data: [], error: null };

    render(<AssignedQuizzesBoard courseId="course-1" />);

    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByText("A1")).toBeInTheDocument());

    await waitFor(() => {
      expect(screen.getByText("Quiz One")).toBeInTheDocument();
    });

    // Expand the assignment card to reveal the settings editors.
    await user.click(screen.getByRole("button", { name: /Quiz One/ }));

    await waitFor(() => {
      expect(screen.getByLabelText(/Due date/i)).toBeInTheDocument();
    });
    const timeLimitInput = screen.getByLabelText(
      /Time limit override \(minutes\)/i,
    ) as HTMLInputElement;
    expect(timeLimitInput.value).toBe("30");
  });

  it("persists due-date changes to offering_quizzes on save", async () => {
    responses.offerings = {
      data: [
        {
          id: "off-1",
          class_id: "cls-1",
          classes: {
            id: "cls-1",
            name: "A1",
            grade_level_id: null,
            section_name: null,
            category: null,
            academic_period: null,
          },
        },
      ],
      error: null,
    };
    responses.offering_quizzes = {
      data: [
        {
          id: "oq-1",
          offering_id: "off-1",
          quiz_id: "quiz-1",
          due_date: null,
          published_at: null,
          time_limit_override: null,
          quizzes: {
            id: "quiz-1",
            title: "Quiz One",
            quiz_questions: [{ count: 2 }],
          },
        },
      ],
      error: null,
    };

    render(<AssignedQuizzesBoard courseId="course-1" />);

    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByText("A1")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("Quiz One")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /Quiz One/ }));

    const dateInput = (await screen.findByLabelText(/Due date/i)) as HTMLInputElement;
    await user.type(dateInput, "2026-05-15");

    // Click the Save button next to the due-date field (the first "Save" in DOM order).
    const saveButtons = screen.getAllByRole("button", { name: /Save/i });
    await user.click(saveButtons[0]);

    await waitFor(() => {
      const oqUpdate = updateCalls.find(
        (c) =>
          c.table === "offering_quizzes" &&
          typeof c.values === "object" &&
          c.values !== null &&
          "due_date" in (c.values as Record<string, unknown>),
      );
      expect(oqUpdate).toBeTruthy();
      expect((oqUpdate!.values as Record<string, unknown>).due_date).toBeTruthy();
      expect(oqUpdate!.id).toBe("oq-1");
    });
  });

  it("hides scores for in-progress sessions and exposes a Mark complete action", async () => {
    responses.offerings = {
      data: [
        {
          id: "off-1",
          class_id: "cls-1",
          classes: {
            id: "cls-1",
            name: "A1",
            grade_level_id: null,
            section_name: null,
            category: null,
            academic_period: null,
          },
        },
      ],
      error: null,
    };
    responses.offering_quizzes = {
      data: [
        {
          id: "oq-1",
          offering_id: "off-1",
          quiz_id: "quiz-1",
          due_date: null,
          published_at: null,
          time_limit_override: null,
          quizzes: {
            id: "quiz-1",
            title: "Quiz One",
            quiz_questions: [{ count: 2 }],
          },
        },
      ],
      error: null,
    };
    responses.class_enrollments = {
      data: [{ class_id: "cls-1", user_id: "stu-1" }],
      error: null,
    };
    responses.profiles = {
      data: [{ user_id: "stu-1", full_name: "Alice", email: "alice@test" }],
      error: null,
    };
    responses.quiz_sessions = {
      data: [
        {
          id: "sess-1",
          user_id: "stu-1",
          status: "in_progress",
          started_at: "2026-04-22T00:00:00Z",
          completed_at: null,
        },
      ],
      error: null,
    };
    responses.quiz_answers = {
      data: [
        {
          user_id: "stu-1",
          is_correct: true,
          answered_at: "2026-04-22T00:01:00Z",
        },
      ],
      error: null,
    };

    render(<AssignedQuizzesBoard courseId="course-1" />);

    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByText("A1")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("Quiz One")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /Quiz One/ }));

    await waitFor(() => {
      expect(screen.getByText("Alice")).toBeInTheDocument();
    });
    expect(screen.getByText(/Results hidden until finalised/i)).toBeInTheDocument();
    expect(screen.queryByText(/1\/1/)).not.toBeInTheDocument();
    expect(screen.queryByText("100%")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Mark Alice's attempt as completed/i }),
    ).toBeInTheDocument();
  });

  it("force-completes an in-progress session via the Mark complete button", async () => {
    responses.offerings = {
      data: [
        {
          id: "off-1",
          class_id: "cls-1",
          classes: {
            id: "cls-1",
            name: "A1",
            grade_level_id: null,
            section_name: null,
            category: null,
            academic_period: null,
          },
        },
      ],
      error: null,
    };
    responses.offering_quizzes = {
      data: [
        {
          id: "oq-1",
          offering_id: "off-1",
          quiz_id: "quiz-1",
          due_date: null,
          published_at: null,
          time_limit_override: null,
          quizzes: {
            id: "quiz-1",
            title: "Quiz One",
            quiz_questions: [{ count: 2 }],
          },
        },
      ],
      error: null,
    };
    responses.class_enrollments = {
      data: [{ class_id: "cls-1", user_id: "stu-1" }],
      error: null,
    };
    responses.profiles = {
      data: [{ user_id: "stu-1", full_name: "Alice", email: "alice@test" }],
      error: null,
    };
    responses.quiz_sessions = {
      data: [
        {
          id: "sess-1",
          user_id: "stu-1",
          status: "in_progress",
          started_at: "2026-04-22T00:00:00Z",
          completed_at: null,
        },
      ],
      error: null,
    };
    responses.quiz_answers = { data: [], error: null };

    render(<AssignedQuizzesBoard courseId="course-1" />);

    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByText("A1")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("Quiz One")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /Quiz One/ }));

    const markBtn = await screen.findByRole("button", {
      name: /Mark Alice's attempt as completed/i,
    });
    await user.click(markBtn);

    await waitFor(() => {
      const sessionUpdate = updateCalls.find(
        (c) =>
          c.table === "quiz_sessions" &&
          typeof c.values === "object" &&
          c.values !== null &&
          (c.values as Record<string, unknown>).status === "completed",
      );
      expect(sessionUpdate).toBeTruthy();
      expect(sessionUpdate!.id).toBe("sess-1");
    });
  });

  it("flags completed attempts that ran past the time limit with an over-time badge", async () => {
    responses.offerings = {
      data: [
        {
          id: "off-1",
          class_id: "cls-1",
          classes: {
            id: "cls-1",
            name: "A1",
            grade_level_id: null,
            section_name: null,
            category: null,
            academic_period: null,
          },
        },
      ],
      error: null,
    };
    responses.offering_quizzes = {
      data: [
        {
          id: "oq-1",
          offering_id: "off-1",
          quiz_id: "quiz-1",
          due_date: null,
          published_at: null,
          time_limit_override: null,
          quizzes: {
            id: "quiz-1",
            title: "Timed Quiz",
            time_limit_minutes: 10,
            quiz_questions: [{ count: 1 }],
          },
        },
      ],
      error: null,
    };
    responses.class_enrollments = {
      data: [{ class_id: "cls-1", user_id: "stu-1" }],
      error: null,
    };
    responses.profiles = {
      data: [{ user_id: "stu-1", full_name: "Bob", email: "bob@test" }],
      error: null,
    };
    // started 15 min before completed — exceeds the 10-minute limit.
    responses.quiz_sessions = {
      data: [
        {
          id: "sess-late",
          user_id: "stu-1",
          status: "completed",
          started_at: "2026-04-22T00:00:00Z",
          completed_at: "2026-04-22T00:15:00Z",
        },
      ],
      error: null,
    };
    responses.quiz_answers = {
      data: [
        { user_id: "stu-1", is_correct: true, answered_at: "2026-04-22T00:14:00Z" },
      ],
      error: null,
    };

    render(<AssignedQuizzesBoard courseId="course-1" />);

    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByText("A1")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("Timed Quiz")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /Timed Quiz/ }));

    await waitFor(() => {
      expect(screen.getByTestId("overtime-badge-stu-1")).toBeInTheDocument();
    });
  });

  it("renders the Release answers toggle reflecting answers_released state", async () => {
    responses.offerings = {
      data: [
        {
          id: "off-1",
          class_id: "cls-1",
          classes: {
            id: "cls-1",
            name: "A1",
            grade_level_id: null,
            section_name: null,
            category: null,
            academic_period: null,
          },
        },
      ],
      error: null,
    };
    responses.offering_quizzes = {
      data: [
        {
          id: "oq-1",
          offering_id: "off-1",
          quiz_id: "quiz-1",
          due_date: null,
          published_at: null,
          time_limit_override: null,
          answers_released: true,
          closed_at: "2026-01-02T10:00:00.000Z",
          quizzes: {
            id: "quiz-1",
            title: "Quiz One",
            quiz_questions: [{ count: 2 }],
          },
        },
      ],
      error: null,
    };
    responses.class_enrollments = { data: [], error: null };

    render(<AssignedQuizzesBoard courseId="course-1" />);

    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByText("A1")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("Quiz One")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /Quiz One/ }));

    const releaseToggle = (await screen.findByRole("switch", {
      name: /Release answers to this class/i,
    })) as HTMLButtonElement;
    expect(releaseToggle.getAttribute("aria-checked")).toBe("true");
  });

  it("persists answers_released when the Release answers toggle is flipped", async () => {
    responses.offerings = {
      data: [
        {
          id: "off-1",
          class_id: "cls-1",
          classes: {
            id: "cls-1",
            name: "A1",
            grade_level_id: null,
            section_name: null,
            category: null,
            academic_period: null,
          },
        },
      ],
      error: null,
    };
    responses.offering_quizzes = {
      data: [
        {
          id: "oq-1",
          offering_id: "off-1",
          quiz_id: "quiz-1",
          due_date: null,
          published_at: null,
          time_limit_override: null,
          answers_released: false,
          closed_at: "2026-01-02T10:00:00.000Z",
          quizzes: {
            id: "quiz-1",
            title: "Quiz One",
            quiz_questions: [{ count: 2 }],
          },
        },
      ],
      error: null,
    };
    responses.class_enrollments = { data: [], error: null };

    render(<AssignedQuizzesBoard courseId="course-1" />);

    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByText("A1")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("Quiz One")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /Quiz One/ }));

    const releaseToggle = await screen.findByRole("switch", {
      name: /Release answers to this class/i,
    });
    await user.click(releaseToggle);

    await waitFor(() => {
      const releaseUpdate = updateCalls.find(
        (c) =>
          c.table === "offering_quizzes" &&
          typeof c.values === "object" &&
          c.values !== null &&
          "answers_released" in (c.values as Record<string, unknown>),
      );
      expect(releaseUpdate).toBeTruthy();
      expect((releaseUpdate!.values as Record<string, unknown>).answers_released).toBe(true);
      expect(releaseUpdate!.id).toBe("oq-1");
    });
  });

  it("locks the Release answers toggle until the quiz is marked as done", async () => {
    responses.offerings = {
      data: [
        {
          id: "off-1",
          class_id: "cls-1",
          classes: {
            id: "cls-1",
            name: "A1",
            grade_level_id: null,
            section_name: null,
            category: null,
            academic_period: null,
          },
        },
      ],
      error: null,
    };
    responses.offering_quizzes = {
      data: [
        {
          id: "oq-1",
          offering_id: "off-1",
          quiz_id: "quiz-1",
          due_date: null,
          published_at: "2026-01-01T10:00:00.000Z",
          time_limit_override: null,
          answers_released: false,
          closed_at: null,
          quizzes: {
            id: "quiz-1",
            title: "Quiz One",
            quiz_questions: [{ count: 2 }],
          },
        },
      ],
      error: null,
    };
    responses.class_enrollments = { data: [], error: null };

    render(<AssignedQuizzesBoard courseId="course-1" />);

    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByText("A1")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("Quiz One")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /Quiz One/ }));

    const releaseToggle = await screen.findByRole("switch", {
      name: /Release answers to this class/i,
    });
    expect(releaseToggle).toBeDisabled();

    await user.click(releaseToggle);

    const releaseUpdate = updateCalls.find(
      (c) =>
        c.table === "offering_quizzes" &&
        typeof c.values === "object" &&
        c.values !== null &&
        "answers_released" in (c.values as Record<string, unknown>),
    );
    expect(releaseUpdate).toBeUndefined();
  });

  it("does not flag a completed attempt that finished within the time limit", async () => {
    responses.offerings = {
      data: [
        {
          id: "off-1",
          class_id: "cls-1",
          classes: {
            id: "cls-1",
            name: "A1",
            grade_level_id: null,
            section_name: null,
            category: null,
            academic_period: null,
          },
        },
      ],
      error: null,
    };
    responses.offering_quizzes = {
      data: [
        {
          id: "oq-1",
          offering_id: "off-1",
          quiz_id: "quiz-1",
          due_date: null,
          published_at: null,
          time_limit_override: 10,
          quizzes: {
            id: "quiz-1",
            title: "On-time Quiz",
            time_limit_minutes: null,
            quiz_questions: [{ count: 1 }],
          },
        },
      ],
      error: null,
    };
    responses.class_enrollments = {
      data: [{ class_id: "cls-1", user_id: "stu-2" }],
      error: null,
    };
    responses.profiles = {
      data: [{ user_id: "stu-2", full_name: "Carol", email: "carol@test" }],
      error: null,
    };
    // Finished inside the 10 minute limit (override wins over the base field).
    responses.quiz_sessions = {
      data: [
        {
          id: "sess-ok",
          user_id: "stu-2",
          status: "completed",
          started_at: "2026-04-22T00:00:00Z",
          completed_at: "2026-04-22T00:08:00Z",
        },
      ],
      error: null,
    };
    responses.quiz_answers = {
      data: [
        { user_id: "stu-2", is_correct: true, answered_at: "2026-04-22T00:07:00Z" },
      ],
      error: null,
    };

    render(<AssignedQuizzesBoard courseId="course-1" />);

    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByText("A1")).toBeInTheDocument());
    await waitFor(() =>
      expect(screen.getByText("On-time Quiz")).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: /On-time Quiz/ }));

    await waitFor(() => {
      expect(screen.getByText("Carol")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("overtime-badge-stu-2")).not.toBeInTheDocument();
  });

  it("renders a Closed badge when the assignment has closed_at set", async () => {
    responses.offerings = {
      data: [
        {
          id: "off-1",
          class_id: "cls-1",
          classes: {
            id: "cls-1",
            name: "A1",
            grade_level_id: null,
            section_name: null,
            category: null,
            academic_period: null,
          },
        },
      ],
      error: null,
    };
    responses.offering_quizzes = {
      data: [
        {
          id: "oq-closed",
          offering_id: "off-1",
          quiz_id: "quiz-1",
          due_date: null,
          published_at: "2026-04-01T00:00:00Z",
          time_limit_override: null,
          closed_at: "2026-05-01T12:00:00Z",
          quizzes: {
            id: "quiz-1",
            title: "Closed Quiz",
            quiz_questions: [{ count: 2 }],
          },
        },
      ],
      error: null,
    };
    responses.class_enrollments = { data: [], error: null };

    render(<AssignedQuizzesBoard courseId="course-1" />);

    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByText("A1")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("Closed Quiz")).toBeInTheDocument());

    expect(screen.getByTestId("closed-badge-oq-closed")).toBeInTheDocument();
  });

  it("calls mark_offering_quiz_done when the instructor confirms Mark as done", async () => {
    responses.offerings = {
      data: [
        {
          id: "off-1",
          class_id: "cls-1",
          classes: {
            id: "cls-1",
            name: "A1",
            grade_level_id: null,
            section_name: null,
            category: null,
            academic_period: null,
          },
        },
      ],
      error: null,
    };
    responses.offering_quizzes = {
      data: [
        {
          id: "oq-open",
          offering_id: "off-1",
          quiz_id: "quiz-1",
          due_date: null,
          published_at: "2026-04-01T00:00:00Z",
          time_limit_override: null,
          closed_at: null,
          quizzes: {
            id: "quiz-1",
            title: "Open Quiz",
            quiz_questions: [{ count: 2 }],
          },
        },
      ],
      error: null,
    };
    responses.class_enrollments = { data: [], error: null };

    render(<AssignedQuizzesBoard courseId="course-1" />);

    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByText("A1")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("Open Quiz")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /Open Quiz/ }));

    const markBtn = await screen.findByTestId("mark-done-oq-open");
    await user.click(markBtn);

    // Confirm in the dialog
    const confirmBtn = await screen.findByRole("button", {
      name: /^Mark as done$/i,
    });
    await user.click(confirmBtn);

    await waitFor(() => {
      const rpcCall = rpcCalls.find((c) => c.name === "mark_offering_quiz_done");
      expect(rpcCall).toBeTruthy();
      expect((rpcCall!.args as Record<string, unknown>).p_offering_quiz_id).toBe(
        "oq-open",
      );
    });
  });

  it("calls reopen_offering_quiz when the instructor clicks Reopen on a closed assignment", async () => {
    responses.offerings = {
      data: [
        {
          id: "off-1",
          class_id: "cls-1",
          classes: {
            id: "cls-1",
            name: "A1",
            grade_level_id: null,
            section_name: null,
            category: null,
            academic_period: null,
          },
        },
      ],
      error: null,
    };
    responses.offering_quizzes = {
      data: [
        {
          id: "oq-closed",
          offering_id: "off-1",
          quiz_id: "quiz-1",
          due_date: null,
          published_at: "2026-04-01T00:00:00Z",
          time_limit_override: null,
          closed_at: "2026-05-01T12:00:00Z",
          quizzes: {
            id: "quiz-1",
            title: "Closed Quiz",
            quiz_questions: [{ count: 2 }],
          },
        },
      ],
      error: null,
    };
    responses.class_enrollments = { data: [], error: null };

    render(<AssignedQuizzesBoard courseId="course-1" />);

    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByText("A1")).toBeInTheDocument());
    await waitFor(() =>
      expect(screen.getByText("Closed Quiz")).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: /Closed Quiz/ }));

    const reopenBtn = await screen.findByTestId("reopen-oq-closed");
    await user.click(reopenBtn);

    await waitFor(() => {
      const rpcCall = rpcCalls.find((c) => c.name === "reopen_offering_quiz");
      expect(rpcCall).toBeTruthy();
      expect((rpcCall!.args as Record<string, unknown>).p_offering_quiz_id).toBe(
        "oq-closed",
      );
    });
  });

  it("refetches when refreshKey changes so sibling components can trigger a reload (#651)", async () => {
    responses.offerings = {
      data: [
        {
          id: "off-1",
          class_id: "cls-1",
          classes: {
            id: "cls-1",
            name: "A1",
            grade_level_id: null,
            section_name: null,
            category: null,
            academic_period: null,
          },
        },
      ],
      error: null,
    };
    responses.offering_quizzes = { data: [], error: null };

    const { rerender } = render(
      <AssignedQuizzesBoard courseId="course-1" refreshKey={0} />,
    );
    await waitFor(() =>
      expect(
        screen.getByText(/no quizzes have been assigned/i),
      ).toBeInTheDocument(),
    );

    const fromMock = supabase.from as unknown as {
      mock: { calls: Array<[string]> };
    };
    const initialOfferingQuizCalls = fromMock.mock.calls.filter(
      ([t]) => t === "offering_quizzes",
    ).length;
    expect(initialOfferingQuizCalls).toBeGreaterThanOrEqual(1);

    // Simulate the parent bumping the key after a sibling assigns a quiz.
    responses.offering_quizzes = {
      data: [
        {
          id: "oq-new",
          offering_id: "off-1",
          quiz_id: "quiz-1",
          due_date: null,
          published_at: "2026-04-01T00:00:00Z",
          time_limit_override: null,
          quizzes: {
            id: "quiz-1",
            title: "Newly Assigned Quiz",
            quiz_questions: [{ count: 4 }],
          },
        },
      ],
      error: null,
    };

    rerender(<AssignedQuizzesBoard courseId="course-1" refreshKey={1} />);

    // The refetch surfaces the new assignment in the header summary.
    await waitFor(() => {
      expect(
        screen.getByText((content) => /1 total across 1 class/i.test(content)),
      ).toBeInTheDocument();
    });
    const afterOfferingQuizCalls = fromMock.mock.calls.filter(
      ([t]) => t === "offering_quizzes",
    ).length;
    expect(afterOfferingQuizCalls).toBeGreaterThan(initialOfferingQuizCalls);
  });

  const renderWithSingleAssignment = async (closedAt: string | null) => {
    responses.offerings = {
      data: [
        {
          id: "off-1",
          class_id: "cls-1",
          classes: {
            id: "cls-1",
            name: "A1",
            grade_level_id: null,
            section_name: null,
            category: null,
            academic_period: null,
          },
        },
      ],
      error: null,
    };
    responses.offering_quizzes = {
      data: [
        {
          id: "oq-1",
          offering_id: "off-1",
          quiz_id: "quiz-1",
          due_date: null,
          published_at: "2026-04-01T00:00:00Z",
          time_limit_override: null,
          closed_at: closedAt,
          quizzes: {
            id: "quiz-1",
            title: "Some Quiz",
            quiz_questions: [{ count: 2 }],
          },
        },
      ],
      error: null,
    };
    responses.class_enrollments = { data: [], error: null };

    render(<AssignedQuizzesBoard courseId="course-1" />);
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByText("A1")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("Some Quiz")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /Some Quiz/ }));
    return user;
  };

  it("labels a whole-class assignment with a 'Whole class' target badge", async () => {
    responses.offerings = {
      data: [
        {
          id: "off-1",
          class_id: "cls-1",
          classes: {
            id: "cls-1",
            name: "A1",
            grade_level_id: null,
            section_name: null,
            category: null,
            academic_period: null,
          },
        },
      ],
      error: null,
    };
    responses.offering_quizzes = {
      data: [
        {
          id: "oq-1",
          offering_id: "off-1",
          quiz_id: "quiz-1",
          group_id: null,
          due_date: null,
          published_at: "2026-04-01T00:00:00Z",
          time_limit_override: null,
          quizzes: {
            id: "quiz-1",
            title: "Quiz One",
            quiz_questions: [{ count: 2 }],
          },
        },
      ],
      error: null,
    };
    responses.class_enrollments = { data: [], error: null };

    render(<AssignedQuizzesBoard courseId="course-1" />);

    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByText("A1")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("Quiz One")).toBeInTheDocument());

    const badge = screen.getByTestId("target-badge-oq-1");
    expect(badge).toHaveTextContent(/Whole class/i);
  });

  it("labels a cluster assignment and scopes the roster/stats to the group's members", async () => {
    responses.offerings = {
      data: [
        {
          id: "off-1",
          class_id: "cls-1",
          classes: {
            id: "cls-1",
            name: "A1",
            grade_level_id: null,
            section_name: null,
            category: null,
            academic_period: null,
          },
        },
      ],
      error: null,
    };
    responses.offering_quizzes = {
      data: [
        {
          id: "oq-grp",
          offering_id: "off-1",
          quiz_id: "quiz-1",
          group_id: "grp-1",
          due_date: null,
          published_at: "2026-04-01T00:00:00Z",
          time_limit_override: null,
          quizzes: {
            id: "quiz-1",
            title: "Cluster Quiz",
            quiz_questions: [{ count: 2 }],
          },
        },
      ],
      error: null,
    };
    responses.offering_groups = {
      data: [{ id: "grp-1", name: "Struggling Readers" }],
      error: null,
    };
    responses.offering_group_members = {
      data: [{ group_id: "grp-1", user_id: "stu-1" }],
      error: null,
    };
    // Two students in the class, but only stu-1 is a member of the cluster.
    responses.class_enrollments = {
      data: [
        { class_id: "cls-1", user_id: "stu-1" },
        { class_id: "cls-1", user_id: "stu-2" },
      ],
      error: null,
    };
    responses.profiles = {
      data: [
        { user_id: "stu-1", full_name: "Alice", email: "alice@test" },
        { user_id: "stu-2", full_name: "Bob", email: "bob@test" },
      ],
      error: null,
    };
    responses.quiz_sessions = { data: [], error: null };
    responses.quiz_answers = { data: [], error: null };

    render(<AssignedQuizzesBoard courseId="course-1" />);

    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByText("A1")).toBeInTheDocument());
    await waitFor(() =>
      expect(screen.getByText("Cluster Quiz")).toBeInTheDocument(),
    );

    // Target badge names the cluster.
    expect(screen.getByTestId("target-badge-oq-grp")).toHaveTextContent(
      /Struggling Readers/i,
    );

    // Expand the card to load stats scoped to the group's members.
    await user.click(screen.getByRole("button", { name: /Cluster Quiz/ }));

    await waitFor(() => {
      // Only the one cluster member is counted, not the whole class of two.
      expect(screen.getByText(/Not submitted \(1\)/i)).toBeInTheDocument();
    });
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.queryByText("Bob")).not.toBeInTheDocument();
  });

  it("offers no in-card Analyze action — the AI assessment lives in the results dialog", async () => {
    await renderWithSingleAssignment("2026-05-01T12:00:00Z");
    // The closed card still renders its settings…
    await screen.findByTestId("reopen-oq-1");
    // …but the analysis moved to the quiz row's results dialog (Assessment tab).
    expect(screen.queryByTestId("analyze-quiz-oq-1")).not.toBeInTheDocument();
  });

  // Two assignments in the same class: one still accepting attempts, one closed.
  const renderOpenAndClosed = () => {
    responses.offerings = {
      data: [
        {
          id: "off-1",
          class_id: "cls-1",
          classes: {
            id: "cls-1",
            name: "A1",
            grade_level_id: null,
            section_name: null,
            category: null,
            academic_period: null,
          },
        },
      ],
      error: null,
    };
    responses.offering_quizzes = {
      data: [
        {
          id: "oq-open",
          offering_id: "off-1",
          quiz_id: "quiz-1",
          due_date: null,
          published_at: "2026-04-01T00:00:00Z",
          closed_at: null,
          quizzes: {
            id: "quiz-1",
            title: "Running Quiz",
            quiz_questions: [{ count: 2 }],
          },
        },
        {
          id: "oq-closed",
          offering_id: "off-1",
          quiz_id: "quiz-2",
          due_date: null,
          published_at: "2026-04-01T00:00:00Z",
          closed_at: "2026-05-01T12:00:00Z",
          quizzes: {
            id: "quiz-2",
            title: "Finished Quiz",
            quiz_questions: [{ count: 3 }],
          },
        },
      ],
      error: null,
    };
    responses.class_enrollments = { data: [], error: null };
    render(<AssignedQuizzesBoard courseId="course-1" />);
  };

  it("starts with every class expanded, without an accordion click", async () => {
    renderOpenAndClosed();

    // No user interaction: the assignments are on screen as soon as data lands.
    expect(await screen.findByText("Running Quiz")).toBeInTheDocument();
    expect(screen.getByText("Finished Quiz")).toBeInTheDocument();
  });

  it("splits a class's assignments into Open and Closed sessions", async () => {
    renderOpenAndClosed();

    const openSection = await screen.findByTestId("open-assignments-cls-1");
    const closedSection = screen.getByTestId("closed-assignments-cls-1");

    expect(
      within(openSection).getByTestId("assignment-card-oq-open"),
    ).toBeInTheDocument();
    expect(
      within(openSection).queryByTestId("assignment-card-oq-closed"),
    ).not.toBeInTheDocument();

    expect(
      within(closedSection).getByTestId("assignment-card-oq-closed"),
    ).toBeInTheDocument();
    expect(
      within(closedSection).queryByTestId("assignment-card-oq-open"),
    ).not.toBeInTheDocument();
  });

  it("moves an assignment into the Closed group once it is marked as done", async () => {
    renderOpenAndClosed();

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Running Quiz/ }));
    await user.click(await screen.findByTestId("mark-done-oq-open"));
    await user.click(
      await screen.findByRole("button", { name: /^mark as done$/i }),
    );

    await waitFor(() => {
      expect(
        within(screen.getByTestId("closed-assignments-cls-1")).getByTestId(
          "assignment-card-oq-open",
        ),
      ).toBeInTheDocument();
    });
    expect(
      within(screen.getByTestId("open-assignments-cls-1")).queryByTestId(
        "assignment-card-oq-open",
      ),
    ).not.toBeInTheDocument();
  });
  // A class holding one of each: an unpublished draft, a live assignment and a
  // closed one. Drafts are invisible to students (RLS hides published_at IS NULL),
  // so they must not sit under Open.
  const renderDraftOpenAndClosed = () => {
    responses.offerings = {
      data: [
        {
          id: "off-1",
          class_id: "cls-1",
          classes: {
            id: "cls-1",
            name: "A1",
            grade_level_id: null,
            section_name: null,
            category: null,
            academic_period: null,
          },
        },
      ],
      error: null,
    };
    responses.offering_quizzes = {
      data: [
        {
          id: "oq-draft",
          offering_id: "off-1",
          quiz_id: "quiz-1",
          due_date: null,
          published_at: null,
          closed_at: null,
          quizzes: {
            id: "quiz-1",
            title: "Draft Quiz",
            quiz_questions: [{ count: 2 }],
          },
        },
        {
          id: "oq-open",
          offering_id: "off-1",
          quiz_id: "quiz-2",
          due_date: null,
          published_at: "2026-04-01T00:00:00Z",
          closed_at: null,
          quizzes: {
            id: "quiz-2",
            title: "Running Quiz",
            quiz_questions: [{ count: 3 }],
          },
        },
        {
          id: "oq-closed",
          offering_id: "off-1",
          quiz_id: "quiz-3",
          due_date: null,
          published_at: "2026-04-01T00:00:00Z",
          closed_at: "2026-05-01T12:00:00Z",
          quizzes: {
            id: "quiz-3",
            title: "Finished Quiz",
            quiz_questions: [{ count: 4 }],
          },
        },
      ],
      error: null,
    };
    responses.class_enrollments = { data: [], error: null };
    render(<AssignedQuizzesBoard courseId="course-1" />);
  };

  it("keeps unpublished assignments out of Open and lists them under Drafts", async () => {
    renderDraftOpenAndClosed();

    const draftSection = await screen.findByTestId("draft-assignments-cls-1");
    const openSection = screen.getByTestId("open-assignments-cls-1");
    const closedSection = screen.getByTestId("closed-assignments-cls-1");

    expect(
      within(draftSection).getByTestId("assignment-card-oq-draft"),
    ).toBeInTheDocument();
    expect(
      within(openSection).queryByTestId("assignment-card-oq-draft"),
    ).not.toBeInTheDocument();
    expect(
      within(closedSection).queryByTestId("assignment-card-oq-draft"),
    ).not.toBeInTheDocument();

    // The other two stay where they were.
    expect(
      within(openSection).getByTestId("assignment-card-oq-open"),
    ).toBeInTheDocument();
    expect(
      within(closedSection).getByTestId("assignment-card-oq-closed"),
    ).toBeInTheDocument();
  });

  it("counts drafts separately from open in the header summary", async () => {
    renderDraftOpenAndClosed();

    await screen.findByTestId("draft-assignments-cls-1");
    expect(screen.getAllByText(/^1 draft$/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/^1 open$/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/^1 closed$/).length).toBeGreaterThan(0);
  });

  it("omits the Drafts group entirely when a class has no unpublished assignments", async () => {
    renderOpenAndClosed();

    await screen.findByTestId("open-assignments-cls-1");
    expect(screen.queryByTestId("draft-assignments-cls-1")).not.toBeInTheDocument();
  });

  it("explains an empty Open group by why it is empty", async () => {
    responses.offerings = {
      data: [
        {
          id: "off-1",
          class_id: "cls-1",
          classes: {
            id: "cls-1",
            name: "A1",
            grade_level_id: null,
            section_name: null,
            category: null,
            academic_period: null,
          },
        },
      ],
      error: null,
    };
    responses.offering_quizzes = {
      data: [
        {
          id: "oq-draft",
          offering_id: "off-1",
          quiz_id: "quiz-1",
          due_date: null,
          published_at: null,
          closed_at: null,
          quizzes: {
            id: "quiz-1",
            title: "Draft Quiz",
            quiz_questions: [{ count: 2 }],
          },
        },
      ],
      error: null,
    };
    render(<AssignedQuizzesBoard courseId="course-1" />);

    expect(
      await screen.findByText(/every assignment for this class is still a draft/i),
    ).toBeInTheDocument();
  });

  it("publishes a draft and moves its card into the Open group", async () => {
    renderDraftOpenAndClosed();

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Draft Quiz/ }));
    await user.click(await screen.findByTestId("publish-oq-draft"));

    await waitFor(() => {
      expect(
        within(screen.getByTestId("open-assignments-cls-1")).getByTestId(
          "assignment-card-oq-draft",
        ),
      ).toBeInTheDocument();
    });
    expect(screen.queryByTestId("draft-assignments-cls-1")).not.toBeInTheDocument();

    const publish = updateCalls.find(
      (c) => c.table === "offering_quizzes" && c.id === "oq-draft",
    );
    expect(publish).toBeDefined();
    expect((publish?.values as { published_at: string }).published_at).toEqual(
      expect.any(String),
    );
    // The update repeats the draft precondition, so a row another session closed
    // or published in the meantime matches nothing instead of being overwritten.
    expect(publish?.filters).toEqual(
      expect.arrayContaining(["published_at is null", "closed_at is null"]),
    );
  });

  it("refuses to publish a draft that has no questions yet", async () => {
    responses.offerings = {
      data: [
        {
          id: "off-1",
          class_id: "cls-1",
          classes: {
            id: "cls-1",
            name: "A1",
            grade_level_id: null,
            section_name: null,
            category: null,
            academic_period: null,
          },
        },
      ],
      error: null,
    };
    // An AI follow-up draft is assigned before its generation job produces any
    // questions; publishing it would hand students an empty quiz.
    responses.offering_quizzes = {
      data: [
        {
          id: "oq-empty",
          offering_id: "off-1",
          quiz_id: "quiz-1",
          due_date: null,
          published_at: null,
          closed_at: null,
          quizzes: {
            id: "quiz-1",
            title: "Generating Draft",
            quiz_questions: [{ count: 0 }],
          },
        },
      ],
      error: null,
    };
    responses.class_enrollments = { data: [], error: null };
    render(<AssignedQuizzesBoard courseId="course-1" />);

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Generating Draft/ }));

    const publishBtn = await screen.findByTestId("publish-oq-empty");
    expect(publishBtn).toBeDisabled();
    expect(
      screen.getByText(/this draft has no questions yet/i),
    ).toBeInTheDocument();

    await user.click(publishBtn);
    expect(
      updateCalls.filter((c) => c.table === "offering_quizzes"),
    ).toHaveLength(0);
  });

  it("keeps the card in Drafts when the publish update matches no row", async () => {
    renderDraftOpenAndClosed();
    // The guarded update matches nothing: another session closed, deleted or
    // already published this assignment since the board loaded.
    updateResponses.offering_quizzes = { data: [], error: null };

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Draft Quiz/ }));
    await user.click(await screen.findByTestId("publish-oq-draft"));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringMatching(/changed since the board loaded/i),
      );
    });
    expect(toast.success).not.toHaveBeenCalled();
    expect(
      within(screen.getByTestId("draft-assignments-cls-1")).getByTestId(
        "assignment-card-oq-draft",
      ),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("open-assignments-cls-1")).queryByTestId(
        "assignment-card-oq-draft",
      ),
    ).not.toBeInTheDocument();
  });
  // A draft whose follow-up generation job is still running. Job items append
  // questions per (chapter, type), so a nonzero count does not mean "ready".
  const renderGeneratingDraft = (jobStatus: string, questionCount: number) => {
    responses.offerings = {
      data: [
        {
          id: "off-1",
          class_id: "cls-1",
          classes: {
            id: "cls-1",
            name: "A1",
            grade_level_id: null,
            section_name: null,
            category: null,
            academic_period: null,
          },
        },
      ],
      error: null,
    };
    responses.offering_quizzes = {
      data: [
        {
          id: "oq-gen",
          offering_id: "off-1",
          quiz_id: "quiz-1",
          due_date: null,
          published_at: null,
          closed_at: null,
          quizzes: {
            id: "quiz-1",
            title: "Partial Draft",
            quiz_questions: [{ count: questionCount }],
          },
        },
      ],
      error: null,
    };
    responses.jobs = {
      data: [
        {
          status: jobStatus,
          created_at: "2026-07-01T00:00:00Z",
          params: { targetQuizId: "quiz-1" },
        },
      ],
      error: null,
    };
    responses.class_enrollments = { data: [], error: null };
    render(<AssignedQuizzesBoard courseId="course-1" />);
  };

  it("blocks publishing a nonempty draft while its generation job is still running", async () => {
    renderGeneratingDraft("processing", 3);

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Partial Draft/ }));

    const publishBtn = await screen.findByTestId("publish-oq-gen");
    expect(publishBtn).toBeDisabled();
    expect(
      screen.getByText(/questions are still being generated \(3 so far\)/i),
    ).toBeInTheDocument();

    await user.click(publishBtn);
    expect(updateCalls.filter((c) => c.table === "offering_quizzes")).toHaveLength(0);
  });

  it("blocks publishing while a generation job is still queued", async () => {
    renderGeneratingDraft("pending", 2);

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Partial Draft/ }));

    expect(await screen.findByTestId("publish-oq-gen")).toBeDisabled();
  });

  it("allows publishing a draft whose generation stopped short, but says it is incomplete", async () => {
    // The job will produce nothing further, so blocking forever would strand the
    // draft. Warn instead and let the instructor decide.
    renderGeneratingDraft("partially_completed", 4);

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Partial Draft/ }));

    const publishBtn = await screen.findByTestId("publish-oq-gen");
    expect(publishBtn).toBeEnabled();
    expect(
      screen.getByText(/generation stopped before finishing/i),
    ).toBeInTheDocument();

    await user.click(publishBtn);
    await waitFor(() => {
      expect(
        updateCalls.find((c) => c.table === "offering_quizzes" && c.id === "oq-gen"),
      ).toBeDefined();
    });
  });

  it("publishes normally when a completed job leaves no doubt about the draft", async () => {
    renderGeneratingDraft("completed", 6);

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Partial Draft/ }));

    expect(await screen.findByTestId("publish-oq-gen")).toBeEnabled();
    expect(
      screen.getByText(/publishing makes it visible to the students it targets/i),
    ).toBeInTheDocument();
  });
  it("refuses to publish when the generation-state lookup fails", async () => {
    // Failing open here would publish a draft whose worker may still be
    // appending questions, so an unreadable jobs table blocks the action.
    renderGeneratingDraft("processing", 3);
    responses.jobs = { data: null, error: { message: "boom" } };

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Partial Draft/ }));

    // Enabled on purpose — the click re-checks rather than stranding the draft.
    const publishBtn = await screen.findByTestId("publish-oq-gen");
    expect(publishBtn).toBeEnabled();
    await user.click(publishBtn);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringMatching(/could not check whether this draft has finished/i),
      );
    });
    expect(
      updateCalls.filter((c) => c.table === "offering_quizzes"),
    ).toHaveLength(0);
  });

  it("re-checks generation state at publish time, not just at board load", async () => {
    // Board loads with a finished job, then a regeneration starts before the
    // instructor clicks Publish. The stale snapshot must not win.
    renderGeneratingDraft("completed", 5);

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Partial Draft/ }));
    const publishBtn = await screen.findByTestId("publish-oq-gen");
    expect(publishBtn).toBeEnabled();

    responses.jobs = {
      data: [
        {
          status: "processing",
          created_at: "2026-07-02T00:00:00Z",
          params: { targetQuizId: "quiz-1" },
        },
      ],
      error: null,
    };
    await user.click(publishBtn);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringMatching(/still being generated/i),
      );
    });
    expect(
      updateCalls.filter((c) => c.table === "offering_quizzes"),
    ).toHaveLength(0);
    expect(toast.success).not.toHaveBeenCalled();
  });
});
