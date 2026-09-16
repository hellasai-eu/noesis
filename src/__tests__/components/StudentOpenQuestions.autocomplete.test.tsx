import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";

/**
 * A question the tutor closed shows as closed, without a reload.
 *
 * The tutor ends an open question by deciding `STOP`; the server turns that
 * into `chat_sessions.status = 'completed'` (`completeSessionOnStop`). Nothing
 * on this screen is told directly — `StreamingChatPanel` disables its own
 * composer off the same row, but the list badge and the mark-complete button
 * are rendered here — so the Realtime UPDATE is the only route, and these pin
 * that it is read correctly.
 *
 * Specifically: from `payload.new`. The handler this replaces compared
 * `payload.old.status`, which is always undefined under the default replica
 * identity, so it never fired at all.
 */

type Result = { data: unknown; error: unknown };
type Handler = (payload: { new: Record<string, unknown>; old: Record<string, unknown> }) => void;

const responses: Record<string, Result> = {
  questions: { data: [], error: null },
  chat_sessions: { data: [], error: null },
  chat_messages: { data: [], error: null },
  open_question_grades: { data: null, error: null },
  offering_questions: { data: [], error: null },
  profiles: { data: [], error: null },
};

const handlers: Handler[] = [];
/** Per-table gate: while set, that table's reads park until it resolves. */
const gates: Record<string, Promise<void> | undefined> = {};

vi.mock("@/integrations/supabase/client", () => {
  const buildChain = (table: string) => {
    const chain: Record<string, (...a: unknown[]) => unknown> = {};
    const passThrough = () => chain;
    chain.select = passThrough;
    chain.eq = passThrough;
    chain.in = passThrough;
    chain.neq = passThrough;
    chain.is = passThrough;
    chain.not = passThrough;
    chain.order = passThrough;
    chain.lte = passThrough;
    chain.insert = passThrough;
    chain.update = passThrough;
    chain.delete = passThrough;
    chain.upsert = passThrough;
    chain.single = () => Promise.resolve(responses[table] || { data: null, error: null });
    chain.maybeSingle = chain.single;
    chain.then = (resolve: (v: unknown) => unknown) => {
      const answer = () => resolve(responses[table] || { data: [], error: null });
      const gate = gates[table];
      return gate ? gate.then(answer) : Promise.resolve(answer());
    };
    return chain;
  };

  return {
    supabase: {
      from: vi.fn((table: string) => buildChain(table)),
      auth: {
        getUser: vi.fn(async () => ({ data: { user: { id: "stu-1" } } })),
        getSession: vi.fn(async () => ({ data: { session: { access_token: "tok" } } })),
      },
      channel: vi.fn(() => {
        const ch = {
          on: vi.fn((_event: string, _filter: unknown, handler: Handler) => {
            handlers.push(handler);
            return ch;
          }),
          subscribe: vi.fn(() => ch),
        };
        return ch;
      }),
      removeChannel: vi.fn(),
    },
  };
});

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "stu-1" } }) }));
vi.mock("@/hooks/useUserInstitution", () => ({
  useUserInstitution: () => ({ isAdmin: false, isInstructor: false }),
}));
vi.mock("@/hooks/useSocraticState", () => ({
  useSocraticState: () => ({ state: null, updateState: vi.fn() }),
}));

vi.mock("@/components/chat", async () => {
  const { useState } = await import("react");
  return {
    ChatWidget: () => null,
    StreamingChatPanel: ({ headerActions }: { headerActions?: unknown }) => (
      <div>{headerActions as never}</div>
    ),
    useChatStreaming: () => ({
      displayedContent: "",
      isTyping: false,
      addToQueue: vi.fn(),
      beginTyping: vi.fn(),
      finishTyping: vi.fn(),
      resetTyping: vi.fn(),
    }),
    parseSSEStream: vi.fn(),
    useChatMessages: (initial: unknown[] = []) => useState(initial),
  };
});

vi.mock("@/lib/latex-utils", () => ({ formatQuestionText: (s: string) => s }));

