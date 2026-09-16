/**
 * #1100 — StudentQuestionGenerator: what a student is allowed to generate, and
 * what happens to the answers they give.
 *
 * `gradeMcq`, `mcqOptionsFromPayload` and `mcqCorrectIndicesFromAnswerKey` are
 * tested as libraries. The wiring around them was not, and it holds three rules
 * that only exist in this file:
 *
 *  - the CHAPTER GATE. `restrictToCompletedChapters` means "only what the
 *    instructor has marked complete for THIS class". With the flag on and no
 *    class in context, completion cannot be established, so the correct answer
 *    is *no chapters* — not "all of them". That fallback is the difference
 *    between a locked syllabus and an open one.
 *  - the DAILY LIMIT, and the admin bypass around it. The count is per student
 *    per course and only counts today's user-generated rows; `remaining === -1`
 *    is the sentinel for unlimited, and a component that treated it as a number
 *    would read it as "below zero, blocked".
 *  - the MULTI-CORRECT ANSWER PATH (#592). Grading is an exact set match, and
 *    the write is a dual write: the legacy `selected_answer` column keeps the
 *    FIRST selected index while `submission.selected_indices` carries the whole
 *    set. Dropping either half loses data that no other row records.
 *
 * The edge function is reached through `fetch`, not `functions.invoke`, so the
 * request itself is asserted here — it is the only place the request shape is
 * expressed.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

type Filter = { op: string; col: string; val: unknown };

const db = vi.hoisted(() => ({
  materials: [] as Array<{
    id: string;
    title: string | null;
    file_name: string;
    material_type: string;
  }>,
  chapters: [] as Array<{
    id: string;
    title: string;
    chapter_number: number;
    material_id: string;
    content: string | null;
    openai_file_id: string | null;
  }>,
  progress: [] as Array<{ chapter_id: string; class_id: string; is_complete: boolean }>,
  /** Today's user-generated question rows for this student and course. */
  questionsToday: [] as Array<{ id: string }>,
  isSuperAdmin: false,
  isAdmin: false,
  errors: {} as Record<string, { message: string } | undefined>,
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
  queries: [] as Array<{ table: string; filters: Filter[] }>,
}));

vi.mock("@/integrations/supabase/client", () => {
  const resolveQuery = (table: string, filters: Filter[]) => {
    db.queries.push({ table, filters });
    const failure = db.errors[table];
    if (failure) return { data: null, error: failure };

    const find = (op: string, col: string) =>
      filters.find((f) => f.op === op && f.col === col);

    if (table === "course_materials") {
      const type = find("eq", "material_type");
      const rows = db.materials.filter((m) => !type || m.material_type === type.val);
      return { data: rows.map((m) => ({ ...m })), error: null };
    }

    if (table === "material_chapters") {
      const many = find("in", "material_id");
      const rows = db.chapters.filter(
        (c) => !many || (many.val as string[]).includes(c.material_id),
      );
      return { data: rows.map((c) => ({ ...c })), error: null };
    }

    if (table === "course_chapter_progress") {
      const cls = find("eq", "class_id");
      const many = find("in", "chapter_id");
      const complete = find("eq", "is_complete");
      const rows = db.progress.filter((p) => {
        if (cls && p.class_id !== cls.val) return false;
        if (many && !(many.val as string[]).includes(p.chapter_id)) return false;
        if (complete && p.is_complete !== complete.val) return false;
        return true;
      });
      return { data: rows.map((p) => ({ ...p })), error: null };
    }

    if (table === "questions") {
      // The count is only meaningful with all four filters; a test asserts them
      // rather than the fake silently ignoring a missing one.
      return { data: db.questionsToday.map((q) => ({ ...q })), error: null };
    }

    return { data: [], error: null };
  };

  const buildChain = (table: string) => {
    const filters: Filter[] = [];
    const chain: Record<string, unknown> = {};
    const push = (op: string) => (col: string, val: unknown) => {
      filters.push({ op, col, val });
      return chain;
    };
    chain.select = () => chain;
    chain.order = () => chain;
    chain.eq = push("eq");
    chain.in = push("in");
    chain.gte = push("gte");
    chain.insert = (row: Record<string, unknown>) => {
      db.inserts.push({ table, row });
      return Promise.resolve({ data: null, error: null });
    };
    chain.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(resolve(resolveQuery(table, filters)));
    return chain;
  };

  return {
    supabase: {
      from: vi.fn((table: string) => buildChain(table)),
      rpc: vi.fn(async (name: string) => ({
        data: name === "is_super_admin" ? db.isSuperAdmin : db.isAdmin,
        error: null,
      })),
      auth: {
        getSession: vi.fn(async () => ({
          data: { session: { access_token: "tok-123" } },
          error: null,
        })),
      },
    },
  };
});

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: toastMocks }));

