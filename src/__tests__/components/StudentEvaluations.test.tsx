import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { format } from "date-fns";
import { MemoryRouter } from "react-router-dom";

type Result = { data: unknown; error: unknown };

const responses: Record<string, Result> = {
  courses: { data: { institution_id: "inst-1" }, error: null },
  course_competencies: { data: [], error: null },
  offerings: { data: [], error: null },
  class_enrollments: { data: [], error: null },
  classes: { data: [], error: null },
  offering_groups: { data: [], error: null },
  profiles: { data: [], error: null },
  quiz_answers: { data: [], error: null },
  chat_sessions: { data: [], error: null },
  chat_messages: { data: [], error: null },
  open_question_grades: { data: [], error: null },
  flashcard_reviews: { data: [], error: null },
  study_guide_answers: { data: [], error: null },
  offering_quizzes: { data: [], error: null },
  offering_study_guides: { data: [], error: null },
  offering_group_members: { data: [], error: null },
  quizzes: { data: [], error: null },
  study_guides: { data: [], error: null },
  quiz_sessions: { data: [], error: null },
  study_guide_progress: { data: [], error: null },

  student_evaluations: { data: [], error: null },
  evaluation_competency_scores: { data: [], error: null },
  student_admin_notes: { data: [], error: null },
};

// Per-function results for supabase.functions.invoke, keyed by function name.
// Empty by default: a test that needs the edge function to return an
// evaluation seeds it here.
const functionResponses: Record<string, Result> = {};

const insertCalls: Array<{ table: string; values: unknown }> = [];
const updateCalls: Array<{ table: string; values: unknown; id?: unknown }> = [];
const deleteCalls: Array<{ table: string; id?: unknown }> = [];
const invokedFunctions: Array<{ name: string; body: unknown }> = [];

