/**
 * #873 — ClassCompetencyAnalytics aggregates the latest per-student evaluation
 * scores per competency. Covers the aggregation math (average, evaluated / no-
 * data counts, latest-evaluation-per-user, null-score handling) plus the two
 * empty states (no competencies, no evaluations).
 *
 * Data flows through four sequential tables:
 *   class_enrollments → course_competencies → student_evaluations →
 *   evaluation_competency_scores
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

type Result = { data: unknown; error: unknown };

const enrollmentResponse = vi.hoisted(() => ({ current: { data: [], error: null } as Result }));
const competencyResponse = vi.hoisted(() => ({ current: { data: [], error: null } as Result }));
const evaluationResponse = vi.hoisted(() => ({ current: { data: [], error: null } as Result }));
const scoresResponse = vi.hoisted(() => ({ current: { data: [], error: null } as Result }));

vi.mock("@/integrations/supabase/client", () => {
  const buildChain = (table: string) => {
    // Capture the evaluation_id filter so the scores table only returns rows
    // for the *latest* evaluations, exactly as the real `.in()` query would —
    // this is what makes the "stale evaluation is ignored" assertion real.
    let evaluationIdFilter: string[] | null = null;
    const chain: Record<string, (...a: unknown[]) => unknown> = {};
    const passThrough = () => chain;
    chain.select = passThrough;
    chain.eq = passThrough;
    chain.in = (column: string, values: string[]) => {
      if (table === "evaluation_competency_scores" && column === "evaluation_id") {
        evaluationIdFilter = values;
      }
      return chain;
    };
    // Terminal resolvers differ by table.
    chain.order = () => {
      if (table === "course_competencies") {
        return Promise.resolve(competencyResponse.current);
      }
      if (table === "student_evaluations") {
        return Promise.resolve(evaluationResponse.current);
      }
      return chain;
    };
    // `class_enrollments` and `evaluation_competency_scores` are awaited
    // directly (no .order/.single terminal) — resolve them via `.then`.
    chain.then = (resolve: (v: unknown) => unknown) => {
      if (table === "class_enrollments") {
        return Promise.resolve(resolve(enrollmentResponse.current));
      }
      if (table === "evaluation_competency_scores") {
        const resp = scoresResponse.current;
        const filtered = evaluationIdFilter
          ? {
              data: (resp.data as { evaluation_id: string }[]).filter((r) =>
                evaluationIdFilter!.includes(r.evaluation_id),
              ),
              error: resp.error,
            }
          : resp;
        return Promise.resolve(resolve(filtered));
      }
      return Promise.resolve(resolve({ data: [], error: null }));
    };
    return chain;
  };
  return { supabase: { from: vi.fn((t: string) => buildChain(t)) } };
});

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: toastMocks }));

import { ClassCompetencyAnalytics } from "@/components/ClassCompetencyAnalytics";

const classes = [
  { id: "cls-1", name: "A1", grade_level_id: null, section_name: null, is_active: true },
];

beforeEach(() => {
  vi.clearAllMocks();
  enrollmentResponse.current = { data: [], error: null };
  competencyResponse.current = { data: [], error: null };
  evaluationResponse.current = { data: [], error: null };
  scoresResponse.current = { data: [], error: null };
});

describe("ClassCompetencyAnalytics (#873)", () => {
  it("aggregates the latest evaluation per student into per-competency averages", async () => {
    enrollmentResponse.current = {
      data: [{ user_id: "s1" }, { user_id: "s2" }, { user_id: "s3" }],
      error: null,
    };
    competencyResponse.current = {
      data: [
        { id: "c1", title: "Cell Division", order_num: 0 },
        { id: "c2", title: "Genetics", order_num: 1 },
      ],
      error: null,
    };
    // s1 has a newer (eval-1b) and older (eval-1a) evaluation — only the newer
    // one must count. Rows are returned newest-first (component relies on the
    // generated_at desc order).
    evaluationResponse.current = {
      data: [
        { id: "eval-1b", user_id: "s1", generated_at: "2026-05-01T10:00:00Z" },
        { id: "eval-2", user_id: "s2", generated_at: "2026-04-20T10:00:00Z" },
        { id: "eval-1a", user_id: "s1", generated_at: "2026-03-01T10:00:00Z" },
        // s3 has no evaluation at all.
      ],
      error: null,
    };
    scoresResponse.current = {
      data: [
        // c1: s1=80 (high), s2=30 (low) → avg 55
        { evaluation_id: "eval-1b", competency_id: "c1", score: 80 },
        { evaluation_id: "eval-2", competency_id: "c1", score: 30 },
        // c2: s1=60 (mid), s2=null (insufficient) → avg 60, one nullCount
        { evaluation_id: "eval-1b", competency_id: "c2", score: 60 },
        { evaluation_id: "eval-2", competency_id: "c2", score: null },
        // Stale score from the older s1 evaluation must be ignored.
        { evaluation_id: "eval-1a", competency_id: "c1", score: 10 },
      ],
      error: null,
    };

    render(<ClassCompetencyAnalytics courseId="course-1" classes={classes} selectedClassId="cls-1" />);

    await waitFor(() => {
      expect(screen.getByText("Cell Division")).toBeInTheDocument();
    });

    // 2 of 3 students have a numeric score in their latest evaluation.
    expect(screen.getByText("2/3 students evaluated")).toBeInTheDocument();

    // c1 average = round((80 + 30) / 2) = 55
    expect(screen.getByText("55/100")).toBeInTheDocument();
    // c2 average = round(60 / 1) = 60 (the null score is excluded)
    expect(screen.getByText("60/100")).toBeInTheDocument();

    // c1 evaluated 2/3, c2 evaluated 1/3.
    expect(screen.getByText("2/3")).toBeInTheDocument();
    expect(screen.getByText("1/3")).toBeInTheDocument();
  });

  it("shows the no-competencies empty state", async () => {
    enrollmentResponse.current = { data: [{ user_id: "s1" }], error: null };
    competencyResponse.current = { data: [], error: null };

    render(<ClassCompetencyAnalytics courseId="course-1" classes={classes} selectedClassId="cls-1" />);

    await waitFor(() => {
      expect(screen.getByText("No competencies defined")).toBeInTheDocument();
    });
  });

  it("shows the no-evaluation-data empty state when competencies exist but nobody is scored", async () => {
    enrollmentResponse.current = {
      data: [{ user_id: "s1" }, { user_id: "s2" }],
      error: null,
    };
    competencyResponse.current = {
      data: [{ id: "c1", title: "Cell Division", order_num: 0 }],
      error: null,
    };
    // No evaluations → no scores.
    evaluationResponse.current = { data: [], error: null };
    scoresResponse.current = { data: [], error: null };

    render(<ClassCompetencyAnalytics courseId="course-1" classes={classes} selectedClassId="cls-1" />);

    await waitFor(() => {
      expect(screen.getByText("No evaluation data yet")).toBeInTheDocument();
    });
  });

  it("shows the no-evaluation-data empty state when no students are enrolled", async () => {
    enrollmentResponse.current = { data: [], error: null };
    competencyResponse.current = {
      data: [{ id: "c1", title: "Cell Division", order_num: 0 }],
      error: null,
    };

    render(<ClassCompetencyAnalytics courseId="course-1" classes={classes} selectedClassId="cls-1" />);

    await waitFor(() => {
      expect(screen.getByText("No evaluation data yet")).toBeInTheDocument();
    });
  });
});
