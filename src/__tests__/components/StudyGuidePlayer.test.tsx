/**
 * #1007 — the student study guide player.
 *
 * The lock/unlock state machine and the submit gate are pure and already
 * covered in `src/__tests__/lib/study-guide-player.test.ts`. What was not
 * covered is the wiring, and one piece of that wiring is security-adjacent
 * rather than cosmetic:
 *
 *   Only the pieces the student has REACHED get their theory and questions —
 *   including `answer_key` — fetched. RLS on a published guide authorizes every
 *   piece's row, so nothing server-side stops a locked piece's answer key from
 *   being read. The gate is the client narrowing its own query, and a collapsed
 *   accordion is NOT that gate: content already fetched is in the page whatever
 *   the DOM shows.
 *
 * So these tests assert on the QUERIES the component issues, not on what it
 * renders. That distinction is load-bearing and was checked by mutation: with
 * the query narrowing removed, the three scoping tests below fail, while a
 * DOM-level "locked theory is not visible" assertion still passes — the leaked
 * content is in React state, not the page. Testing the rendering would have
 * looked like coverage and caught nothing.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/** Every `.in(col, values)` the component issues, in order. */
const inFilters = vi.hoisted(() => [] as Array<{ table: string; select: string; col: string; values: string[] }>);
const progressState = vi.hoisted(() => ({
  current_piece_position: 0,
  completed_at: null as string | null,
  draft_answers: {} as Record<string, unknown>,
}));

/** What the mocked `submit-study-guide-piece` endpoint returns. */
const submitResponse = vi.hoisted(() => ({
  ok: true,
  body: {
    results: [{ questionId: "q-1", isCorrect: true, grade: 1 }],
    progress: { currentPiecePosition: 1, completedAt: null as string | null },
  },
}));

/**
 * Set to a table name to make its reads fail. Set it mid-test to fail only the
 * post-submit refetch, leaving the initial load intact.
 */
const failingTable = vi.hoisted(() => ({ value: null as string | null }));

const PIECES = [
  { id: "piece-1", position: 0, title: "Reached" },
  { id: "piece-2", position: 1, title: "Locked next" },
  { id: "piece-3", position: 2, title: "Locked later" },
];

