/**
 * CreateAssessmentDialog — create a quiz or test straight from a Question
 * Bank selection, without leaving the bank.
 *
 * The behaviours worth pinning:
 *  - the inserts mirror the Assessments builders exactly (quizzes +
 *    quiz_questions with order_num; tests + test_questions with order_num AND
 *    difficulty-based default points 1/2/3), so the created rows are
 *    indistinguishable from builder-authored ones;
 *  - order_num follows the order the questions were passed in — the caller
 *    passes table order, and this is what makes the new assessment read the
 *    way the bank did;
 *  - ELIGIBILITY mirrors the builders: hidden, student-created, and
 *    unverified-MCQ rows are checked server-side on open, flagged, and left
 *    OUT of the created assessment (the bank shows rows the builders
 *    deliberately exclude, and this dialog must not smuggle them past that
 *    gate). The check fails closed.
 *  - a failed junction insert must not leave an empty head row behind — and
 *    if the cleanup delete itself fails, the error must say an empty
 *    assessment may remain;
 *  - an empty title is rejected before anything is written.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UnifiedQuestion } from "@/lib/unified-question";

const insertedRows = vi.hoisted(
  () => [] as Array<{ table: string; rows: unknown }>,
);
const deletedIds = vi.hoisted(
  () => [] as Array<{ table: string; id: string }>,
);
// Set to a table name to make that table's insert (or delete) fail.
const failInsertFor = vi.hoisted(() => ({ table: null as string | null }));
const failDeleteFor = vi.hoisted(() => ({ table: null as string | null }));
// Rows returned by the eligibility check (`questions` select … in).
const eligibilityRows = vi.hoisted(
  () => ({ data: [] as unknown[], error: null as unknown }),
);

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: vi.fn((table: string) => ({
      select: () => ({
        in: () =>
          Promise.resolve({
            data: eligibilityRows.data,
            error: eligibilityRows.error,
          }),
      }),
      insert: (rows: unknown) => {
        insertedRows.push({ table, rows });
        const error =
          failInsertFor.table === table ? { message: `${table} boom` } : null;
        return {
          select: () => ({
            single: () =>
              Promise.resolve(
                error
                  ? { data: null, error }
                  : { data: { id: `${table}-new` }, error: null },
              ),
          }),
          then: (resolve: (v: unknown) => unknown) =>
            Promise.resolve(resolve({ data: null, error })),
        };
      },
      delete: () => ({
        eq: (_col: string, id: string) => {
          deletedIds.push({ table, id });
          const error =
            failDeleteFor.table === table
              ? { message: `${table} delete boom` }
              : null;
          return Promise.resolve({ data: null, error });
        },
      }),
    })),
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: "user-1" } } })),
    },
  },
}));

vi.mock("@/lib/latex-utils", () => ({
  processLatexContent: (text: string) => text ?? "",
  formatQuestionText: (text: string) => text ?? "",
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { CreateAssessmentDialog } from "@/components/question-bank/CreateAssessmentDialog";
import { toast } from "sonner";

const mk = (over: Partial<UnifiedQuestion>): UnifiedQuestion => ({
  id: "q",
  type: "mcq",
  preview: "preview",
  searchText: "search",
  difficulty: "medium",
  authorName: null,
  createdBy: null,
  createdAt: "2026-01-01T00:00:00Z",
  hidden: false,
  upvotes: 0,
  downvotes: 0,
  chapters: [],
  competencies: [],
  materials: [],
  generatedForGroup: null,
  raw: {
    question: null,
    payload: null,
    answer_key: null,
    explanation: null,
    generation_rationale: null,
  },
  ...over,
});

const easy = mk({ id: "q-easy", difficulty: "easy", preview: "Easy one" });
const medium = mk({ id: "q-med", type: "open", difficulty: "medium", preview: "Medium one" });
const hard = mk({ id: "q-hard", type: "ordering", difficulty: "hard", preview: "Hard one" });

/** Server row for the eligibility check; defaults describe an eligible row. */
const dbRow = (
  q: UnifiedQuestion,
  over: Partial<{
    hidden: boolean;
    is_user_generated: boolean;
    validation_status: string | null;
    validation_confidence: number | null;
  }> = {},
) => ({
  id: q.id,
  type: q.type,
  hidden: false,
  is_user_generated: false,
  // MCQs need a passing verdict to be eligible; other types ignore these.
  validation_status: q.type === "mcq" ? "CORRECT" : null,
  validation_confidence: q.type === "mcq" ? 0.9 : null,
  ...over,
});

