/**
 * #753 — exercises `useStudentPracticeQuestions`.
 *
 * The hook fans out several Supabase fetches (offerings → offering_questions →
 * questions → status sources) and reconciles them into a single normalized
 * list. Tests mock the Supabase client at the boundary so we can assert:
 *  - assignment scoping (offerings + published_at)
 *  - per-type status reconciliation (MCQ via quiz_answers; others via
 *    chat_sessions / open_question_grades)
 *  - interactive-open exclusion
 *  - timed-quiz exclusion
 *  - malformed payload defense (no throw; `stemPreview === ''`)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

type Result = { data: unknown; error: unknown };

const responses: Record<string, Result> = {
  class_enrollments: { data: [], error: null },
  offerings: { data: [], error: null },
  offering_questions: { data: [], error: null },
  quiz_questions: { data: [], error: null },
  questions: { data: [], error: null },
  quiz_answers: { data: [], error: null },
  chat_sessions: { data: [], error: null },
  open_question_grades: { data: [], error: null },
  question_chapters: { data: [], error: null },
};

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

// vi.mock() is hoisted to the top of the file, so any helper referenced by
// the factory must be hoisted with it. vi.hoisted is the supported escape
// hatch — see https://vitest.dev/api/vi.html#vi-hoisted.
const hoisted = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  selects: {} as Record<string, string[]>,
}));
const getUserMock = hoisted.getUserMock;
/** Column lists each table was asked for, so a test can assert the REQUEST. */
const selects: Record<string, string[]> = hoisted.selects;

vi.mock("@/integrations/supabase/client", () => {
  // Each table call returns a chainable, awaitable object that resolves to
  // the configured response on the FIRST await (mirroring PostgREST).
  function buildChain(table: string) {
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
    chain.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(resolve(responses[table] || { data: [], error: null }));
    return chain;
  }
  return {
    supabase: {
      from: vi.fn((table: string) => buildChain(table)),
      auth: { getUser: hoisted.getUserMock },
    },
  };
});

import { useStudentPracticeQuestions } from "@/hooks/useStudentPracticeQuestions";

beforeEach(() => {
  for (const key of Object.keys(selects)) delete selects[key];
  for (const key of Object.keys(responses)) {
    responses[key] = { data: [], error: null };
  }
  getUserMock.mockReset();
  getUserMock.mockResolvedValue({
    data: { user: { id: "user-1" } },
    error: null,
  });
});