vi.stubEnv("VITE_SUPABASE_URL", "https://test.supabase.co");
vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "anon-test");

import { toast } from "sonner";
import StudentOpenQuestions from "@/components/StudentOpenQuestions";

const QUESTION = {
  id: "q-1",
  question: "Why is the sky blue?",
  difficulty: "easy",
  created_at: "2026-05-01T00:00:00Z",
  payload: { answering_mode: "interactive" },
  hidden: false,
};

const OTHER_QUESTION = {
  id: "q-2",
  question: "Why is the grass green?",
  difficulty: "easy",
  created_at: "2026-05-02T00:00:00Z",
  payload: { answering_mode: "interactive" },
  hidden: false,
};

const emit = async (row: Record<string, unknown>) => {
  await act(async () => {
    // `old` carries only the primary key: that is what the default replica
    // identity publishes, and reading anything else out of it is the bug.
    handlers.forEach((h) => h({ new: row, old: { id: "sess-1" } }));
  });
};

const renderList = async () => {
  render(
    <StudentOpenQuestions courseId="course-1" offeringId={null} mode="interactive" onBack={() => {}} />,
  );
  await waitFor(() => expect(screen.getByText("Why is the sky blue?")).toBeInTheDocument());
  await waitFor(() => expect(handlers.length).toBeGreaterThan(0));
};

beforeEach(() => {
  handlers.length = 0;
  for (const key of Object.keys(gates)) delete gates[key];
  vi.clearAllMocks();
  for (const key of Object.keys(responses)) responses[key] = { data: [], error: null };
  responses.questions = { data: [QUESTION], error: null };
});

