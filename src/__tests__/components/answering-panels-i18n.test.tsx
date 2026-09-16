/**
 * The five single-question answering panels render translated copy.
 *
 * Each panel is a separate component with its own `useTranslation`, which is the
 * shape that produced runtime crashes twice already (#1207, #1209) when one was
 * missed. These mount every panel in both locales rather than checking the
 * catalog in isolation, so a missing hook throws here instead of in front of a
 * student mid-practice.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

import i18n from "@/i18n";

const QUESTIONS: Record<string, Record<string, unknown>> = {
  mcq: {
    id: "q-mcq",
    type: "mcq",
    question: "Pick one",
    difficulty: "easy",
    payload: { options: ["a", "b"], multi_correct: false },
  },
  open: {
    id: "q-open",
    type: "open",
    question: "Explain",
    difficulty: "easy",
    payload: { answering_mode: "single" },
  },
  fill_gaps: {
    id: "q-gaps",
    type: "fill_gaps",
    question: "Water freezes at {{1}}.",
    difficulty: "easy",
    payload: { stem: "Water freezes at {{1}}.", gaps: [{ ordinal: 1 }] },
  },
  ordering: {
    id: "q-order",
    type: "ordering",
    question: "Put in order",
    difficulty: "easy",
    payload: { items: ["one", "two"] },
  },
  classification: {
    id: "q-class",
    type: "classification",
    question: "Sort these",
    difficulty: "easy",
    payload: {
      categories: [{ id: "c1", label: "Metals" }],
      items: [{ id: "i1", text: "Iron" }],
    },
  },
};

/** Which question the mocked client should return for the next render. */
let activeQuestion: Record<string, unknown> = QUESTIONS.mcq;

/**
 * The `open_question_grades` row, or null for an unanswered question. Setting
 * it is what puts a panel into its submitted result state — the state the
 * student is actually looking at when they read their grade.
 */
let activeGrade: Record<string, unknown> | null = null;

function chain(table: string) {
  let rows: Record<string, unknown>[] = [];
  if (table === "questions") rows = [activeQuestion];
  else if (table === "open_question_grades" && activeGrade) rows = [activeGrade];
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
        data: { session: { access_token: "t" } },
        error: null,
      }),
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: "u-1" } },
        error: null,
      }),
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

const PANELS = [
  ["SingleMcqAnsweringPanel", "mcq", "Multiple choice", "Πολλαπλής επιλογής"],
  ["SingleOpenAnsweringPanel", "open", "Single-answer question", "Ερώτηση ανοικτής απάντησης"],
  ["SingleFillGapsAnsweringPanel", "fill_gaps", "Fill the Gaps", "Συμπλήρωση κενών"],
  ["SingleOrderingAnsweringPanel", "ordering", "Ordering", "Σειρά"],
  ["SingleClassificationAnsweringPanel", "classification", "Classification", "Ταξινόμηση"],
] as const;

async function renderPanel(
  name: string,
  questionKey: string,
  grade: Record<string, unknown> | null = null
) {
  activeQuestion = QUESTIONS[questionKey];
  activeGrade = grade;
  const mod = await import("@/components/student-answering");
  const Panel = (mod as unknown as Record<
    string,
    React.ComponentType<Record<string, unknown>>
  >)[name];
  expect(Panel, `${name} is exported`).toBeTruthy();
  return render(
    <Panel
      questionId={activeQuestion.id}
      courseId="c-1"
      offeringId="off-1"
      userId="u-1"
      onBack={() => {}}
    />
  );
}

describe("answering panels — locale", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(async () => {
    await i18n.changeLanguage("en");
    activeGrade = null;
  });

  for (const [name, key, english, greek] of PANELS) {
    it(`${name} renders its title in English`, async () => {
      const { unmount } = await renderPanel(name, key);
      await waitFor(() => expect(screen.getByText(english)).toBeInTheDocument());
      unmount();
    });

    it(`${name} renders its title in Greek`, async () => {
      await i18n.changeLanguage("el");
      const { unmount } = await renderPanel(name, key);
      await waitFor(() => expect(screen.getByText(greek)).toBeInTheDocument());
      unmount();
    });
  }

  /**
   * The submitted result views. These are a separate mount from the ones above
   * because a panel only reaches them when a grade row exists — which is why
   * mounting every panel was not enough to catch untranslated result copy
   * staying English through two review rounds. The numeric grade itself is
   * deliberately NOT rendered in practice (formative surface) — each mount
   * also asserts its absence in both languages.
   */
  const GRADED = [
    [
      "SingleFillGapsAnsweringPanel",
      "fill_gaps",
      { grade: 84, submitted_answer: '["0"]', gap_results: { perGap: [true], allCorrect: true } },
      ["1 από 1 κενά σωστά"],
    ],
    [
      "SingleOrderingAnsweringPanel",
      "ordering",
      {
        grade: 84,
        submitted_answer: '["one","two"]',
        gap_results: { perPosition: [true, true], allCorrect: true },
      },
      ["2 από 2 θέσεις σωστές"],
    ],
    [
      "SingleClassificationAnsweringPanel",
      "classification",
      {
        grade: 84,
        submitted_answer: '{"i1":"c1"}',
        gap_results: { perItem: { i1: true }, allCorrect: true, hintsUsed: 2 },
      },
      ["1 από 1 στοιχεία σωστά", "χρησιμοποιήθηκαν 2 βοήθειες"],
    ],
    [
      "SingleOpenAnsweringPanel",
      "open",
      {
        grade: 84,
        feedback: "ok",
        strengths: [],
        areas_for_improvement: [],
        submitted_answer: "an answer",
      },
      ["Υποβλήθηκε"],
    ],
  ] as const;

  for (const [name, key, grade, expected] of GRADED) {
    it(`${name} translates its submitted state and hides the numeric grade`, async () => {
      await i18n.changeLanguage("el");
      const { unmount } = await renderPanel(name, key, grade);
      await waitFor(() =>
        expect(screen.getByText(expected[0])).toBeInTheDocument()
      );
      for (const text of expected.slice(1)) {
        expect(screen.getByText(text)).toBeInTheDocument();
      }
      expect(screen.queryByText(/Βαθμός: 84|Grade: 84/)).not.toBeInTheDocument();
      unmount();
    });
  }

  it("translates the shared back control", async () => {
    await i18n.changeLanguage("el");
    await renderPanel("SingleMcqAnsweringPanel", "mcq");
    await waitFor(() =>
      expect(screen.getByText("Πολλαπλής επιλογής")).toBeInTheDocument()
    );
    // The chrome's default back label comes from the same catalog.
    expect(screen.getByRole("button", { name: "Πίσω" })).toBeInTheDocument();
  });
});