beforeEach(() => {
  insertedRows.length = 0;
  deletedIds.length = 0;
  failInsertFor.table = null;
  failDeleteFor.table = null;
  eligibilityRows.data = [];
  eligibilityRows.error = null;
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
});

function renderDialog(
  kind: "quiz" | "test",
  questions: UnifiedQuestion[],
  extra: { onCreated?: (kind: "quiz" | "test") => void } = {},
) {
  return render(
    <CreateAssessmentDialog
      open
      onOpenChange={() => {}}
      kind={kind}
      courseId="course-1"
      questions={questions}
      {...extra}
    />,
  );
}

/** Wait out the on-open eligibility check (submit is disabled until it lands). */
async function waitForCheck() {
  await waitFor(() =>
    expect(screen.getByTestId("create-assessment-submit")).not.toHaveTextContent(
      "Checking…",
    ),
  );
}

describe("CreateAssessmentDialog", () => {
  it("lists the selection in order and shows the count", async () => {
    eligibilityRows.data = [dbRow(easy), dbRow(medium), dbRow(hard)];
    renderDialog("quiz", [easy, medium, hard]);
    await waitForCheck();
    expect(screen.getByTestId("create-assessment-summary")).toHaveTextContent(
      "3 of 3 selected questions will be included",
    );
    const items = screen.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Easy one");
    expect(items[1]).toHaveTextContent("Medium one");
    expect(items[2]).toHaveTextContent("Hard one");
  });

  it("creates a quiz with quiz_questions in the passed order", async () => {
    eligibilityRows.data = [dbRow(easy), dbRow(medium)];
    const user = userEvent.setup();
    const onCreated = vi.fn();
    renderDialog("quiz", [medium, easy], { onCreated });
    await waitForCheck();

    await user.type(screen.getByTestId("create-assessment-title"), "Friday check-in");
    await user.click(screen.getByTestId("create-assessment-submit"));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("quiz"));

    const quizInsert = insertedRows.find((r) => r.table === "quizzes");
    expect(quizInsert?.rows).toMatchObject({
      course_id: "course-1",
      title: "Friday check-in",
      description: null,
      is_published: true,
      created_by: "user-1",
    });

    const junction = insertedRows.find((r) => r.table === "quiz_questions");
    expect(junction?.rows).toEqual([
      { quiz_id: "quizzes-new", question_id: "q-med", order_num: 0 },
      { quiz_id: "quizzes-new", question_id: "q-easy", order_num: 1 },
    ]);
    expect(toast.success).toHaveBeenCalled();
  });

  it("creates a test with difficulty-based default points (easy 1 / medium 2 / hard 3)", async () => {
    eligibilityRows.data = [dbRow(easy), dbRow(medium), dbRow(hard)];
    const user = userEvent.setup();
    renderDialog("test", [easy, medium, hard]);
    await waitForCheck();

    await user.type(screen.getByTestId("create-assessment-title"), "Chapter 3 test");
    await user.click(screen.getByTestId("create-assessment-submit"));

    await waitFor(() =>
      expect(insertedRows.some((r) => r.table === "test_questions")).toBe(true),
    );

    const junction = insertedRows.find((r) => r.table === "test_questions");
    expect(junction?.rows).toEqual([
      { test_id: "tests-new", question_id: "q-easy", order_num: 0, points: 1 },
      { test_id: "tests-new", question_id: "q-med", order_num: 1, points: 2 },
      { test_id: "tests-new", question_id: "q-hard", order_num: 2, points: 3 },
    ]);
  });

  it("rejects an empty title before writing anything", async () => {
    eligibilityRows.data = [dbRow(easy)];
    const user = userEvent.setup();
    renderDialog("quiz", [easy]);
    await waitForCheck();

    await user.click(screen.getByTestId("create-assessment-submit"));

    expect(toast.error).toHaveBeenCalled();
    expect(insertedRows).toHaveLength(0);
  });

  it("deletes the head row when the junction insert fails, and reports the error", async () => {
    eligibilityRows.data = [dbRow(easy)];
    failInsertFor.table = "quiz_questions";
    const user = userEvent.setup();
    const onCreated = vi.fn();
    renderDialog("quiz", [easy], { onCreated });
    await waitForCheck();

    await user.type(screen.getByTestId("create-assessment-title"), "Doomed quiz");
    await user.click(screen.getByTestId("create-assessment-submit"));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(deletedIds).toEqual([{ table: "quizzes", id: "quizzes-new" }]);
    expect(onCreated).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("says an empty assessment may remain when the cleanup delete ALSO fails", async () => {
    eligibilityRows.data = [dbRow(easy)];
    failInsertFor.table = "quiz_questions";
    failDeleteFor.table = "quizzes";
    const user = userEvent.setup();
    renderDialog("quiz", [easy]);
    await waitForCheck();

    await user.type(screen.getByTestId("create-assessment-title"), "Doomed quiz");
    await user.click(screen.getByTestId("create-assessment-submit"));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining("may remain"),
      ),
    );
  });
});

