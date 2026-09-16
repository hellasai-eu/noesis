import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * Component tests for the student ordering answering surface (#1054).
 *
 * The two things this file is really here to guard:
 *
 *  - the LIST must not print the canonical order. That was #1041: the preview
 *    rendered items in stored (correct) order, handing over the answer before
 *    the question was opened. Fixed in #1059; this pins it.
 *  - the ANSWERING view must show a deterministic per-(question, student)
 *    shuffle, and must go read-only once submitted — ordering questions allow a
 *    single submission, so a post-submit edit would be silently discarded.
 *
 * Not covered here, deliberately: the drag interaction itself. dnd-kit's
 * pointer sensor needs a real layout (it measures rects), so exercising it in
 * jsdom tests dnd-kit rather than this component. What IS asserted is the
 * contract that matters downstream — the order submitted to the grader is the
 * order on screen. Per-position grading maths lives in
 * src/__tests__/lib/grade-ordering.test.ts.
 */

type Result = { data: unknown; error: unknown };
const responses: Record<string, Result> = {
  questions: { data: [], error: null },
  chat_sessions: { data: [], error: null },
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
    chain.upsert = passThrough;
    chain.maybeSingle = () => Promise.resolve(responses[table] ?? { data: null, error: null });
    chain.single = chain.maybeSingle;
    chain.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(resolve(responses[table] ?? { data: [], error: null }));
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

import StudentOrderingQuestions, { seededShuffle } from "@/components/StudentOrderingQuestions";

const CANONICAL = ["Otto", "George I", "Constantine I", "Alexander"];
const QUESTION_ID = "ord-1";
const USER_ID = "stu-1";

/** The order this student is expected to be shown, per the component's seed. */
const EXPECTED_SHUFFLE = seededShuffle(CANONICAL, `${QUESTION_ID}::${USER_ID}`);

function seedQuestionRow() {
  responses.questions = {
    data: [
      {
        id: QUESTION_ID,
        payload: { prompt: "Order the kings by reign", items: CANONICAL },
        answer_key: {},
        explanation: "Chronological order.",
        difficulty: "medium",
      },
    ],
    error: null,
  };
}

/** Read the item labels in rendered order from the answering view. */
function renderedOrder(): string[] {
  return screen
    .getAllByRole("button", { name: /drag item at position/i })
    .map((handle) => handle.parentElement!.textContent!.replace(/^\d+\.\s*/, "").trim());
}

beforeEach(() => {
  responses.questions = { data: [], error: null };
  responses.chat_sessions = { data: [], error: null };
  responses.open_question_grades = { data: null, error: null };
  fetchMock.mockReset();
  seedQuestionRow();
});

async function openTheQuestion() {
  render(<StudentOrderingQuestions courseId="course-1" offeringId={null} onBack={() => {}} />);
  const start = await screen.findByRole("button", { name: /^start$/i });
  await userEvent.click(start);
  await waitFor(() =>
    expect(screen.getAllByRole("button", { name: /drag item at position/i })).not.toHaveLength(0),
  );
}

describe("StudentOrderingQuestions — list preview (#1041)", () => {
  it("shows the prompt but none of the orderable items", async () => {
    render(<StudentOrderingQuestions courseId="course-1" offeringId={null} onBack={() => {}} />);

    expect(await screen.findByText("Order the kings by reign")).toBeInTheDocument();

    // The whole point of #1041: the answer must not be reachable from the list.
    for (const item of CANONICAL) {
      expect(screen.queryByText(item)).not.toBeInTheDocument();
    }
  });

  it("offers Start for an unanswered question", async () => {
    render(<StudentOrderingQuestions courseId="course-1" offeringId={null} onBack={() => {}} />);
    expect(await screen.findByRole("button", { name: /^start$/i })).toBeInTheDocument();
  });

  it("offers View instead once the question is completed", async () => {
    responses.chat_sessions = {
      data: [{ open_question_id: QUESTION_ID, status: "completed" }],
      error: null,
    };
    render(<StudentOrderingQuestions courseId="course-1" offeringId={null} onBack={() => {}} />);

    expect(await screen.findByRole("button", { name: /^view$/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^start$/i })).not.toBeInTheDocument();
  });
});

describe("StudentOrderingQuestions — answering view", () => {
  it("renders every item exactly once, in the student's seeded shuffle", async () => {
    await openTheQuestion();

    const shown = renderedOrder();
    expect([...shown].sort()).toEqual([...CANONICAL].sort());
    // Deterministic per (question, student) — the same student always sees the
    // same order, so a reload cannot reshuffle the question under them.
    expect(shown).toEqual(EXPECTED_SHUFFLE);
  });

  it("leaves the drag handles enabled before submission", async () => {
    await openTheQuestion();

    for (const handle of screen.getAllByRole("button", { name: /drag item at position/i })) {
      expect(handle).not.toBeDisabled();
    }
  });

  it("submits the order currently on screen, not the canonical one", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        grade: 50,
        gapResults: { perPosition: [true, false, false, true], allCorrect: false },
      }),
    });

    await openTheQuestion();
    await userEvent.click(screen.getByRole("button", { name: /^submit$/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse((init as { body: string }).body);

    expect(body.questionId).toBe(QUESTION_ID);
    expect(body.questionType).toBe("ordering");
    expect(body.submittedAnswer).toEqual(EXPECTED_SHUFFLE);
    // Guards the grader against being handed the answer key by accident.
    expect(body.submittedAnswer).not.toEqual(CANONICAL);
  });
});

describe("StudentOrderingQuestions — submitted view", () => {
  /** A prior submission with positions 1 and 4 right, 2 and 3 wrong. */
  function seedPriorSubmission() {
    responses.open_question_grades = {
      data: {
        grade: 50,
        submitted_answer: JSON.stringify(EXPECTED_SHUFFLE),
        gap_results: { perPosition: [true, false, false, true], allCorrect: false },
      },
      error: null,
    };
  }

  it("reopens a graded question read-only — every handle disabled", async () => {
    seedPriorSubmission();
    await openTheQuestion();

    for (const handle of screen.getAllByRole("button", { name: /drag item at position/i })) {
      expect(handle).toBeDisabled();
    }
    // One submission only, so there must be no way back into editing.
    expect(screen.queryByRole("button", { name: /^submit$/i })).not.toBeInTheDocument();
  });

  it("marks each position individually rather than pass/fail for the whole answer", async () => {
    seedPriorSubmission();
    await openTheQuestion();

    const rows = screen
      .getAllByRole("button", { name: /drag item at position/i })
      .map((h) => h.parentElement!);

    // perPosition = [true, false, false, true]
    expect(within(rows[0]).queryByTestId("ordering-row-correct")).toBeTruthy();
    expect(within(rows[1]).queryByTestId("ordering-row-correct")).toBeFalsy();
    expect(within(rows[2]).queryByTestId("ordering-row-correct")).toBeFalsy();
    expect(within(rows[3]).queryByTestId("ordering-row-correct")).toBeTruthy();
  });

  it("shows the grade it was awarded", async () => {
    seedPriorSubmission();
    await openTheQuestion();

    expect(await screen.findByText(/50\s*\/\s*100/)).toBeInTheDocument();
  });
});