describe("useStudentPracticeQuestions", () => {
  it("returns empty list when the student has no class enrollments", async () => {
    responses.class_enrollments = { data: [], error: null };

    const { result } = renderHook(() => useStudentPracticeQuestions("course-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.questions).toEqual([]);
  });

  it("returns empty list when the student is enrolled in no offerings for the course", async () => {
    responses.class_enrollments = { data: [{ class_id: "class-1" }], error: null };
    responses.offerings = { data: [], error: null };

    const { result } = renderHook(() => useStudentPracticeQuestions("course-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.questions).toEqual([]);
  });

  it("returns empty list when no questions are published to the student's offerings", async () => {
    responses.class_enrollments = { data: [{ class_id: "class-1" }], error: null };
    responses.offerings = { data: [{ id: "off-1", class_id: "class-1" }], error: null };
    responses.offering_questions = { data: [], error: null };

    const { result } = renderHook(() => useStudentPracticeQuestions("course-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.questions).toEqual([]);
  });

  it("maps assigned questions of all five types with per-type previews and difficulty", async () => {
    responses.class_enrollments = { data: [{ class_id: "class-1" }], error: null };
    responses.offerings = { data: [{ id: "off-1", class_id: "class-1" }], error: null };
    responses.offering_questions = {
      data: [
        { question_id: "q-mcq", offering_id: "off-1" },
        { question_id: "q-open", offering_id: "off-1" },
        { question_id: "q-fill", offering_id: "off-1" },
        { question_id: "q-order", offering_id: "off-1" },
        { question_id: "q-class", offering_id: "off-1" },
      ],
      error: null,
    };
    responses.questions = {
      data: [
        {
          id: "q-mcq",
          type: "mcq",
          question: "MCQ stem",
          payload: { options: ["A", "B"] },
          answer_key: { correct_indices: [0] },
          explanation: null,
          difficulty: "easy",
          hidden: false,
        },
        {
          id: "q-open",
          type: "open",
          question: "Open stem",
          payload: { answering_mode: "single" },
          answer_key: { model_answer: "answer" },
          explanation: null,
          difficulty: "medium",
          hidden: false,
        },
        {
          id: "q-fill",
          type: "fill_gaps",
          question: null,
          payload: { stem: "X is {{1}} than Y" },
          answer_key: { gaps: [{ ordinal: 1, acceptable: ["larger"] }] },
          explanation: null,
          difficulty: "hard",
          hidden: false,
        },
        {
          id: "q-order",
          type: "ordering",
          question: null,
          payload: { prompt: "Sort", items: ["one", "two", "three"] },
          answer_key: {},
          explanation: null,
          difficulty: "medium",
          hidden: false,
        },
        {
          id: "q-class",
          type: "classification",
          question: null,
          payload: {
            prompt: "Sort cards",
            categories: [
              { id: "c1", label: "Cat A" },
              { id: "c2", label: "Cat B" },
            ],
            items: [
              { id: "i1", text: "alpha" },
              { id: "i2", text: "beta" },
            ],
          },
          answer_key: { assignments: { i1: "c1", i2: "c2" } },
          explanation: null,
          difficulty: "easy",
          hidden: false,
        },
      ],
      error: null,
    };

    const { result } = renderHook(() => useStudentPracticeQuestions("course-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const byId = Object.fromEntries(
      result.current.questions.map((q) => [q.id, q]),
    );
    expect(Object.keys(byId).sort()).toEqual([
      "q-class",
      "q-fill",
      "q-mcq",
      "q-open",
      "q-order",
    ]);
    expect(byId["q-mcq"].type).toBe("mcq");
    expect(byId["q-mcq"].difficulty).toBe("easy");
    expect(byId["q-mcq"].stemPreview).toContain("MCQ stem");
    expect(byId["q-mcq"].offeringId).toBe("off-1");
    expect(byId["q-fill"].stemPreview).toContain("X is");
    expect(byId["q-order"].stemPreview).toContain("Sort");
    expect(byId["q-class"].stemPreview).toContain("Cat A");
    // Every question is `not_started` because we provided no status rows.
    for (const q of result.current.questions) {
      expect(q.status).toBe("not_started");
      expect(q.grade).toBeUndefined();
    }
  });

  it("reconciles MCQ status from quiz_answers — correct attempt → completed", async () => {
    responses.class_enrollments = { data: [{ class_id: "class-1" }], error: null };
    responses.offerings = { data: [{ id: "off-1", class_id: "class-1" }], error: null };
    responses.offering_questions = {
      data: [
        { question_id: "q-correct", offering_id: "off-1" },
        { question_id: "q-wrong", offering_id: "off-1" },
        { question_id: "q-none", offering_id: "off-1" },
      ],
      error: null,
    };
    responses.questions = {
      data: ["q-correct", "q-wrong", "q-none"].map((id) => ({
        id,
        type: "mcq",
        question: `Q ${id}`,
        payload: { options: ["A", "B"] },
        answer_key: { correct_indices: [0] },
        explanation: null,
        difficulty: "medium",
        hidden: false,
      })),
      error: null,
    };
    responses.quiz_answers = {
      data: [
        { question_id: "q-correct", is_correct: true },
        { question_id: "q-correct", is_correct: false },
        { question_id: "q-wrong", is_correct: false },
      ],
      error: null,
    };

    const { result } = renderHook(() => useStudentPracticeQuestions("course-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const byId = Object.fromEntries(
      result.current.questions.map((q) => [q.id, q]),
    );
    expect(byId["q-correct"].status).toBe("completed");
    expect(byId["q-correct"].grade).toBe(100);
    expect(byId["q-wrong"].status).toBe("in_progress");
    expect(byId["q-wrong"].grade).toBe(0);
    expect(byId["q-none"].status).toBe("not_started");
    expect(byId["q-none"].grade).toBeUndefined();
  });

  it("counts a graded submission with no chat session as completed", async () => {
    // The deterministic types never open a chat: `grade-deterministic-answer`
    // writes the result to `open_question_grades`, and the answering panel
    // reads that row back to render itself as done. Asking `chat_sessions`
    // alone put the question back to not-started on the next reload, so a
    // student saw finished work as outstanding.
    responses.class_enrollments = { data: [{ class_id: "class-1" }], error: null };
    responses.offerings = { data: [{ id: "off-1", class_id: "class-1" }], error: null };
    responses.offering_questions = {
      data: [{ question_id: "q-submitted", offering_id: "off-1" }],
      error: null,
    };
    responses.questions = {
      data: [
        {
          id: "q-submitted",
          type: "fill_gaps",
          question: null,
          payload: { stem: "A {{1}} B" },
          answer_key: { gaps: [{ ordinal: 1, acceptable: ["x"] }] },
          explanation: null,
          difficulty: "easy",
          hidden: false,
        },
      ],
      error: null,
    };
    responses.chat_sessions = { data: [], error: null };
    responses.open_question_grades = {
      data: [{ open_question_id: "q-submitted", grade: 75 }],
      error: null,
    };

    const { result } = renderHook(() => useStudentPracticeQuestions("course-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const question = result.current.questions.find((q) => q.id === "q-submitted");
    expect(question?.status).toBe("completed");
    expect(question?.grade).toBe(75);
  });

  it("reconciles non-MCQ status from the chat session and surfaces grades", async () => {
    responses.class_enrollments = { data: [{ class_id: "class-1" }], error: null };
    responses.offerings = { data: [{ id: "off-1", class_id: "class-1" }], error: null };
    responses.offering_questions = {
      data: [
        { question_id: "q-completed", offering_id: "off-1" },
        { question_id: "q-inprogress", offering_id: "off-1" },
        { question_id: "q-paused", offering_id: "off-1" },
        { question_id: "q-empty", offering_id: "off-1" },
      ],
      error: null,
    };
    responses.questions = {
      data: [
        {
          id: "q-completed",
          type: "fill_gaps",
          question: null,
          payload: { stem: "A {{1}} B" },
          answer_key: { gaps: [{ ordinal: 1, acceptable: ["x"] }] },
          explanation: null,
          difficulty: "easy",
          hidden: false,
        },
        {
          id: "q-inprogress",
          type: "ordering",
          question: null,
          payload: { prompt: "Sort", items: ["a", "b", "c"] },
          answer_key: {},
          explanation: null,
          difficulty: "easy",
          hidden: false,
        },
        {
          id: "q-paused",
          type: "open",
          question: "Paused?",
          payload: { answering_mode: "single" },
          answer_key: { model_answer: "x" },
          explanation: null,
          difficulty: "easy",
          hidden: false,
        },
        {
          id: "q-empty",
          type: "open",
          question: "Empty",
          payload: { answering_mode: "single" },
          answer_key: { model_answer: "x" },
          explanation: null,
          difficulty: "easy",
          hidden: false,
        },
      ],
      error: null,
    };
    responses.chat_sessions = {
      data: [
        { open_question_id: "q-completed", status: "completed" },
        { open_question_id: "q-inprogress", status: "in_progress" },
        { open_question_id: "q-paused", status: "paused" },
      ],
      error: null,
    };
    responses.open_question_grades = {
      data: [
        { open_question_id: "q-completed", grade: 88 },
        { open_question_id: "q-inprogress", grade: 42 },
      ],
      error: null,
    };

    const { result } = renderHook(() => useStudentPracticeQuestions("course-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const byId = Object.fromEntries(
      result.current.questions.map((q) => [q.id, q]),
    );
    expect(byId["q-completed"].status).toBe("completed");
    expect(byId["q-completed"].grade).toBe(88);
    expect(byId["q-inprogress"].status).toBe("in_progress");
    expect(byId["q-inprogress"].grade).toBe(42);
    expect(byId["q-paused"].status).toBe("in_progress");
    expect(byId["q-paused"].grade).toBeUndefined();
    expect(byId["q-empty"].status).toBe("not_started");
    expect(byId["q-empty"].grade).toBeUndefined();
  });

  it("excludes interactive-mode open questions", async () => {
    responses.class_enrollments = { data: [{ class_id: "class-1" }], error: null };
    responses.offerings = { data: [{ id: "off-1", class_id: "class-1" }], error: null };
    responses.offering_questions = {
      data: [
        { question_id: "q-single", offering_id: "off-1" },
        { question_id: "q-interactive", offering_id: "off-1" },
        { question_id: "q-legacy", offering_id: "off-1" },
      ],
      error: null,
    };
    responses.questions = {
      data: [
        {
          id: "q-single",
          type: "open",
          question: "Single",
          payload: { answering_mode: "single" },
          answer_key: { model_answer: "x" },
          explanation: null,
          difficulty: "medium",
          hidden: false,
        },
        {
          id: "q-interactive",
          type: "open",
          question: "Interactive",
          payload: { answering_mode: "interactive" },
          answer_key: { model_answer: "x" },
          explanation: null,
          difficulty: "medium",
          hidden: false,
        },
        {
          id: "q-legacy",
          type: "open",
          question: "Legacy",
          payload: {},
          answer_key: { model_answer: "x" },
          explanation: null,
          difficulty: "medium",
          hidden: false,
        },
      ],
      error: null,
    };

    const { result } = renderHook(() => useStudentPracticeQuestions("course-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.questions.map((q) => q.id)).toEqual(["q-single"]);
    expect(result.current.questions[0].answeringMode).toBe("single");
  });

  it("excludes timed-quiz questions", async () => {
    responses.class_enrollments = { data: [{ class_id: "class-1" }], error: null };
    responses.offerings = { data: [{ id: "off-1", class_id: "class-1" }], error: null };
    responses.offering_questions = {
      data: [
        { question_id: "q-practice", offering_id: "off-1" },
        { question_id: "q-in-quiz", offering_id: "off-1" },
      ],
      error: null,
    };
    responses.quiz_questions = {
      data: [{ question_id: "q-in-quiz" }],
      error: null,
    };
    responses.questions = {
      data: [
        {
          id: "q-practice",
          type: "mcq",
          question: "Practice MCQ",
          payload: { options: ["A", "B"] },
          answer_key: { correct_indices: [0] },
          explanation: null,
          difficulty: "easy",
          hidden: false,
        },
      ],
      error: null,
    };

    const { result } = renderHook(() => useStudentPracticeQuestions("course-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.questions.map((q) => q.id)).toEqual(["q-practice"]);
  });

  it("filters out hidden questions and unknown types", async () => {
    responses.class_enrollments = { data: [{ class_id: "class-1" }], error: null };
    responses.offerings = { data: [{ id: "off-1", class_id: "class-1" }], error: null };
    responses.offering_questions = {
      data: [
        { question_id: "q-good", offering_id: "off-1" },
        { question_id: "q-hidden", offering_id: "off-1" },
        { question_id: "q-bad-type", offering_id: "off-1" },
      ],
      error: null,
    };
    responses.questions = {
      data: [
        {
          id: "q-good",
          type: "mcq",
          question: "Visible",
          payload: { options: ["A", "B"] },
          answer_key: { correct_indices: [0] },
          explanation: null,
          difficulty: "easy",
          hidden: false,
        },
        {
          id: "q-hidden",
          type: "mcq",
          question: "Hidden",
          payload: { options: ["A", "B"] },
          answer_key: { correct_indices: [0] },
          explanation: null,
          difficulty: "easy",
          hidden: true,
        },
        {
          id: "q-bad-type",
          type: "flashcard",
          question: "Not a practice type",
          payload: {},
          answer_key: {},
          explanation: null,
          difficulty: "easy",
          hidden: false,
        },
      ],
      error: null,
    };

    const { result } = renderHook(() => useStudentPracticeQuestions("course-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.questions.map((q) => q.id)).toEqual(["q-good"]);
  });

  it("defends against malformed payloads — never throws, stemPreview becomes ''", async () => {
    responses.class_enrollments = { data: [{ class_id: "class-1" }], error: null };
    responses.offerings = { data: [{ id: "off-1", class_id: "class-1" }], error: null };
    responses.offering_questions = {
      data: [{ question_id: "q-malformed", offering_id: "off-1" }],
      error: null,
    };
    responses.questions = {
      data: [
        {
          id: "q-malformed",
          type: "fill_gaps",
          question: null,
          payload: null,
          answer_key: null,
          explanation: null,
          difficulty: "medium",
          hidden: false,
        },
      ],
      error: null,
    };

    const { result } = renderHook(() => useStudentPracticeQuestions("course-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.questions).toHaveLength(1);
    expect(result.current.questions[0].stemPreview).toBe("");
    expect(result.current.questions[0].status).toBe("not_started");
  });

  it("exposes joined chapters per question via question_chapters (#774)", async () => {
    responses.class_enrollments = { data: [{ class_id: "class-1" }], error: null };
    responses.offerings = { data: [{ id: "off-1", class_id: "class-1" }], error: null };
    responses.offering_questions = {
      data: [
        { question_id: "q-tagged", offering_id: "off-1" },
        { question_id: "q-untagged", offering_id: "off-1" },
        { question_id: "q-multi", offering_id: "off-1" },
      ],
      error: null,
    };
    responses.questions = {
      data: ["q-tagged", "q-untagged", "q-multi"].map((id) => ({
        id,
        type: "mcq",
        question: `Q ${id}`,
        payload: { options: ["A", "B"] },
        answer_key: { correct_indices: [0] },
        explanation: null,
        difficulty: "medium",
        hidden: false,
      })),
      error: null,
    };
    responses.question_chapters = {
      data: [
        {
          question_id: "q-tagged",
          chapter_id: "ch-1",
          material_chapters: {
            id: "ch-1",
            title: "Photosynthesis",
            material_id: "mat-1",
            course_materials: { id: "mat-1", title: "Biology Book", file_name: null },
          },
        },
        {
          question_id: "q-multi",
          chapter_id: "ch-1",
          material_chapters: {
            id: "ch-1",
            title: "Photosynthesis",
            material_id: "mat-1",
            course_materials: { id: "mat-1", title: "Biology Book", file_name: null },
          },
        },
        {
          question_id: "q-multi",
          chapter_id: "ch-2",
          material_chapters: {
            id: "ch-2",
            title: "Respiration",
            material_id: "mat-1",
            course_materials: { id: "mat-1", title: "Biology Book", file_name: null },
          },
        },
      ],
      error: null,
    };

    const { result } = renderHook(() => useStudentPracticeQuestions("course-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const byId = Object.fromEntries(
      result.current.questions.map((q) => [q.id, q]),
    );
    expect(byId["q-tagged"].chapters).toEqual([
      {
        id: "ch-1",
        title: "Photosynthesis",
        materialId: "mat-1",
        materialTitle: "Biology Book",
      },
    ]);
    // No chapter rows for q-untagged — falls back to an empty array.
    expect(byId["q-untagged"].chapters).toEqual([]);
    // Multiple chapters surface as multiple entries.
    expect(byId["q-multi"].chapters.map((c) => c.id).sort()).toEqual([
      "ch-1",
      "ch-2",
    ]);
  });

  it("falls back to file_name when course_materials.title is null (#774)", async () => {
    responses.class_enrollments = { data: [{ class_id: "class-1" }], error: null };
    responses.offerings = { data: [{ id: "off-1", class_id: "class-1" }], error: null };
    responses.offering_questions = {
      data: [{ question_id: "q-1", offering_id: "off-1" }],
      error: null,
    };
    responses.questions = {
      data: [
        {
          id: "q-1",
          type: "mcq",
          question: "Q",
          payload: { options: ["A", "B"] },
          answer_key: { correct_indices: [0] },
          explanation: null,
          difficulty: "medium",
          hidden: false,
        },
      ],
      error: null,
    };
    responses.question_chapters = {
      data: [
        {
          question_id: "q-1",
          chapter_id: "ch-1",
          material_chapters: {
            id: "ch-1",
            title: "Intro",
            material_id: "mat-1",
            course_materials: { id: "mat-1", title: null, file_name: "biology.pdf" },
          },
        },
      ],
      error: null,
    };

    const { result } = renderHook(() => useStudentPracticeQuestions("course-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.questions[0].chapters[0].materialTitle).toBe("biology.pdf");
  });

  it("returns empty list when no user is authenticated", async () => {
    getUserMock.mockResolvedValueOnce({
      data: { user: null },
      error: null,
    } as unknown as Awaited<ReturnType<typeof getUserMock>>);

    const { result } = renderHook(() => useStudentPracticeQuestions("course-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.questions).toEqual([]);
  });

  it("resolves offerings via split queries, not via a class_enrollments embed (#770)", async () => {
    // Regression guard for #770: an earlier version embedded
    // `class_enrollments` under `offerings`, but no FK exists between the
    // two tables, so PostgREST errored at request time. Ensure both queries
    // are executed independently so the embed pattern cannot return.
    const { supabase } = await import("@/integrations/supabase/client");
    responses.class_enrollments = { data: [{ class_id: "class-1" }], error: null };
    responses.offerings = { data: [{ id: "off-1", class_id: "class-1" }], error: null };
    responses.offering_questions = { data: [], error: null };

    const { result } = renderHook(() => useStudentPracticeQuestions("course-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const fromMock = supabase.from as unknown as ReturnType<typeof vi.fn>;
    const calls = fromMock.mock.calls.map((c) => c[0]);
    expect(calls).toContain("class_enrollments");
    expect(calls).toContain("offerings");
    expect(calls.indexOf("class_enrollments")).toBeLessThan(calls.indexOf("offerings"));
  });
});

describe("useStudentPracticeQuestions — the key is not fetched (#1011)", () => {
  it("asks for neither the answer key nor the explanation", async () => {
    // This hook loads a whole course's assigned questions across all five
    // types, so asking for `answer_key` handed the browser every answer the
    // student had been set. Nothing here ever read it: the hook returns a
    // preview, a status and a grade, and `buildPreview` works from `payload`
    // alone — only `buildSearchText` reads the key, and this hook does not
    // call it.
    responses.class_enrollments = { data: [{ class_id: "class-1" }], error: null };
    responses.offerings = { data: [{ id: "off-1", class_id: "class-1" }], error: null };
    responses.offering_questions = {
      data: [{ question_id: "q1", offering_id: "off-1" }],
      error: null,
    };
    responses.questions = {
      data: [
        {
          id: "q1",
          type: "mcq",
          question: "Stem?",
          payload: { options: ["a", "b"] },
          difficulty: "easy",
          hidden: false,
        },
      ],
      error: null,
    };

    const { result } = renderHook(() => useStudentPracticeQuestions("course-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(selects.questions?.length).toBeGreaterThan(0);
    for (const cols of selects.questions) {
      expect(cols).not.toContain("answer_key");
      expect(cols).not.toContain("explanation");
    }
    // And the row still resolves — the preview needs none of it.
    expect(result.current.questions).toHaveLength(1);
    expect(result.current.questions[0].stemPreview).toContain("Stem?");
  });
});
