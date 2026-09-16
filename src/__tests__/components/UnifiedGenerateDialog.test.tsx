/**
 * #630 — end-to-end happy path for the unified Question Bank generate
 * dialog. The bug: the dialog called the edge function and toasted
 * success without inserting anything, so the bank stayed empty for
 * open / fill-gaps / ordering / classification.
 *
 * The fix calls `insertGeneratedQuestions` after the edge function
 * returns. This test mocks the helper and asserts the dialog hands it
 * the right inputs (type / generated rows / audience / target).
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const insertGeneratedQuestionsMock = vi.hoisted(() =>
  vi.fn(async () => ({
    insertedCount: 1,
    autoAssignedLabel: null,
    warning: null,
  })),
);

const invokeMock = vi.hoisted(() => vi.fn());

const tableResponses = vi.hoisted(
  () =>
    ({
      material_chapters: { data: [], error: null },
      course_competencies: { data: [], error: null },
      // The chapterless "Other" materials offered as whole documents (#1019).
      course_materials: { data: [], error: null },
    }) as Record<string, { data: unknown; error: unknown }>,
);

vi.mock("@/integrations/supabase/client", () => {
  const buildChain = (table: string) => {
    const chain: Record<string, (...a: unknown[]) => unknown> = {};
    const passThrough = () => chain;
    chain.select = passThrough;
    chain.eq = passThrough;
    // #1019 — the chapter query excludes chapterless "Other" materials, and a
    // second query fetches those separately as whole documents (`.not(...)` on
    // `openai_file_id`, to skip any that have not synced to OpenAI).
    chain.neq = passThrough;
    chain.not = passThrough;
    // Chainable, not terminal: the real builder allows repeated .order() calls
    // and the chapter query now passes a tiebreak (#1065). `chain.then` below is
    // what actually resolves the query when it is awaited.
    chain.order = passThrough;
    chain.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(
        resolve(tableResponses[table] ?? { data: [], error: null }),
      );
    return chain;
  };

  return {
    supabase: {
      from: vi.fn((t: string) => buildChain(t)),
      auth: {
        getSession: vi.fn(async () => ({
          data: { session: { access_token: "tok" } },
        })),
        getUser: vi.fn(async () => ({ data: { user: { id: "user-1" } } })),
      },
      functions: { invoke: invokeMock },
    },
  };
});

vi.mock("@/lib/insert-generated-questions", () => ({
  insertGeneratedQuestions: insertGeneratedQuestionsMock,
}));

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: toastMocks }));

vi.mock("@/components/TargetAudienceSelector", () => ({
  TargetAudienceSelector: () => null,
}));

const mcqDialogProps = vi.hoisted(() => ({ current: [] as unknown[] }));
vi.mock("@/components/GenerateMcqDialog", () => ({
  GenerateMcqDialog: (props: unknown) => {
    mcqDialogProps.current.push(props);
    return null;
  },
}));

// jsdom shims for Radix.
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

import { UnifiedGenerateDialog } from "@/components/UnifiedGenerateDialog";

beforeEach(() => {
  mcqDialogProps.current = [];
  insertGeneratedQuestionsMock.mockClear();
  insertGeneratedQuestionsMock.mockResolvedValue({
    insertedCount: 1,
    autoAssignedLabel: null,
    warning: null,
  });
  invokeMock.mockReset();
  toastMocks.success.mockClear();
  toastMocks.error.mockClear();
  toastMocks.warning.mockClear();
  tableResponses.material_chapters = {
    data: [
      {
        id: "ch-1",
        title: "Mitosis",
        material_id: "mat-1",
        course_materials: { title: "Biology", file_name: "bio.pdf" },
      },
    ],
    error: null,
  };
  tableResponses.course_competencies = { data: [], error: null };
  tableResponses.course_materials = { data: [], error: null };
});

describe("UnifiedGenerateDialog (#630)", () => {
  it("inserts generated open questions instead of stopping at the edge function", async () => {
    const generated = [
      {
        id: "q-new",
        course_id: "course-1",
        question: "What is mitosis?",
        type: "open",
        payload: {},
        answer_key: { model_answer: "Cell division.", rubric: null },
        model_answer: "Cell division.",
        explanation: "Biology basics.",
        difficulty: "medium",
        hidden: false,
        chapter_ids: ["ch-1"],
        competency_ids: [],
      },
    ];
    invokeMock.mockResolvedValueOnce({
      data: { questions: generated, target: null },
      error: null,
    });

    const onGenerated = vi.fn();
    render(
      <UnifiedGenerateDialog
        open
        onOpenChange={() => {}}
        courseId="course-1"
        materials={[]}
        classes={[]}
        groupsByOffering={{}}
        onGenerated={onGenerated}
      />,
    );

    const user = userEvent.setup();

    // Step 1 — pick Open and continue.
    await user.click(await screen.findByRole("radio", { name: /Open/i }));
    await user.click(screen.getByRole("button", { name: /Continue/i }));

    // Step 2 — pick the loaded chapter and submit.
    const chapterCheckbox = await screen.findByRole("checkbox", {
      name: /Mitosis/i,
    });
    await user.click(chapterCheckbox);
    await user.click(screen.getByRole("button", { name: /^Generate$/i }));

    // Edge function was called with the right type-specific function name.
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "generate-open-questions",
        expect.objectContaining({
          body: expect.objectContaining({
            courseId: "course-1",
            chapterIds: ["ch-1"],
          }),
        }),
      );
    });

    // The fix: the insert helper is called with the generated rows.
    await waitFor(() => {
      expect(insertGeneratedQuestionsMock).toHaveBeenCalledTimes(1);
    });
    expect(insertGeneratedQuestionsMock).toHaveBeenCalledWith({
      type: "open",
      courseId: "course-1",
      generated,
      target: null,
      audience: { kind: "none" },
    });

    // Refetch trigger fires so the bank refreshes.
    expect(onGenerated).toHaveBeenCalledTimes(1);
    expect(toastMocks.success).toHaveBeenCalled();
  });

  it("calls insertGeneratedQuestions with type='fill_gaps' when picking Fill the Gaps", async () => {
    const generated = [
      {
        id: "q-fg",
        course_id: "course-1",
        question: "The ___ divides.",
        type: "fill_gaps",
        payload: { stem: "The ___ divides." },
        answer_key: { gaps: [{ ordinal: 1, acceptable: ["cell"] }] },
        difficulty: "easy",
        hidden: false,
        chapter_ids: ["ch-1"],
        competency_ids: [],
      },
    ];
    invokeMock.mockResolvedValueOnce({
      data: { questions: generated, target: null },
      error: null,
    });

    render(
      <UnifiedGenerateDialog
        open
        onOpenChange={() => {}}
        courseId="course-1"
        materials={[]}
        classes={[]}
        groupsByOffering={{}}
      />,
    );

    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("radio", { name: /Fill the Gaps/i }),
    );
    await user.click(screen.getByRole("button", { name: /Continue/i }));
    const chapterCheckbox = await screen.findByRole("checkbox", {
      name: /Mitosis/i,
    });
    await user.click(chapterCheckbox);
    await user.click(screen.getByRole("button", { name: /^Generate$/i }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "generate-fill-gaps-questions",
        expect.any(Object),
      );
    });
    await waitFor(() => {
      expect(insertGeneratedQuestionsMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: "fill_gaps", generated }),
      );
    });
  });

  it("surfaces the helper warning as a toast and still reports success", async () => {
    invokeMock.mockResolvedValueOnce({
      data: {
        questions: [
          {
            id: "q1",
            course_id: "course-1",
            question: "x",
            type: "ordering",
            payload: { prompt: "x", items: [] },
            answer_key: {},
            difficulty: "easy",
            hidden: false,
            chapter_ids: ["ch-1"],
          },
        ],
        target: null,
      },
      error: null,
    });
    insertGeneratedQuestionsMock.mockResolvedValueOnce({
      insertedCount: 1,
      autoAssignedLabel: null,
      warning: "auto-assign failed: nope",
    });

    render(
      <UnifiedGenerateDialog
        open
        onOpenChange={() => {}}
        courseId="course-1"
        materials={[]}
        classes={[]}
        groupsByOffering={{}}
      />,
    );

    const user = userEvent.setup();
    await user.click(await screen.findByRole("radio", { name: /Ordering/i }));
    await user.click(screen.getByRole("button", { name: /Continue/i }));
    const chapterCheckbox = await screen.findByRole("checkbox", {
      name: /Mitosis/i,
    });
    await user.click(chapterCheckbox);
    await user.click(screen.getByRole("button", { name: /^Generate$/i }));

    await waitFor(() => {
      expect(toastMocks.warning).toHaveBeenCalledWith(
        "auto-assign failed: nope",
      );
    });
    expect(toastMocks.success).toHaveBeenCalled();
  });

  it("shows an error toast and does not insert when the edge function returns no questions", async () => {
    invokeMock.mockResolvedValueOnce({
      data: { questions: [], target: null },
      error: null,
    });

    render(
      <UnifiedGenerateDialog
        open
        onOpenChange={() => {}}
        courseId="course-1"
        materials={[]}
        classes={[]}
        groupsByOffering={{}}
      />,
    );

    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("radio", { name: /Classification/i }),
    );
    await user.click(screen.getByRole("button", { name: /Continue/i }));
    const chapterCheckbox = await screen.findByRole("checkbox", {
      name: /Mitosis/i,
    });
    await user.click(chapterCheckbox);
    await user.click(screen.getByRole("button", { name: /^Generate$/i }));

    await waitFor(() => {
      expect(toastMocks.error).toHaveBeenCalledWith("No questions were generated");
    });
    expect(insertGeneratedQuestionsMock).not.toHaveBeenCalled();
  });

  // ── Whole-document "Other" materials (#1019) ────────────────────────────

  it("offers an 'Other' material as a whole document and sends it as materialIds", async () => {
    // These are never split, so they cannot appear in the chapter tree. Each is
    // one checkbox for the entire document, sent alongside `chapterIds`.
    tableResponses.course_materials = {
      data: [{
        id: "mat-other",
        title: "Course syllabus",
        file_name: "syllabus.pdf",
        page_count: 12,
        file_size: 2048,
      }],
      error: null,
    };
    invokeMock.mockResolvedValueOnce({
      data: {
        questions: [{
          id: "q-new",
          course_id: "course-1",
          question: "What is the late-submission policy?",
          type: "open",
          payload: {},
          answer_key: { model_answer: "Stated in the syllabus.", rubric: null },
          model_answer: "Stated in the syllabus.",
          explanation: "Course expectations.",
          difficulty: "medium",
          hidden: false,
          chapter_ids: [],
          competency_ids: [],
        }],
        target: null,
      },
      error: null,
    });

    render(
      <UnifiedGenerateDialog
        open
        onOpenChange={() => {}}
        courseId="course-1"
        materials={[]}
        classes={[]}
        groupsByOffering={{}}
      />,
    );

    const user = userEvent.setup();
    await user.click(await screen.findByRole("radio", { name: /Open/i }));
    await user.click(screen.getByRole("button", { name: /Continue/i }));

    await screen.findByText(/Other documents/i);
    await user.click(await screen.findByRole("checkbox", { name: /Course syllabus/i }));
    await user.click(screen.getByRole("button", { name: /^Generate$/i }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalled();
    });
    expect(invokeMock.mock.calls[0][0]).toBe("generate-open-questions");
    expect(invokeMock.mock.calls[0][1].body).toMatchObject({
      chapterIds: [],
      materialIds: ["mat-other"],
    });
    expect(insertGeneratedQuestionsMock).toHaveBeenCalled();
  });

  it("refuses to generate when neither a chapter nor a document is picked", async () => {
    tableResponses.course_materials = {
      data: [{
        id: "mat-other",
        title: "Course syllabus",
        file_name: "syllabus.pdf",
        page_count: 12,
        file_size: 2048,
      }],
      error: null,
    };

    render(
      <UnifiedGenerateDialog
        open
        onOpenChange={() => {}}
        courseId="course-1"
        materials={[]}
        classes={[]}
        groupsByOffering={{}}
      />,
    );

    const user = userEvent.setup();
    await user.click(await screen.findByRole("radio", { name: /Ordering/i }));
    await user.click(screen.getByRole("button", { name: /Continue/i }));
    await screen.findByText(/Other documents/i);
    await user.click(screen.getByRole("button", { name: /^Generate$/i }));

    await waitFor(() => {
      expect(toastMocks.error).toHaveBeenCalledWith(
        "Please select at least one chapter or document",
      );
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  // ── initialAudience seeding (per-group "Generate questions") ────────────

  const groupAudience = {
    kind: "group" as const,
    groupId: "g-1",
    offeringId: "off-1",
    label: "A1 → Advanced Track",
    description: "needs practice on sources",
  };

  it("sends the seeded group's group_id on non-MCQ generation and hands the audience to the insert helper", async () => {
    const generated = [
      {
        id: "q-grp",
        course_id: "course-1",
        question: "What is mitosis?",
        type: "open",
        payload: {},
        answer_key: { model_answer: "Cell division.", rubric: null },
        model_answer: "Cell division.",
        explanation: "Biology basics.",
        difficulty: "medium",
        hidden: false,
        chapter_ids: ["ch-1"],
        competency_ids: [],
      },
    ];
    invokeMock.mockResolvedValueOnce({
      data: { questions: generated, target: null },
      error: null,
    });

    render(
      <UnifiedGenerateDialog
        open
        onOpenChange={() => {}}
        courseId="course-1"
        materials={[]}
        classes={[]}
        groupsByOffering={{}}
        initialAudience={groupAudience}
      />,
    );

    const user = userEvent.setup();
    await user.click(await screen.findByRole("radio", { name: /Open/i }));
    await user.click(screen.getByRole("button", { name: /Continue/i }));
    await user.click(await screen.findByRole("checkbox", { name: /Mitosis/i }));
    await user.click(screen.getByRole("button", { name: /^Generate$/i }));

    // The seeded group rides into the edge-function request…
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "generate-open-questions",
        expect.objectContaining({
          body: expect.objectContaining({ group_id: "g-1" }),
        }),
      );
    });
    // …and into the insert helper, which records generated_for_group_id.
    await waitFor(() => {
      expect(insertGeneratedQuestionsMock).toHaveBeenCalledWith(
        expect.objectContaining({ audience: groupAudience }),
      );
    });
  });

  it("forwards the seeded audience to the MCQ dialog as seed.audience", async () => {
    render(
      <UnifiedGenerateDialog
        open
        onOpenChange={() => {}}
        courseId="course-1"
        materials={[]}
        classes={[]}
        groupsByOffering={{}}
        initialAudience={groupAudience}
      />,
    );

    const user = userEvent.setup();
    // MCQ is the default selection on the pick step.
    await user.click(await screen.findByRole("button", { name: /Continue/i }));

    await waitFor(() => {
      expect(mcqDialogProps.current.length).toBeGreaterThan(0);
    });
    const props = mcqDialogProps.current.at(-1) as {
      seed?: { audience?: unknown };
    };
    expect(props.seed?.audience).toEqual(groupAudience);
  });
});
