import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

type Result = { data?: unknown; error?: unknown };
type Responder = Result | ((select: string) => Result);

const mockNavigate = vi.hoisted(() => vi.fn());
const mockToast = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));

const authState = vi.hoisted(() => ({
  user: { id: "viewer-1" } as { id: string } | null,
  profile: { role: "admin" } as { role: string } | null,
  loading: false,
}));

/**
 * The viewer's own role, as `useUserInstitution` reports it.
 *
 * It used to be read from `authState.profile.role`. `Profile` has no `role`
 * field — roles live on `user_institutions` — so the guard under test could
 * never fire in production, and this suite passed only because the fixture
 * invented a shape the app never builds.
 */
const membershipState = vi.hoisted(() => ({ isStudent: false, loading: false }));

vi.mock("@/hooks/useUserInstitution", () => ({
  useUserInstitution: () => ({
    membership: null,
    loading: membershipState.loading,
    institutionId: null,
    role: membershipState.isStudent ? "student" : "admin",
    isAdmin: !membershipState.isStudent,
    isInstructor: false,
    isStudent: membershipState.isStudent,
    isEvaluator: false,
    refetch: vi.fn(),
  }),
}));

/**
 * Responses keyed by table. A function receives the `select(...)` string so a
 * table queried with more than one shape can answer differently per call site.
 */
const responses: Record<string, Responder> = {};
const rpcResults: Record<string, Result> = {};

interface QueryRecord {
  table: string;
  select: string;
  filters: Array<[string, unknown]>;
  inFilters: Array<[string, unknown[]]>;
  orders: Array<{ column: string; ascending: boolean }>;
}

/**
 * Every query the page issues, in order. The mock both *records* the
 * modifiers and *applies* `.in()` / `.order()` to the fixture, so a
 * production query that loses its institution filter or its newest-first
 * ordering breaks these tests rather than sliding by on a conveniently
 * pre-sorted fixture.
 */
const queryLog: QueryRecord[] = [];

const queryFor = (table: string, matchSelect?: string): QueryRecord | undefined =>
  queryLog.find(
    (r) => r.table === table && (matchSelect === undefined || r.select.includes(matchSelect)),
  );

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock("sonner", () => ({ toast: mockToast }));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({
    user: authState.user,
    profile: authState.profile,
    loading: authState.loading,
  }),
}));

vi.mock("@/hooks/useInstitutionGradeLevels", () => ({
  useInstitutionGradeLevels: () => ({
    rows: [],
    options: [],
    loading: false,
    findIdByCode: () => null,
    findCodeById: () => null,
    getLabel: () => "",
    getLabelById: (id: string | null | undefined) =>
      id === "gl-1" ? "Α΄ Γυμνασίου" : "",
  }),
}));

vi.mock("@/components/student-evaluations/CompetencyScoreEditor", () => ({
  CompetencyScoreEditor: ({
    entry,
    canEdit,
    evaluationId,
  }: {
    entry: { title: string; score: number | null };
    canEdit: boolean;
    evaluationId: string;
  }) => (
    <div
      data-testid={`competency-${entry.title}`}
      data-can-edit={String(canEdit)}
      data-evaluation-id={evaluationId}
    >
      {entry.title}: {entry.score ?? "—"}
    </div>
  ),
}));

