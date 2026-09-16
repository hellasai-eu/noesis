/**
 * #621 — UnifiedQuestionsTable tests.
 *
 * Covers the surface the new component owns:
 *  - Renders rows for every question type passed in.
 *  - The type badge column reflects the row's `type`.
 *  - Expanded row dispatches to the per-type panel (we assert a
 *    type-specific cue — e.g. MCQ shows option letters, Fill the Gaps
 *    shows the ‗‗‗(N) marker, Ordering shows the canonical sequence).
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UnifiedQuestion } from "@/lib/unified-question";

const mockSupabaseFrom = vi.hoisted(() => vi.fn());

const mockGetSession = vi.hoisted(() =>
  vi.fn(async () => ({ data: { session: { access_token: "tok" } } })),
);

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: mockSupabaseFrom, auth: { getSession: mockGetSession } },
}));

vi.mock("@/lib/latex-utils", () => ({
  processLatexContent: (text: string) => text ?? "",
  formatQuestionText: (text: string) => text ?? "",
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.stubEnv("VITE_SUPABASE_URL", "https://test.supabase.co");
vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "anon-test");

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { UnifiedQuestionsTable } from "@/components/UnifiedQuestionsTable";
import { toast } from "sonner";

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    (globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
      ResizeObserverStub;
  }
});

beforeEach(() => {
  mockSupabaseFrom.mockReset();
  fetchMock.mockReset();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.warning).mockClear();
  vi.mocked(toast.error).mockClear();
});

const mkBase = (over: Partial<UnifiedQuestion>): UnifiedQuestion => ({
  id: over.id ?? "q",
  type: over.type ?? "mcq",
  preview: over.preview ?? "preview",
  searchText: over.searchText ?? "search",
  difficulty: over.difficulty ?? "medium",
  authorName: over.authorName ?? null,
  createdBy: over.createdBy ?? null,
  createdAt: over.createdAt ?? "2026-01-01T00:00:00Z",
  hidden: over.hidden ?? false,
  upvotes: over.upvotes ?? 0,
  downvotes: over.downvotes ?? 0,
  chapters: over.chapters ?? [],
  competencies: over.competencies ?? [],
  materials: over.materials ?? [],
  generatedForGroup: over.generatedForGroup ?? null,
  raw: over.raw ?? {
    question: null,
    payload: null,
    answer_key: null,
    explanation: null,
    generation_rationale: null,
  },
});

const mcq: UnifiedQuestion = mkBase({
  id: "q-mcq",
  type: "mcq",
  preview: "What is 2+2? — A. 4 / B. 5",
  searchText: "what is 2+2",
  raw: {
    question: "What is 2+2?",
    payload: { options: ["4", "5", "6"] },
    answer_key: { correct_indices: [0] },
    explanation: null,
    generation_rationale: null,
  },
});

const open: UnifiedQuestion = mkBase({
  id: "q-open",
  type: "open",
  preview: "Explain photosynthesis",
  searchText: "explain photosynthesis chloroplasts",
  raw: {
    question: "Explain photosynthesis",
    payload: {},
    answer_key: { model_answer: "Light → chemical energy in chloroplasts." },
    explanation: null,
    generation_rationale: null,
  },
});

const fillGaps: UnifiedQuestion = mkBase({
  id: "q-fill",
  type: "fill_gaps",
  preview: "The capital is ___",
  searchText: "the capital paris",
  raw: {
    question: null,
    payload: { stem: "The capital of France is {{1}}." },
    answer_key: { gaps: [{ ordinal: 1, acceptable: ["Paris"] }] },
    explanation: null,
    generation_rationale: null,
  },
});

const ordering: UnifiedQuestion = mkBase({
  id: "q-ord",
  type: "ordering",
  preview: "Order the planets — Mercury → Venus → Earth",
  searchText: "order planets mercury venus earth mars",
  raw: {
    question: null,
    payload: {
      prompt: "Order the planets from the sun",
      items: ["Mercury", "Venus", "Earth", "Mars"],
    },
    answer_key: {},
    explanation: null,
    generation_rationale: null,
  },
});

const classification: UnifiedQuestion = mkBase({
  id: "q-cls",
  type: "classification",
  preview: "Sort animals — Mammals / Birds",
  searchText: "sort animals mammals birds dog eagle",
  raw: {
    question: null,
    payload: {
      prompt: "Sort each animal",
      categories: [
        { id: "cat-m", label: "Mammals" },
        { id: "cat-b", label: "Birds" },
      ],
      items: [
        { id: "it-1", text: "Dog" },
        { id: "it-2", text: "Eagle" },
      ],
    },
    answer_key: { assignments: { "it-1": "cat-m", "it-2": "cat-b" } },
    explanation: null,
    generation_rationale: null,
  },
});

const allTypes = [mcq, open, fillGaps, ordering, classification];

describe("UnifiedQuestionsTable", () => {
  it("renders a row for every passed question regardless of type", () => {
    render(
      <UnifiedQuestionsTable
        questions={allTypes}
        onQuestionsChange={() => {}}
        isAdmin
      />,
    );
    for (const q of allTypes) {
      expect(screen.getByTestId(`question-row-${q.id}`)).toBeInTheDocument();
    }
  });

  it("renders the correct type badge per row", () => {
    render(
      <UnifiedQuestionsTable
        questions={allTypes}
        onQuestionsChange={() => {}}
        isAdmin
      />,
    );
    expect(screen.getAllByTestId("type-badge-mcq").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByTestId("type-badge-open").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByTestId("type-badge-fill_gaps").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByTestId("type-badge-ordering").length).toBeGreaterThanOrEqual(1);
    expect(
      screen.getAllByTestId("type-badge-classification").length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("expanding an MCQ row shows the option list (A, B, C)", async () => {
    const user = userEvent.setup();
    render(
      <UnifiedQuestionsTable
        questions={[mcq]}
        onQuestionsChange={() => {}}
        isAdmin
      />,
    );
    await user.click(screen.getByTestId("question-row-q-mcq"));
    expect(screen.getByText("A")).toBeInTheDocument();
    expect(screen.getByText("B")).toBeInTheDocument();
    expect(screen.getByText("C")).toBeInTheDocument();
  });

  it("expanding a Fill-the-Gaps row shows the ‗‗‗ marker and acceptable answer", async () => {
    const user = userEvent.setup();
    render(
      <UnifiedQuestionsTable
        questions={[fillGaps]}
        onQuestionsChange={() => {}}
        isAdmin
      />,
    );
    await user.click(screen.getByTestId("question-row-q-fill"));
    // The unique underline char (U+2017) confirms the per-type panel rendered.
    expect(
      screen.getAllByText((_, el) => el?.innerHTML?.includes("‗‗‗(1)") ?? false).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("Paris")).toBeInTheDocument();
  });

  it("expanding an Ordering row shows the canonical sequence", async () => {
    const user = userEvent.setup();
    render(
      <UnifiedQuestionsTable
        questions={[ordering]}
        onQuestionsChange={() => {}}
        isAdmin
      />,
    );
    await user.click(screen.getByTestId("question-row-q-ord"));
    // "Mars" is the only item NOT in the 3-item preview, so its presence
    // confirms the expanded panel rendered the full canonical sequence.
    expect(screen.getByText("Mars")).toBeInTheDocument();
    // And the "Correct order" header is unique to the expanded panel.
    expect(screen.getByText(/Correct order/)).toBeInTheDocument();
  });

  it("expanding a Classification row shows both category labels", async () => {
    const user = userEvent.setup();
    render(
      <UnifiedQuestionsTable
        questions={[classification]}
        onQuestionsChange={() => {}}
        isAdmin
      />,
    );
    await user.click(screen.getByTestId("question-row-q-cls"));
    expect(screen.getByText("Mammals")).toBeInTheDocument();
    expect(screen.getByText("Birds")).toBeInTheDocument();
  });

  it("does NOT render the Created column header (#623)", () => {
    render(
      <UnifiedQuestionsTable
        questions={allTypes}
        onQuestionsChange={() => {}}
        isAdmin
      />,
    );
    expect(
      screen.queryByRole("columnheader", { name: /created/i }),
    ).toBeNull();
  });

  it("does NOT render the Votes column header (#623)", () => {
    render(
      <UnifiedQuestionsTable
        questions={allTypes}
        onQuestionsChange={() => {}}
        isAdmin
      />,
    );
    expect(
      screen.queryByRole("columnheader", { name: /votes/i }),
    ).toBeNull();
  });

  it("expanded row reveals the created date and vote counts (#623)", async () => {
    const user = userEvent.setup();
    const withMeta: UnifiedQuestion = mkBase({
      id: "q-meta",
      type: "mcq",
      preview: "Sample",
      createdAt: "2026-03-15T10:00:00Z",
      upvotes: 3,
      downvotes: 1,
      raw: {
        question: "Sample stem",
        payload: { options: ["A", "B"] },
        answer_key: { correct_indices: [0] },
        explanation: null,
        generation_rationale: null,
      },
    });
    render(
      <UnifiedQuestionsTable
        questions={[withMeta]}
        onQuestionsChange={() => {}}
        isAdmin
      />,
    );
    await user.click(screen.getByTestId("question-row-q-meta"));
    const meta = screen.getByTestId("expanded-meta");
    expect(meta).toBeInTheDocument();
    expect(screen.getByTestId("expanded-meta-created")).toHaveTextContent(
      /Created/i,
    );
    // VoteBadges renders both badges including the raw numeric counts.
    expect(meta).toHaveTextContent("3");
    expect(meta).toHaveTextContent("1");
  });

  it("expanded row shows whole-document sources and the generated-for group", async () => {
    const user = userEvent.setup();
    const withProvenance: UnifiedQuestion = mkBase({
      id: "q-prov",
      type: "mcq",
      preview: "Sample",
      materials: [{ id: "doc-1", title: "Syllabus" }],
      generatedForGroup: { id: "grp-1", name: "Algebra strugglers" },
      raw: {
        question: "Sample stem",
        payload: { options: ["A", "B"] },
        answer_key: { correct_indices: [0] },
        explanation: null,
        generation_rationale: null,
      },
    });
    render(
      <UnifiedQuestionsTable
        questions={[withProvenance]}
        onQuestionsChange={() => {}}
        isAdmin
      />,
    );
    await user.click(screen.getByTestId("question-row-q-prov"));
    expect(screen.getByTestId("expanded-materials")).toHaveTextContent("Syllabus");
    expect(screen.getByTestId("expanded-generated-for")).toHaveTextContent(
      "Algebra strugglers",
    );
  });

  it("expanded row omits the provenance sections when there is none", async () => {
    const user = userEvent.setup();
    render(
      <UnifiedQuestionsTable
        questions={[mcq]}
        onQuestionsChange={() => {}}
        isAdmin
      />,
    );
    await user.click(screen.getByTestId("question-row-q-mcq"));
    expect(screen.queryByTestId("expanded-materials")).toBeNull();
    expect(screen.queryByTestId("expanded-generated-for")).toBeNull();
  });

  it("shows the bulk-actions bar when at least one row is selected", async () => {
    const user = userEvent.setup();
    render(
      <UnifiedQuestionsTable
        questions={allTypes}
        onQuestionsChange={() => {}}
        isAdmin
      />,
    );
    // Click the row's checkbox (stopPropagation prevents expand).
    const checkboxes = screen.getAllByRole("checkbox", { name: "Select question" });
    await user.click(checkboxes[0]);
    expect(screen.getByTestId("bulk-actions-bar")).toBeInTheDocument();
    expect(screen.getByText("1 selected")).toBeInTheDocument();
  });

  it("omits the Create… bulk action when onCreateAssessment is not provided", async () => {
    const user = userEvent.setup();
    render(
      <UnifiedQuestionsTable
        questions={allTypes}
        onQuestionsChange={() => {}}
        isAdmin
      />,
    );
    const checkboxes = screen.getAllByRole("checkbox", { name: "Select question" });
    await user.click(checkboxes[0]);
    expect(screen.getByTestId("bulk-actions-bar")).toBeInTheDocument();
    expect(screen.queryByTestId("bulk-create-assessment-trigger")).toBeNull();
  });

  it("Create… → Quiz passes the selected ids in TABLE order, not click order", async () => {
    const user = userEvent.setup();
    const onCreateAssessment = vi.fn();
    render(
      <UnifiedQuestionsTable
        questions={allTypes}
        onQuestionsChange={() => {}}
        isAdmin
        onCreateAssessment={onCreateAssessment}
      />,
    );
    const checkboxes = screen.getAllByRole("checkbox", { name: "Select question" });
    // Click the third row first, then the first — the handler must still
    // receive them in the on-screen order.
    await user.click(checkboxes[2]);
    await user.click(checkboxes[0]);

    await user.click(screen.getByTestId("bulk-create-assessment-trigger"));
    await user.click(await screen.findByTestId("bulk-create-quiz"));

    expect(onCreateAssessment).toHaveBeenCalledWith("quiz", [
      allTypes[0].id,
      allTypes[2].id,
    ]);
  });

  it("Create… → Test dispatches with kind 'test'", async () => {
    const user = userEvent.setup();
    const onCreateAssessment = vi.fn();
    render(
      <UnifiedQuestionsTable
        questions={allTypes}
        onQuestionsChange={() => {}}
        isAdmin
        onCreateAssessment={onCreateAssessment}
      />,
    );
    const checkboxes = screen.getAllByRole("checkbox", { name: "Select question" });
    await user.click(checkboxes[1]);

    await user.click(screen.getByTestId("bulk-create-assessment-trigger"));
    await user.click(await screen.findByTestId("bulk-create-test"));

    expect(onCreateAssessment).toHaveBeenCalledWith("test", [allTypes[1].id]);
  });
});

/**
 * Revalidate action (#1069). Questions are validated once at generation time
 * and never again, so an edited question keeps the verdict its original
 * content earned. This is the only way to re-run it from the live bank.
 */
