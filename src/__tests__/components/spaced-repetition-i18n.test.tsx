/**
 * SpacedRepetitionReview renders translated copy.
 *
 * In its own file rather than alongside the other study tools: it drives a
 * long async load and leaves timers behind, and sharing a module registry with
 * the other four made whichever test ran first hang. Isolation is cheaper than
 * unpicking that, and keeps a failure here attributable to this component.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

import i18n from "@/i18n";

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
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import SpacedRepetitionReview from "@/components/SpacedRepetitionReview";

beforeAll(() => {
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

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("SpacedRepetitionReview — locale", () => {
  /**
   * With nothing due, the component settles on its all-done screen — where the
   * daily-progress lines and their <Trans> slots live.
   */
  it("translates the all-done screen", async () => {
    await i18n.changeLanguage("el");
    render(
      <SpacedRepetitionReview courseId="c-1" chapterIds={[]} onClose={vi.fn()} />,
    );

    // Asserted together: the screen settles through a loading pass, and
    // checking them separately raced different renders.
    await waitFor(
      () => {
        expect(screen.getByText("Τελείωσες για σήμερα!")).toBeInTheDocument();
        expect(screen.getByText("Πίσω στο μάθημα")).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
    expect(screen.queryByText("All Done for Today!")).not.toBeInTheDocument();
  });
});