vi.mock("@/integrations/supabase/client", () => {
  const buildChain = (table: string) => {
    const record: QueryRecord = {
      table,
      select: "",
      filters: [],
      inFilters: [],
      orders: [],
    };
    queryLog.push(record);

    const chain: Record<string, (...a: unknown[]) => unknown> = {};

    /** Apply the recorded `.in()` / `.order()` modifiers to array fixtures. */
    const applyModifiers = (result: Result): Result => {
      if (!Array.isArray(result.data)) return result;
      let rows = result.data as Array<Record<string, unknown>>;
      for (const [column, values] of record.inFilters) {
        rows = rows.filter((row) => values.includes(row[column]));
      }
      // Later .order() calls are the outer sort key in PostgREST, so apply in
      // reverse for a stable multi-key sort.
      for (const { column, ascending } of [...record.orders].reverse()) {
        rows = [...rows].sort((a, b) => {
          const av = a[column] as string | number;
          const bv = b[column] as string | number;
          if (av === bv) return 0;
          return (av > bv ? 1 : -1) * (ascending ? 1 : -1);
        });
      }
      return { ...result, data: rows };
    };

    const resolveResult = (): Result => {
      const responder = responses[table];
      const base =
        typeof responder === "function"
          ? responder(record.select)
          : (responder ?? { data: [], error: null });
      return applyModifiers(base);
    };

    chain.select = (arg: unknown) => {
      record.select = typeof arg === "string" ? arg : "";
      return chain;
    };
    chain.eq = (column: unknown, value: unknown) => {
      record.filters.push([column as string, value]);
      return chain;
    };
    chain.in = (column: unknown, values: unknown) => {
      record.inFilters.push([column as string, (values ?? []) as unknown[]]);
      return chain;
    };
    chain.order = (column: unknown, opts?: unknown) => {
      record.orders.push({
        column: column as string,
        ascending: (opts as { ascending?: boolean } | undefined)?.ascending !== false,
      });
      return chain;
    };
    chain.limit = () => chain;
    chain.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(resolve(resolveResult()));
    chain.single = () => Promise.resolve(resolveResult());
    chain.maybeSingle = chain.single;
    return chain;
  };

  return {
    supabase: {
      from: vi.fn((table: string) => buildChain(table)),
      rpc: vi.fn(async (name: string) => rpcResults[name] ?? { data: null, error: null }),
    },
  };
});

import StudentProfile from "@/pages/StudentProfile";
import { supabase } from "@/integrations/supabase/client";

const membership = {
  id: "ui-1",
  user_id: "student-1",
  institution_id: "inst-1",
  role: "student",
  grade_level_id: "gl-1",
  created_at: "2026-01-10T08:00:00.000Z",
};

const studentProfileRow = {
  user_id: "student-1",
  full_name: "Maria Nikolaou",
  email: "maria@test.local",
  father_name: "Giorgos",
  date_of_birth: "2010-04-15",
};

/** One active class/offering (Algebra) and one inactive one (History). */
const enrollmentRows = [
  {
    class_id: "class-1",
    role: "student",
    enrolled_at: "2026-01-10T08:00:00.000Z",
    classes: {
      id: "class-1",
      name: "A1",
      grade_level_id: "gl-1",
      section_name: "A",
      category: null,
      is_active: true,
      institution_id: "inst-1",
      offerings: [
        {
          id: "off-1",
          course_id: "course-algebra",
          is_active: true,
          courses: { id: "course-algebra", title: "Algebra" },
        },
      ],
    },
  },
  {
    class_id: "class-2",
    role: "student",
    enrolled_at: "2025-09-01T08:00:00.000Z",
    classes: {
      id: "class-2",
      name: "B2",
      grade_level_id: "gl-1",
      section_name: "B",
      category: null,
      is_active: false,
      institution_id: "inst-1",
      offerings: [
        {
          id: "off-2",
          course_id: "course-history",
          is_active: true,
          courses: { id: "course-history", title: "History" },
        },
      ],
    },
  },
];

/**
 * Deliberately in *ascending* generated_at order — the page relies on the
 * query's `.order("generated_at", { ascending: false })` to surface the latest
 * evaluation, so a pre-sorted fixture would hide the loss of that ordering.
 */