describe("CreateAssessmentDialog — eligibility gate", () => {
  it.each([
    ["hidden", { hidden: true }, "Hidden"],
    ["student-created", { is_user_generated: true }, "Student-created"],
  ] as const)(
    "flags and excludes a %s question",
    async (_label, over, badge) => {
      const bad = mk({ id: "q-bad", type: "open", preview: "Bad one" });
      eligibilityRows.data = [dbRow(easy), dbRow(bad, over)];
      const user = userEvent.setup();
      renderDialog("quiz", [easy, bad]);
      await waitForCheck();

      expect(screen.getByTestId("create-assessment-excluded-q-bad")).toHaveTextContent(badge);
      expect(screen.getByTestId("create-assessment-ineligible-note")).toBeInTheDocument();
      expect(screen.getByTestId("create-assessment-summary")).toHaveTextContent(
        "1 of 2 selected questions will be included",
      );

      await user.type(screen.getByTestId("create-assessment-title"), "Filtered quiz");
      await user.click(screen.getByTestId("create-assessment-submit"));

      await waitFor(() =>
        expect(insertedRows.some((r) => r.table === "quiz_questions")).toBe(true),
      );
      const junction = insertedRows.find((r) => r.table === "quiz_questions");
      expect(junction?.rows).toEqual([
        { quiz_id: "quizzes-new", question_id: "q-easy", order_num: 0 },
      ]);
    },
  );

  it("excludes an MCQ without a CORRECT verdict at confidence > 0.7 — the builders' isMcqVerified rule", async () => {
    const unverified = mk({ id: "q-unv", type: "mcq", preview: "Unverified" });
    eligibilityRows.data = [
      dbRow(medium),
      dbRow(unverified, { validation_status: "CORRECT", validation_confidence: 0.5 }),
    ];
    renderDialog("quiz", [medium, unverified]);
    await waitForCheck();

    expect(screen.getByTestId("create-assessment-excluded-q-unv")).toHaveTextContent(
      "Unverified MCQ",
    );
  });

  it("disables Create entirely when nothing in the selection is eligible", async () => {
    eligibilityRows.data = [dbRow(easy, { hidden: true })];
    renderDialog("quiz", [easy]);
    await waitForCheck();

    expect(screen.getByTestId("create-assessment-submit")).toBeDisabled();
  });

  it("fails closed when the eligibility check errors — no writes possible", async () => {
    eligibilityRows.error = { message: "network down" };
    renderDialog("quiz", [easy]);

    await waitFor(() =>
      expect(
        screen.getByTestId("create-assessment-eligibility-error"),
      ).toBeInTheDocument(),
    );
    expect(screen.getByTestId("create-assessment-submit")).toBeDisabled();
    expect(insertedRows).toHaveLength(0);
  });
});
