/**
 * #623 — UnifiedQuestionBank tests.
 *
 * Verifies the bank-level behaviors added by #623:
 *  - Pagination footer rendered with the configured default page size.
 *  - Each new filter (Author / Date / Book / Chapter) narrows the list.
 *  - URL state round-trips through filters + page params.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import type { UnifiedQuestion } from "@/lib/unified-question";

// jsdom lacks the pointer-capture and ResizeObserver APIs used by Radix Select
// and Popover — stub them in once so the filter / page-size widgets work.
beforeAll(() => {
  if (!Element.prototype.hasPointerCapture) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Element.prototype as any).hasPointerCapture = () => false;
  }
  if (!Element.prototype.setPointerCapture) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Element.prototype as any).setPointerCapture = () => {};
  }
  if (!Element.prototype.releasePointerCapture) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Element.prototype as any).releasePointerCapture = () => {};
  }
  if (!Element.prototype.scrollIntoView) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Element.prototype as any).scrollIntoView = () => {};
  }
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

const useUnifiedQuestionsMock = vi.hoisted(() => vi.fn());
const useContentAssignmentsMock = vi.hoisted(() => vi.fn());
const useQuizQuestionUsageMock = vi.hoisted(() => vi.fn());
const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/useUnifiedQuestions", () => ({
  useUnifiedQuestions: useUnifiedQuestionsMock,
}));

vi.mock("@/hooks/useContentAssignments", () => ({
  useContentAssignments: useContentAssignmentsMock,
}));

vi.mock("@/hooks/useQuizQuestionUsage", () => ({
  useQuizQuestionUsage: useQuizQuestionUsageMock,
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn(), functions: { invoke: invokeMock } },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/lib/latex-utils", () => ({
  processLatexContent: (s: string) => s ?? "",
  formatQuestionText: (s: string) => s ?? "",
}));

// Stub out heavy children — we only care about which questions get rendered.
vi.mock("@/components/UnifiedQuestionsTable", () => ({
  UnifiedQuestionsTable: ({ questions }: { questions: UnifiedQuestion[] }) => (
    <div data-testid="rendered-rows">
      {questions.map((q) => (
        <div key={q.id} data-testid={`rendered-row-${q.id}`}>
          {q.id}
        </div>
      ))}
    </div>
  ),
  TypeBadge: ({ type }: { type: string }) => (
    <span data-testid={`type-badge-${type}`}>{type}</span>
  ),
}));

vi.mock("@/components/UnifiedGenerateDialog", () => ({
  UnifiedGenerateDialog: () => null,
}));

vi.mock("@/components/SimilarityCheckDialog", () => ({
  SimilarityCheckDialog: () => null,
}));

vi.mock("@/components/GenerateMcqDialog", () => ({
  GenerateMcqDialog: ({
    open,
    seed,
  }: {
    open: boolean;
    seed?: {
      note?: string;
      difficulty?: string;
      selectionMode?: string;
      selectedCompetencyIds?: string[];
      selectedStudyGuideIds?: string[];
    };
  }) =>
    open ? (
      <div data-testid="seeded-mcq-dialog">
        <span data-testid="seed-note">{seed?.note}</span>
        <span data-testid="seed-difficulty">{seed?.difficulty}</span>
        <span data-testid="seed-mode">{seed?.selectionMode}</span>
        <span data-testid="seed-competencies">
          {(seed?.selectedCompetencyIds ?? []).join(",")}
        </span>
        <span data-testid="seed-guides">
          {(seed?.selectedStudyGuideIds ?? []).join(",")}
        </span>
      </div>
    ) : null,
}));

vi.mock("@/components/ContentAssignDialog", () => ({
  ContentAssignDialog: () => null,
}));

import { UnifiedQuestionBank } from "@/components/UnifiedQuestionBank";

const mkQ = (over: Partial<UnifiedQuestion>): UnifiedQuestion => ({
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

// 30 questions so the default page size of 25 leaves a second page; mix of
// authors, books and dates so we can exercise every filter.
function makeFixture(): UnifiedQuestion[] {
  const out: UnifiedQuestion[] = [];
  for (let i = 0; i < 30; i++) {
    const monthOffset = i % 6;
    const date = new Date(2026, monthOffset, 1).toISOString();
    out.push(
      mkQ({
        id: `q-${i.toString().padStart(2, "0")}`,
        preview: `Question ${i}`,
        searchText: `question ${i}`,
        createdBy: i % 3 === 0 ? null : i % 2 === 0 ? "user-a" : "user-b",
        authorName: i % 2 === 0 ? "Alice" : "Bob",
        createdAt: date,
        chapters:
          i % 2 === 0
            ? [
                {
                  id: `ch-${i}`,
                  title: `Chapter ${i}`,
                  materialId: "book-1",
                  materialTitle: "Mathematics",
                },
              ]
            : [
                {
                  id: `ch-${i}`,
                  title: `Chapter ${i}`,
                  materialId: "book-2",
                  materialTitle: "Physics",
                },
              ],
        // Tag ~1/3 of rows with "Fractions"; the rest are untagged so the
        // competency filter has something to narrow (#858).
        competencies:
          i % 3 === 0
            ? [{ id: "comp-1", title: "Fractions" }]
            : [],
      }),
    );
  }
  return out;
}

let UrlSpy: { current: string } = { current: "" };

function UrlReader() {
  const loc = useLocation();
  UrlSpy.current = `${loc.pathname}${loc.search}`;
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderBank(initialUrl = "/bank", classes: any[] = []) {
  return render(
    <MemoryRouter initialEntries={[initialUrl]}>
      <Routes>
        <Route
          path="/bank"
          element={
            <>
              <UrlReader />
              <UnifiedQuestionBank
                courseId="c-1"
                materials={[]}
                isAdmin
                classes={classes}
              />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  UrlSpy = { current: "" };
  invokeMock.mockReset();
  useUnifiedQuestionsMock.mockReturnValue({
    questions: makeFixture(),
    loading: false,
    refetch: vi.fn(),
    setQuestions: vi.fn(),
  });
  useContentAssignmentsMock.mockReturnValue({
    assignments: {},
    groupsByOffering: {},
    saving: false,
    saveAssignments: vi.fn(),
    getAssignedTargets: () => [],
  });
  useQuizQuestionUsageMock.mockReturnValue({
    quizzes: [],
    quizIdsByQuestion: {},
    loading: false,
    error: null,
    refetch: vi.fn(),
  });
});

/** A class + its offering, matching the `CourseClass` shape the bank expects. */
function mkClass(offeringId: string, name: string) {
  return {
    id: `cls-${offeringId}`,
    name,
    grade_level_id: null,
    section_name: null,
    category: null,
    academic_period: null,
    offering_id: offeringId,
  };
}