vi.mock("@/integrations/supabase/client", () => {
  const buildChain = (table: string) => {
    const state = { select: "", inValues: null as string[] | null };
    const chain: Record<string, unknown> = {};
    const self = () => chain;

    chain.select = (sel?: string) => {
      state.select = sel ?? "";
      return chain;
    };
    chain.eq = self;
    chain.order = self;
    chain.insert = () => Promise.resolve({ data: null, error: null });
    chain.in = (col: string, values: string[]) => {
      state.inValues = [...values];
      inFilters.push({ table, select: state.select, col, values: [...values] });
      return chain;
    };

    const rowsFor = (): unknown[] => {
      if (table === "study_guide_pieces") {
        // Two different reads hit this table: the title-only listing, and the
        // theory fetch that must be narrowed to unlocked pieces.
        if (state.select.includes("theory_html")) {
          // Carries LaTeX, because the theory prompt asks the model for it.
          return PIECES.map((p) => ({
            id: p.id,
            theory_html: `<p>theory ${p.id} where $x^2$ holds</p>`,
          }));
        }
        return PIECES;
      }
      if (table === "study_guide_piece_questions") {
        // piece-1 and piece-2 carry a question; piece-3 stays content-free —
        // the state that produced the blank next piece (#1037). piece-2 having
        // one is what makes the current-piece key narrowing observable (#1011):
        // at position 1 it is the CURRENT piece, so its row must arrive without
        // an answer key while piece-1's (completed) still has one.
        const rows = [
          {
            piece_id: "piece-1",
            position: 0,
            questions: {
              id: "q-1",
              type: "mcq",
              question: "Pick the first option",
              payload: { options: ["right", "wrong"] },
              answer_key: { correct_indices: [0] },
              explanation: "",
            },
          },
          {
            piece_id: "piece-2",
            position: 0,
            questions: {
              id: "q-2",
              type: "mcq",
              question: "Pick the first option again",
              payload: { options: ["right", "wrong"] },
              answer_key: { correct_indices: [0] },
              // Answer-bearing prose: it exists to justify the key, so it gives
              // the answer away just as readily (#1116 review).
              explanation: "Option one is right because water is wet",
            },
          },
          {
            // fill_gaps keeps its gap STRUCTURE in the same column as its
            // answers, so this row is what proves withholding the key does not
            // make the question unanswerable (#1011).
            piece_id: "piece-2",
            position: 1,
            questions: {
              id: "q-3",
              type: "fill_gaps",
              question: "",
              payload: { stem: "Water freezes at {{1}} and boils at {{2}}" },
              answer_key: {
                gaps: [
                  { ordinal: 1, acceptable: ["0C"] },
                  { ordinal: 2, acceptable: ["100C"] },
                ],
              },
              explanation: "",
            },
          },
        ];
        // Model PostgREST: honour the `.in()` filter, and return a column only
        // when the select asked for it. Without the projection the mock would
        // hand back `answer_key` however the component narrowed its query, and
        // the narrowing test below could not fail.
        return rows
          .filter((r) => !state.inValues || state.inValues.includes(r.piece_id))
          .map((r) =>
            state.select.includes("answer_key")
              ? r
              : {
                  ...r,
                  questions: Object.fromEntries(
                    Object.entries(r.questions).filter(([k]) => k !== "answer_key"),
                  ),
                },
          );
      }
      if (table === "study_guide_answers") return [];
      return [];
    };

    chain.maybeSingle = () => {
      if (failingTable.value === table) {
        return Promise.resolve({ data: null, error: { message: "boom" } });
      }
      if (table === "study_guides") {
        return Promise.resolve({ data: { id: "guide-1", title: "Thermodynamics" }, error: null });
      }
      if (table === "study_guide_progress") {
        return Promise.resolve({ data: { ...progressState }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    };
    chain.single = chain.maybeSingle;
    chain.then = (resolve: (v: unknown) => unknown) => {
      if (failingTable.value === table) {
        return Promise.resolve(resolve({ data: null, error: { message: "boom" } }));
      }
      return Promise.resolve(resolve({ data: rowsFor(), error: null }));
    };

    return chain;
  };

  return {
    supabase: {
      from: vi.fn((t: string) => buildChain(t)),
      functions: { invoke: vi.fn(async () => ({ data: { success: true }, error: null })) },
      auth: {
        // access_token is required: submitPiece throws "Not authenticated"
        // without one and never reaches the refetch.
        getSession: vi.fn(async () => ({
          data: { session: { user: { id: "student-1" }, access_token: "test-token" } },
        })),
      },
    },
  };
});

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "student-1" }, profile: null, loading: false }),
}));

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: toastMocks }));