// A stable object: `user` is an effect dependency.
const auth = vi.hoisted(() => ({ user: { id: "student-1" } }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => auth }));

import StudentQuestionGenerator from "@/components/StudentQuestionGenerator";

const COURSE = "course-1";
const CLASS = "class-1";

/** One MCQ row in the shape the edge function returns (unified payload, #582). */
function questionRow(opts: {
  id: string;
  question: string;
  options: string[];
  correct: number[];
  explanation?: string;
  difficulty?: string;
}) {
  return {
    id: opts.id,
    question: opts.question,
    payload: { options: opts.options },
    answer_key: { correct_indices: opts.correct },
    explanation: opts.explanation ?? `Because of ${opts.id}`,
    difficulty: opts.difficulty ?? "medium",
  };
}

/** Every answer the student submits, as posted to `submit-quiz-answers`. */
const submitCalls: Array<{
  courseId: string;
  sessionId: string;
  answers: Array<{ questionId: string; submission: Record<string, unknown> }>;
}> = [];

/**
 * Stubs the edge-function calls; returns the mock so the request can be read.
 *
 * Two endpoints are reached by `fetch` here: `generate-student-questions`,
 * whose body the caller supplies, and `submit-quiz-answers`, which grades an
 * attempt (#1094). The answer verdict is the server's, so it is answered from
 * here rather than derived from the question the generator produced.
 */
function stubGeneration(body: Record<string, unknown>, ok = true, status = 200) {
  const fetchMock = vi.fn(async (url: string, init?: { body?: string }) => {
    if (String(url).includes("submit-quiz-answers")) {
      const parsed = JSON.parse(init?.body ?? "{}");
      submitCalls.push(parsed);
      const results = (parsed.answers ?? []).map((a: { questionId: string }) => ({
        questionId: a.questionId,
        isCorrect: false,
        recordedNow: true,
      }));
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, results, correctCount: 0, totalCount: results.length }),
      };
    }
    return { ok, status, json: async () => body };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function seedChapter(opts: {
  id: string;
  materialId?: string;
  content?: string | null;
  openaiFileId?: string | null;
  number?: number;
  title?: string;
}) {
  db.chapters.push({
    id: opts.id,
    title: opts.title ?? `Chapter ${opts.id}`,
    chapter_number: opts.number ?? db.chapters.length + 1,
    material_id: opts.materialId ?? "mat-1",
    // `?? ` would swallow an explicit null, which is the whole point of the
    // "no content anywhere" fixture.
    content: "content" in opts ? opts.content! : "some text",
    openai_file_id: opts.openaiFileId ?? null,
  });
}

function renderGenerator(props: Partial<{
  classId: string | null;
  restrictToCompletedChapters: boolean;
}> = {}) {
  const onBack = vi.fn();
  render(
    <StudentQuestionGenerator courseId={COURSE} onBack={onBack} {...props} />,
  );
  return { onBack };
}