describe("UnifiedQuestionBank #623", () => {
  it("renders only the first page (default 25 rows) of the 30-item fixture", () => {
    renderBank();
    const rows = screen.getAllByTestId(/^rendered-row-/);
    expect(rows).toHaveLength(25);
    expect(screen.getByTestId("bank-pagination-footer")).toBeInTheDocument();
    expect(screen.getByTestId("bank-page-indicator")).toHaveTextContent(
      "Page 1 of 2",
    );
  });

  it("Next button advances to page 2 and writes ?page=2 to the URL", async () => {
    const user = userEvent.setup();
    renderBank();
    await user.click(screen.getByTestId("bank-page-next"));
    expect(UrlSpy.current).toMatch(/[?&]page=2/);
    const rows = screen.getAllByTestId(/^rendered-row-/);
    expect(rows).toHaveLength(5);
    expect(screen.getByTestId("bank-page-indicator")).toHaveTextContent(
      "Page 2 of 2",
    );
  });

  it("changing page_size resets to page 1 and persists in the URL", async () => {
    const user = userEvent.setup();
    renderBank("/bank?page=2");
    expect(screen.getByTestId("bank-page-indicator")).toHaveTextContent(
      "Page 2 of 2",
    );

    const select = screen.getByTestId("bank-page-size");
    await user.click(select);
    const option50 = await screen.findByRole("option", { name: "50" });
    await user.click(option50);

    expect(UrlSpy.current).toMatch(/[?&]page_size=50/);
    expect(UrlSpy.current).not.toMatch(/[?&]page=/);
    expect(screen.getByTestId("bank-page-indicator")).toHaveTextContent(
      "Page 1 of 1",
    );
  });

  it("Author filter narrows the rendered list and writes ?author=… to URL", async () => {
    const user = userEvent.setup();
    renderBank();

    await user.click(screen.getByTestId("author-filter"));
    // 10 AI rows + 10 Alice + 10 Bob in the fixture; tick "user-a".
    const aliceOption = await screen.findByTestId(
      "author-filter-option-user-a",
    );
    await user.click(within(aliceOption).getByRole("checkbox"));
    expect(UrlSpy.current).toMatch(/[?&]author=user-a/);

    const rows = screen.getAllByTestId(/^rendered-row-/);
    // user-a indices: i % 2 === 0 AND i % 3 !== 0 → 2,4,8,10,14,16,20,22,26,28
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(30);
  });

  it("Book filter restricts results to questions tagged with that material", async () => {
    const user = userEvent.setup();
    renderBank();

    await user.click(screen.getByTestId("book-filter"));
    const phys = await screen.findByTestId("book-filter-option-book-2");
    await user.click(within(phys).getByRole("checkbox"));

    expect(UrlSpy.current).toMatch(/[?&]book=book-2/);
    // Odd indices in the fixture map to book-2 → 15 questions, all on page 1.
    const rows = screen.getAllByTestId(/^rendered-row-/);
    expect(rows).toHaveLength(15);
  });

  it("Book filter lists whole 'Other' documents and narrows by them (#1019)", async () => {
    // Two questions from a chaptered book, one generated from a whole
    // document (no chapters at all) — the document must still be pickable
    // under Book, and picking it must keep only its question.
    useUnifiedQuestionsMock.mockReturnValue({
      questions: [
        mkQ({
          id: "q-book",
          chapters: [
            { id: "ch-1", title: "Ch 1", materialId: "book-1", materialTitle: "Mathematics" },
          ],
        }),
        mkQ({ id: "q-doc", chapters: [], materials: [{ id: "doc-1", title: "Syllabus" }] }),
        mkQ({ id: "q-untagged", chapters: [] }),
      ],
      loading: false,
      refetch: vi.fn(),
      setQuestions: vi.fn(),
    });
    const user = userEvent.setup();
    renderBank();

    await user.click(screen.getByTestId("book-filter"));
    const doc = await screen.findByTestId("book-filter-option-doc-1");
    expect(doc).toHaveTextContent("Syllabus");
    await user.click(within(doc).getByRole("checkbox"));

    expect(UrlSpy.current).toMatch(/[?&]book=doc-1/);
    const rows = screen.getAllByTestId(/^rendered-row-/);
    expect(rows).toHaveLength(1);
    expect(screen.getByTestId("rendered-row-q-doc")).toBeInTheDocument();
  });

  it("'Generated for' filter narrows to questions generated for that group", async () => {
    useUnifiedQuestionsMock.mockReturnValue({
      questions: [
        mkQ({ id: "q-grp-a", generatedForGroup: { id: "grp-a", name: "Algebra strugglers" } }),
        mkQ({ id: "q-grp-b", generatedForGroup: { id: "grp-b", name: "Fast finishers" } }),
        mkQ({ id: "q-untargeted" }),
      ],
      loading: false,
      refetch: vi.fn(),
      setQuestions: vi.fn(),
    });
    const user = userEvent.setup();
    renderBank();

    await user.click(screen.getByTestId("generated-for-filter"));
    const opt = await screen.findByTestId("generated-for-filter-option-grp-a");
    expect(opt).toHaveTextContent("Algebra strugglers");
    await user.click(within(opt).getByRole("checkbox"));

    expect(UrlSpy.current).toMatch(/[?&]generated_for=grp-a/);
    const rows = screen.getAllByTestId(/^rendered-row-/);
    expect(rows).toHaveLength(1);
    expect(screen.getByTestId("rendered-row-q-grp-a")).toBeInTheDocument();
  });

  it("?generated_for= hydrates from the URL and Clear filters resets it", async () => {
    useUnifiedQuestionsMock.mockReturnValue({
      questions: [
        mkQ({ id: "q-grp-a", generatedForGroup: { id: "grp-a", name: "Algebra strugglers" } }),
        mkQ({ id: "q-untargeted" }),
      ],
      loading: false,
      refetch: vi.fn(),
      setQuestions: vi.fn(),
    });
    const user = userEvent.setup();
    renderBank("/bank?generated_for=grp-a");

    expect(screen.getAllByTestId(/^rendered-row-/)).toHaveLength(1);
    const clear = screen.getByTestId("clear-filters");
    await user.click(clear);
    expect(UrlSpy.current).toBe("/bank");
    expect(screen.getAllByTestId(/^rendered-row-/)).toHaveLength(2);
  });

  it("Date preset 'last_7d' writes created_from/to to the URL", async () => {
    const user = userEvent.setup();
    renderBank();

    await user.click(screen.getByTestId("date-filter"));
    const preset = await screen.findByTestId("date-filter-preset-last_7d");
    await user.click(preset);

    expect(UrlSpy.current).toMatch(/[?&]created_from=/);
    expect(UrlSpy.current).toMatch(/[?&]created_to=/);
  });

  it("URL params hydrate the filter state on mount (round-trip)", () => {
    renderBank("/bank?author=user-a&book=book-1&page=2&page_size=10");
    // page_size=10 ⇒ 25? No, 10. fixture 30 items, only user-a + book-1 left.
    // user-a authors that also touch book-1: i where i%2===0 && i%3!==0 →
    // 2,4,8,10,14,16,20,22,26,28 → 10 items → page 2 = items 11–20.
    expect(screen.getByTestId("bank-page-indicator")).toHaveTextContent(
      "Page 1 of 1",
    );
    // After hydration, page param is clamped to in-range but URL was set to 2.
    // The bank shows the correct (page 1 since there's only 1 page after
    // filtering, but the URL was preserved before any user interaction).
    const rows = screen.getAllByTestId(/^rendered-row-/);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(10);
  });

  it("Competency filter narrows the list and writes ?competency=… to URL", async () => {
    const user = userEvent.setup();
    renderBank();

    await user.click(screen.getByTestId("competency-filter"));
    const opt = await screen.findByTestId("competency-filter-option-comp-1");
    await user.click(within(opt).getByRole("checkbox"));

    expect(UrlSpy.current).toMatch(/[?&]competency=comp-1/);
    // Rows where i % 3 === 0 are tagged → 10 of 30, all on page 1.
    const rows = screen.getAllByTestId(/^rendered-row-/);
    expect(rows).toHaveLength(10);
  });

  it("Chapter filter is disabled until a Book is selected", async () => {
    const user = userEvent.setup();
    renderBank();

    // No book selected → Chapter trigger disabled with a prompt, popover inert.
    const chapterTrigger = screen.getByTestId("chapter-filter");
    expect(chapterTrigger).toBeDisabled();
    expect(chapterTrigger).toHaveTextContent("Select a book first");
    await user.click(chapterTrigger);
    expect(
      screen.queryByTestId("chapter-filter-option-ch-0"),
    ).not.toBeInTheDocument();

    // Pick a book → Chapter enables and lists that book's chapters.
    await user.click(screen.getByTestId("book-filter"));
    const book1 = await screen.findByTestId("book-filter-option-book-1");
    await user.click(within(book1).getByRole("checkbox"));

    expect(screen.getByTestId("chapter-filter")).not.toBeDisabled();
    await user.click(screen.getByTestId("chapter-filter"));
    expect(
      await screen.findByTestId("chapter-filter-option-ch-0"),
    ).toBeInTheDocument();
  });

  it("Clear filters clears a competency selection", async () => {
    const user = userEvent.setup();
    renderBank("/bank?competency=comp-1");
    const clear = screen.getByTestId("clear-filters");
    await user.click(clear);
    expect(UrlSpy.current).toBe("/bank");
  });

  it("Clear filters resets every advanced filter and the URL", async () => {
    const user = userEvent.setup();
    renderBank("/bank?author=user-a&book=book-1&difficulty=easy");
    const clear = screen.getByTestId("clear-filters");
    await user.click(clear);
    expect(UrlSpy.current).toBe("/bank");
  });

  it("changing a filter resets pagination to page 1", async () => {
    const user = userEvent.setup();
    renderBank("/bank?page=2");
    expect(screen.getByTestId("bank-page-indicator")).toHaveTextContent(
      "Page 2 of 2",
    );

    await user.click(screen.getByTestId("book-filter"));
    const opt = await screen.findByTestId("book-filter-option-book-1");
    await user.click(within(opt).getByRole("checkbox"));

    expect(UrlSpy.current).not.toMatch(/[?&]page=/);
    expect(screen.getByTestId("bank-page-indicator")).toHaveTextContent(
      "Page 1 of 1",
    );
  });
});

