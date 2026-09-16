/**
 * #873 — GenerateMcqDialog: seed/pre-fill behaviour and the generation submit
 * payload. Prioritised because #853 will extend the seed (chapters/difficulty).
 *
 * Generation POSTs to the `generate-questions` edge function via `fetch`, then
 * inserts the returned rows into `questions`. We mock `fetch`, the supabase
 * `from(...)` chain, and `auth.getSession`.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

type Result = { data: unknown; error: unknown };

const chapterResponse = vi.hoisted(() => ({ current: { data: [], error: null } as Result }));
const competencyResponse = vi.hoisted(() => ({ current: { data: [], error: null } as Result }));
// The chapterless "Other" materials offered as whole documents (#1019).
const wholeDocResponse = vi.hoisted(() => ({ current: { data: [], error: null } as Result }));
const questionInsertResponse = vi.hoisted(() => ({ current: { data: [], error: null } as Result }));
// Completed study guides offered as sources.
const studyGuideResponse = vi.hoisted(() => ({ current: { data: [], error: null } as Result }));
const studyGuidePieceResponse = vi.hoisted(() => ({ current: { data: [], error: null } as Result }));
const studyGuidePieceQuestionResponse = vi.hoisted(() => ({ current: { data: [], error: null } as Result }));

const getSessionMock = vi.hoisted(() => vi.fn());

vi.mock("@/integrations/supabase/client", () => {
  const buildChain = (table: string) => {
    const chain: Record<string, (...a: unknown[]) => unknown> = {};
    const passThrough = () => chain;
    chain.select = () => {
      // questions.insert(...).select() resolves the inserted rows.
      if (table === "questions") {
        return Promise.resolve(questionInsertResponse.current);
      }
      return chain;
    };
    chain.insert = passThrough;
    chain.eq = passThrough;
    // The chapter query excludes chapterless "Other" materials; a second
    // query fetches those as whole documents (#1019).
    chain.neq = passThrough;
    chain.not = passThrough;
    // The study-guide fetch filters pieces/links by id lists.
    chain.in = passThrough;
    // Chainable, not terminal: the chapter query orders twice (chapter_number
    // then id, for a stable tiebreak). `chain.then` is what resolves a query
    // when it is finally awaited.
    chain.order = passThrough;
    // Also covers the question_competencies / question_chapters /
    // offering_questions inserts, which are awaited directly.
    chain.then = (resolve: (v: unknown) => unknown) => {
      if (table === "material_chapters") return Promise.resolve(resolve(chapterResponse.current));
      if (table === "course_competencies") return Promise.resolve(resolve(competencyResponse.current));
      if (table === "course_materials") return Promise.resolve(resolve(wholeDocResponse.current));
      if (table === "study_guides") return Promise.resolve(resolve(studyGuideResponse.current));
      if (table === "study_guide_pieces") return Promise.resolve(resolve(studyGuidePieceResponse.current));
      if (table === "study_guide_piece_questions") {
        return Promise.resolve(resolve(studyGuidePieceQuestionResponse.current));
      }
      return Promise.resolve(resolve({ data: null, error: null }));
    };
    return chain;
  };

  return {
    supabase: {
      from: vi.fn((t: string) => buildChain(t)),
      auth: { getSession: getSessionMock },
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

// The dialog only renders the audience selector when `classes.length > 0`, and
// this test never passes classes, so the selector never mounts. Stub it anyway
// to keep the unit isolated from its own supabase fetches.
vi.mock("@/components/TargetAudienceSelector", () => ({
  TargetAudienceSelector: () => null,
}));

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
});

import { GenerateMcqDialog, type GenerateMcqSeed } from "@/components/GenerateMcqDialog";

let lastFetchBody: Record<string, unknown> | null = null;
let nextFetchResponse: { ok: boolean; body: unknown };
const originalFetch = global.fetch;

const competencies = [
  { id: "comp-1", title: "Photosynthesis", chapter_id: null },
  { id: "comp-2", title: "Respiration", chapter_id: null },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("VITE_SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "anon-test");
  chapterResponse.current = { data: [], error: null };
  wholeDocResponse.current = { data: [], error: null };
  competencyResponse.current = { data: competencies, error: null };
  studyGuideResponse.current = { data: [], error: null };
  studyGuidePieceResponse.current = { data: [], error: null };
  studyGuidePieceQuestionResponse.current = { data: [], error: null };
  questionInsertResponse.current = {
    data: [{ id: "q-1" }, { id: "q-2" }],
    error: null,
  };
  getSessionMock.mockResolvedValue({
    data: { session: { access_token: "tok", user: { id: "user-1" } } },
    error: null,
  });

  lastFetchBody = null;
  nextFetchResponse = {
    ok: true,
    body: {
      questions: [
        { question: "Q1", competency_ids: ["comp-1"], chapter_ids: [] },
        { question: "Q2", competency_ids: ["comp-1"], chapter_ids: [] },
      ],
    },
  };
  global.fetch = vi.fn(async (_url: string, opts: any) => {
    try {
      lastFetchBody = JSON.parse(opts?.body ?? "{}");
    } catch {
      lastFetchBody = null;
    }
    return {
      ok: nextFetchResponse.ok,
      status: 200,
      json: async () => nextFetchResponse.body,
    } as Response;
  }) as any;
});

afterEach(() => {
  vi.unstubAllEnvs();
  global.fetch = originalFetch;
});

describe("GenerateMcqDialog (#873)", () => {
  it("pre-fills competency selection, difficulty, instructions and note from the seed", async () => {
    const seed: GenerateMcqSeed = {
      selectionMode: "competencies",
      selectedCompetencyIds: ["comp-1"],
      difficulty: "hard",
      specialInstructions: "Focus on weak areas",
      note: "Seeded from group Alpha — weak in: Photosynthesis",
    };

    render(
      <GenerateMcqDialog
        open
        onOpenChange={() => {}}
        courseId="course-1"
        seed={seed}
      />,
    );

    // Note banner is rendered.
    await screen.findByText(/Seeded from group Alpha/);

    // Competency mode active → the competency checkboxes are shown.
    const compCheckbox = await screen.findByRole("checkbox", { name: /Photosynthesis/i });
    expect(compCheckbox.getAttribute("data-state")).toBe("checked");

    // Seeded special instructions carried into the textarea.
    expect(
      (screen.getByLabelText(/Special Instructions/i) as HTMLTextAreaElement).value,
    ).toBe("Focus on weak areas");
  });

  it("defaults to chapters mode with no pre-selection when no seed is given", async () => {
    render(<GenerateMcqDialog open onOpenChange={() => {}} courseId="course-1" />);

    // Chapters mode empty-state copy (no chapters were returned).
    await screen.findByText(/No text chapters found/i);
    expect(
      screen.getByText(/0 chapters selected/i),
    ).toBeInTheDocument();
  });

  it("submits the generate-questions payload for the selected competencies", async () => {
    const seed: GenerateMcqSeed = {
      selectionMode: "competencies",
      selectedCompetencyIds: ["comp-1"],
      difficulty: "hard",
    };

    const onGenerated = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <GenerateMcqDialog
        open
        onOpenChange={onOpenChange}
        courseId="course-1"
        seed={seed}
        onGenerated={onGenerated}
      />,
    );

    await screen.findByRole("checkbox", { name: /Photosynthesis/i });

    await userEvent.setup().click(
      screen.getByRole("button", { name: /Generate .* Questions/i }),
    );

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });

    expect(lastFetchBody).toMatchObject({
      courseId: "course-1",
      numQuestions: 5,
      difficulty: "hard",
      competencyIds: ["comp-1"],
      startHidden: false,
      diagramMode: "off",
      enableTrueFalse: false,
    });
    // Chapter mode payload key must be omitted for a competency-based run.
    expect(lastFetchBody?.chapterIds).toBeUndefined();

    await waitFor(() => {
      expect(onGenerated).toHaveBeenCalled();
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(toastMocks.success).toHaveBeenCalled();
  });

  it("blocks submission and toasts when no competency is selected", async () => {
    const seed: GenerateMcqSeed = { selectionMode: "competencies" };
    render(
      <GenerateMcqDialog open onOpenChange={() => {}} courseId="course-1" seed={seed} />,
    );

    await screen.findByRole("checkbox", { name: /Photosynthesis/i });

    // The generate button is disabled with an empty selection, so submission
    // cannot fire a request.
    const generate = screen.getByRole("button", { name: /Generate .* Questions/i });
    expect(generate).toBeDisabled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  // ── Whole-document "Other" materials (#1019) ────────────────────────────
  //
  // These are never split into chapters, so they are not in the chapter tree at
  // all: each one is a single checkbox for the entire document, and the payload
  // carries them as `materialIds` rather than `chapterIds`.

  const wholeDocs = [
    { id: "mat-other", title: "Course syllabus", file_name: "syllabus.pdf", page_count: 12, file_size: 2048 },
  ];

  it("offers an 'Other' material as one whole-document choice", async () => {
    wholeDocResponse.current = { data: wholeDocs, error: null };

    render(<GenerateMcqDialog open onOpenChange={() => {}} courseId="course-1" />);

    // Listed under its own heading rather than as a chapter of something.
    await screen.findByText(/Other documents/i);
    const docCheckbox = await screen.findByRole("checkbox", { name: /Course syllabus/i });
    expect(docCheckbox.getAttribute("data-state")).toBe("unchecked");

    // The chapter empty-state must not claim there is nothing to generate from.
    expect(screen.queryByText(/No text chapters found/i)).not.toBeInTheDocument();
  });

  it("submits a selected document as materialIds, with no chapters", async () => {
    wholeDocResponse.current = { data: wholeDocs, error: null };
    const user = userEvent.setup();

    render(<GenerateMcqDialog open onOpenChange={() => {}} courseId="course-1" />);

    await user.click(await screen.findByRole("checkbox", { name: /Course syllabus/i }));
    await user.click(screen.getByRole("button", { name: /Generate .* Questions/i }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });
    expect(lastFetchBody).toMatchObject({
      courseId: "course-1",
      chapterIds: [],
      materialIds: ["mat-other"],
    });
  });

  it("lets a document alone satisfy the selection requirement", async () => {
    // Without this the Generate button stays disabled for a course whose only
    // AI-usable material is an "Other" document — the whole point of #1019.
    wholeDocResponse.current = { data: wholeDocs, error: null };
    const user = userEvent.setup();

    render(<GenerateMcqDialog open onOpenChange={() => {}} courseId="course-1" />);

    const generate = await screen.findByRole("button", { name: /Generate .* Questions/i });
    expect(generate).toBeDisabled();

    await user.click(await screen.findByRole("checkbox", { name: /Course syllabus/i }));
    expect(generate).not.toBeDisabled();
  });

  it("counts a document against the page budget", async () => {
    // A document is attached whole, so its own page count is what it costs.
    wholeDocResponse.current = {
      data: [{ ...wholeDocs[0], page_count: 40, file_size: 1024 * 1024 }],
      error: null,
    };
    const user = userEvent.setup();

    render(<GenerateMcqDialog open onOpenChange={() => {}} courseId="course-1" />);

    await user.click(await screen.findByRole("checkbox", { name: /Course syllabus/i }));
    await screen.findByText(/1 document · 40 \/ 400 pages/i);
  });

  // ── Completed study guides as sources ───────────────────────────────────
  //
  // A guide's stored theory is the generation input and its own questions are
  // the dedup list, so only guides whose every piece has both are selectable.
  // The payload carries them as `studyGuideIds`.

  const guideTheory = `<p>${"theory prose ".repeat(10)}</p>`;
  const seedStudyGuides = () => {
    studyGuideResponse.current = {
      data: [
        { id: "guide-done", title: "Forces, start to finish" },
        { id: "guide-wip", title: "Waves (draft)" },
      ],
      error: null,
    };
    studyGuidePieceResponse.current = {
      data: [
        { id: "p-1", study_guide_id: "guide-done", theory_html: guideTheory },
        { id: "p-2", study_guide_id: "guide-done", theory_html: guideTheory },
        // Has theory but no questions yet → the guide is incomplete.
        { id: "p-3", study_guide_id: "guide-wip", theory_html: guideTheory },
      ],
      error: null,
    };
    studyGuidePieceQuestionResponse.current = {
      data: [{ piece_id: "p-1" }, { piece_id: "p-2" }],
      error: null,
    };
  };

  it("offers completed study guides and disables incomplete ones", async () => {
    seedStudyGuides();
    const user = userEvent.setup();

    render(<GenerateMcqDialog open onOpenChange={() => {}} courseId="course-1" />);

    await user.click(await screen.findByRole("radio", { name: /Study guides/i }));

    const complete = await screen.findByRole("checkbox", { name: /Forces, start to finish/i });
    expect(complete).not.toBeDisabled();

    const incomplete = screen.getByRole("checkbox", { name: /Waves \(draft\)/i });
    expect(incomplete).toBeDisabled();
    expect(screen.getByText(/incomplete — every piece needs theory and questions/i)).toBeInTheDocument();
  });

  it("submits selected guides as studyGuideIds, with no chapter payload", async () => {
    seedStudyGuides();
    const user = userEvent.setup();

    render(<GenerateMcqDialog open onOpenChange={() => {}} courseId="course-1" />);

    await user.click(await screen.findByRole("radio", { name: /Study guides/i }));

    const generate = screen.getByRole("button", { name: /Generate .* Questions/i });
    expect(generate).toBeDisabled();

    await user.click(await screen.findByRole("checkbox", { name: /Forces, start to finish/i }));
    expect(generate).not.toBeDisabled();
    await user.click(generate);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });
    expect(lastFetchBody).toMatchObject({
      courseId: "course-1",
      studyGuideIds: ["guide-done"],
    });
    expect(lastFetchBody?.chapterIds).toBeUndefined();
    expect(lastFetchBody?.materialIds).toBeUndefined();
    expect(lastFetchBody?.competencyIds).toBeUndefined();
  });

  it("refuses a document that would blow the page budget", async () => {
    wholeDocResponse.current = {
      data: [{ ...wholeDocs[0], page_count: 900, file_size: 1024 }],
      error: null,
    };

    render(<GenerateMcqDialog open onOpenChange={() => {}} courseId="course-1" />);

    // Disabled rather than left clickable-then-rejected by the edge function.
    const docCheckbox = await screen.findByRole("checkbox", { name: /Course syllabus/i });
    expect(docCheckbox).toBeDisabled();
  });
});
