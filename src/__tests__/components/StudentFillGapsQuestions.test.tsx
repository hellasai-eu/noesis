import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * Component tests for the student fill-the-gaps answering surface (#1054).
 *
 * What this pins:
 *
 *  - the `{{N}}` contract from #1036 — N markers in the stem produce exactly N
 *    inputs, each bound to the gap whose ordinal it carries, including when the
 *    ordinals are out of order or repeated in the prose;
 *  - the list preview masks the markers instead of printing them raw;
 *  - expected answers are revealed only AFTER submission (the fill-gaps analogue
 *    of #1041, which was the ordering list handing over its answer early);
 *  - the surface goes read-only after submission — one submission per question.
 *
 * Answer MATCHING is not retested here: `grade-fill-gaps.ts` owns it and
 * src/__tests__/lib/grade-fill-gaps.test.ts already covers case-insensitivity
 * (Latin and Greek), whitespace handling, NFC equivalence and the acceptance of
 * any listed alternative. Duplicating that at component level would assert the
 * mock, not the product.
 */

type Result = { data: unknown; error: unknown };
/** Column lists each table was asked for, so a test can assert the REQUEST. */
const selects: Record<string, string[]> = {};
/**
 * Per-call overrides for a by-id `.maybeSingle()`, consumed in order. A test
 * that needs to interleave two `selectQuestion` calls queues a promise it can
 * resolve later, which is the only way to reproduce a late response landing
 * after the student has moved on.
 */
const singleQueue: Record<string, Array<Promise<Result> | Result>> = {};
const responses: Record<string, Result> = {
  questions: { data: [], error: null },
  chat_sessions: { data: [], error: null },
  open_question_grades: { data: null, error: null },
};

vi.mock("@/integrations/supabase/client", () => {
  const buildChain = (table: string) => {
    const chain: Record<string, (...a: unknown[]) => unknown> = {};
    const passThrough = () => chain;
    chain.select = (...a: unknown[]) => {
      if (typeof a[0] === "string") (selects[table] ??= []).push(a[0]);
      return chain;
    };
    chain.eq = passThrough;
    chain.in = passThrough;
    chain.is = passThrough;
    chain.not = passThrough;
    chain.order = passThrough;
    chain.insert = passThrough;
    chain.update = passThrough;
    chain.upsert = passThrough;
    // A by-id lookup resolves to ONE row. `questions` is now read both ways:
    // the list (awaited directly) and, once the student opens a question they
    // have already answered, a single-row fetch for its key (#1011). Unwrap the
    // seeded list so both callers get a shape they can use.
    chain.maybeSingle = () => {
      const queued = singleQueue[table]?.shift();
      if (queued) return Promise.resolve(queued);
      const seeded = responses[table] ?? { data: null, error: null };
      const { data } = seeded as { data: unknown };
      return Promise.resolve(
        Array.isArray(data) ? { ...seeded, data: data[0] ?? null } : seeded,
      );
    };
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

import StudentFillGapsQuestions from "@/components/StudentFillGapsQuestions";

const QUESTION_ID = "fg-1";

function seedQuestion(
  stem: string,
  gaps: Array<{ ordinal: number; acceptable: string[] }>,
) {
  responses.questions = {
    data: [
      {
        id: QUESTION_ID,
        payload: { stem },
        answer_key: { gaps },
        explanation: "",
        difficulty: "easy",
      },
    ],
    error: null,
  };
}

async function openTheQuestion() {
  render(<StudentFillGapsQuestions courseId="course-1" offeringId={null} onBack={() => {}} />);
  const start = await screen.findByRole("button", { name: /^(start|view)$/i });
  await userEvent.click(start);
}

beforeEach(() => {
  for (const k of Object.keys(selects)) delete selects[k];
  for (const k of Object.keys(singleQueue)) delete singleQueue[k];
  responses.questions = { data: [], error: null };
  responses.chat_sessions = { data: [], error: null };
  responses.open_question_grades = { data: null, error: null };
  fetchMock.mockReset();
  seedQuestion("The {{1}} was signed in {{2}}.", [
    { ordinal: 1, acceptable: ["Σύνταγμα", "syntagma"] },
    { ordinal: 2, acceptable: ["1975"] },
  ]);
});

describe("StudentFillGapsQuestions — the {{N}} contract (#1036)", () => {
  it("renders exactly one input per marker, labelled by ordinal", async () => {
    await openTheQuestion();

    expect(await screen.findByLabelText("Gap 1")).toBeInTheDocument();
    expect(screen.getByLabelText("Gap 2")).toBeInTheDocument();
    expect(screen.queryByLabelText("Gap 3")).not.toBeInTheDocument();
  });

  it("renders three inputs for three markers", async () => {
    seedQuestion("{{1}} plus {{2}} equals {{3}}", [
      { ordinal: 1, acceptable: ["one"] },
      { ordinal: 2, acceptable: ["two"] },
      { ordinal: 3, acceptable: ["three"] },
    ]);
    await openTheQuestion();

    expect(await screen.findByLabelText("Gap 1")).toBeInTheDocument();
    expect(screen.getByLabelText("Gap 2")).toBeInTheDocument();
    expect(screen.getByLabelText("Gap 3")).toBeInTheDocument();
  });

  it("binds each input to its ordinal even when the stem lists them out of order", async () => {
    // The renderer must key off the ordinal inside the marker, not the order in
    // which markers appear, or the submitted array lands against the wrong keys.
    seedQuestion("Second is {{2}} and first is {{1}}.", [
      { ordinal: 1, acceptable: ["alpha"] },
      { ordinal: 2, acceptable: ["beta"] },
    ]);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ grade: 100, gapResults: { perGap: [true, true], allCorrect: true } }),
    });

    await openTheQuestion();
    await userEvent.type(await screen.findByLabelText("Gap 1"), "alpha");
    await userEvent.type(screen.getByLabelText("Gap 2"), "beta");
    await userEvent.click(screen.getByRole("button", { name: /^submit$/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    // Indexed by gap ordinal, so gap 1's text is first regardless of layout.
    expect(body.submittedAnswer).toEqual(["alpha", "beta"]);
  });

  it("renders an input for every marker, even one the key does not match", async () => {
    // Before #1011 the gaps came from `answer_key`, so a stem marker with no
    // matching key entry could be spotted and printed as an inert `___(7)`.
    // The gaps are now the skeleton read off the stem itself — the key does not
    // reach the browser until there is an answer on record — so the mismatch is
    // invisible here and every marker becomes an input.
    //
    // Only reachable on a corrupt row: `validateFillGapsQuestion` requires the
    // stem's placeholders and the key's gaps to correspond exactly, 1..N, so no
    // validated writer can produce this. When it does happen the student now
    // gets a gap they can answer and the server marks it wrong, rather than a
    // marker they can see is broken. That is the trade the narrowing makes, and
    // it is the same one the quiz surface already made.
    seedQuestion("Dangling {{7}} marker", [{ ordinal: 1, acceptable: ["x"] }]);
    await openTheQuestion();

    expect(await screen.findByLabelText("Gap 7")).toBeInTheDocument();
    expect(screen.queryByText("___(7)")).not.toBeInTheDocument();
  });
});

describe("StudentFillGapsQuestions — list preview", () => {
  it("masks the markers rather than printing them raw", async () => {
    render(<StudentFillGapsQuestions courseId="course-1" offeringId={null} onBack={() => {}} />);

    // Anchor on the loaded list FIRST. Wrapping a negative assertion in
    // `waitFor` is worse than useless here: it succeeds on the first tick,
    // while the component is still loading and the row has not rendered, so the
    // test would pass without ever looking at the preview.
    await screen.findByRole("button", { name: /^start$/i });

    // Raw `{{1}}` would both look broken and leak the gap count formatting.
    expect(screen.queryByText(/\{\{1\}\}/)).not.toBeInTheDocument();
    expect(screen.getByText(/was signed in/)).toBeInTheDocument();
  });

  it("never shows an acceptable answer before the question is opened", async () => {
    render(<StudentFillGapsQuestions courseId="course-1" offeringId={null} onBack={() => {}} />);
    await screen.findByRole("button", { name: /^start$/i });

    expect(screen.queryByText("Σύνταγμα")).not.toBeInTheDocument();
    expect(screen.queryByText("1975")).not.toBeInTheDocument();
  });
});

describe("StudentFillGapsQuestions — submission gate", () => {
  it("keeps Submit disabled until every gap has a non-blank value", async () => {
    await openTheQuestion();

    const submit = await screen.findByRole("button", { name: /^submit$/i });
    expect(submit).toBeDisabled();

    await userEvent.type(screen.getByLabelText("Gap 1"), "Σύνταγμα");
    expect(submit).toBeDisabled();

    await userEvent.type(screen.getByLabelText("Gap 2"), "1975");
    expect(submit).toBeEnabled();
  });

  it("treats a whitespace-only entry as unanswered", async () => {
    await openTheQuestion();

    await userEvent.type(await screen.findByLabelText("Gap 1"), "Σύνταγμα");
    await userEvent.type(screen.getByLabelText("Gap 2"), "   ");

    expect(screen.getByRole("button", { name: /^submit$/i })).toBeDisabled();
  });
});

describe("StudentFillGapsQuestions — after submission", () => {
  /** A prior submission: gap 1 right, gap 2 wrong. */
  function seedPriorSubmission() {
    responses.open_question_grades = {
      data: {
        grade: 50,
        submitted_answer: JSON.stringify(["Σύνταγμα", "1821"]),
        gap_results: { perGap: [true, false], allCorrect: false },
      },
      error: null,
    };
    responses.chat_sessions = {
      data: [{ open_question_id: QUESTION_ID, status: "completed" }],
      error: null,
    };
  }

  it("reopens read-only, with the student's own answers still shown", async () => {
    seedPriorSubmission();
    await openTheQuestion();

    const gap1 = await screen.findByLabelText("Gap 1");
    expect(gap1).toBeDisabled();
    expect(gap1).toHaveValue("Σύνταγμα");
    expect(screen.getByLabelText("Gap 2")).toBeDisabled();
    expect(screen.queryByRole("button", { name: /^submit$/i })).not.toBeInTheDocument();
  });

  it("reveals the expected answer only for the gaps that were wrong", async () => {
    seedPriorSubmission();
    await openTheQuestion();

    // Gap 2 was wrong, so its key is revealed as feedback...
    expect(await screen.findByText("Gap 2:")).toBeInTheDocument();
    expect(screen.getByText("1975")).toBeInTheDocument();
    // ...while gap 1 was right and needs no reveal.
    expect(screen.queryByText("Gap 1:")).not.toBeInTheDocument();
  });

  it("reports the per-gap tally alongside the grade", async () => {
    seedPriorSubmission();
    await openTheQuestion();

    expect(await screen.findByText("Grade: 50/100")).toBeInTheDocument();
    expect(screen.getByText("1 of 2 gaps correct")).toBeInTheDocument();
  });

  it("does not reveal any expected answer when everything was correct", async () => {
    responses.open_question_grades = {
      data: {
        grade: 100,
        submitted_answer: JSON.stringify(["Σύνταγμα", "1975"]),
        gap_results: { perGap: [true, true], allCorrect: true },
      },
      error: null,
    };
    await openTheQuestion();

    expect(await screen.findByText("Grade: 100/100")).toBeInTheDocument();
    expect(screen.queryByText(/^Expected answers$/)).not.toBeInTheDocument();
  });
});


// #1011 — the practice list stops holding the key.
//
// This surface reads a whole course's fill-gaps questions in one query, so
// requesting `answer_key` handed over every acceptable answer in the course
// before the student opened a single one. The gaps are now the ordinal
// skeleton read off the stem, and the real answers arrive only with an answer
// on record: from the grader's `reveal` on submit, or from a one-question
// fetch when reopening one already answered.
describe("StudentFillGapsQuestions — the key is not fetched with the list (#1011)", () => {
  it("asks for neither the key nor the explanation when listing", async () => {
    render(<StudentFillGapsQuestions courseId="course-1" offeringId={null} onBack={() => {}} />);
    await screen.findByRole("button", { name: /^start$/i });

    expect(selects.questions?.length).toBeGreaterThan(0);
    for (const cols of selects.questions) {
      expect(cols).not.toContain("answer_key");
      expect(cols).not.toContain("explanation");
    }
  });

  it("still does not ask for them when opening an unanswered question", async () => {
    await openTheQuestion();
    await screen.findByLabelText("Gap 1");

    // No grade row, so nothing has been answered and nothing is owed.
    for (const cols of selects.questions) {
      expect(cols).not.toContain("answer_key");
      expect(cols).not.toContain("explanation");
    }
  });

  it("fetches the key for the one question being reopened, once it is answered", async () => {
    responses.open_question_grades = {
      data: {
        grade: 50,
        submitted_answer: JSON.stringify(["Σύνταγμα", "1821"]),
        gap_results: { perGap: [true, false], allCorrect: false },
      },
      error: null,
    };
    await openTheQuestion();

    // The expected answer is on screen, so the key did arrive...
    expect(await screen.findByText("1975")).toBeInTheDocument();
    // ...but only through a by-id read, never the list query.
    const keyReads = (selects.questions ?? []).filter((c) => c.includes("answer_key"));
    expect(keyReads).toHaveLength(1);
    expect(keyReads[0]).not.toContain("difficulty");
  });

  it("takes the expected answers from the grader's reveal on submit", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        grade: 50,
        gapResults: { perGap: [true, false], allCorrect: false },
        reveal: {
          explanation: "The 1975 constitution.",
          fillGapsGaps: [
            { ordinal: 1, acceptable: ["Σύνταγμα"] },
            { ordinal: 2, acceptable: ["1975"] },
          ],
        },
      }),
    });

    await openTheQuestion();
    await userEvent.type(await screen.findByLabelText("Gap 1"), "Σύνταγμα");
    await userEvent.type(screen.getByLabelText("Gap 2"), "1821");
    await userEvent.click(screen.getByRole("button", { name: /^submit$/i }));

    // Nothing in the page's data could have produced these — the list fetch
    // never carried them.
    expect(await screen.findByText("1975")).toBeInTheDocument();
    expect(screen.getByText("The 1975 constitution.")).toBeInTheDocument();
  });

  it("shows no expected answers when the grader sends no reveal", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        grade: 50,
        gapResults: { perGap: [true, false], allCorrect: false },
      }),
    });

    await openTheQuestion();
    await userEvent.type(await screen.findByLabelText("Gap 1"), "Σύνταγμα");
    await userEvent.type(screen.getByLabelText("Gap 2"), "1821");
    await userEvent.click(screen.getByRole("button", { name: /^submit$/i }));

    await screen.findByText("Grade: 50/100");
    // The panel has no key of its own to fall back on, which is the point.
    expect(screen.queryByText("1975")).not.toBeInTheDocument();
  });
});

