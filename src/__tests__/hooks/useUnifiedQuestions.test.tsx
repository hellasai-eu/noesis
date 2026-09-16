/**
 * #624 — exercises the `excludeInteractiveOpen` option on `useUnifiedQuestions`.
 *
 * The hook's primary job is to fan out a Supabase fetch and shape the result;
 * here we only care that:
 *  - `answeringMode` is populated for open rows (and `undefined` otherwise).
 *  - The opt-in filter drops interactive opens (including legacy rows whose
 *    payload defaults to `interactive`).
 *  - Without the option, the hook returns everything unchanged (so future
 *    callers like Practice & Review stay unaffected).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

type Result = { data: unknown; error: unknown };

const responses: Record<string, Result> = {
  questions: { data: [], error: null },
  question_votes: { data: [], error: null },
  question_competencies: { data: [], error: null },
  question_chapters: { data: [], error: null },
  profiles: { data: [], error: null },
};

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/integrations/supabase/client", () => {
  const buildChain = (table: string) => {
    const chain: Record<string, (...a: unknown[]) => unknown> = {};
    const passThrough = () => chain;
    chain.select = passThrough;
    chain.eq = passThrough;
    chain.in = passThrough;
    chain.order = passThrough;
    chain.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(resolve(responses[table] || { data: [], error: null }));
    return chain;
  };
  return {
    supabase: { from: vi.fn((table: string) => buildChain(table)) },
  };
});

import { useUnifiedQuestions } from "@/hooks/useUnifiedQuestions";

const baseRow = {
  course_id: "course-1",
  answer_key: { model_answer: "ans" },
  explanation: "",
  difficulty: "medium",
  upvotes: 0,
  downvotes: 0,
  hidden: false,
  created_at: "2026-05-01T00:00:00Z",
  created_by: null,
  generation_rationale: null,
};

beforeEach(() => {
  for (const key of Object.keys(responses)) {
    responses[key] = { data: [], error: null };
  }
});

describe("useUnifiedQuestions (#624)", () => {
  it("populates answeringMode on open rows and leaves it undefined on others", async () => {
    responses.questions = {
      data: [
        {
          ...baseRow,
          id: "q-single",
          type: "open",
          question: "Single Q",
          payload: { answering_mode: "single" },
        },
        {
          ...baseRow,
          id: "q-mcq",
          type: "mcq",
          question: "MCQ Q",
          payload: { options: ["a", "b"] },
          answer_key: { correct_indices: [0] },
        },
      ],
      error: null,
    };

    const { result } = renderHook(() => useUnifiedQuestions("course-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const byId = Object.fromEntries(result.current.questions.map((q) => [q.id, q]));
    expect(byId["q-single"].answeringMode).toBe("single");
    expect(byId["q-mcq"].answeringMode).toBeUndefined();
  });

  it("by default returns interactive open questions (option off)", async () => {
    responses.questions = {
      data: [
        {
          ...baseRow,
          id: "q-interactive",
          type: "open",
          question: "Interactive Q",
          payload: { answering_mode: "interactive" },
        },
        {
          ...baseRow,
          id: "q-legacy",
          type: "open",
          question: "Legacy Q",
          payload: {},
        },
      ],
      error: null,
    };

    const { result } = renderHook(() => useUnifiedQuestions("course-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.questions.map((q) => q.id).sort()).toEqual([
      "q-interactive",
      "q-legacy",
    ]);
  });

  it("with excludeInteractiveOpen, drops interactive opens (incl. legacy/empty payload)", async () => {
    responses.questions = {
      data: [
        {
          ...baseRow,
          id: "q-single",
          type: "open",
          question: "Single Q",
          payload: { answering_mode: "single" },
        },
        {
          ...baseRow,
          id: "q-interactive",
          type: "open",
          question: "Interactive Q",
          payload: { answering_mode: "interactive" },
        },
        {
          ...baseRow,
          id: "q-legacy",
          type: "open",
          question: "Legacy Q",
          payload: {},
        },
        {
          ...baseRow,
          id: "q-mcq",
          type: "mcq",
          question: "MCQ Q",
          payload: { options: ["a", "b"] },
          answer_key: { correct_indices: [0] },
        },
      ],
      error: null,
    };

    const { result } = renderHook(() =>
      useUnifiedQuestions("course-1", { excludeInteractiveOpen: true }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    const ids = result.current.questions.map((q) => q.id).sort();
    expect(ids).toEqual(["q-mcq", "q-single"]);
    // Non-open types are unaffected by the filter.
    expect(
      result.current.questions.find((q) => q.id === "q-mcq")?.answeringMode,
    ).toBeUndefined();
  });
});
