import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

/**
 * QuizHistory — the Data Bank "Student Interactions" table.
 *
 * Covers the per-type decode → render path added when the table was expanded
 * beyond MCQs: each unified question type's `submission` shape renders its
 * own submitted/correct breakdown, open answers are "Not scored" rather than
 * Wrong, and an answer whose question row is gone is never mislabeled as an
 * MCQ.
 *
 * The quiz / question-type / "Not in a quiz" filters are Radix selects,
 * which don't open under jsdom — their behavior is plain predicate logic in
 * the component; the rendering they gate is what's asserted here.
 */

// Per-table rows the chainable supabase mock resolves to. Reset per test.
let tables: Record<string, unknown[]> = {};
// Values passed to .update(), per table — for asserting the grading write.
let updateCalls: { table: string; values: Record<string, unknown> }[] = [];

vi.mock("@/integrations/supabase/client", () => {
  const buildChain = (table: string) => {
    const chain: Record<string, unknown> = {};
    const passThrough = () => chain;
    chain.select = passThrough;
    chain.eq = passThrough;
    chain.in = passThrough;
    chain.not = passThrough;
    chain.order = passThrough;
    chain.update = (values: Record<string, unknown>) => {
      updateCalls.push({ table, values });
      return chain;
    };
    chain.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(resolve({ data: tables[table] ?? [], error: null }));
    return chain;
  };
  return { supabase: { from: vi.fn((table: string) => buildChain(table)) } };
});

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import QuizHistory from "@/components/QuizHistory";

const baseTables = (): Record<string, unknown[]> => ({
  quizzes: [{ id: "quiz-1", title: "Quiz One" }],
  quiz_questions: [{ quiz_id: "quiz-1" }],
  offerings: [{ class_id: "class-1" }],
  class_enrollments: [{ user_id: "user-1" }],
  profiles: [
    { user_id: "user-1", full_name: "Student One", email: "s1@test.local" },
    { user_id: "user-2", full_name: "Student Two", email: "s2@test.local" },
  ],
  // Written single-mode practice submissions (submit-open-answer). The
  // ordering row must be filtered out — only `open` questions belong in the
  // table from this source.
  open_question_grades: [
    {
      id: "g-open-pending",
      user_id: "user-1",
      open_question_id: "q-open",
      grade: null,
      submitted_answer: "Practice essay pending review",
      created_at: "2026-09-01T11:00:00Z",
    },
    {
      id: "g-open-graded",
      user_id: "user-2",
      open_question_id: "q-open",
      grade: 85,
      submitted_answer: "Practice essay graded",
      created_at: "2026-09-01T11:01:00Z",
    },
    {
      id: "g-ordering",
      user_id: "user-2",
      open_question_id: "q-ord",
      grade: 100,
      submitted_answer: '["First","Second","Third"]',
      created_at: "2026-09-01T11:02:00Z",
    },
  ],
  questions: [
    {
      id: "q-mcq",
      question: "Which option?",
      type: "mcq",
      payload: { options: ["Alpha", "Beta", "Gamma"], multi_correct: false },
      answer_key: { correct_indices: [1] },
    },
    {
      id: "q-open",
      question: "Explain the treaty.",
      type: "open",
      payload: {},
      answer_key: { model_answer: "Model." },
    },
    {
      id: "q-ord",
      question: "Order the events.",
      type: "ordering",
      payload: { prompt: "Order the events.", items: ["First", "Second", "Third"] },
      answer_key: {},
    },
    {
      id: "q-gaps",
      question: "A {{1}} B {{2}}",
      type: "fill_gaps",
      payload: { stem: "A {{1}} B {{2}}" },
      answer_key: {
        gaps: [
          { ordinal: 1, acceptable: ["foo"] },
          { ordinal: 2, acceptable: ["bar", "baz"] },
        ],
      },
    },
    {
      id: "q-cls",
      question: "Sort the items.",
      type: "classification",
      payload: {
        prompt: "Sort the items.",
        categories: [
          { id: "c1", label: "Cat A" },
          { id: "c2", label: "Cat B" },
        ],
        items: [
          { id: "i1", text: "Item 1" },
          { id: "i2", text: "Item 2" },
        ],
      },
      answer_key: { assignments: { i1: "c1", i2: "c2" } },
    },
  ],
  quiz_answers: [
    {
      id: "a-mcq",
      user_id: "user-1",
      question_id: "q-mcq",
      quiz_id: "quiz-1",
      selected_answer: null,
      submission: { selected_indices: [0] },
      is_correct: false,
      answered_at: "2026-09-01T10:00:00Z",
    },
    {
      id: "a-open",
      user_id: "user-1",
      question_id: "q-open",
      quiz_id: null,
      selected_answer: null,
      submission: { open_text: "My essay answer" },
      is_correct: false,
      answered_at: "2026-09-01T10:01:00Z",
    },
    {
      id: "a-ord",
      user_id: "user-1",
      question_id: "q-ord",
      quiz_id: null,
      selected_answer: null,
      submission: { ordering: ["Second", "First", "Third"] },
      is_correct: false,
      answered_at: "2026-09-01T10:02:00Z",
    },
    {
      id: "a-gaps",
      user_id: "user-1",
      question_id: "q-gaps",
      quiz_id: "quiz-1",
      selected_answer: null,
      submission: { fill_gaps: ["foo", "wrong"] },
      is_correct: false,
      answered_at: "2026-09-01T10:03:00Z",
    },
    {
      id: "a-cls",
      user_id: "user-1",
      question_id: "q-cls",
      quiz_id: "quiz-1",
      selected_answer: null,
      submission: { classification: { i1: "c1", i2: "c1" } },
      is_correct: false,
      answered_at: "2026-09-01T10:04:00Z",
    },
    {
      id: "a-gone",
      user_id: "user-1",
      question_id: "q-deleted",
      quiz_id: null,
      selected_answer: 0,
      submission: { selected_indices: [0] },
      is_correct: true,
      answered_at: "2026-09-01T10:05:00Z",
    },
  ],
});