const evaluationRows = [
  {
    id: "eval-older",
    course_id: "course-algebra",
    offering_id: "off-1",
    overall_assessment: "Getting started.",
    strengths: [],
    weaknesses: [],
    recommendations: [],
    generated_at: "2026-01-15T09:00:00.000Z",
    instructor_feedback: null,
    is_manual: true,
  },
  {
    id: "eval-latest",
    course_id: "course-algebra",
    offering_id: "off-1",
    overall_assessment: "Strong grasp of linear equations.",
    strengths: ["Factoring"],
    weaknesses: ["Word problems"],
    recommendations: ["More practice sets"],
    generated_at: "2026-03-01T09:00:00.000Z",
    instructor_feedback: "Great improvement this term.",
    is_manual: false,
  },
];

const latestEvaluationRow = evaluationRows.find((e) => e.id === "eval-latest")!;

const competencyScoreRows = [
  {
    evaluation_id: "eval-latest",
    competency_id: "cc-2",
    score: 71,
    rationale: "Solid",
    is_manual: false,
    course_competencies: { id: "cc-2", title: "Quadratics" },
  },
  {
    evaluation_id: "eval-latest",
    competency_id: "cc-1",
    score: null,
    rationale: null,
    is_manual: false,
    course_competencies: { id: "cc-1", title: "Fractions" },
  },
];

const renderProfile = (userId = "student-1") => {
  // Fresh client per render: InstructorHomeButton in the header runs a
  // react-query lookup, and a shared cache would leak role answers between
  // tests.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/students/${userId}`]}>
        <Routes>
          <Route path="/students/:userId" element={<StudentProfile />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  queryLog.length = 0;
  for (const key of Object.keys(responses)) delete responses[key];
  for (const key of Object.keys(rpcResults)) delete rpcResults[key];

  authState.user = { id: "viewer-1" };
  authState.profile = { role: "admin" };
  authState.loading = false;

  membershipState.isStudent = false;
  membershipState.loading = false;

  sessionStorage.setItem("selectedInstitutionId", "inst-1");

  rpcResults.is_super_admin = { data: false, error: null };
  rpcResults.is_institution_admin = { data: true, error: null };

  responses.user_institutions = { data: [membership], error: null };
  responses.profiles = { data: studentProfileRow, error: null };
  responses.institutions = { data: { id: "inst-1", name: "Test Gymnasio" }, error: null };
  responses.student_evaluations = { data: evaluationRows, error: null };
  responses.evaluation_competency_scores = { data: competencyScoreRows, error: null };
  responses.class_enrollments = (select: string) =>
    select.includes("classes!inner")
      ? { data: enrollmentRows, error: null }
      : { data: [], error: null };
});

afterEach(() => {
  sessionStorage.clear();
});

