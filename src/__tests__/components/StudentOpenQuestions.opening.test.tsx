/**
 * The Socratic opening turn on an interactive open question (#1313).
 *
 * #1249 made `StreamingChatPanel` the surface students get, but left this
 * component asking for the opening turn the buffered way. Two halves of one
 * bug, and this file pins both:
 *
 *   1. The panel is asked to open with a tutor turn (`openWithTutorTurn`).
 *      Without it the student opened an un-started question to an empty
 *      transcript and no greeting — the panel waits to be spoken to first.
 *   2. The buffered `generateWelcomeMessage` effect no longer fires. It POSTs
 *      to `chat` — a real, billed model call — and writes the reply into
 *      `chatMessages`, state the streaming panel never reads. Under streaming
 *      it was pure waste with nothing to show for it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

type Result = { data: unknown; error: unknown };

const responses: Record<string, Result> = {
  questions: { data: [], error: null },
  chat_sessions: { data: [], error: null },
  chat_messages: { data: [], error: null },
  open_question_grades: { data: null, error: null },
  offering_questions: { data: [], error: null },
  profiles: { data: [], error: null },
};

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
    chain.single = () =>
      Promise.resolve(responses[table] || { data: null, error: null });
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
        getSession: vi.fn(async () => ({
          data: { session: { access_token: "tok" } },
        })),
      },
      channel: vi.fn(() => ({
        on: vi.fn().mockReturnThis(),
        subscribe: vi.fn().mockReturnThis(),
      })),
      removeChannel: vi.fn(),
    },
  };
});

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "stu-1" } }),
}));

vi.mock("@/hooks/useUserInstitution", () => ({
  useUserInstitution: () => ({ isAdmin: false, isInstructor: false }),
}));

vi.mock("@/hooks/useSocraticState", () => ({
  useSocraticState: () => ({ state: null, updateState: vi.fn() }),
}));

/** Props the panel was last rendered with — what assertion 1 reads. */
const panelProps: Array<Record<string, unknown>> = [];

vi.mock("@/components/chat", async () => {
  const { useState } = await import("react");
  return {
    ChatWidget: () => null,
    // Stands in for the real panel: records its props and renders a marker, so
    // the test can assert what it was ASKED to do without pulling in streaming.
    StreamingChatPanel: (props: Record<string, unknown>) => {
      panelProps.push(props);
      return <div data-testid="streaming-panel" />;
    },
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

vi.mock("@/lib/latex-utils", () => ({
  formatQuestionText: (s: string) => s,
}));

vi.stubEnv("VITE_SUPABASE_URL", "https://test.supabase.co");
vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "anon-test");

import StudentOpenQuestions from "@/components/StudentOpenQuestions";
import { USE_STREAMING_CHAT } from "@/lib/chat-surface";

const INTERACTIVE_QUESTION = {
  id: "q-interactive-1",
  question: "Explain why 2 + 3 is the same as 3 + 2.",
  difficulty: "easy",
  created_at: "2026-05-02T00:00:00Z",
  payload: { answering_mode: "interactive" },
  hidden: false,
};

/** Every URL passed to `fetch` during a test. */
let fetchedUrls: string[] = [];

beforeEach(() => {
  for (const key of Object.keys(responses)) {
    responses[key] = { data: [], error: null };
  }
  panelProps.length = 0;
  fetchedUrls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      fetchedUrls.push(String(url));
      return {
        ok: true,
        headers: { get: () => "application/json" },
        json: async () => ({ assistant_text: "hi" }),
      };
    }),
  );
});

/** Render the interactive list and open the seeded question. */
async function openTheQuestion() {
  responses.questions = { data: [INTERACTIVE_QUESTION], error: null };

  render(
    <StudentOpenQuestions
      courseId="course-1"
      offeringId={null}
      mode="interactive"
      onBack={() => {}}
    />,
  );

  await waitFor(() => {
    expect(screen.getByText(INTERACTIVE_QUESTION.question)).toBeInTheDocument();
  });
  await userEvent.click(screen.getByRole("button", { name: /start/i }));
  await screen.findByTestId("streaming-panel");
}

describe("StudentOpenQuestions — Socratic opening turn (#1313)", () => {
  it("is the streaming surface students get", () => {
    // The rest of this file only means anything while that is true; if the
    // switch is ever flipped back, these assertions should be revisited rather
    // than silently passing against the buffered path.
    expect(USE_STREAMING_CHAT).toBe(true);
  });

  it("asks the panel to open with a tutor turn", async () => {
    await openTheQuestion();

    expect(panelProps.length).toBeGreaterThan(0);
    const last = panelProps[panelProps.length - 1];
    expect(last.openWithTutorTurn).toBe(true);
    // Scoped to the question the student picked, not the course.
    expect(last.kind).toBe("open_question");
    expect(last.subjectId).toBe(INTERACTIVE_QUESTION.id);
  });

  it("does not fire the buffered welcome call, whose reply nothing would render", async () => {
    await openTheQuestion();

    // Give the (now removed) effect a chance to run before asserting absence —
    // otherwise this passes for the wrong reason.
    await waitFor(() => {
      expect(screen.getByTestId("streaming-panel")).toBeInTheDocument();
    });
    expect(fetchedUrls.filter((u) => u.includes("/functions/v1/chat"))).toEqual([]);
  });
});
