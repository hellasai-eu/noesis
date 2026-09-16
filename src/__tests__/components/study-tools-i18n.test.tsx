/**
 * The five study-tool surfaces render translated copy.
 *
 * Same discipline as the earlier phases: each component is driven into the
 * state that actually carries the text — a finished review session, a loaded
 * chapter list, a graded single answer — rather than asserting first paint,
 * because the strings that survived review in #1211 and #1213 were all in
 * states the tests never reached.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

import i18n from "@/i18n";

vi.mock("@/lib/latex-utils", () => ({
  formatQuestionText: (text: string) => text ?? "",
  processLatexContent: (text: string) => text ?? "",
}));

const chain = () => {
  const c: Record<string, unknown> = {};
  for (const m of [
    "select", "insert", "update", "upsert", "delete", "eq", "neq", "in",
    "not", "is", "or", "order", "limit", "range", "gte", "lte",
  ]) {
    c[m] = vi.fn(() => c);
  }
  c.single = vi.fn().mockResolvedValue({ data: null, error: null });
  c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
  c.then = vi.fn((cb: (v: unknown) => void) =>
    Promise.resolve(cb({ data: [], error: null })),
  );
  return c;
};

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: vi.fn(() => chain()),
    // StudentQuestionGenerator resolves the caller's admin status through two
    // RPCs before it renders; without these the promise rejects and the run
    // exits non-zero even though every assertion passes.
    rpc: vi.fn().mockResolvedValue({ data: false, error: null }),
    channel: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn().mockReturnThis(),
    })),
    removeChannel: vi.fn(),
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: "u-1" } },
        error: null,
      }),
      getSession: vi.fn().mockResolvedValue({
        data: { session: { access_token: "t" } },
        error: null,
      }),
      onAuthStateChange: vi.fn(() => ({
        data: { subscription: { unsubscribe: vi.fn() } },
      })),
    },
  },
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({
    user: { id: "u-1", email: "s@test.local" },
    session: { access_token: "t" },
    profile: { id: "p", user_id: "u-1", full_name: "S", email: "s@test.local" },
    loading: false,
    signIn: vi.fn(),
    signUp: vi.fn(),
    signOut: vi.fn(),
    updatePassword: vi.fn(),
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(),
  },
}));

import FlashcardSessionManager from "@/components/FlashcardSessionManager";
import StudentQuestionGenerator from "@/components/StudentQuestionGenerator";
import { StudentStudySession } from "@/components/StudentStudySession";
import StudentOpenQuestions from "@/components/StudentOpenQuestions";

beforeAll(() => {
  for (const m of ["hasPointerCapture", "setPointerCapture", "releasePointerCapture"]) {
    if (!(m in Element.prototype)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (Element.prototype as any)[m] = () => false;
    }
  }
  if (!Element.prototype.scrollIntoView) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Element.prototype as any).scrollIntoView = () => {};
  }
  if (typeof globalThis.ResizeObserver === "undefined") {
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).ResizeObserver = ResizeObserverStub;
  }
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("study tools — locale", () => {
  it("FlashcardSessionManager translates its empty state", async () => {
    await i18n.changeLanguage("el");
    render(
      <FlashcardSessionManager
        courseId="c-1"
        onStartSession={vi.fn()}
      />,
    );

    // Longer than the 1s default: this component chains several awaited
    // queries before it can decide it has nothing to show, and it lands just
    // past the default whenever the suite runs files in parallel.
    await waitFor(
      () =>
        expect(
          screen.getByText(
            "Δεν υπάρχουν διαθέσιμες κάρτες. Περίμενε να προσθέσει ο καθηγητής σου.",
          ),
        ).toBeInTheDocument(),
      { timeout: 5000 },
    );
  });

  it("StudentQuestionGenerator translates its setup screen", async () => {
    await i18n.changeLanguage("el");
    render(
      <StudentQuestionGenerator
        courseId="c-1"
        classId="cl-1"
        onBack={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(screen.getByText("Φτιάξε ερωτήσεις εξάσκησης")).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /Πίσω/ })).toBeInTheDocument();
    expect(screen.queryByText("Create Practice Questions")).not.toBeInTheDocument();
  });

  it("StudentStudySession translates its list and empty state", async () => {
    await i18n.changeLanguage("el");
    render(<StudentStudySession courseId="c-1" onBack={vi.fn()} />);

    await waitFor(() =>
      expect(screen.getByText("Συνεδρίες διδασκαλίας")).toBeInTheDocument(),
    );
    expect(screen.getByText("Δεν υπάρχουν συνεδρίες")).toBeInTheDocument();
    expect(screen.queryByText("Tutoring Sessions")).not.toBeInTheDocument();
  });

  it("StudentOpenQuestions translates the single-answer header and empty state", async () => {
    await i18n.changeLanguage("el");
    render(
      <StudentOpenQuestions
        courseId="c-1"
        mode="single"
        onBack={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(screen.getByText("Ανοικτές ερωτήσεις")).toBeInTheDocument(),
    );
    expect(
      screen.getByText("Δεν υπάρχουν ανοικτές ερωτήσεις ακόμα"),
    ).toBeInTheDocument();
  });

  /**
   * The interactive mode is a different header and empty state chosen by the
   * same component, so asserting only `single` would leave half the copy
   * unexercised.
   */
  it("StudentOpenQuestions translates the interactive-mode header", async () => {
    await i18n.changeLanguage("el");
    render(
      <StudentOpenQuestions
        courseId="c-1"
        mode="interactive"
        onBack={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(screen.getByText("Διαδραστικές ερωτήσεις AI")).toBeInTheDocument(),
    );
    expect(
      screen.getByText("Δεν υπάρχουν διαδραστικές ερωτήσεις AI ακόμα"),
    ).toBeInTheDocument();
  });
});