beforeAll(() => {
  // Radix Select needs the same pointer shims used elsewhere in the suite.
  if (!Element.prototype.hasPointerCapture) {
    (Element.prototype as unknown as { hasPointerCapture: () => boolean }).hasPointerCapture =
      () => false;
  }
  if (!Element.prototype.setPointerCapture) {
    (Element.prototype as unknown as { setPointerCapture: () => void }).setPointerCapture =
      () => {};
  }
  if (!Element.prototype.releasePointerCapture) {
    (
      Element.prototype as unknown as { releasePointerCapture: () => void }
    ).releasePointerCapture = () => {};
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  db.materials = [{ id: "mat-1", title: "Algebra", file_name: "algebra.pdf", material_type: "textbook" }];
  db.chapters = [];
  db.progress = [];
  db.questionsToday = [];
  db.isSuperAdmin = false;
  db.isAdmin = false;
  db.errors = {};
  db.inserts = [];
  db.queries = [];
  submitCalls.length = 0;
});

describe("StudentQuestionGenerator — which chapters are on offer", () => {
  it("offers a chapter that has text and one that only has an uploaded file", async () => {
    seedChapter({ id: "ch-1", content: "text", number: 1 });
    seedChapter({ id: "ch-2", content: null, openaiFileId: "file-abc", number: 2 });

    renderGenerator();

    await waitFor(() =>
      expect(screen.getByText("Choose a chapter...")).toBeInTheDocument(),
    );
    const user = userEvent.setup();
    await user.click(screen.getAllByRole("combobox")[0]);
    expect(await screen.findByRole("option", { name: /Ch\.1/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Ch\.2/ })).toBeInTheDocument();
  });

  it("hides a chapter with neither text nor an uploaded file", async () => {
    seedChapter({ id: "ch-1", content: null, openaiFileId: null });

    renderGenerator();

    expect(
      await screen.findByText("No chapters with content available for question generation."),
    ).toBeInTheDocument();
  });

  it("only draws chapters from textbooks", async () => {
    renderGenerator();

    await waitFor(() => expect(db.queries.length).toBeGreaterThan(0));
    const materialQuery = db.queries.find((q) => q.table === "course_materials")!;
    expect(materialQuery.filters).toEqual(
      expect.arrayContaining([
        { op: "eq", col: "course_id", val: COURSE },
        { op: "eq", col: "material_type", val: "textbook" },
      ]),
    );
  });

  it("restricts to the chapters the instructor marked complete for this class", async () => {
    seedChapter({ id: "ch-1", number: 1 });
    seedChapter({ id: "ch-2", number: 2 });
    db.progress.push({ chapter_id: "ch-1", class_id: CLASS, is_complete: true });

    renderGenerator({ classId: CLASS, restrictToCompletedChapters: true });

    await waitFor(() =>
      expect(screen.getByText("Choose a chapter...")).toBeInTheDocument(),
    );
    const user = userEvent.setup();
    await user.click(screen.getAllByRole("combobox")[0]);
    expect(await screen.findByRole("option", { name: /Ch\.1/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Ch\.2/ })).not.toBeInTheDocument();
  });

  it("offers nothing when the restriction is on but no class is in context", async () => {
    seedChapter({ id: "ch-1" });
    seedChapter({ id: "ch-2" });

    renderGenerator({ classId: null, restrictToCompletedChapters: true });

    // Completion is unknowable without a class, so the safe answer is none —
    // NOT every chapter with content.
    expect(
      await screen.findByText("No chapters with content available for question generation."),
    ).toBeInTheDocument();
  });

  it("offers every chapter with content when the restriction is off", async () => {
    seedChapter({ id: "ch-1", number: 1 });
    seedChapter({ id: "ch-2", number: 2 });
    // Nothing is marked complete — irrelevant while the flag is off.

    renderGenerator({ classId: CLASS, restrictToCompletedChapters: false });

    await waitFor(() =>
      expect(screen.getByText("Choose a chapter...")).toBeInTheDocument(),
    );
    const user = userEvent.setup();
    await user.click(screen.getAllByRole("combobox")[0]);
    expect(await screen.findByRole("option", { name: /Ch\.1/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Ch\.2/ })).toBeInTheDocument();
    expect(db.queries.some((q) => q.table === "course_chapter_progress")).toBe(false);
  });

  it("labels a chapter with its material's file name when the title is missing", async () => {
    db.materials = [
      { id: "mat-1", title: null, file_name: "untitled-book.pdf", material_type: "textbook" },
    ];
    seedChapter({ id: "ch-1", number: 1, title: "Fractions" });

    renderGenerator();

    await waitFor(() =>
      expect(screen.getByText("Choose a chapter...")).toBeInTheDocument(),
    );
    const user = userEvent.setup();
    await user.click(screen.getAllByRole("combobox")[0]);
    expect(
      await screen.findByRole("option", { name: /untitled-book\.pdf - Ch\.1: Fractions/ }),
    ).toBeInTheDocument();
  });
});

describe("StudentQuestionGenerator — the daily limit", () => {
  it("counts only today's own user-generated questions for this course", async () => {
    seedChapter({ id: "ch-1" });
    db.questionsToday = [{ id: "q1" }, { id: "q2" }, { id: "q3" }];

    renderGenerator();

    expect(await screen.findByText("7 questions left today")).toBeInTheDocument();
    const countQuery = db.queries.find((q) => q.table === "questions")!;
    expect(countQuery.filters).toEqual(
      expect.arrayContaining([
        { op: "eq", col: "created_by", val: "student-1" },
        { op: "eq", col: "course_id", val: COURSE },
        { op: "eq", col: "is_user_generated", val: true },
      ]),
    );
    expect(countQuery.filters.some((f) => f.op === "gte" && f.col === "created_at")).toBe(true);
  });

  it("blocks generation once the allowance is spent", async () => {
    seedChapter({ id: "ch-1" });
    db.questionsToday = Array.from({ length: 10 }, (_, i) => ({ id: `q${i}` }));

    renderGenerator();

    expect(await screen.findByText("0 questions left today")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Generate 10 Questions/ })).toBeDisabled();
  });

  it("never shows a negative allowance", async () => {
    seedChapter({ id: "ch-1" });
    db.questionsToday = Array.from({ length: 13 }, (_, i) => ({ id: `q${i}` }));

    renderGenerator();

    expect(await screen.findByText("0 questions left today")).toBeInTheDocument();
  });

  it("lifts the limit for a super admin", async () => {
    seedChapter({ id: "ch-1" });
    db.isSuperAdmin = true;
    db.questionsToday = Array.from({ length: 50 }, (_, i) => ({ id: `q${i}` }));

    renderGenerator();

    expect(await screen.findByText("Unlimited")).toBeInTheDocument();
    expect(screen.queryByText(/10 questions per day limit/)).not.toBeInTheDocument();
    // The spent count is never even read for an unlimited user.
    expect(db.queries.some((q) => q.table === "questions")).toBe(false);
  });

  it("lifts the limit for an institution admin too", async () => {
    seedChapter({ id: "ch-1" });
    db.isAdmin = true;

    renderGenerator();

    expect(await screen.findByText("Unlimited")).toBeInTheDocument();
  });

  it("tells a student who is out of allowance rather than calling the function", async () => {
    seedChapter({ id: "ch-1" });
    db.questionsToday = Array.from({ length: 10 }, (_, i) => ({ id: `q${i}` }));
    const fetchMock = stubGeneration({ questions: [] });

    renderGenerator();
    await screen.findByText("0 questions left today");

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("StudentQuestionGenerator — generating", () => {
  async function generate(
    responseBody: Record<string, unknown>,
    props: Parameters<typeof renderGenerator>[0] = {},
  ) {
    const fetchMock = stubGeneration(responseBody);
    seedChapter({ id: "ch-1", number: 1, title: "Fractions" });
    const rendered = renderGenerator(props);

    await waitFor(() =>
      expect(screen.getByText("Choose a chapter...")).toBeInTheDocument(),
    );
    const user = userEvent.setup();
    await user.click(screen.getAllByRole("combobox")[0]);
    await user.click(await screen.findByRole("option", { name: /Ch\.1/ }));
    await user.click(screen.getByRole("button", { name: /Generate 10 Questions/ }));
    return { user, fetchMock, ...rendered };
  }

  it("asks the edge function for ten MCQs from the chosen chapter, as the signed-in student", async () => {
    const { fetchMock } = await generate({ questions: [], remaining: 9 });

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = (fetchMock as unknown as { mock: { calls: [string, RequestInit][] } })
      .mock.calls[0];
    expect(url).toContain("/functions/v1/generate-student-questions");
    expect(JSON.parse(init.body as string)).toEqual({
      courseId: COURSE,
      chapterId: "ch-1",
      difficulty: "mixed",
      numQuestions: 10,
      format: "mcq",
    });
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-123");
  });

  it("renders the returned rows from their unified payload/answer_key", async () => {
    await generate({
      questions: [
        questionRow({
          id: "q-1",
          question: "What is 2 + 2?",
          options: ["3", "4", "5"],
          correct: [1],
          difficulty: "easy",
        }),
      ],
      remaining: 9,
    });

    expect(await screen.findByText("What is 2 + 2?")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByText("Question 1 of 1")).toBeInTheDocument();
    expect(screen.getByText("easy")).toBeInTheDocument();
  });

  it("prefixes a multi-correct stem with the select-all hint", async () => {
    await generate({
      questions: [
        questionRow({
          id: "q-1",
          question: "Which are primes?",
          options: ["2", "3", "4"],
          correct: [0, 1],
        }),
      ],
    });

    expect(
      await screen.findByText(/Select all that apply\. Which are primes\?/),
    ).toBeInTheDocument();
  });

  it("takes the server's remaining count as the new allowance", async () => {
    await generate({ questions: [], remaining: 4 });

    expect(await screen.findByText("4 questions left today")).toBeInTheDocument();
  });

  it("reads a remaining of -1 as unlimited rather than as an exhausted allowance", async () => {
    await generate({ questions: [], remaining: -1 });

    expect(await screen.findByText("Unlimited")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Generate 10 Questions/ })).toBeEnabled();
  });

  it("surfaces an error the function reports in its body", async () => {
    await generate({ error: "Chapter has no content" });

    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith("Chapter has no content"),
    );
    expect(screen.queryByText(/Question 1 of/)).not.toBeInTheDocument();
  });

  it("surfaces a transport failure", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: "Internal boom" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    seedChapter({ id: "ch-1", number: 1 });
    renderGenerator();

    await waitFor(() =>
      expect(screen.getByText("Choose a chapter...")).toBeInTheDocument(),
    );
    const user = userEvent.setup();
    await user.click(screen.getAllByRole("combobox")[0]);
    await user.click(await screen.findByRole("option", { name: /Ch\.1/ }));
    await user.click(screen.getByRole("button", { name: /Generate 10 Questions/ }));

    await waitFor(() => expect(toastMocks.error).toHaveBeenCalledWith("Internal boom"));
  });
});