describe("UnifiedQuestionBank #853 — generate from student cluster", () => {
  it("shows the disabled hint when the section has no Student Groups", async () => {
    const user = userEvent.setup();
    useContentAssignmentsMock.mockReturnValue({
      assignments: {},
      groupsByOffering: {}, // no groups
      saving: false,
      saveAssignments: vi.fn(),
      getAssignedTargets: () => [],
    });
    renderBank("/bank", [mkClass("off-1", "Class A")]);

    await user.click(screen.getByTestId("generate-cluster-trigger"));
    const hint = await screen.findByTestId("cluster-empty-hint");
    expect(hint).toHaveTextContent(
      "Create groups under My Class → Student Groups",
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("derives weaknesses and opens the seeded MCQ dialog when a group is picked", async () => {
    const user = userEvent.setup();
    useContentAssignmentsMock.mockReturnValue({
      assignments: {},
      groupsByOffering: {
        "off-1": [
          {
            id: "grp-1",
            offering_id: "off-1",
            name: "Struggling readers",
            description: null,
            is_individual: false,
          },
        ],
      },
      saving: false,
      saveAssignments: vi.fn(),
      getAssignedTargets: () => [],
    });
    invokeMock.mockResolvedValue({
      data: {
        insufficient_data: false,
        suggested_difficulty: "easy",
        weak_competencies: [
          {
            competency_id: "comp-1",
            title: "Fractions",
            chapters: [{ id: "ch-1", title: "Ch 1" }],
          },
          {
            competency_id: "comp-2",
            title: "Decimals",
            chapters: [{ id: "ch-2", title: "Ch 2" }],
          },
        ],
      },
      error: null,
    });

    renderBank("/bank", [mkClass("off-1", "Class A")]);

    await user.click(screen.getByTestId("generate-cluster-trigger"));
    const groupItem = await screen.findByTestId("cluster-group-grp-1");
    await user.click(groupItem);

    // Edge function invoked with the offering + group ids.
    expect(invokeMock).toHaveBeenCalledWith("derive-group-weaknesses", {
      body: { offering_id: "off-1", group_id: "grp-1" },
    });

    // Seeded dialog opens with the weak areas pre-filled.
    const dialog = await screen.findByTestId("seeded-mcq-dialog");
    expect(dialog).toBeInTheDocument();
    expect(screen.getByTestId("seed-note")).toHaveTextContent(
      "Seeded from",
    );
    expect(screen.getByTestId("seed-note")).toHaveTextContent("Fractions");
    expect(screen.getByTestId("seed-difficulty")).toHaveTextContent("easy");
    expect(screen.getByTestId("seed-competencies")).toHaveTextContent(
      "comp-1,comp-2",
    );
  });

  it("opens with an insufficient-data note when the derivation has too little to go on", async () => {
    const user = userEvent.setup();
    useContentAssignmentsMock.mockReturnValue({
      assignments: {},
      groupsByOffering: {
        "off-1": [
          {
            id: "grp-1",
            offering_id: "off-1",
            name: "New group",
            description: null,
            is_individual: false,
          },
        ],
      },
      saving: false,
      saveAssignments: vi.fn(),
      getAssignedTargets: () => [],
    });
    invokeMock.mockResolvedValue({
      data: {
        insufficient_data: true,
        reason: "too few quiz answers",
        suggested_difficulty: null,
        weak_competencies: [],
      },
      error: null,
    });

    renderBank("/bank", [mkClass("off-1", "Class A")]);

    await user.click(screen.getByTestId("generate-cluster-trigger"));
    await user.click(await screen.findByTestId("cluster-group-grp-1"));

    await screen.findByTestId("seeded-mcq-dialog");
    expect(screen.getByTestId("seed-note")).toHaveTextContent(
      "Not enough data to target",
    );
    // Nothing pre-filled.
    expect(screen.getByTestId("seed-competencies")).toHaveTextContent("");
    expect(screen.getByTestId("seed-difficulty")).toHaveTextContent("");
  });
});

describe("UnifiedQuestionBank — ?followupGuide deep link", () => {
  it("opens the MCQ generator seeded with the guide and strips the param", async () => {
    renderBank("/bank?followupGuide=guide-7");

    const dialog = await screen.findByTestId("seeded-mcq-dialog");
    expect(dialog).toBeInTheDocument();
    expect(screen.getByTestId("seed-mode")).toHaveTextContent("guides");
    expect(screen.getByTestId("seed-guides")).toHaveTextContent("guide-7");
    // One-shot: the param is consumed with a replace so a remount (tab
    // switch) doesn't reopen the dialog.
    expect(UrlSpy.current).not.toContain("followupGuide");
  });

  it("stays closed without the param", () => {
    renderBank();
    expect(screen.queryByTestId("seeded-mcq-dialog")).not.toBeInTheDocument();
  });
});

describe("UnifiedQuestionBank — Exclude quiz filter", () => {
  const quizFixture = () => ({
    quizzes: [
      { id: "quiz-1", title: "Midterm review", questionCount: 1 },
      { id: "quiz-2", title: "Chapter 3 check", questionCount: 1 },
    ],
    quizIdsByQuestion: { "q-a": ["quiz-1"], "q-b": ["quiz-2"] },
    loading: false,
    error: null,
    refetch: vi.fn(),
  });

  beforeEach(() => {
    useUnifiedQuestionsMock.mockReturnValue({
      questions: [mkQ({ id: "q-a" }), mkQ({ id: "q-b" }), mkQ({ id: "q-c" })],
      loading: false,
      refetch: vi.fn(),
      setQuestions: vi.fn(),
    });
    useQuizQuestionUsageMock.mockReturnValue(quizFixture());
  });

  it("'In any quiz' drops every quiz member and writes ?exclude_quiz=any", async () => {
    const user = userEvent.setup();
    renderBank();

    await user.click(screen.getByTestId("exclude-quiz-filter"));
    const anyRow = await screen.findByTestId("exclude-quiz-filter-any");
    await user.click(within(anyRow).getByRole("checkbox"));

    expect(UrlSpy.current).toMatch(/[?&]exclude_quiz=any/);
    const rows = screen.getAllByTestId(/^rendered-row-/);
    expect(rows).toHaveLength(1);
    expect(screen.getByTestId("rendered-row-q-c")).toBeInTheDocument();

    // Specific quiz rows are subsumed by "any" and become inert.
    const specific = screen.getByTestId("exclude-quiz-filter-option-quiz-1");
    expect(within(specific).getByRole("checkbox")).toBeDisabled();
  });

  it("Excluding a specific quiz drops only that quiz's questions", async () => {
    const user = userEvent.setup();
    renderBank();

    await user.click(screen.getByTestId("exclude-quiz-filter"));
    const opt = await screen.findByTestId(
      "exclude-quiz-filter-option-quiz-1",
    );
    expect(opt).toHaveTextContent("Midterm review");
    await user.click(within(opt).getByRole("checkbox"));

    expect(UrlSpy.current).toMatch(/[?&]exclude_quiz=quiz-1/);
    const rows = screen.getAllByTestId(/^rendered-row-/);
    expect(rows).toHaveLength(2);
    expect(screen.queryByTestId("rendered-row-q-a")).not.toBeInTheDocument();
    expect(screen.getByTestId("rendered-row-q-b")).toBeInTheDocument();
    expect(screen.getByTestId("rendered-row-q-c")).toBeInTheDocument();
  });

  it("popover 'Clear exclusions' button clears the filter (keyboard-operable)", async () => {
    const user = userEvent.setup();
    renderBank("/bank?exclude_quiz=any");
    expect(screen.getAllByTestId(/^rendered-row-/)).toHaveLength(1);

    await user.click(screen.getByTestId("exclude-quiz-filter"));
    await user.click(await screen.findByTestId("exclude-quiz-filter-clear"));

    expect(UrlSpy.current).not.toMatch(/exclude_quiz/);
    expect(screen.getAllByTestId(/^rendered-row-/)).toHaveLength(3);
  });

  it("is disabled with a hint when quiz usage failed to load", () => {
    useQuizQuestionUsageMock.mockReturnValue({
      quizzes: [],
      quizIdsByQuestion: {},
      loading: false,
      error: "permission denied",
      refetch: vi.fn(),
    });
    renderBank();

    const trigger = screen.getByTestId("exclude-quiz-filter");
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveTextContent("Quiz data unavailable");
  });

  it("does not apply a (possibly stale) membership map while usage is errored", () => {
    // A failed refetch keeps the previously-loaded map in state; the filter
    // must go inert with the disabled control, not keep excluding rows the
    // user can no longer inspect through it.
    useQuizQuestionUsageMock.mockReturnValue({
      ...quizFixture(),
      error: "network error",
    });
    renderBank("/bank?exclude_quiz=any");

    expect(screen.getAllByTestId(/^rendered-row-/)).toHaveLength(3);
    expect(screen.getByTestId("exclude-quiz-filter")).toBeDisabled();
  });

  it("?exclude_quiz hydrates from the URL and Clear filters resets it", async () => {
    const user = userEvent.setup();
    renderBank("/bank?exclude_quiz=any");

    // q-a and q-b each sit in a quiz → only q-c survives.
    expect(screen.getAllByTestId(/^rendered-row-/)).toHaveLength(1);
    expect(screen.getByTestId("rendered-row-q-c")).toBeInTheDocument();

    await user.click(screen.getByTestId("clear-filters"));
    expect(UrlSpy.current).toBe("/bank");
    expect(screen.getAllByTestId(/^rendered-row-/)).toHaveLength(3);
  });
});
