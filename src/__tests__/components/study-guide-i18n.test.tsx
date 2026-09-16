/**
 * The study-guide player's copy, in both locales.
 *
 * `StudyGuidePlayer` mounts four components that each render catalog copy —
 * itself, `TheoryBlock`, `PieceView` and `Feedback` — and each needed its own
 * `useTranslation`. That is exactly the shape that produced a runtime crash in
 * #1207 when one component was missed, so this renders the player far enough to
 * mount them rather than testing the catalog in isolation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

import i18n from "@/i18n";

const PIECES = [
  { id: "p1", title: "Addition", position: 0, theory_html: "<p>Adding numbers</p>" },
  { id: "p2", title: "Subtraction", position: 1, theory_html: null },
];

/**
 * Table-aware rows. The player only clears its spinner once the guide, its
 * pieces and the student's progress have all resolved; returning `[]` for
 * everything leaves it on "Loading study guide…" and every assertion fails for
 * the wrong reason.
 */
const ROWS: Record<string, unknown[]> = {
  study_guides: [{ id: "sg-1", title: "Numbers", course_id: "c-1" }],
  study_guide_pieces: PIECES,
  study_guide_progress: [
    {
      id: "prog-1",
      study_guide_id: "sg-1",
      user_id: "u-1",
      current_piece_position: 0,
      completed_piece_ids: [],
      completed_at: null,
      draft_answers: null,
    },
  ],
  study_guide_piece_questions: [],
  questions: [],
  study_guide_answers: [],
};

function chain(table: string) {
  const rows = ROWS[table] ?? [];
  const result = { data: rows, error: null };
  const c: Record<string, unknown> = {};
  for (const m of [
    "select", "insert", "update", "upsert", "delete", "eq", "neq", "in",
    "not", "is", "or", "order", "limit", "range",
  ]) {
    c[m] = vi.fn(() => c);
  }
  const one = { data: rows[0] ?? null, error: null };
  c.single = vi.fn().mockResolvedValue(one);
  c.maybeSingle = vi.fn().mockResolvedValue(one);
  c.then = vi.fn((cb: (v: unknown) => void) => Promise.resolve(cb(result)));
  return c;
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: vi.fn((table: string) => chain(table)),
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { access_token: "token" } },
        error: null,
      }),
    },
  },
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({
    user: { id: "u-1", email: "s@test.local" },
    session: { access_token: "token" },
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

async function renderPlayer() {
  const { StudyGuidePlayer } = await import("@/components/study-guide/StudyGuidePlayer");
  return render(
    <StudyGuidePlayer
      studyGuideId="sg-1"
      offeringId="off-1"
      courseId="c-1"
      onBack={() => {}}
    />
  );
}

describe("StudyGuidePlayer — locale", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("renders its chrome in English", async () => {
    await renderPlayer();

    await waitFor(() =>
      expect(screen.getByText("0 of 2 pieces completed")).toBeInTheDocument()
    );
    expect(screen.getByRole("button", { name: "Back to course" })).toBeInTheDocument();
    // The current piece auto-opens, which is what mounts `PieceView` and
    // `TheoryBlock` — the components whose own hooks this test exists to cover.
    expect(await screen.findByText("Theory")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Submit piece/ })).toBeInTheDocument();
  });

  it("renders its chrome in Greek", async () => {
    await i18n.changeLanguage("el");
    await renderPlayer();

    await waitFor(() =>
      expect(screen.getByText("0 από 2 κομμάτια ολοκληρώθηκαν")).toBeInTheDocument()
    );
    expect(
      screen.getByRole("button", { name: "Πίσω στο μάθημα" })
    ).toBeInTheDocument();
  });

  it("inflects the piece count", async () => {
    const original = ROWS.study_guide_pieces;
    ROWS.study_guide_pieces = [PIECES[0]];
    try {
      await i18n.changeLanguage("el");
      await renderPlayer();
      await waitFor(() =>
        expect(screen.getByText("0 από 1 κομμάτι ολοκληρώθηκε")).toBeInTheDocument()
      );
    } finally {
      ROWS.study_guide_pieces = original;
    }
  });

  it("translates the empty state", async () => {
    const original = ROWS.study_guide_pieces;
    ROWS.study_guide_pieces = [];
    try {
      await i18n.changeLanguage("el");
      await renderPlayer();
      await waitFor(() =>
        expect(
          screen.getByText("Αυτός ο οδηγός μελέτης δεν έχει κομμάτια ακόμα.")
        ).toBeInTheDocument()
      );
    } finally {
      ROWS.study_guide_pieces = original;
    }
  });
});