describe("StudentProfile", () => {
  describe("route guards", () => {
    it("sends an unauthenticated visitor to /auth", async () => {
      authState.user = null;

      renderProfile();

      await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith("/auth"));
    });

    it("sends a student to their own dashboard", async () => {
      membershipState.isStudent = true;

      renderProfile();

      await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith("/student"));
    });
  });

  describe("access control", () => {
    it("shows not-found when the id has no student membership in the institution", async () => {
      responses.user_institutions = { data: [], error: null };

      renderProfile();

      await waitFor(() => expect(screen.getByText("Student not found")).toBeInTheDocument());
    });

    it("denies an instructor who does not teach the student", async () => {
      rpcResults.is_institution_admin = { data: false, error: null };
      rpcResults.instructor_teaches_student = { data: false, error: null };

      renderProfile();

      await waitFor(() => expect(screen.getByText("Access denied")).toBeInTheDocument());
    });

    it("admits an instructor who teaches the student", async () => {
      rpcResults.is_institution_admin = { data: false, error: null };
      rpcResults.instructor_teaches_student = { data: true, error: null };

      renderProfile();

      await waitFor(() =>
        expect(screen.getByRole("heading", { name: "Maria Nikolaou" })).toBeInTheDocument(),
      );
    });

    it("asks about the student and their own institution, naming no instructor", async () => {
      // Which ids go where is not cosmetic: defaulting the institution would
      // ask a question whose answer happens to be true for the wrong reason.
      // And the viewer is deliberately absent — the function reads the caller
      // from auth.uid(), so passing one would be a rpc anyone could point at
      // anyone.
      rpcResults.is_institution_admin = { data: false, error: null };
      rpcResults.instructor_teaches_student = { data: true, error: null };

      renderProfile();

      await waitFor(() =>
        expect(screen.getByRole("heading", { name: "Maria Nikolaou" })).toBeInTheDocument(),
      );

      const call = (supabase.rpc as unknown as Mock).mock.calls.find(
        ([name]: [string]) => name === "instructor_teaches_student",
      );
      expect(call).toBeTruthy();
      expect(call![1]).toEqual({
        _student_id: "student-1",
        _institution_id: "inst-1",
      });
    });

    it("does not reconstruct the relationship from section rows", async () => {
      // The bug this replaced: the check intersected the student's classes with
      // the viewer's `course_instructor_sections` rows, but an unrestricted
      // instructor has none of those — no rows means full access (#59), not no
      // access — so the page denied exactly the people entitled to everything.
      // The fixture below is that instructor: no section rows anywhere.
      rpcResults.is_institution_admin = { data: false, error: null };
      rpcResults.instructor_teaches_student = { data: true, error: null };
      responses.course_instructor_sections = { data: [], error: null };

      renderProfile();

      await waitFor(() =>
        expect(screen.getByRole("heading", { name: "Maria Nikolaou" })).toBeInTheDocument(),
      );
      expect(queryFor("course_instructor_sections")).toBeUndefined();
    });

    it("admits a super-admin without an institution-admin check", async () => {
      rpcResults.is_super_admin = { data: true, error: null };
      rpcResults.is_institution_admin = { data: false, error: null };

      renderProfile();

      await waitFor(() =>
        expect(screen.getByRole("heading", { name: "Maria Nikolaou" })).toBeInTheDocument(),
      );
    });
  });

  describe("query scoping", () => {
    it("scopes the membership lookup to the selected institution", async () => {
      renderProfile();

      await waitFor(() => expect(queryFor("user_institutions")).toBeDefined());
      const q = queryFor("user_institutions")!;
      expect(q.filters).toContainEqual(["user_id", "student-1"]);
      expect(q.filters).toContainEqual(["role", "student"]);
      expect(q.filters).toContainEqual(["institution_id", "inst-1"]);
    });

    it("drops the institution filter when no institution is selected", async () => {
      sessionStorage.removeItem("selectedInstitutionId");

      renderProfile();

      await waitFor(() => expect(queryFor("user_institutions")).toBeDefined());
      const q = queryFor("user_institutions")!;
      expect(q.filters).toContainEqual(["user_id", "student-1"]);
      expect(q.filters.map(([col]) => col)).not.toContain("institution_id");
    });

    it("reads evaluations newest-first for the student", async () => {
      renderProfile();

      await waitFor(() => expect(queryFor("student_evaluations")).toBeDefined());
      const q = queryFor("student_evaluations")!;
      expect(q.filters).toContainEqual(["user_id", "student-1"]);
      expect(q.orders).toContainEqual({ column: "generated_at", ascending: false });
    });

    it("scopes the enrolment join to the student's institution", async () => {
      renderProfile();

      await waitFor(() => expect(queryFor("class_enrollments", "classes!inner")).toBeDefined());
      const q = queryFor("class_enrollments", "classes!inner")!;
      expect(q.filters).toContainEqual(["user_id", "student-1"]);
      expect(q.filters).toContainEqual(["classes.institution_id", "inst-1"]);
    });

    it("fetches competency scores only for the evaluations it will render", async () => {
      responses.student_evaluations = {
        data: [
          ...evaluationRows,
          {
            ...evaluationRows[0],
            id: "eval-orphan",
            course_id: "course-not-enrolled",
          },
        ],
        error: null,
      };

      renderProfile();

      await waitFor(() => expect(queryFor("evaluation_competency_scores")).toBeDefined());
      const q = queryFor("evaluation_competency_scores")!;
      expect(q.inFilters).toHaveLength(1);
      const [column, ids] = q.inFilters[0];
      expect(column).toBe("evaluation_id");
      expect([...(ids as string[])].sort()).toEqual(["eval-latest", "eval-older"]);
    });
  });

  describe("student information", () => {
    it("renders the identity fields", async () => {
      renderProfile();

      await waitFor(() => expect(screen.getByText("Student information")).toBeInTheDocument());
      expect(screen.getByText("maria@test.local")).toBeInTheDocument();
      expect(screen.getByText("Giorgos")).toBeInTheDocument();
      expect(screen.getByText("Test Gymnasio")).toBeInTheDocument();
      expect(screen.getByText("Α΄ Γυμνασίου")).toBeInTheDocument();
    });

    it("falls back to a placeholder for a missing name", async () => {
      responses.profiles = { data: { ...studentProfileRow, full_name: null }, error: null };

      renderProfile();

      await waitFor(() => expect(screen.getByText("Unnamed student")).toBeInTheDocument());
    });

    it("renders an em-dash for absent optional fields", async () => {
      responses.profiles = {
        data: { ...studentProfileRow, father_name: null, date_of_birth: null },
        error: null,
      };

      renderProfile();

      await waitFor(() => expect(screen.getByText("Student information")).toBeInTheDocument());
      expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("courses", () => {
    it("separates active from past courses", async () => {
      renderProfile();

      await waitFor(() => expect(screen.getByText("Active courses")).toBeInTheDocument());
      expect(screen.getByText("Past courses")).toBeInTheDocument();
      expect(screen.getByText("Algebra")).toBeInTheDocument();
      expect(screen.getByText("History")).toBeInTheDocument();
    });

    it("omits the past-courses section when every course is active", async () => {
      responses.class_enrollments = (select: string) =>
        select.includes("classes!inner")
          ? { data: [enrollmentRows[0]], error: null }
          : { data: [], error: null };

      renderProfile();

      await waitFor(() => expect(screen.getByText("Algebra")).toBeInTheDocument());
      expect(screen.queryByText("Past courses")).not.toBeInTheDocument();
    });

    it("shows the empty state when the student has no enrolments", async () => {
      responses.class_enrollments = () => ({ data: [], error: null });

      renderProfile();

      await waitFor(() =>
        expect(
          screen.getByText("This student is not enrolled in any courses yet."),
        ).toBeInTheDocument(),
      );
    });

    it("counts the evaluations attached to each course", async () => {
      renderProfile();

      await waitFor(() => expect(screen.getByText("Algebra")).toBeInTheDocument());
      expect(screen.getByText("2 evals")).toBeInTheDocument();
      expect(screen.getByText("0 evals")).toBeInTheDocument();
    });

    it("tells the instructor when a course has no evaluation yet", async () => {
      renderProfile();

      await waitFor(() =>
        expect(
          screen.getByText("No evaluation generated for this course yet."),
        ).toBeInTheDocument(),
      );
    });
  });

  describe("evaluations", () => {
    it("renders the latest evaluation summary for a course", async () => {
      renderProfile();

      await waitFor(() =>
        expect(screen.getByText("Strong grasp of linear equations.")).toBeInTheDocument(),
      );
      expect(screen.getByText("Factoring")).toBeInTheDocument();
      expect(screen.getByText("Word problems")).toBeInTheDocument();
      expect(screen.getByText("More practice sets")).toBeInTheDocument();
    });

    it("renders instructor feedback when present", async () => {
      renderProfile();

      await waitFor(() =>
        expect(screen.getByText("Great improvement this term.")).toBeInTheDocument(),
      );
      expect(screen.getByText("Instructor feedback")).toBeInTheDocument();
    });

    it("keeps older evaluations collapsed behind a history toggle", async () => {
      renderProfile();

      await waitFor(() =>
        expect(screen.getByText("Show evaluation history (1)")).toBeInTheDocument(),
      );
      expect(screen.queryByText("Getting started.")).not.toBeInTheDocument();

      await userEvent.click(screen.getByText("Show evaluation history (1)"));

      await waitFor(() => expect(screen.getByText("Getting started.")).toBeInTheDocument());
      expect(screen.getByText("Hide evaluation history (1)")).toBeInTheDocument();
    });

    it("marks manual evaluations in the history", async () => {
      renderProfile();

      await waitFor(() =>
        expect(screen.getByText("Show evaluation history (1)")).toBeInTheDocument(),
      );
      await userEvent.click(screen.getByText("Show evaluation history (1)"));

      await waitFor(() => expect(screen.getByText("manual")).toBeInTheDocument());
    });

    it("renders 'None recorded.' for an evaluation with empty bullet lists", async () => {
      renderProfile();

      await waitFor(() =>
        expect(screen.getByText("Show evaluation history (1)")).toBeInTheDocument(),
      );
      await userEvent.click(screen.getByText("Show evaluation history (1)"));

      await waitFor(() =>
        expect(screen.getAllByText("None recorded.").length).toBe(3),
      );
    });

    it("hides the history toggle when a course has a single evaluation", async () => {
      responses.student_evaluations = { data: [latestEvaluationRow], error: null };

      renderProfile();

      await waitFor(() =>
        expect(screen.getByText("Strong grasp of linear equations.")).toBeInTheDocument(),
      );
      expect(screen.queryByText(/evaluation history/)).not.toBeInTheDocument();
    });

    it("ignores evaluations for courses the student is not enrolled in", async () => {
      responses.student_evaluations = {
        data: [
          ...evaluationRows,
          {
            ...evaluationRows[0],
            id: "eval-orphan",
            course_id: "course-not-enrolled",
            overall_assessment: "Orphaned evaluation",
          },
        ],
        error: null,
      };

      renderProfile();

      await waitFor(() => expect(screen.getByText("Algebra")).toBeInTheDocument());
      expect(screen.queryByText("Orphaned evaluation")).not.toBeInTheDocument();
    });
  });

  describe("competency scores", () => {
    it("renders the latest evaluation's competency scores sorted by title", async () => {
      renderProfile();

      await waitFor(() =>
        expect(screen.getByText("Course competency scores")).toBeInTheDocument(),
      );
      const cells = screen.getAllByTestId(/^competency-/);
      expect(cells.map((c) => c.getAttribute("data-testid"))).toEqual([
        "competency-Fractions",
        "competency-Quadratics",
      ]);
      expect(screen.getByTestId("competency-Quadratics")).toHaveTextContent("Quadratics: 71");
      expect(screen.getByTestId("competency-Fractions")).toHaveTextContent("Fractions: —");
    });

    it("renders competency scores read-only on this page", async () => {
      renderProfile();

      await waitFor(() =>
        expect(screen.getByTestId("competency-Quadratics")).toBeInTheDocument(),
      );
      for (const cell of screen.getAllByTestId(/^competency-/)) {
        expect(cell).toHaveAttribute("data-can-edit", "false");
        expect(cell).toHaveAttribute("data-evaluation-id", "eval-latest");
      }
    });

    it("omits the competency section when the latest evaluation has no scores", async () => {
      responses.evaluation_competency_scores = { data: [], error: null };

      renderProfile();

      await waitFor(() =>
        expect(screen.getByText("Strong grasp of linear equations.")).toBeInTheDocument(),
      );
      expect(screen.queryByText("Course competency scores")).not.toBeInTheDocument();
    });
  });
});