describe("UnifiedQuestionsTable — Revalidate action (#1069)", () => {
  const one = [mkBase({ id: "q1", type: "mcq", preview: "Two plus two" })];

  async function openRowMenu() {
    const user = userEvent.setup();
    render(
      <UnifiedQuestionsTable questions={one} onQuestionsChange={() => {}} isAdmin />,
    );
    await user.click(screen.getByRole("button", { name: "Question actions" }));
    return user;
  }

  it("offers Revalidate in the row actions menu", async () => {
    await openRowMenu();
    expect(await screen.findByTestId("revalidate-q1")).toHaveTextContent("Revalidate");
  });

  it("is not offered to non-admins, who have no actions menu at all", () => {
    render(
      <UnifiedQuestionsTable questions={one} onQuestionsChange={() => {}} isAdmin={false} />,
    );
    expect(screen.queryByRole("button", { name: "Question actions" })).not.toBeInTheDocument();
  });

  it.each(["open", "fill_gaps", "ordering", "classification"] as const)(
    "is not offered on a %s row — validate-questions serves MCQ only",
    async (type) => {
      // Offering it would guarantee a 422: the validator judges a marked answer
      // against the stem, which needs options and a correct index.
      const user = userEvent.setup();
      render(
        <UnifiedQuestionsTable
          questions={[mkBase({ id: "qx", type })]}
          onQuestionsChange={() => {}}
          isAdmin
        />,
      );
      await user.click(screen.getByRole("button", { name: "Question actions" }));

      // The menu itself opened — the other actions are still there.
      expect(await screen.findByText("Delete")).toBeInTheDocument();
      expect(screen.queryByTestId("revalidate-qx")).not.toBeInTheDocument();
    },
  );

  it("posts the question id to validate-questions with the caller's token", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [{ questionId: "q1", verdict: "CORRECT", confidence: 0.92, passed: true }],
      }),
    });

    const user = await openRowMenu();
    await user.click(await screen.findByTestId("revalidate-q1"));

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/functions/v1/validate-questions");
    expect(JSON.parse(init.body)).toEqual({ questionIds: ["q1"] });
    expect(init.headers.Authorization).toBe("Bearer tok");
  });

  it("reports the verdict, not a bare success — it is the whole point of the action", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [{ questionId: "q1", verdict: "CORRECT", confidence: 0.92, passed: true }],
      }),
    });

    const user = await openRowMenu();
    await user.click(await screen.findByTestId("revalidate-q1"));

    await vi.waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Revalidated: CORRECT — 92% confident"),
    );
  });

  it("warns rather than celebrates when the verdict does not pass", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          {
            questionId: "q1",
            verdict: "INCORRECT",
            confidence: 0.81,
            passed: false,
            message: "The marked answer does not follow from the stem.",
          },
        ],
      }),
    });

    const user = await openRowMenu();
    await user.click(await screen.findByTestId("revalidate-q1"));

    await vi.waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith("Revalidated: INCORRECT — 81% confident", {
        description: "The marked answer does not follow from the stem.",
      }),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("surfaces the function's own error message on failure", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: "OpenAI timed out" }),
    });

    const user = await openRowMenu();
    await user.click(await screen.findByTestId("revalidate-q1"));

    await vi.waitFor(() => expect(toast.error).toHaveBeenCalledWith("OpenAI timed out"));
  });

  it("keeps the item disabled while the request is in flight", async () => {
    let release!: (v: unknown) => void;
    fetchMock.mockReturnValue(new Promise((res) => { release = res; }));

    const user = await openRowMenu();
    const item = await screen.findByTestId("revalidate-q1");
    await user.click(item);

    // Menu stays open (onSelect preventDefault) so the pending state is visible
    // rather than unmounting mid-request.
    await vi.waitFor(() =>
      expect(screen.getByTestId("revalidate-q1")).toHaveTextContent("Revalidating…"),
    );
    expect(screen.getByTestId("revalidate-q1")).toHaveAttribute("aria-disabled", "true");

    release({ ok: true, json: async () => ({ results: [{ verdict: "CORRECT", confidence: 1, passed: true }] }) });
    await vi.waitFor(() =>
      expect(screen.getByTestId("revalidate-q1")).toHaveTextContent("Revalidate"),
    );
  });
});
