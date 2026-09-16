import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

type Result = { data: unknown; error: unknown };

const responses: Record<string, Result> = {
  questions: { data: [], error: null },
  question_votes: { data: [], error: null },
  question_competencies: { data: [], error: null },
  question_chapters: { data: [], error: null },
  profiles: { data: [], error: null },
  material_chapters: { data: [], error: null },
  course_competencies: { data: [], error: null },
  study_guides: { data: [], error: null },
  study_guide_pieces: { data: [], error: null },
};

const insertCalls: Array<{ table: string; values: unknown }> = [];

// Per-call script for `study_guide_pieces`, so a test can make an EARLIER
// request resolve after a later one and prove the stale response is dropped.
let pieceScript: Array<{ data: unknown; delayMs: number }> | null = null;
let pieceCallCount = 0;

let lastFetchBody: any = null;
let nextFetchResponse: { ok: boolean; body: any } = {
  ok: true,
  body: { questions: [] },
};

vi.mock("@/integrations/supabase/client", () => {
  const buildChain = (table: string) => {
    const chain: Record<string, (...a: unknown[]) => unknown> = {};
    const passThrough = () => chain;
    chain.select = passThrough;
    chain.eq = passThrough;
    chain.in = passThrough;
    chain.neq = passThrough;
    chain.is = passThrough;
    chain.order = passThrough;
    chain.insert = (values: unknown) => {
      insertCalls.push({ table, values });
      return chain;
    };
    chain.update = passThrough;
    chain.delete = passThrough;
    chain.single = () =>
      Promise.resolve(responses[table] || { data: null, error: null });
    chain.maybeSingle = chain.single;
    chain.then = (resolve: (v: unknown) => unknown) => {
      if (table === "study_guide_pieces" && pieceScript) {
        const step = pieceScript[Math.min(pieceCallCount, pieceScript.length - 1)];
        pieceCallCount++;
        return new Promise((res) =>
          setTimeout(() => res(resolve({ data: step.data, error: null })), step.delayMs),
        );
      }
      return Promise.resolve(resolve(responses[table] || { data: [], error: null }));
    };
    return chain;
  };

  return {
    supabase: {
      from: vi.fn((table: string) => buildChain(table)),
      auth: {
        getSession: vi.fn(async () => ({
          data: { session: { access_token: "fake-token" } },
        })),
        getUser: vi.fn(async () => ({ data: { user: { id: "user-1" } } })),
      },
      storage: {
        from: vi.fn(() => ({
          createSignedUrl: vi.fn(async () => ({
            data: { signedUrl: "https://signed" },
            error: null,
          })),
          remove: vi.fn(async () => ({ data: null, error: null })),
        })),
      },
    },
  };
});

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("@/hooks/useContentAssignments", () => ({
  useContentAssignments: () => ({
    assignments: {},
    groupsByOffering: {
      "off-1": [
        {
          id: "grp-1",
          offering_id: "off-1",
          name: "Group Alpha",
          description: null,
        },
      ],
    },
    loading: false,
    saving: false,
    getAssignedTargets: vi.fn(() => []),
    saveAssignments: vi.fn(async () => ({ ok: true })),
  }),
}));

vi.mock("@/components/OpenQuestionsTable", () => ({
  OpenQuestionsTable: ({ questions }: { questions: unknown[] }) => (
    <div data-testid="open-questions-table" data-count={questions.length}>
      {questions.map((q: any) => (
        <div key={q.id} data-testid={`row-${q.id}`} data-author={q.authorName ?? ""}>
          {q.question}
        </div>
      ))}
    </div>
  ),
}));

vi.mock("@/components/TargetAudienceSelector", async () => {
  return {
    TargetAudienceSelector: ({
      value,
    }: {
      value: unknown;
      onChange: (v: unknown) => void;
    }) => (
      <div data-testid="audience-selector">
        <span data-testid="audience-kind">{(value as any).kind}</span>
      </div>
    ),
  };
});

vi.mock("@/components/ContentAssignDialog", () => ({
  ContentAssignDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="assign-dialog" /> : null,
}));