describe("StudentFillGapsQuestions — a late reveal must not land on another question", () => {
  it("drops the key of a question the student has already left", async () => {
    // Two answered questions. Opening the first starts a by-id read for its
    // key; the student goes back and opens the second before that read
    // returns. The late response describes a question no longer on screen, and
    // writing it would show the first question's expected answers under the
    // second question's stem.
    responses.questions = {
      data: [
        { id: "fg-1", payload: { stem: "First {{1}}." }, difficulty: "easy" },
        { id: "fg-2", payload: { stem: "Second {{1}}." }, difficulty: "easy" },
      ],
      error: null,
    };
    responses.chat_sessions = {
      data: [
        { open_question_id: "fg-1", status: "completed" },
        { open_question_id: "fg-2", status: "completed" },
      ],
      error: null,
    };
    responses.open_question_grades = {
      data: {
        grade: 0,
        submitted_answer: JSON.stringify(["wrong"]),
        gap_results: { perGap: [false], allCorrect: false },
      },
      error: null,
    };

    // The first question's key is held open; the second's returns at once.
    let releaseFirstKey: (v: Result) => void = () => {};
    const firstKey = new Promise<Result>((resolve) => {
      releaseFirstKey = resolve;
    });
    singleQueue.questions = [
      firstKey,
      { data: { answer_key: { gaps: [{ ordinal: 1, acceptable: ["SECOND-KEY"] }] }, explanation: "" }, error: null },
    ];

    render(<StudentFillGapsQuestions courseId="course-1" offeringId={null} onBack={() => {}} />);
    const rows = await screen.findAllByRole("button", { name: /^view$/i });

    await userEvent.click(rows[0]);            // fg-1 — its key read hangs
    // The back control is an icon-only button, and while fg-1's key read hangs
    // the panel shows a spinner, so it is the only button on screen.
    await userEvent.click(screen.getAllByRole("button")[0]);
    await userEvent.click(
      (await screen.findAllByRole("button", { name: /^view$/i }))[1],
    );                                          // fg-2 — resolves immediately

    expect(await screen.findByText("SECOND-KEY")).toBeInTheDocument();

    // Now let the first question's key arrive, far too late.
    releaseFirstKey({
      data: { answer_key: { gaps: [{ ordinal: 1, acceptable: ["FIRST-KEY"] }] }, explanation: "" },
      error: null,
    });
    await waitFor(() => expect(screen.getByText("SECOND-KEY")).toBeInTheDocument());
    expect(screen.queryByText("FIRST-KEY")).not.toBeInTheDocument();
  });
  it("drops the grade of a question the student has already left", async () => {
    // The other half of the same race, and the one a guard placed before the
    // key read does not cover: `setSubmitted` runs AFTER that second await, so
    // a late grade could show the first question's submitted answers under the
    // second question's stem.
    responses.questions = {
      data: [
        { id: "fg-1", payload: { stem: "First {{1}}." }, difficulty: "easy" },
        { id: "fg-2", payload: { stem: "Second {{1}}." }, difficulty: "easy" },
      ],
      error: null,
    };
    responses.chat_sessions = {
      data: [
        { open_question_id: "fg-1", status: "completed" },
        { open_question_id: "fg-2", status: "completed" },
      ],
      error: null,
    };

    // A different recorded answer per question, consumed in open order.
    singleQueue.open_question_grades = [
      {
        data: {
          grade: 0,
          submitted_answer: JSON.stringify(["FIRST-ANSWER"]),
          gap_results: { perGap: [false], allCorrect: false },
        },
        error: null,
      },
      {
        data: {
          grade: 0,
          submitted_answer: JSON.stringify(["SECOND-ANSWER"]),
          gap_results: { perGap: [false], allCorrect: false },
        },
        error: null,
      },
    ];

    let releaseFirstKey: (v: Result) => void = () => {};
    const firstKey = new Promise<Result>((resolve) => {
      releaseFirstKey = resolve;
    });
    const key = (word: string): Result => ({
      data: { answer_key: { gaps: [{ ordinal: 1, acceptable: [word] }] }, explanation: "" },
      error: null,
    });
    singleQueue.questions = [firstKey, key("SECOND-KEY")];

    render(<StudentFillGapsQuestions courseId="course-1" offeringId={null} onBack={() => {}} />);
    const rows = await screen.findAllByRole("button", { name: /^view$/i });

    await userEvent.click(rows[0]);
    await userEvent.click(screen.getAllByRole("button")[0]);
    await userEvent.click(
      (await screen.findAllByRole("button", { name: /^view$/i }))[1],
    );

    expect(await screen.findByDisplayValue("SECOND-ANSWER")).toBeInTheDocument();

    // fg-1's reads complete long after the student left it.
    releaseFirstKey(key("FIRST-KEY"));
    await waitFor(() =>
      expect(screen.getByDisplayValue("SECOND-ANSWER")).toBeInTheDocument(),
    );
    expect(screen.queryByDisplayValue("FIRST-ANSWER")).not.toBeInTheDocument();
    expect(screen.queryByText("FIRST-KEY")).not.toBeInTheDocument();
  });
});
