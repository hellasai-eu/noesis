import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

// #613 — verifies that the `mode` prop filters the rendered list to the
// matching `payload.answering_mode`, with the legacy reader's "missing →
// interactive" default still respected.

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
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
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

// Avoid loading the chat widget — it pulls in markdown/streaming utilities
// that aren't relevant to the filter assertion.
vi.mock("@/components/chat", async () => {
  const { useState } = await import("react");
  return {
  ChatWidget: () => null,
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

const mixedQuestions = [
  {
    id: "q-single-1",
    question: "Single-mode A",
    difficulty: "easy",
    created_at: "2026-05-01T00:00:00Z",
    payload: { answering_mode: "single" },
    hidden: false,
  },
  {
    id: "q-interactive-1",
    question: "Interactive-mode A",
    difficulty: "medium",
    created_at: "2026-05-02T00:00:00Z",
    payload: { answering_mode: "interactive" },
    hidden: false,
  },
  {
    id: "q-default-1",
    question: "Default-mode (no payload)",
    difficulty: "hard",
    created_at: "2026-05-03T00:00:00Z",
    payload: {},
    hidden: false,
  },
];

beforeEach(() => {
  for (const key of Object.keys(responses)) {
    responses[key] = { data: [], error: null };
  }
});

describe("StudentOpenQuestions — mode filter (#613)", () => {
  it("renders only single-answer questions when mode='single'", async () => {
    responses.questions = { data: mixedQuestions, error: null };

    render(
      <StudentOpenQuestions
        courseId="course-1"
        offeringId={null}
        mode="single"
        onBack={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Single-mode A")).toBeInTheDocument();
    });
    // The default-mode row reads as "interactive" — must not appear in the
    // single-mode list.
    expect(screen.queryByText("Interactive-mode A")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Default-mode (no payload)"),
    ).not.toBeInTheDocument();
    // Header uses the single-mode title.
    expect(
      screen.getByRole("heading", { name: /Open Questions/i }),
    ).toBeInTheDocument();
  });

  it("renders interactive + default-mode questions when mode='interactive'", async () => {
    responses.questions = { data: mixedQuestions, error: null };

    render(
      <StudentOpenQuestions
        courseId="course-1"
        offeringId={null}
        mode="interactive"
        onBack={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Interactive-mode A")).toBeInTheDocument();
    });
    // The legacy default ({} → "interactive") surfaces here too.
    expect(screen.getByText("Default-mode (no payload)")).toBeInTheDocument();
    // Single-mode row is filtered out.
    expect(screen.queryByText("Single-mode A")).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /AI Interactive Questions/i }),
    ).toBeInTheDocument();
  });

  it("shows the mode-specific empty state when filter excludes every row", async () => {
    responses.questions = {
      data: [mixedQuestions[1], mixedQuestions[2]],
      error: null,
    };

    render(
      <StudentOpenQuestions
        courseId="course-1"
        offeringId={null}
        mode="single"
        onBack={() => {}}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByText(/No open questions available yet/i),
      ).toBeInTheDocument();
    });
  });
});