describe("StudentOpenQuestions — the tutor closing a question", () => {
  it("marks the question complete when the session row turns completed", async () => {
    responses.chat_sessions = {
      data: [{ id: "sess-1", open_question_id: "q-1", status: "in_progress" }],
      error: null,
    };
    await renderList();

    expect(screen.queryByText("Completed")).not.toBeInTheDocument();

    await emit({ id: "sess-1", open_question_id: "q-1", status: "completed" });

    expect(screen.getByText("Completed")).toBeInTheDocument();
  });

  it("treats a repeat of the same status as nothing happening", async () => {
    responses.chat_sessions = {
      data: [{ id: "sess-1", open_question_id: "q-1", status: "in_progress" }],
      error: null,
    };
    await renderList();

    await emit({ id: "sess-1", open_question_id: "q-1", status: "completed" });
    await emit({ id: "sess-1", open_question_id: "q-1", status: "completed" });

    // Postgres emits an UPDATE for any write to the row, `updated_at` included,
    // so the same status arrives repeatedly. Only the transition may be acted
    // on — a student must not be told twice that their question just closed.
    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
  });

  it("does not announce a question that was already complete when the list loaded", async () => {
    responses.chat_sessions = {
      data: [{ id: "sess-1", open_question_id: "q-1", status: "completed" }],
      error: null,
    };
    await renderList();

    expect(screen.getByText("Completed")).toBeInTheDocument();

    // An unrelated UPDATE on the same row — `updated_at` moving, say. The
    // status has not changed, so nothing may be claimed about it.
    await emit({ id: "sess-1", open_question_id: "q-1", status: "completed" });

    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
  });

  it("ignores this student's study-session rows", async () => {
    responses.chat_sessions = {
      data: [{ id: "sess-1", open_question_id: "q-1", status: "in_progress" }],
      error: null,
    };
    await renderList();

    // The subscription can only filter on `user_id` — one row per (student,
    // subject), with no course column to narrow on — so study sessions arrive
    // on this channel too.
    await emit({ id: "sess-9", open_question_id: null, study_session_id: "ss-1", status: "completed" });

    expect(screen.queryByText("Completed")).not.toBeInTheDocument();
  });

  it("clears the completed badge when the question is reopened", async () => {
    responses.chat_sessions = {
      data: [{ id: "sess-1", open_question_id: "q-1", status: "completed" }],
      error: null,
    };
    await renderList();

    expect(screen.getByText("Completed")).toBeInTheDocument();

    await emit({ id: "sess-1", open_question_id: "q-1", status: "in_progress" });

    expect(screen.queryByText("Completed")).not.toBeInTheDocument();
  });

  it("keeps a live event that lands while the initial fetch is still reading", async () => {
    // The fetch and the subscription start together, and nothing orders them.
    // A completion arriving in that window is newer than anything the reads
    // return, so it must survive them — otherwise the badge appears and is
    // then quietly undone by the older answer.
    let openTheGate = () => {};
    gates.chat_sessions = new Promise<void>((resolve) => {
      openTheGate = resolve;
    });
    responses.chat_sessions = {
      data: [{ id: "sess-1", open_question_id: "q-1", status: "in_progress" }],
      error: null,
    };

    render(
      <StudentOpenQuestions courseId="course-1" offeringId={null} mode="interactive" onBack={() => {}} />,
    );
    await waitFor(() => expect(handlers.length).toBeGreaterThan(0));
    // The gate is doing its job: the fetch has not answered yet, so the event
    // below genuinely lands mid-read rather than after it.
    expect(screen.queryByText("Why is the sky blue?")).not.toBeInTheDocument();

    await emit({ id: "sess-1", open_question_id: "q-1", status: "completed" });

    await act(async () => {
      openTheGate();
    });
    await waitFor(() => expect(screen.getByText("Why is the sky blue?")).toBeInTheDocument());

    // The read said `in_progress`. The event said `completed`, and it is newer.
    expect(screen.getByText("Completed")).toBeInTheDocument();
  });

  it("releases its claim when the student's own write fails", async () => {
    responses.chat_sessions = {
      data: [{ id: "sess-1", open_question_id: "q-1", status: "in_progress" }],
      error: null,
    };
    await renderList();

    await userEvent.click(screen.getByRole("button", { name: /Start|Continue/i }));
    const markComplete = await screen.findByRole("button", { name: /Mark Complete/i });

    // Every write to this table now fails, including the one the button makes.
    responses.chat_sessions = { data: null, error: { message: "connection reset" } };
    await userEvent.click(markComplete);
    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalled());

    // Nothing was written, so the claim staked before the write must not
    // survive it: the tutor closing this question a moment later is a real
    // transition, not an echo of a click that never landed.
    await emit({ id: "sess-1", open_question_id: "q-1", status: "completed" });

    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
      "Correct! Question completed.",
      expect.anything(),
    );
  });

  it("releases its claim even when another question changes mid-write", async () => {
    // The sequence counter is global, so any question's event advances it. A
    // rollback that compared against the counter rather than against its own
    // claim would give up here — and the stale claim would then swallow the
    // real transition on the question the student actually pressed.
    responses.questions = { data: [QUESTION, OTHER_QUESTION], error: null };
    responses.chat_sessions = {
      data: [
        { id: "sess-1", open_question_id: "q-1", status: "in_progress" },
        { id: "sess-2", open_question_id: "q-2", status: "in_progress" },
      ],
      error: null,
    };
    await renderList();

    await userEvent.click(screen.getAllByRole("button", { name: /Start|Continue/i })[0]);
    const markComplete = await screen.findByRole("button", { name: /Mark Complete/i });

    // Park the write, so the unrelated event below genuinely lands while it is
    // in flight, and fail it when it is finally let through.
    let failTheWrite = () => {};
    gates.chat_sessions = new Promise<void>((resolve) => {
      failTheWrite = resolve;
    });
    responses.chat_sessions = { data: null, error: { message: "connection reset" } };

    const clicked = userEvent.click(markComplete);
    await waitFor(() => expect(markComplete).toBeDisabled());

    await emit({ id: "sess-2", open_question_id: "q-2", status: "completed" });

    await act(async () => {
      failTheWrite();
    });
    await clicked;
    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalled());

    await emit({ id: "sess-1", open_question_id: "q-1", status: "completed" });

    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
      "Correct! Question completed.",
      expect.anything(),
    );
  });
});