vi.stubEnv("VITE_SUPABASE_URL", "https://test.supabase.co");
vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "anon-test");

import AIInteractiveQuestions from "@/components/AIInteractiveQuestions";

const courseClasses = [
  {
    id: "cls-1",
    name: "A1",
    grade_level_id: null,
    section_name: null,
    category: null,
    academic_period: null,
    offering_id: "off-1",
  },
];

beforeEach(() => {
  for (const key of Object.keys(responses)) {
    responses[key] = { data: [], error: null };
  }
  insertCalls.length = 0;
  pieceScript = null;
  pieceCallCount = 0;
  lastFetchBody = null;
  nextFetchResponse = { ok: true, body: { questions: [] } };

  global.fetch = vi.fn(async (_url: string, opts: any) => {
    try {
      lastFetchBody = JSON.parse(opts?.body ?? "{}");
    } catch {
      lastFetchBody = null;
    }
    return {
      ok: nextFetchResponse.ok,
      json: async () => nextFetchResponse.body,
    } as Response;
  }) as any;
});

describe("AIInteractiveQuestions", () => {
  it("renders the AI Interactive empty state when no questions exist", async () => {
    render(
      <AIInteractiveQuestions
        courseId="course-1"
        materials={[]}
        isAdmin
        classes={courseClasses}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByText(/No AI interactive questions generated yet/i),
      ).toBeInTheDocument();
    });
    // #618 — this component does NOT host the single-answer Open Questions
    // section anymore; its empty-state copy must not appear here.
    expect(
      screen.queryByText(/No open questions generated yet/i),
    ).not.toBeInTheDocument();
  });

  it("hides the Generate button when isAdmin is false", async () => {
    render(
      <AIInteractiveQuestions
        courseId="course-1"
        materials={[]}
        isAdmin={false}
        classes={courseClasses}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByText(/No AI interactive questions generated yet/i),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByRole("button", {
        name: /Generate AI Interactive Questions/i,
      }),
    ).not.toBeInTheDocument();
  });

  it("lists only interactive-mode opens (single-answer rows belong to the Question Bank)", async () => {
    responses.questions = {
      data: [
        {
          id: "q-single",
          course_id: "course-1",
          question: "Single-mode Q",
          answer_key: { model_answer: "X", rubric: null, explanation: "" },
          payload: { answering_mode: "single" },
          explanation: "",
          difficulty: "easy",
          upvotes: 0,
          downvotes: 0,
          hidden: false,
          created_at: "2026-05-01T00:00:00Z",
          created_by: "user-1",
          generation_rationale: null,
        },
        {
          id: "q-interactive",
          course_id: "course-1",
          question: "Interactive-mode Q",
          answer_key: { model_answer: "Y", rubric: null, explanation: "" },
          payload: { answering_mode: "interactive" },
          explanation: "",
          difficulty: "medium",
          upvotes: 0,
          downvotes: 0,
          hidden: false,
          created_at: "2026-05-02T00:00:00Z",
          created_by: "user-1",
          generation_rationale: null,
        },
        {
          id: "q-legacy",
          course_id: "course-1",
          question: "Legacy row (empty payload defaults to interactive)",
          answer_key: { model_answer: "Z", rubric: null, explanation: "" },
          payload: {},
          explanation: "",
          difficulty: "hard",
          upvotes: 0,
          downvotes: 0,
          hidden: false,
          created_at: "2026-05-03T00:00:00Z",
          created_by: "user-1",
          generation_rationale: null,
        },
      ],
      error: null,
    };

    render(
      <AIInteractiveQuestions
        courseId="course-1"
        materials={[]}
        isAdmin
        classes={courseClasses}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("row-q-interactive")).toBeInTheDocument();
    });
    // A legacy row with an empty payload reads as interactive, so it belongs
    // here; an explicit single-answer row does not — it lives in the Question
    // Bank, which applies the inverse filter (#624).
    expect(screen.getByTestId("row-q-legacy")).toBeInTheDocument();
    expect(screen.queryByTestId("row-q-single")).not.toBeInTheDocument();

    const tables = screen.getAllByTestId("open-questions-table");
    expect(tables.length).toBe(1);
    expect(tables[0].getAttribute("data-count")).toBe("2");
    expect(screen.getByText(/\(2\)/)).toBeInTheDocument();
  });

  it("names the author by email when the profile has no full_name", async () => {
    // `handle_new_user` only fills `full_name` from signup metadata, so an
    // invited or admin-created instructor has NULL there — which used to
    // render every question they generated as "Unknown".
    responses.questions = {
      data: [
        {
          id: "q-authored",
          course_id: "course-1",
          question: "Authored question",
          answer_key: { model_answer: "A", rubric: null, explanation: "" },
          payload: { answering_mode: "interactive" },
          explanation: "",
          difficulty: "easy",
          upvotes: 0,
          downvotes: 0,
          hidden: false,
          created_at: "2026-05-01T00:00:00Z",
          created_by: "user-no-name",
          generation_rationale: null,
        },
      ],
      error: null,
    };
    responses.profiles = {
      data: [{ user_id: "user-no-name", full_name: null, email: "teacher@school.gr" }],
      error: null,
    };

    render(
      <AIInteractiveQuestions
        courseId="course-1"
        materials={[]}
        isAdmin
        classes={courseClasses}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("row-q-authored")).toBeInTheDocument();
    });
    expect(screen.getByTestId("row-q-authored")).toHaveAttribute(
      "data-author",
      "teacher@school.gr",
    );
  });

  it("opens a generation dialog titled 'Generate AI Interactive Questions'", async () => {
    responses.material_chapters = {
      data: [
        {
          id: "ch-1",
          title: "Polynomials",
          content_type: "pdf",
          content: null,
          file_name: "Pages 1-10",
          material_id: "mat-1",
          course_materials: {
            id: "mat-1",
            title: "Algebra",
            file_name: "algebra.pdf",
            course_id: "course-1",
            openai_file_id: null,
            page_count: 100,
            file_size: 100000,
            material_type: "textbook",
          },
        },
      ],
      error: null,
    };

    render(
      <AIInteractiveQuestions
        courseId="course-1"
        materials={[]}
        isAdmin
        classes={courseClasses}
      />,
    );

    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", {
        name: /^Generate AI Interactive Questions$/i,
      }),
    );

    // Dialog header reads the interactive title.
    await waitFor(() => {
      expect(
        screen.getByRole("heading", {
          name: /Generate AI Interactive Questions/i,
        }),
      ).toBeInTheDocument();
    });

    // The in-dialog mode toggle from earlier rounds (#596) is absent —
    // this tab fixes the mode to "interactive".
    expect(
      screen.queryByRole("checkbox", { name: /AI Interactive Learning/i }),
    ).not.toBeInTheDocument();
  });

  it("inserts rows with payload.answering_mode='interactive' after generation", async () => {
    responses.material_chapters = {
      data: [
        {
          id: "ch-1",
          title: "Polynomials",
          content_type: "pdf",
          content: null,
          file_name: "Pages 1-10",
          material_id: "mat-1",
          course_materials: {
            id: "mat-1",
            title: "Algebra",
            file_name: "algebra.pdf",
            course_id: "course-1",
            openai_file_id: null,
            page_count: 100,
            file_size: 100000,
            material_type: "textbook",
          },
        },
      ],
      error: null,
    };

    nextFetchResponse = {
      ok: true,
      body: {
        questions: [
          {
            course_id: "course-1",
            question: "Interactive Q",
            model_answer: "42",
            explanation: "",
            difficulty: "easy",
            upvotes: 0,
            downvotes: 0,
            hidden: false,
            competency_ids: [],
            chapter_ids: ["ch-1"],
          },
        ],
      },
    };
    responses.questions = {
      data: [
        {
          id: "new-i-1",
          course_id: "course-1",
          question: "Interactive Q",
          answer_key: { model_answer: "42", rubric: null, explanation: "" },
          payload: { answering_mode: "interactive" },
          explanation: "",
          difficulty: "easy",
          upvotes: 0,
          downvotes: 0,
          hidden: false,
          created_at: "2026-05-01T00:00:00Z",
          created_by: "user-1",
          generation_rationale: null,
        },
      ],
      error: null,
    };

    render(
      <AIInteractiveQuestions
        courseId="course-1"
        materials={[]}
        isAdmin
        classes={courseClasses}
      />,
    );

    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", {
        name: /^Generate AI Interactive Questions$/i,
      }),
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Polynomials")).toBeInTheDocument();
    });
    await user.click(screen.getByLabelText("Polynomials"));
    await user.click(
      screen.getByRole("button", { name: /Generate 1 Questions/i }),
    );

    await waitFor(() => {
      const qInsert = insertCalls.find(
        (c) => c.table === "questions" && Array.isArray(c.values),
      );
      expect(qInsert).toBeTruthy();
      const rows = qInsert!.values as Array<Record<string, unknown>>;
      expect((rows[0].payload as Record<string, unknown>).answering_mode).toBe(
        "interactive",
      );
    });

    // Sanity-check the fetch body — it should target the open-question
    // generator and forward the selected chapter id.
    expect(lastFetchBody?.chapterIds).toEqual(["ch-1"]);
  });

  it("sends the selected study guide and its sections when generating from theory", async () => {
    responses.study_guides = {
      data: [{ id: "sg-1", title: "Europe 1815-1871" }],
      error: null,
    };
    responses.study_guide_pieces = {
      data: [
        {
          id: "p-1",
          title: "Congress of Vienna",
          position: 0,
          theory_html: "<p>The Congress redrew the map.</p>",
        },
        // No theory yet: offered but unselectable, and never sent.
        { id: "p-2", title: "Restoration", position: 1, theory_html: null },
      ],
      error: null,
    };

    render(
      <AIInteractiveQuestions
        courseId="course-1"
        materials={[]}
        isAdmin
        classes={courseClasses}
      />,
    );

    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", {
        name: /^Generate AI Interactive Questions$/i,
      }),
    );

    await user.click(await screen.findByLabelText("Study Guide"));

    // Pick the guide, which loads its sections.
    await user.click(await screen.findByRole("combobox", { name: /Select Study Guide/i }));
    await user.click(await screen.findByRole("option", { name: "Europe 1815-1871" }));

    // Sections with theory are pre-selected; the one without it is disabled.
    await waitFor(() => {
      expect(screen.getByLabelText("Congress of Vienna")).toBeChecked();
    });
    expect(screen.getByLabelText(/Restoration/)).toBeDisabled();

    await user.click(screen.getByRole("button", { name: /Generate 1 Questions/i }));

    await waitFor(() => {
      expect(lastFetchBody?.studyGuideId).toBe("sg-1");
    });
    expect(lastFetchBody?.pieceIds).toEqual(["p-1"]);
    // The other two sources stay out of a study-guide request.
    expect(lastFetchBody?.chapterIds).toBeUndefined();
    expect(lastFetchBody?.competencyIds).toBeUndefined();
  });


  it("refuses to generate from a study guide whose sections have no theory", async () => {
    responses.study_guides = {
      data: [{ id: "sg-1", title: "Outline only" }],
      error: null,
    };
    responses.study_guide_pieces = {
      data: [{ id: "p-1", title: "Congress of Vienna", position: 0, theory_html: null }],
      error: null,
    };

    render(
      <AIInteractiveQuestions
        courseId="course-1"
        materials={[]}
        isAdmin
        classes={courseClasses}
      />,
    );

    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", {
        name: /^Generate AI Interactive Questions$/i,
      }),
    );
    await user.click(await screen.findByLabelText("Study Guide"));
    await user.click(await screen.findByRole("combobox", { name: /Select Study Guide/i }));
    await user.click(await screen.findByRole("option", { name: "Outline only" }));

    await waitFor(() => {
      expect(
        screen.getByText(/This guide has no generated theory yet/i),
      ).toBeInTheDocument();
    });
    // Nothing selectable means nothing to generate from.
    expect(
      screen.getByRole("button", { name: /Generate 1 Questions/i }),
    ).toBeDisabled();
    expect(global.fetch).not.toHaveBeenCalled();
  });


  it("ignores a stale guide-piece response that resolves after a newer one", async () => {
    responses.study_guides = {
      data: [
        { id: "sg-1", title: "Europe 1815-1871" },
        { id: "sg-2", title: "The interwar years" },
      ],
      error: null,
    };
    // The first guide's sections come back LAST — the shape that used to pair
    // the selected guide with another guide's sections.
    pieceScript = [
      {
        data: [{ id: "p-old", title: "Congress of Vienna", position: 0, theory_html: "<p>old</p>" }],
        delayMs: 60,
      },
      {
        data: [{ id: "p-new", title: "Weimar Germany", position: 0, theory_html: "<p>new</p>" }],
        delayMs: 0,
      },
    ];

    render(
      <AIInteractiveQuestions
        courseId="course-1"
        materials={[]}
        isAdmin
        classes={courseClasses}
      />,
    );

    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", {
        name: /^Generate AI Interactive Questions$/i,
      }),
    );
    await user.click(await screen.findByLabelText("Study Guide"));

    const openGuideList = async () =>
      user.click(await screen.findByRole("combobox", { name: /Select Study Guide/i }));

    await openGuideList();
    await user.click(await screen.findByRole("option", { name: "Europe 1815-1871" }));
    // Switch before the first response lands.
    await openGuideList();
    await user.click(await screen.findByRole("option", { name: "The interwar years" }));

    await waitFor(() => {
      expect(screen.getByLabelText("Weimar Germany")).toBeChecked();
    });

    // Let the stale response resolve, then confirm it changed nothing.
    await new Promise((r) => setTimeout(r, 120));
    expect(screen.queryByLabelText("Congress of Vienna")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Weimar Germany")).toBeChecked();

    await user.click(screen.getByRole("button", { name: /Generate 1 Questions/i }));
    await waitFor(() => {
      expect(lastFetchBody?.studyGuideId).toBe("sg-2");
    });
    expect(lastFetchBody?.pieceIds).toEqual(["p-new"]);
  });


  it("drops the previous guide's sections while the next guide is still loading", async () => {
    responses.study_guides = {
      data: [
        { id: "sg-1", title: "Europe 1815-1871" },
        { id: "sg-2", title: "The interwar years" },
      ],
      error: null,
    };
    // First guide answers immediately, the replacement takes its time — the
    // window in which the old selection used to stay live and submittable.
    pieceScript = [
      {
        data: [{ id: "p-old", title: "Congress of Vienna", position: 0, theory_html: "<p>old</p>" }],
        delayMs: 0,
      },
      {
        data: [{ id: "p-new", title: "Weimar Germany", position: 0, theory_html: "<p>new</p>" }],
        delayMs: 80,
      },
    ];

    render(
      <AIInteractiveQuestions
        courseId="course-1"
        materials={[]}
        isAdmin
        classes={courseClasses}
      />,
    );

    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", {
        name: /^Generate AI Interactive Questions$/i,
      }),
    );
    await user.click(await screen.findByLabelText("Study Guide"));

    const openGuideList = async () =>
      user.click(await screen.findByRole("combobox", { name: /Select Study Guide/i }));

    await openGuideList();
    await user.click(await screen.findByRole("option", { name: "Europe 1815-1871" }));
    await waitFor(() => {
      expect(screen.getByLabelText("Congress of Vienna")).toBeChecked();
    });

    await openGuideList();
    await user.click(await screen.findByRole("option", { name: "The interwar years" }));

    // Mid-load: the first guide's section is gone and nothing is submittable,
    // so the new guide id can never be paired with the old piece ids.
    expect(screen.queryByLabelText("Congress of Vienna")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Generate 1 Questions/i }),
    ).toBeDisabled();
    expect(global.fetch).not.toHaveBeenCalled();

    // Once it lands, the replacement is selected and generation is live again.
    await waitFor(() => {
      expect(screen.getByLabelText("Weimar Germany")).toBeChecked();
    });
    expect(
      screen.getByRole("button", { name: /Generate 1 Questions/i }),
    ).toBeEnabled();
  });

});