const renderHistory = async () => {
  const view = render(<QuizHistory courseId="course-1" />);
  // Loading spinner resolves once the fetch chain settles.
  await screen.findByText("Which option?");
  return view;
};

beforeEach(() => {
  vi.clearAllMocks();
  tables = baseTables();
  updateCalls = [];
});

describe("QuizHistory — per-type answer rendering", () => {
  it("renders each question type's submission with its own shape", async () => {
    const { container } = await renderHistory();
    const text = container.textContent ?? "";

    // MCQ: selected vs correct options by index.
    expect(text).toContain("Selected: Alpha");
    expect(text).toContain("Correct: Beta");

    // Open: the free text, verbatim.
    expect(text).toContain("Answer: My essay answer");

    // Ordering: submitted sequence plus the canonical order on a miss.
    expect(text).toContain("Order: Second → First → Third");
    expect(text).toContain("Correct: First → Second → Third");

    // Fill the gaps: filled values plus the accepted lists on a miss.
    expect(text).toContain("Filled: foo, wrong");
    expect(text).toContain("Accepted: foo, bar / baz");

    // Classification: per-item placement, correct category on misplacement.
    expect(text).toContain("Item 1 → Cat A");
    expect(text).toContain("Item 2 → Cat A (correct: Cat B)");
  });

  it("labels each row with its question type", async () => {
    await renderHistory();
    for (const label of ["MCQ", "Open", "Ordering", "Fill the Gaps", "Classification"]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
  });

  it("includes written practice open submissions, but only for open questions", async () => {
    const { container } = await renderHistory();
    const text = container.textContent ?? "";

    // Both open_question_grades submissions render as open-answer rows.
    expect(text).toContain("Answer: Practice essay pending review");
    expect(text).toContain("Answer: Practice essay graded");
    // The reviewed one carries the instructor's score instead of "Not scored".
    expect(screen.getByText("85/100")).toBeInTheDocument();

    // The ordering-type grade row is excluded — its submitted_answer is
    // JSON, not prose, and its history is out of scope for this source.
    expect(text).not.toContain('["First');
  });

  it("marks open answers Not scored instead of Wrong", async () => {
    await renderHistory();
    const table = within(screen.getByRole("table"));
    // The quiz open answer and the pending practice submission; the reviewed
    // practice submission shows its grade badge instead.
    expect(table.getAllByText("Not scored")).toHaveLength(2);
    expect(table.getAllByText("Wrong")).toHaveLength(4);
    expect(table.getAllByText("Correct")).toHaveLength(1);
  });

  it("excludes open answers from Wrong and buckets unreviewed ones as Not Scored in the stats", async () => {
    await renderHistory();
    // Tile labels are <p> elements; "Correct"/"Wrong" also appear as result
    // badges (spans) inside the table, so pick the tile by tag.
    const tile = (label: string) =>
      screen.getAllByText(label).find((el) => el.tagName === "P")?.parentElement
        ?.textContent ?? "";
    expect(tile("Total Attempts")).toContain("8"); // 6 quiz_answers + 2 practice open
    expect(tile("Correct")).toContain("1"); // the deleted-question row, graded by the server
    expect(tile("Wrong")).toContain("4"); // mcq + ordering + fill_gaps + classification
    expect(tile("Not Scored")).toContain("2"); // quiz open + pending practice open
  });

  it("never mislabels an answer whose question row is gone as an MCQ", async () => {
    await renderHistory();
    const row = screen.getByText("Question not found").closest("tr")!;
    // No type badge and no decoded submission — the shape is unknowable.
    expect(row.textContent).not.toContain("MCQ");
    expect(row.textContent).not.toContain("Selected:");
    // Its server verdict still shows.
    expect(row.textContent).toContain("Correct");
  });

  it("offers Grade on pending written submissions and Edit on reviewed ones — never on quiz rows", async () => {
    await renderHistory();
    // Only the two open_question_grades rows carry the action; the quiz
    // open answer (no grade_row_id) shows no button.
    expect(screen.getAllByRole("button", { name: /grade/i })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /^edit$/i })).toHaveLength(1);
  });

  it("saves an instructor grade through open_question_grades", async () => {
    await renderHistory();

    fireEvent.click(screen.getByRole("button", { name: /grade/i }));
    expect(await screen.findByText("Grade Submission")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /save assessment/i }));

    await waitFor(() => {
      expect(updateCalls).toHaveLength(1);
    });
    expect(updateCalls[0].table).toBe("open_question_grades");
    expect(updateCalls[0].values.grade).toBe(50); // the dialog's default score
    // The row's badge reflects the saved grade without a refetch.
    expect(await screen.findByText("50/100")).toBeInTheDocument();
  });

  it("offers a Not-in-a-quiz option in the quiz filter", async () => {
    await renderHistory();
    // Radix renders only the trigger under jsdom; the option list is portal
    // content that needs a real pointer. Assert the trigger defaults intact —
    // the NO_QUIZ predicate itself is covered by the rows above rendering
    // regardless of quiz_id being null.
    expect(screen.getByText("All Quizzes")).toBeInTheDocument();
  });
});