beforeAll(() => {
  for (const fn of [
    "hasPointerCapture",
    "setPointerCapture",
    "releasePointerCapture",
    "scrollIntoView",
  ] as const) {
    if (!(Element.prototype as unknown as Record<string, unknown>)[fn]) {
      (Element.prototype as unknown as Record<string, unknown>)[fn] = () => {};
    }
  }
  if (typeof globalThis.ResizeObserver === "undefined") {
    class RO {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    (globalThis as unknown as { ResizeObserver: typeof RO }).ResizeObserver = RO;
  }
});

import { StudyGuidePlayer } from "@/components/study-guide/StudyGuidePlayer";

function renderPlayer() {
  return render(
    <StudyGuidePlayer
      studyGuideId="guide-1"
      offeringId="offering-1"
      courseId="course-1"
      onBack={() => {}}
    />,
  );
}

/** The `.in()` filters that carry piece content — theory and questions. */
function contentFilters() {
  return inFilters.filter(
    (f) =>
      (f.table === "study_guide_pieces" && f.select.includes("theory_html")) ||
      f.table === "study_guide_piece_questions",
  );
}

/**
 * Every piece id any content query asked for. The questions fetch is split in
 * two — completed pieces with `answer_key`, the current one without (#1011) —
 * so "which pieces were requested at all" is the union across the pair, not a
 * property of any single filter.
 */
function requestedPieceIds() {
  return [...new Set(contentFilters().flatMap((f) => f.values))].sort();
}

/** The question-content filters, split by whether they asked for the key. */
function questionFilters(opts: { withKey: boolean }) {
  return inFilters.filter(
    (f) =>
      f.table === "study_guide_piece_questions" &&
      f.select.includes("answer_key") === opts.withKey,
  );
}

beforeEach(() => {
  inFilters.length = 0;
  submitResponse.ok = true;
  submitResponse.body = {
    results: [{ questionId: "q-1", isCorrect: true, grade: 1 }],
    progress: { currentPiecePosition: 1, completedAt: null },
  };
  // The player posts to the edge function with `fetch`, not supabase-js.
  globalThis.fetch = vi.fn(async () => ({
    ok: submitResponse.ok,
    json: async () => submitResponse.body,
  })) as unknown as typeof globalThis.fetch;
  failingTable.value = null;
  Object.values(toastMocks).forEach((m) => m.mockClear());
  progressState.current_piece_position = 0;
  progressState.completed_at = null;
  progressState.draft_answers = {};
});

describe("StudyGuidePlayer (#1007)", () => {
  it("fetches content for the current piece only, never for locked ones", async () => {
    renderPlayer();
    await waitFor(() => expect(contentFilters().length).toBeGreaterThan(0));

    expect(requestedPieceIds()).toEqual(["piece-1"]);
    // The explicit assertions, so the failure message names the real problem.
    expect(requestedPieceIds()).not.toContain("piece-2");
    expect(requestedPieceIds()).not.toContain("piece-3");
  });

  /**
   * #1011 — the answer key must not reach the browser for a piece the student
   * has not submitted.
   *
   * `AnswerField` only reveals correctness for a completed piece, so nothing
   * was visibly leaked; the key simply sat in the network response and in
   * React state, one DevTools panel away, on a one-attempt immutable
   * assessment. Asserting on the query is the point — see the file header.
   *
   * This closes the CLIENT half only. RLS grants students row access to
   * `questions` and no column privileges are applied, so the key is still
   * readable by a direct PostgREST call with the student's own JWT.
   */
  it("does not request answer_key for the current, unanswered piece", async () => {
    progressState.current_piece_position = 1;
    renderPlayer();
    await waitFor(() => expect(contentFilters().length).toBeGreaterThan(0));

    const withoutKey = questionFilters({ withKey: false });
    expect(withoutKey.length).toBeGreaterThan(0);
    // piece-2 is current: fetched, but never with the key.
    expect(withoutKey.flatMap((f) => f.values)).toContain("piece-2");
    expect(
      questionFilters({ withKey: true }).flatMap((f) => f.values),
    ).not.toContain("piece-2");
  });

  it("requests answer_key for completed pieces, so review still reveals", async () => {
    progressState.current_piece_position = 1;
    renderPlayer();
    await waitFor(() => expect(contentFilters().length).toBeGreaterThan(0));

    // piece-1 is submitted; its key is needed to mark the student's answer.
    expect(
      questionFilters({ withKey: true }).flatMap((f) => f.values),
    ).toContain("piece-1");
  });

  /**
   * The trap in withholding the key: `emptyNonMcqAnswer` sizes a fill_gaps
   * draft from `gaps.length` and `FillGapsField` maps each `{{N}}` placeholder
   * to an input by ordinal — both read the answer key. Withholding it naively
   * renders zero inputs, and since the submit gate requires every blank filled,
   * the piece becomes permanently unsubmittable on a one-attempt assessment.
   * The skeleton derived from the stem is what keeps it answerable.
   */
  it("still renders an input per blank on the current piece, with no key", async () => {
    progressState.current_piece_position = 1;
    renderPlayer();

    // piece-2 is current, so its questions arrived WITHOUT answer_key.
    expect(await screen.findByLabelText("Gap 1")).toBeInTheDocument();
    expect(screen.getByLabelText("Gap 2")).toBeInTheDocument();
    // The "missing its blanks and can't be answered" bail-out must not fire.
    expect(document.body.innerHTML).not.toContain("missing its blanks");
  });

  it("does not leak the acceptable answers into the unanswered fill-gaps question", async () => {
    progressState.current_piece_position = 1;
    renderPlayer();
    await screen.findByLabelText("Gap 1");

    // The expected answers are listed only on reveal. Neither may be anywhere
    // in the document while the question is still open.
    expect(document.body.innerHTML).not.toContain("100C");
    expect(document.body.innerHTML).not.toContain("0C");
  });

  /**
   * `explanation` is written to justify why the answer key is correct, so it
   * gives the answer away as readily as the key. The player renders it nowhere
   * before review, so there is no cost to withholding it — but it rode along in
   * the first cut of this fix. Caught in review of #1116.
   */
  it("does not request the explanation for the current, unanswered piece", async () => {
    progressState.current_piece_position = 1;
    renderPlayer();
    await waitFor(() => expect(contentFilters().length).toBeGreaterThan(0));

    const unrevealed = inFilters.filter(
      (f) =>
        f.table === "study_guide_piece_questions" &&
        !f.select.includes("answer_key"),
    );
    expect(unrevealed.length).toBeGreaterThan(0);
    for (const f of unrevealed) {
      expect(f.select).not.toContain("explanation");
    }
    // And the reasoning never reaches the page for the open question.
    expect(document.body.innerHTML).not.toContain("water is wet");
  });

  it("asks for no key at all while the student is on the first piece", async () => {
    renderPlayer();
    await waitFor(() => expect(contentFilters().length).toBeGreaterThan(0));

    // Nothing is completed yet, so no query has any business requesting a key.
    expect(questionFilters({ withKey: true })).toHaveLength(0);
  });

  it("widens to completed + current as the student advances, and no further", async () => {
    progressState.current_piece_position = 1;
    renderPlayer();
    await waitFor(() => expect(contentFilters().length).toBeGreaterThan(0));

    // Completed pieces stay readable for review; the next one stays dark.
    expect(requestedPieceIds()).toEqual(["piece-1", "piece-2"]);
    expect(requestedPieceIds()).not.toContain("piece-3");
  });

  it("requests every piece once the guide is finished", async () => {
    progressState.current_piece_position = 2;
    renderPlayer();
    await waitFor(() => expect(contentFilters().length).toBeGreaterThan(0));

    expect(requestedPieceIds()).toEqual(["piece-1", "piece-2", "piece-3"]);
  });

  it("still lists every piece, so the student sees what is ahead", async () => {
    renderPlayer();
    // Titles come from the unfiltered listing — locking hides content, not the
    // shape of the guide.
    expect(await screen.findByText("Reached")).toBeInTheDocument();
    expect(screen.getByText("Locked next")).toBeInTheDocument();
    expect(screen.getByText("Locked later")).toBeInTheDocument();
  });

  /**
   * Theory used to render through `sanitizeMathContent` alone, on the
   * assumption the maths arrived as MathML. The theory prompt asks for LaTeX
   * with `$` delimiters, so students read raw `$x^2$` — the same thing the
   * instructor saw in the editor.
   */
  it("renders theory LaTeX as maths, not as raw $ delimiters", async () => {
    renderPlayer();
    await waitFor(() => expect(contentFilters().length).toBeGreaterThan(0));

    await waitFor(() =>
      expect(document.querySelector(".katex")).not.toBeNull(),
    );
    expect(document.body.innerHTML).not.toContain("$x^2$");
  });

  /**
   * The regression this file exists to catch a second time.
   *
   * `load()` narrows the content fetch to pieces already reached, so a later
   * piece sits in state as a title with no theory and no questions. Submitting
   * used to advance the position client-side and open the next piece out of
   * THAT state — so the piece it had just unlocked was the one piece whose
   * content had never been downloaded, and it rendered blank (#1037).
   *
   * Asserting on the queries rather than the DOM, for the same reason as above:
   * a blank piece and a populated one differ by what was fetched.
   */
  it("refetches after submitting, so the newly unlocked piece has content", async () => {
    const user = userEvent.setup();
    renderPlayer();

    // Piece 1 loads with its question; nothing beyond it has content yet.
    await waitFor(() => expect(contentFilters().length).toBeGreaterThan(0));
    expect(contentFilters().every((f) => !f.values.includes("piece-2"))).toBe(true);

    // MCQ options render with role="checkbox" (the type supports multi-correct).
    const options = await screen.findAllByRole("checkbox");
    await user.click(options[0]);

    // The server advances progress; the refetch has to observe that.
    progressState.current_piece_position = 1;

    const submit = await screen.findByRole("button", { name: /submit piece/i });
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);

    // A content fetch that includes piece-2 must have happened. Without the
    // refetch the player opens piece-2 having never asked for it.
    await waitFor(() =>
      expect(contentFilters().some((f) => f.values.includes("piece-2"))).toBe(true),
    );
  });


  /**
   * The submission commits server-side BEFORE the refetch runs, so a failed
   * refetch must not be reported as success. `load()` catches its own query
   * errors, so without a return value this path reached the "next piece is
   * unlocked" toast while the component still held pre-submit state — telling
   * the student the opposite of what was on screen.
   *
   * The message also has to say the answers were saved. Answers are immutable
   * per (student, offering, question), so a student who believes the submission
   * failed and tries to redo the piece cannot.
   */
  // Every read the refetch depends on. `study_guide_progress` and
  // `study_guide_answers` were the gap: load() destructured only `data` from
  // both and returned true regardless, so failures there were still reported as
  // a successful advance. A failed progress read is the worst of them — it reads
  // as "no progress row", sending position to 0 and silently putting the student
  // back on piece 1 with everything re-locked.
  it.each([
    "study_guide_pieces",
    "study_guide_progress",
    "study_guide_answers",
  ])("does not claim success when the post-submit refetch fails on %s", async (table) => {
    const user = userEvent.setup();
    renderPlayer();

    await waitFor(() => expect(contentFilters().length).toBeGreaterThan(0));
    const options = await screen.findAllByRole("checkbox");
    await user.click(options[0]);

    const submit = await screen.findByRole("button", { name: /submit piece/i });
    await waitFor(() => expect(submit).toBeEnabled());

    // Break the refetch only — the submission itself still succeeds.
    failingTable.value = table;
    await user.click(submit);

    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith(
        expect.stringMatching(/answers were saved/i),
      ),
    );
    expect(toastMocks.success).not.toHaveBeenCalled();
  });

  it("renders no theory for a locked piece", async () => {
    renderPlayer();
    await waitFor(() => expect(contentFilters().length).toBeGreaterThan(0));

    await waitFor(() =>
      expect(document.body.innerHTML).not.toContain("theory piece-2"),
    );
    expect(document.body.innerHTML).not.toContain("theory piece-3");

    // NOTE: this is a rendering assertion and nothing more. Verified by
    // mutation: with the query narrowing removed, so that every piece's theory
    // and answer_key is fetched, this test still PASSES — the leaked content
    // sits in React state rather than in the DOM. The three query-scoping tests
    // above are the ones that fail, and they are therefore the real guard.
    // Left in as a cheap check on the accordion, deliberately not relied upon.
  });
});