vi.mock("@/integrations/supabase/client", () => {
  const buildChain = (table: string) => {
    const chain: Record<string, (...a: unknown[]) => unknown> = {};
    const passThrough = () => chain;
    chain.select = passThrough;
    chain.eq = (_col: unknown, value: unknown) => {
      const pendingUpdate = (chain as any).__pendingUpdate;
      if (pendingUpdate) {
        updateCalls.push({ table, values: pendingUpdate, id: value });
        (chain as any).__pendingUpdate = undefined;
      }
      const pendingDelete = (chain as any).__pendingDelete;
      if (pendingDelete) {
        deleteCalls.push({ table, id: value });
        (chain as any).__pendingDelete = undefined;
      }
      return chain;
    };
    chain.in = passThrough;
    chain.not = passThrough;
    chain.is = passThrough;
    chain.or = passThrough;
    chain.order = passThrough;
    chain.limit = passThrough;
    chain.update = (values: unknown) => {
      (chain as any).__pendingUpdate = values;
      return chain;
    };
    chain.delete = () => {
      (chain as any).__pendingDelete = true;
      return chain;
    };
    chain.insert = (values: unknown) => {
      insertCalls.push({ table, values });
      return chain;
    };
    chain.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(resolve(responses[table] || { data: [], error: null }));
    chain.single = () =>
      Promise.resolve(
        responses[`${table}__single`] ||
          (Array.isArray(responses[table]?.data)
            ? { data: (responses[table].data as unknown[])[0] ?? null, error: null }
            : responses[table] || { data: null, error: null }),
      );
    chain.maybeSingle = chain.single;
    return chain;
  };

  return {
    supabase: {
      from: vi.fn((table: string) => buildChain(table)),
      functions: {
        invoke: vi.fn(async (name: string, args: { body: unknown }) => {
          invokedFunctions.push({ name, body: args?.body });
          return functionResponses[name] || { data: null, error: null };
        }),
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

vi.mock("pdf-lib", () => ({
  PDFDocument: { create: vi.fn() },
  rgb: vi.fn(),
  StandardFonts: { Helvetica: "Helvetica", HelveticaBold: "HelveticaBold" },
}));

vi.mock("@/components/EvaluationTimeline", () => ({
  default: () => <div data-testid="evaluation-timeline" />,
}));

vi.mock("@/components/GenerateMcqDialog", () => ({
  GenerateMcqDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="generate-mcq-dialog" /> : null,
}));

vi.mock("@/components/student-evaluations/CompetencyScoreEditor", () => ({
  CompetencyScoreEditor: ({ entry }: { entry: { title: string; score: number | null } }) => (
    <div data-testid={`competency-cell-${entry.title}`}>
      {entry.title}: {entry.score ?? "—"}
    </div>
  ),
}));

import StudentEvaluations from "@/components/StudentEvaluations";

const renderWithRouter = (ui: React.ReactElement) =>
  render(<MemoryRouter>{ui}</MemoryRouter>);

beforeEach(() => {
  for (const key of Object.keys(responses)) {
    if (key === "courses") {
      responses.courses = { data: { institution_id: "inst-1" }, error: null };
    } else {
      responses[key] = { data: [], error: null };
    }
  }
  for (const key of Object.keys(functionResponses)) {
    delete functionResponses[key];
  }
  insertCalls.length = 0;
  updateCalls.length = 0;
  deleteCalls.length = 0;
  invokedFunctions.length = 0;
});

describe("StudentEvaluations", () => {
  const seedEnrolledStudent = (overrides?: {
    student?: { user_id: string; full_name: string; email: string };
    evaluations?: unknown[];
    scores?: unknown[];
  }) => {
    const student = overrides?.student ?? {
      user_id: "stu-1",
      full_name: "Alice",
      email: "alice@test",
    };
    responses.offerings = {
      data: [{ id: "off-1", class_id: "cls-1" }],
      error: null,
    };
    responses.class_enrollments = {
      data: [{ user_id: student.user_id, class_id: "cls-1" }],
      error: null,
    };
    responses.classes = {
      data: [
        {
          id: "cls-1",
          name: "A1",
          grade_level_id: null,
          section_name: null,
          category: null,
          academic_period: null,
        },
      ],
      error: null,
    };
    responses.profiles = { data: [student], error: null };
    if (overrides?.evaluations) {
      responses.student_evaluations = { data: overrides.evaluations, error: null };
    }
    if (overrides?.scores) {
      responses.evaluation_competency_scores = {
        data: overrides.scores,
        error: null,
      };
    }
  };

  it("renders the empty state when no students are enrolled", async () => {
    renderWithRouter(<StudentEvaluations courseId="course-1" />);

    await waitFor(() => {
      expect(
        screen.getByText(/No students enrolled in this course/i),
      ).toBeInTheDocument();
    });
  });

  it("renders enrolled students with an interaction count and an evaluations badge, not a quiz score", async () => {
    seedEnrolledStudent();
    responses.quiz_answers = {
      data: [
        { user_id: "stu-1", is_correct: true, answered_at: "2026-05-01T00:00:00Z" },
        { user_id: "stu-1", is_correct: false, answered_at: "2026-05-02T00:00:00Z" },
        { user_id: "stu-1", is_correct: true, answered_at: "2026-05-03T00:00:00Z" },
      ],
      error: null,
    };

    renderWithRouter(<StudentEvaluations courseId="course-1" />);

    await waitFor(() => {
      expect(screen.getByText("Alice")).toBeInTheDocument();
    });
    expect(screen.getByText("alice@test")).toBeInTheDocument();
    expect(screen.getByText("3 interactions")).toBeInTheDocument();
    expect(screen.queryByText(/quizzes$/)).not.toBeInTheDocument();
    expect(screen.getByText(/1 students/i)).toBeInTheDocument();
  });

  const NEWEST_EVALUATION_AT = "2026-05-20T12:00:00Z";
  const LATEST_ACTIVITY_AT = "2026-06-30T12:00:00Z";

  it("dates the row by the latest evaluation, not by the latest activity", async () => {
    seedEnrolledStudent({
      evaluations: [
        {
          id: "eval-2",
          user_id: "stu-1",
          overall_assessment: "Newer",
          strengths: [],
          weaknesses: [],
          recommendations: [],
          generated_at: NEWEST_EVALUATION_AT,
          instructor_feedback: null,
          is_manual: false,
        },
        {
          id: "eval-1",
          user_id: "stu-1",
          overall_assessment: "Older",
          strengths: [],
          weaknesses: [],
          recommendations: [],
          generated_at: "2026-05-02T00:00:00Z",
          instructor_feedback: null,
          is_manual: false,
        },
      ],
    });
    // Activity long after the newest evaluation: the row must still show the
    // evaluation date.
    responses.quiz_answers = {
      data: [
        { user_id: "stu-1", is_correct: true, answered_at: LATEST_ACTIVITY_AT },
      ],
      error: null,
    };

    renderWithRouter(<StudentEvaluations courseId="course-1" />);

    await waitFor(() => {
      expect(screen.getByText("Alice")).toBeInTheDocument();
    });
    // Formatted with the runner's own timezone so the assertion holds wherever
    // the suite runs, not just under UTC.
    expect(screen.getByTitle("Last evaluation")).toHaveTextContent(
      format(new Date(NEWEST_EVALUATION_AT), "MMM d"),
    );
    expect(
      screen.queryByText(format(new Date(LATEST_ACTIVITY_AT), "MMM d")),
    ).not.toBeInTheDocument();
  });

  it("filters the student list via the search input (case-insensitive)", async () => {
    responses.offerings = {
      data: [{ id: "off-1", class_id: "cls-1" }],
      error: null,
    };
    responses.classes = {
      data: [
        {
          id: "cls-1",
          name: "A1",
          grade_level_id: null,
          section_name: null,
          category: null,
          academic_period: null,
        },
      ],
      error: null,
    };
    responses.class_enrollments = {
      data: [
        { user_id: "stu-1", class_id: "cls-1" },
        { user_id: "stu-2", class_id: "cls-1" },
      ],
      error: null,
    };
    responses.profiles = {
      data: [
        { user_id: "stu-1", full_name: "Alice", email: "alice@test" },
        { user_id: "stu-2", full_name: "Bob", email: "bob@test" },
      ],
      error: null,
    };

    renderWithRouter(<StudentEvaluations courseId="course-1" />);

    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());
    expect(screen.getByText("Bob")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText(/Search students/i), "BOB");

    expect(screen.queryByText("Alice")).not.toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();
  });

  it("expands the drill-down on row click and renders the latest evaluation bullets", async () => {
    seedEnrolledStudent({
      evaluations: [
        {
          id: "eval-1",
          user_id: "stu-1",
          overall_assessment: "Strong analytical skills",
          strengths: ["Clear writing"],
          weaknesses: ["Calculus weak spots"],
          recommendations: ["Practice integrals"],
          generated_at: "2026-05-01T00:00:00Z",
          instructor_feedback: null,
          is_manual: false,
        },
      ],
    });

    renderWithRouter(<StudentEvaluations courseId="course-1" />);

    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByText("Alice").closest("div")!.parentElement!.parentElement!);

    await waitFor(() => {
      expect(screen.getByText("Strong analytical skills")).toBeInTheDocument();
    });
    expect(screen.getByText("Clear writing")).toBeInTheDocument();
    expect(screen.getByText("Calculus weak spots")).toBeInTheDocument();
    expect(screen.getByText("Practice integrals")).toBeInTheDocument();
  });

  it("maps competency scores to the correct badge variant by threshold", async () => {
    seedEnrolledStudent({
      evaluations: [
        {
          id: "eval-1",
          user_id: "stu-1",
          overall_assessment: "ok",
          strengths: [],
          weaknesses: [],
          recommendations: [],
          generated_at: "2026-05-01T00:00:00Z",
          instructor_feedback: null,
          is_manual: false,
        },
      ],
      scores: [
        {
          evaluation_id: "eval-1",
          competency_id: "c-high",
          score: 90,
          rationale: "Mastery",
          is_manual: false,
          course_competencies: { title: "High" },
        },
        {
          evaluation_id: "eval-1",
          competency_id: "c-mid",
          score: 55,
          rationale: "Developing",
          is_manual: false,
          course_competencies: { title: "Mid" },
        },
        {
          evaluation_id: "eval-1",
          competency_id: "c-low",
          score: 20,
          rationale: "Struggling",
          is_manual: false,
          course_competencies: { title: "Low" },
        },
      ],
    });

    renderWithRouter(<StudentEvaluations courseId="course-1" />);

    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByText("Alice").closest("div")!.parentElement!.parentElement!);

    await waitFor(() => {
      expect(screen.getByText("90/100")).toBeInTheDocument();
    });
    const high = screen.getByText("90/100");
    const mid = screen.getByText("55/100");
    const low = screen.getByText("20/100");
    expect(high.className).toMatch(/bg-primary/);
    expect(mid.className).toMatch(/bg-secondary/);
    expect(low.className).toMatch(/bg-destructive/);
  });

  it("opens the manual evaluation dialog and saves with is_manual: true", async () => {
    seedEnrolledStudent();

    responses["student_evaluations__single"] = {
      data: { id: "new-eval-1" },
      error: null,
    } as any;

    renderWithRouter(<StudentEvaluations courseId="course-1" />);

    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: /More evaluation actions/i }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: /Add Manual Evaluation/i }),
    );

    const textarea = await screen.findByPlaceholderText(
      /Write your overall assessment of the student's performance/i,
    );
    await user.type(textarea, "Doing well in algebra");

    await user.click(screen.getByRole("button", { name: /Save Evaluation/i }));

    await waitFor(() => {
      const insert = insertCalls.find(
        (c) =>
          c.table === "student_evaluations" &&
          typeof c.values === "object" &&
          c.values !== null &&
          (c.values as Record<string, unknown>).is_manual === true,
      );
      expect(insert).toBeTruthy();
      expect((insert!.values as Record<string, unknown>).user_id).toBe("stu-1");
      expect((insert!.values as Record<string, unknown>).overall_assessment).toBe(
        "Doing well in algebra",
      );
    });
  });

  it("shows the Compare Progress button only when ≥2 evaluations exist", async () => {
    seedEnrolledStudent({
      evaluations: [
        {
          id: "eval-1",
          user_id: "stu-1",
          overall_assessment: "newer",
          strengths: [],
          weaknesses: [],
          recommendations: [],
          generated_at: "2026-05-01T00:00:00Z",
          instructor_feedback: null,
          is_manual: false,
        },
        {
          id: "eval-2",
          user_id: "stu-1",
          overall_assessment: "older",
          strengths: [],
          weaknesses: [],
          recommendations: [],
          generated_at: "2026-04-01T00:00:00Z",
          instructor_feedback: null,
          is_manual: true,
        },
      ],
    });

    renderWithRouter(<StudentEvaluations courseId="course-1" />);

    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByText("Alice").closest("div")!.parentElement!.parentElement!);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Compare Progress/i }),
      ).toBeInTheDocument();
    });
  });

  it("does not render Compare Progress when only one evaluation exists", async () => {
    seedEnrolledStudent({
      evaluations: [
        {
          id: "eval-1",
          user_id: "stu-1",
          overall_assessment: "only one",
          strengths: [],
          weaknesses: [],
          recommendations: [],
          generated_at: "2026-05-01T00:00:00Z",
          instructor_feedback: null,
          is_manual: false,
        },
      ],
    });

    renderWithRouter(<StudentEvaluations courseId="course-1" />);

    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByText("Alice").closest("div")!.parentElement!.parentElement!);

    await waitFor(() => {
      expect(screen.getByText("only one")).toBeInTheDocument();
    });
    expect(
      screen.queryByRole("button", { name: /Compare Progress/i }),
    ).not.toBeInTheDocument();
  });

  it("deletes an evaluation via the confirm dialog", async () => {
    seedEnrolledStudent({
      evaluations: [
        {
          id: "eval-1",
          user_id: "stu-1",
          overall_assessment: "to be deleted",
          strengths: [],
          weaknesses: [],
          recommendations: [],
          generated_at: "2026-05-01T00:00:00Z",
          instructor_feedback: null,
          is_manual: false,
        },
      ],
    });

    renderWithRouter(<StudentEvaluations courseId="course-1" />);

    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByText("Alice").closest("div")!.parentElement!.parentElement!);

    await waitFor(() =>
      expect(screen.getByText("to be deleted")).toBeInTheDocument(),
    );

    // Find and click the destructive (trash) action button inside the evaluation header.
    const trashButtons = screen
      .getAllByRole("button")
      .filter((b) => b.className.includes("text-destructive"));
    expect(trashButtons.length).toBeGreaterThan(0);
    await user.click(trashButtons[0]);

    // Confirm in the alert dialog.
    const confirmDelete = await screen.findByRole("button", { name: /^Delete$/i });
    await user.click(confirmDelete);

    await waitFor(() => {
      const del = deleteCalls.find((c) => c.table === "student_evaluations");
      expect(del).toBeTruthy();
      expect(del!.id).toBe("eval-1");
    });
  });

  it("prompts to run an AI evaluation when Generate Questions is clicked with no evaluation", async () => {
    seedEnrolledStudent();
    // No evaluations at all → clicking must ask for an evaluation first.

    renderWithRouter(<StudentEvaluations courseId="course-1" />);

    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Generate Questions/i }));

    expect(
      await screen.findByText(/Run an AI evaluation first\?/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/has no evaluation yet/i)).toBeInTheDocument();
    // No usable evaluation → no stale-data escape hatch.
    expect(
      screen.queryByRole("button", { name: /Generate Anyway/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("generate-mcq-dialog")).not.toBeInTheDocument();
  });

  it("prompts with Generate Anyway when the latest evaluation is older than a week", async () => {
    const staleDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    seedEnrolledStudent({
      evaluations: [
        {
          id: "eval-1",
          user_id: "stu-1",
          overall_assessment: "stale but usable",
          strengths: [],
          weaknesses: ["Geometry"],
          recommendations: [],
          generated_at: staleDate,
          instructor_feedback: null,
          is_manual: false,
        },
      ],
    });

    renderWithRouter(<StudentEvaluations courseId="course-1" />);

    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Generate Questions/i }));

    expect(
      await screen.findByText(/Run an AI evaluation first\?/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/more than a week old/i)).toBeInTheDocument();

    // The stale evaluation still has content, so the instructor may proceed.
    await user.click(screen.getByRole("button", { name: /Generate Anyway/i }));
    await waitFor(() =>
      expect(screen.getByTestId("generate-mcq-dialog")).toBeInTheDocument(),
    );
  });

  it("opens the generate dialog directly when a recent usable evaluation exists", async () => {
    const recentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    seedEnrolledStudent({
      evaluations: [
        {
          id: "eval-1",
          user_id: "stu-1",
          overall_assessment: "fresh",
          strengths: [],
          weaknesses: ["Algebra"],
          recommendations: [],
          generated_at: recentDate,
          instructor_feedback: null,
          is_manual: false,
        },
      ],
    });

    renderWithRouter(<StudentEvaluations courseId="course-1" />);

    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Generate Questions/i }));

    await waitFor(() =>
      expect(screen.getByTestId("generate-mcq-dialog")).toBeInTheDocument(),
    );
    expect(
      screen.queryByText(/Run an AI evaluation first\?/i),
    ).not.toBeInTheDocument();
  });

  it("hides the Export PDF button when no student has evaluations", async () => {
    seedEnrolledStudent();

    renderWithRouter(<StudentEvaluations courseId="course-1" />);

    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /Export PDF/i })).not.toBeInTheDocument();
  });

  it("uses the offering_id prop to scope enrollment to a single class", async () => {
    responses["offerings__single"] = {
      data: { class_id: "cls-A" },
      error: null,
    } as any;
    responses.class_enrollments = {
      data: [{ user_id: "stu-A", class_id: "cls-A" }],
      error: null,
    };
    responses.classes = {
      data: [
        {
          id: "cls-A",
          name: "Single Class",
          grade_level_id: null,
          section_name: null,
          category: null,
          academic_period: null,
        },
      ],
      error: null,
    };
    responses.profiles = {
      data: [{ user_id: "stu-A", full_name: "Single Student", email: "single@test" }],
      error: null,
    };

    renderWithRouter(<StudentEvaluations courseId="course-1" offeringId="off-A" />);

    await waitFor(() =>
      expect(screen.getByText("Single Student")).toBeInTheDocument(),
    );
  });

  it("does not forward studentName to generate-student-evaluation (issue #557)", async () => {
    seedEnrolledStudent();
    // Need ≥3 interactions so the edge function path is taken.
    responses.quiz_answers = {
      data: [
        { user_id: "stu-1", is_correct: true, answered_at: "2026-05-01T00:00:00Z" },
        { user_id: "stu-1", is_correct: true, answered_at: "2026-05-02T00:00:00Z" },
        { user_id: "stu-1", is_correct: false, answered_at: "2026-05-03T00:00:00Z" },
      ],
      error: null,
    };
    responses["student_evaluations__single"] = {
      data: { id: "new-eval-1" },
      error: null,
    } as any;

    renderWithRouter(<StudentEvaluations courseId="course-1" />);

    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^AI Evaluation$/i }));

    await waitFor(() => {
      expect(
        invokedFunctions.some((c) => c.name === "generate-student-evaluation"),
      ).toBe(true);
    });

    for (const call of invokedFunctions) {
      if (call.name !== "generate-student-evaluation") {
        continue;
      }
      const body = call.body as Record<string, unknown>;
      expect(body).toBeDefined();
      expect(Object.keys(body)).not.toContain("studentName");
      expect(Object.keys(body)).not.toContain("student_name");
      expect(Object.keys(body)).not.toContain("full_name");
    }
  });

  it("stamps the student's offering on the generated evaluation (#1103)", async () => {
    seedEnrolledStudent();
    // Need >=3 interactions so the edge function path is taken.
    responses.quiz_answers = {
      data: [
        { user_id: "stu-1", is_correct: true, answered_at: "2026-05-01T00:00:00Z" },
        { user_id: "stu-1", is_correct: true, answered_at: "2026-05-02T00:00:00Z" },
        { user_id: "stu-1", is_correct: false, answered_at: "2026-05-03T00:00:00Z" },
      ],
      error: null,
    };
    responses["student_evaluations__single"] = {
      data: { id: "new-eval-1" },
      error: null,
    } as any;
    functionResponses["generate-student-evaluation"] = {
      data: {
        evaluation: {
          hasEnoughData: true,
          overallAssessment: "Solid progress",
          strengths: ["Algebra"],
          weaknesses: ["Geometry"],
          recommendations: ["Practice proofs"],
          competencyScores: [],
        },
      },
      error: null,
    };

    renderWithRouter(<StudentEvaluations courseId="course-1" />);

    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^AI Evaluation$/i }));

    await waitFor(() => {
      const insert = insertCalls.find((c) => c.table === "student_evaluations");
      expect(insert).toBeTruthy();
      // Without this the row is unattributed, and the write policy refuses it
      // for a section-restricted instructor.
      expect((insert!.values as Record<string, unknown>).offering_id).toBe("off-1");
    });
  });

  it("stamps the offering prop on a manually written evaluation (#1103)", async () => {
    responses["offerings__single"] = {
      data: { class_id: "cls-A" },
      error: null,
    } as any;
    responses.class_enrollments = {
      data: [{ user_id: "stu-A", class_id: "cls-A" }],
      error: null,
    };
    responses.classes = {
      data: [
        {
          id: "cls-A",
          name: "Single Class",
          grade_level_id: null,
          section_name: null,
          category: null,
          academic_period: null,
        },
      ],
      error: null,
    };
    responses.profiles = {
      data: [{ user_id: "stu-A", full_name: "Single Student", email: "single@test" }],
      error: null,
    };
    responses["student_evaluations__single"] = {
      data: { id: "new-eval-2" },
      error: null,
    } as any;

    renderWithRouter(<StudentEvaluations courseId="course-1" offeringId="off-A" />);

    await waitFor(() =>
      expect(screen.getByText("Single Student")).toBeInTheDocument(),
    );
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: /More evaluation actions/i }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: /Add Manual Evaluation/i }),
    );

    const textarea = await screen.findByPlaceholderText(
      /Write your overall assessment of the student's performance/i,
    );
    await user.type(textarea, "Catching up nicely");
    await user.click(screen.getByRole("button", { name: /Save Evaluation/i }));

    await waitFor(() => {
      const insert = insertCalls.find(
        (c) =>
          c.table === "student_evaluations" &&
          (c.values as Record<string, unknown>)?.is_manual === true,
      );
      expect(insert).toBeTruthy();
      expect((insert!.values as Record<string, unknown>).offering_id).toBe("off-A");
    });
  });

  it("renders both axes in the drill-down: engagement counts and performance averages", async () => {
    seedEnrolledStudent();
    responses.quiz_answers = {
      data: [
        // Practice answer (quiz_id null) vs a formal quiz submission.
        { user_id: "stu-1", is_correct: true, answered_at: "2026-05-01T00:00:00Z", quiz_id: null },
        { user_id: "stu-1", is_correct: false, answered_at: "2026-05-02T00:00:00Z", quiz_id: "quiz-1" },
      ],
      error: null,
    };
    responses.flashcard_reviews = {
      data: [
        { user_id: "stu-1", last_reviewed: "2026-05-03T00:00:00Z" },
        { user_id: "stu-1", last_reviewed: "2026-05-04T00:00:00Z" },
        { user_id: "stu-1", last_reviewed: "2026-05-05T00:00:00Z" },
      ],
      error: null,
    };
    responses.study_guide_answers = {
      data: [
        { user_id: "stu-1", grade: 80, submitted_at: "2026-05-06T00:00:00Z" },
        { user_id: "stu-1", grade: 60, submitted_at: "2026-05-07T00:00:00Z" },
      ],
      error: null,
    };

    renderWithRouter(<StudentEvaluations courseId="course-1" />);

    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByText("Alice").closest("div")!.parentElement!.parentElement!);

    await waitFor(() => {
      expect(screen.getByText("Engagement")).toBeInTheDocument();
    });
    expect(screen.getByText("Performance")).toBeInTheDocument();
    // Engagement counts: only the quiz_id-null answer is practice.
    expect(screen.getByText("Practice Questions").previousSibling).toHaveTextContent("1");
    expect(screen.getByText("Flashcards Reviewed").previousSibling).toHaveTextContent("3");
    expect(screen.getByText("Study Guide Answers").previousSibling).toHaveTextContent("2");
    // Performance: 1/2 quiz accuracy, study-guide average of 80 and 60.
    expect(screen.getByText("Quiz Accuracy").previousSibling).toHaveTextContent("50%");
    expect(screen.getByText("Study Guide Avg").previousSibling).toHaveTextContent("70.0");
    // Row-level engagement total: 2 quiz + 3 flashcards + 2 study guide.
    expect(screen.getByText("7 interactions")).toBeInTheDocument();
  });

  it("renders the per-assignment breakdown: completed work shows a score, open work a badge", async () => {
    seedEnrolledStudent();
    responses.offering_quizzes = {
      data: [
        { offering_id: "off-1", quiz_id: "quiz-1", group_id: null },
        { offering_id: "off-1", quiz_id: "quiz-2", group_id: null },
        // Group-scoped assignment whose group has no members — must not
        // appear for this student.
        { offering_id: "off-1", quiz_id: "quiz-3", group_id: "grp-1" },
      ],
      error: null,
    };
    responses.quizzes = {
      data: [
        { id: "quiz-1", title: "Chapter 1 Quiz" },
        { id: "quiz-2", title: "Chapter 2 Quiz" },
        { id: "quiz-3", title: "Group-only Quiz" },
      ],
      error: null,
    };
    responses.quiz_sessions = {
      data: [
        { user_id: "stu-1", quiz_id: "quiz-1", status: "completed", offering_id: "off-1" },
        // A finalised session in a different offering must not mark quiz-2
        // completed for the off-1 assignment.
        { user_id: "stu-1", quiz_id: "quiz-2", status: "completed", offering_id: "off-other" },
      ],
      error: null,
    };
    responses.quiz_answers = {
      data: [
        { user_id: "stu-1", is_correct: true, answered_at: "2026-05-01T00:00:00Z", quiz_id: "quiz-1", offering_id: "off-1" },
        { user_id: "stu-1", is_correct: false, answered_at: "2026-05-02T00:00:00Z", quiz_id: "quiz-1", offering_id: "off-1" },
        // Answer from another offering: excluded from the off-1 score.
        { user_id: "stu-1", is_correct: true, answered_at: "2026-05-03T00:00:00Z", quiz_id: "quiz-1", offering_id: "off-other" },
      ],
      error: null,
    };
    responses.offering_study_guides = {
      data: [
        { offering_id: "off-1", study_guide_id: "sg-1", group_id: null },
        { offering_id: "off-1", study_guide_id: "sg-2", group_id: null },
      ],
      error: null,
    };
    responses.study_guides = {
      data: [
        { id: "sg-1", title: "Guide One" },
        { id: "sg-2", title: "Guide Two" },
      ],
      error: null,
    };
    responses.study_guide_progress = {
      data: [
        { user_id: "stu-1", study_guide_id: "sg-1", completed_at: "2026-05-08T00:00:00Z", offering_id: "off-1" },
        // Completion in another offering must not mark the off-1 row done.
        { user_id: "stu-1", study_guide_id: "sg-2", completed_at: "2026-05-08T00:00:00Z", offering_id: "off-other" },
      ],
      error: null,
    };
    responses.study_guide_answers = {
      data: [
        { user_id: "stu-1", grade: 80, submitted_at: "2026-05-06T00:00:00Z", study_guide_id: "sg-1", offering_id: "off-1" },
        { user_id: "stu-1", grade: 60, submitted_at: "2026-05-07T00:00:00Z", study_guide_id: "sg-1", offering_id: "off-1" },
        // Graded answer from another offering: excluded from the off-1 average.
        { user_id: "stu-1", grade: 0, submitted_at: "2026-05-09T00:00:00Z", study_guide_id: "sg-1", offering_id: "off-other" },
      ],
      error: null,
    };

    renderWithRouter(<StudentEvaluations courseId="course-1" />);

    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByText("Alice").closest("div")!.parentElement!.parentElement!);

    await waitFor(() => {
      expect(screen.getByText("Chapter 1 Quiz")).toBeInTheDocument();
    });
    // Completed quiz: percentage plus raw correct/total.
    expect(screen.getByText("Chapter 1 Quiz").parentElement).toHaveTextContent("50%");
    expect(screen.getByText("Chapter 1 Quiz").parentElement).toHaveTextContent("(1/2)");
    // Assigned but not completed: an Open badge, no score.
    expect(screen.getByText("Chapter 2 Quiz").parentElement).toHaveTextContent("Open");
    // Group-scoped assignment for a group the student is not in.
    expect(screen.queryByText("Group-only Quiz")).not.toBeInTheDocument();
    // Study guides: completed one shows the average grade, open one a badge.
    expect(screen.getByText("Guide One").parentElement).toHaveTextContent("70.0");
    expect(screen.getByText("Guide Two").parentElement).toHaveTextContent("Open");
  });

  it("renders the engagement axis stored on a saved evaluation", async () => {
    seedEnrolledStudent({
      evaluations: [
        {
          id: "eval-1",
          user_id: "stu-1",
          overall_assessment: "Strong quiz work",
          strengths: [],
          weaknesses: [],
          recommendations: [],
          generated_at: "2026-05-01T00:00:00Z",
          instructor_feedback: null,
          is_manual: false,
          stats: {
            engagement: {
              level: "high",
              summary: "Very active across practice and flashcards.",
              counts: { practiceQuestionsAnswered: 40 },
            },
          },
        },
      ],
    });

    renderWithRouter(<StudentEvaluations courseId="course-1" />);

    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByText("Alice").closest("div")!.parentElement!.parentElement!);

    await waitFor(() => {
      expect(
        screen.getByText("Very active across practice and flashcards."),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("high")).toBeInTheDocument();
  });

  it("persists the engagement axis returned by the edge function into stats", async () => {
    seedEnrolledStudent();
    responses.quiz_answers = {
      data: [
        { user_id: "stu-1", is_correct: true, answered_at: "2026-05-01T00:00:00Z" },
        { user_id: "stu-1", is_correct: true, answered_at: "2026-05-02T00:00:00Z" },
        { user_id: "stu-1", is_correct: false, answered_at: "2026-05-03T00:00:00Z" },
      ],
      error: null,
    };
    responses["student_evaluations__single"] = {
      data: { id: "new-eval-1" },
      error: null,
    } as any;
    functionResponses["generate-student-evaluation"] = {
      data: {
        evaluation: {
          hasEnoughData: true,
          overallAssessment: "Solid progress",
          strengths: [],
          weaknesses: [],
          recommendations: [],
          competencyScores: [],
          engagement: {
            level: "moderate",
            summary: "Steady platform use.",
            counts: { practiceQuestionsAnswered: 3 },
          },
        },
      },
      error: null,
    };

    renderWithRouter(<StudentEvaluations courseId="course-1" />);

    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^AI Evaluation$/i }));

    await waitFor(() => {
      const insert = insertCalls.find((c) => c.table === "student_evaluations");
      expect(insert).toBeTruthy();
      const stats = (insert!.values as Record<string, any>).stats;
      expect(stats.engagement).toEqual({
        level: "moderate",
        summary: "Steady platform use.",
        counts: { practiceQuestionsAnswered: 3 },
      });
      expect(stats.flashcardReviews).toBe(0);
      expect(stats.studyGuideAnswers).toBe(0);
    });
    // And the fresh evaluation renders its engagement axis immediately.
    await waitFor(() => {
      expect(screen.getByText("Steady platform use.")).toBeInTheDocument();
    });
  });

  it("renders inline AI/Manual badges on the latest evaluation collapsible", async () => {
    seedEnrolledStudent({
      evaluations: [
        {
          id: "eval-1",
          user_id: "stu-1",
          overall_assessment: "ai-generated",
          strengths: [],
          weaknesses: [],
          recommendations: [],
          generated_at: "2026-05-01T00:00:00Z",
          instructor_feedback: null,
          is_manual: false,
        },
      ],
    });

    renderWithRouter(<StudentEvaluations courseId="course-1" />);

    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByText("Alice").closest("div")!.parentElement!.parentElement!);

    await waitFor(() => {
      expect(screen.getByText("ai-generated")).toBeInTheDocument();
    });
    // Badge text appears alongside the bot/user icons inside the collapsible trigger.
    expect(screen.getByText("AI")).toBeInTheDocument();
    expect(screen.getByText("Latest")).toBeInTheDocument();
  });
});