describe("StudentQuestionGenerator — answering", () => {
  async function generateAndAnswer(question: ReturnType<typeof questionRow>[]) {
    stubGeneration({ questions: question, remaining: 9 });
    seedChapter({ id: "ch-1", number: 1 });
    renderGenerator();

    await waitFor(() =>
      expect(screen.getByText("Choose a chapter...")).toBeInTheDocument(),
    );
    const user = userEvent.setup();
    await user.click(screen.getAllByRole("combobox")[0]);
    await user.click(await screen.findByRole("option", { name: /Ch\.1/ }));
    await user.click(screen.getByRole("button", { name: /Generate 10 Questions/ }));
    await screen.findByText("Question 1 of " + question.length);
    return user;
  }

  const MULTI = questionRow({
    id: "q-1",
    question: "Which are primes?",
    options: ["2", "3", "4"],
    correct: [0, 1],
    explanation: "2 and 3 are prime.",
  });

  it("cannot submit without picking something", async () => {
    await generateAndAnswer([MULTI]);
    expect(screen.getByRole("button", { name: "Submit Answer" })).toBeDisabled();
  });

  it("toggles a chosen option back off", async () => {
    const user = await generateAndAnswer([MULTI]);
    const first = screen.getAllByRole("checkbox")[0];

    await user.click(first);
    expect(first).toHaveAttribute("aria-checked", "true");
    await user.click(first);
    expect(first).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("button", { name: "Submit Answer" })).toBeDisabled();
  });

  it("sends a partial selection on a multi-correct question for grading", async () => {
    const user = await generateAndAnswer([MULTI]);

    await user.click(screen.getAllByRole("checkbox")[0]); // only one of two
    await user.click(screen.getByRole("button", { name: "Submit Answer" }));

    await waitFor(() => expect(submitCalls).toHaveLength(1));
    expect(submitCalls[0].answers).toEqual([
      { questionId: "q-1", submission: { selected_indices: [0] } },
    ]);
  });

  it("sends the full selection, in index order, whatever order it was picked in", async () => {
    const user = await generateAndAnswer([MULTI]);

    // Chosen out of order — the submission still lists the lowest index first.
    await user.click(screen.getAllByRole("checkbox")[2]);
    await user.click(screen.getAllByRole("checkbox")[1]);
    await user.click(screen.getByRole("button", { name: "Submit Answer" }));

    await waitFor(() => expect(submitCalls).toHaveLength(1));
    expect(submitCalls[0]).toMatchObject({
      courseId: COURSE,
      answers: [{ questionId: "q-1", submission: { selected_indices: [1, 2] } }],
    });
  });

  it("writes no answer row itself and offers the server no verdict (#1094)", async () => {
    const user = await generateAndAnswer([MULTI]);

    await user.click(screen.getAllByRole("checkbox")[0]);
    await user.click(screen.getAllByRole("checkbox")[1]);
    await user.click(screen.getByRole("button", { name: "Submit Answer" }));

    await waitFor(() => expect(submitCalls).toHaveLength(1));
    expect(db.inserts.filter((i) => i.table === "quiz_answers")).toHaveLength(0);
    expect(JSON.stringify(submitCalls[0])).not.toContain("is_correct");
  });

  it("shows the explanation and freezes the options once submitted", async () => {
    const user = await generateAndAnswer([MULTI]);

    await user.click(screen.getAllByRole("checkbox")[2]);
    await user.click(screen.getByRole("button", { name: "Submit Answer" }));

    expect(await screen.findByText("2 and 3 are prime.")).toBeInTheDocument();
    for (const box of screen.getAllByRole("checkbox")) expect(box).toBeDisabled();
    // A second click must not produce a second answer.
    await user.click(screen.getAllByRole("checkbox")[0]);
    expect(submitCalls).toHaveLength(1);
  });

  it("clears the selection when moving to the next question", async () => {
    const second = questionRow({
      id: "q-2",
      question: "What is 1 + 1?",
      options: ["1", "2"],
      correct: [1],
    });
    const user = await generateAndAnswer([MULTI, second]);

    await user.click(screen.getAllByRole("checkbox")[0]);
    await user.click(screen.getByRole("button", { name: "Submit Answer" }));
    await user.click(await screen.findByRole("button", { name: "Next Question" }));

    expect(await screen.findByText("What is 1 + 1?")).toBeInTheDocument();
    expect(screen.getByText("Question 2 of 2")).toBeInTheDocument();
    for (const box of screen.getAllByRole("checkbox")) {
      expect(box).toHaveAttribute("aria-checked", "false");
    }
    expect(screen.getByRole("button", { name: "Submit Answer" })).toBeDisabled();
  });

  it("returns to the generator after the last question", async () => {
    const user = await generateAndAnswer([MULTI]);

    await user.click(screen.getAllByRole("checkbox")[0]);
    await user.click(screen.getByRole("button", { name: "Submit Answer" }));
    await user.click(await screen.findByRole("button", { name: "Done - Generate More" }));

    await waitFor(() => expect(screen.queryByText("Which are primes?")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: /Generate 10 Questions/ })).toBeInTheDocument();
  });
});
