import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

type Result = { data: unknown; error: unknown };

/**
 * Awaited-chain responses, keyed by table. Used when the component `await`s a
 * builder without `.single()` / `.maybeSingle()`.
 */
const listResponses: Record<string, Result> = {};

/**
 * `.single()` / `.maybeSingle()` responses, keyed by table. A queue: each call
 * shifts the next entry, and the final entry stays sticky. The timeline reads
 * `evaluation_timeline_cache` twice per generate (once to hydrate, once to
 * decide insert-vs-update), so ordering matters.
 */
const singleQueues: Record<string, Result[]> = {};

const insertCalls: Array<{ table: string; values: unknown }> = [];
const updateCalls: Array<{ table: string; values: unknown }> = [];

const invokeResult: { data: unknown; error: unknown } = { data: null, error: null };
const invokedFunctions: Array<{ name: string; body: unknown }> = [];

vi.mock("@/integrations/supabase/client", () => {
  const buildChain = (table: string) => {
    const chain: Record<string, (...a: unknown[]) => unknown> = {};
    const passThrough = () => chain;
    chain.select = passThrough;
    chain.eq = passThrough;
    chain.in = passThrough;
    chain.order = passThrough;
    chain.limit = passThrough;
    chain.update = (values: unknown) => {
      updateCalls.push({ table, values });
      return chain;
    };
    chain.insert = (values: unknown) => {
      insertCalls.push({ table, values });
      return chain;
    };
    chain.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(resolve(listResponses[table] ?? { data: null, error: null }));
    chain.single = () => {
      const queue = singleQueues[table];
      if (!queue || queue.length === 0) return Promise.resolve({ data: null, error: null });
      return Promise.resolve(queue.length > 1 ? queue.shift()! : queue[0]);
    };
    chain.maybeSingle = chain.single;
    return chain;
  };

  return {
    supabase: {
      from: vi.fn((table: string) => buildChain(table)),
      functions: {
        invoke: vi.fn(async (name: string, args: { body: unknown }) => {
          invokedFunctions.push({ name, body: args?.body });
          return { data: invokeResult.data, error: invokeResult.error };
        }),
      },
    },
  };
});

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { supabase } from "@/integrations/supabase/client";
import EvaluationTimeline from "@/components/EvaluationTimeline";

type Evaluation = React.ComponentProps<typeof EvaluationTimeline>["evaluations"][number];

const makeEvaluation = (overrides: Partial<Evaluation> = {}): Evaluation => ({
  id: `eval-${Math.random().toString(36).slice(2, 8)}`,
  strengths: ["Strong algebra"],
  weaknesses: ["Rushes word problems"],
  recommendations: ["Practice daily"],
  overallAssessment: "Steady progress across the term.",
  hasEnoughData: true,
  generatedAt: "2026-03-01T10:00:00.000Z",
  instructorFeedback: null,
  isManual: false,
  ...overrides,
});

const analysisPayload = {
  summary: "Clear upward trajectory over three evaluations.",
  overallTrend: "improving" as const,
  competencyInsights: [
    {
      competencyTitle: "Fractions",
      trend: "improving" as const,
      insight: "Now converts mixed numbers reliably.",
    },
    {
      competencyTitle: "Geometry",
      trend: "declining" as const,
      insight: "Angle reasoning has slipped.",
    },
  ],
  strengths: ["Consistent practice"],
  areasForImprovement: ["Speed under time pressure"],
  recommendations: ["Timed drills", "Peer review"],
};

const twoEvaluations = [
  makeEvaluation({ id: "eval-old", generatedAt: "2026-01-05T09:00:00.000Z" }),
  makeEvaluation({ id: "eval-new", generatedAt: "2026-03-05T09:00:00.000Z" }),
];

const renderTimeline = (props: Partial<React.ComponentProps<typeof EvaluationTimeline>> = {}) =>
  render(
    <EvaluationTimeline
      evaluations={twoEvaluations}
      studentName="Alice Papadopoulou"
      courseId="course-1"
      userId="user-1"
      {...props}
    />,
  );

beforeEach(() => {
  vi.clearAllMocks();
  insertCalls.length = 0;
  updateCalls.length = 0;
  invokedFunctions.length = 0;
  invokeResult.data = { analysis: analysisPayload };
  invokeResult.error = null;

  for (const key of Object.keys(listResponses)) delete listResponses[key];
  for (const key of Object.keys(singleQueues)) delete singleQueues[key];

  // No cached analysis by default → the component generates one.
  singleQueues.evaluation_timeline_cache = [{ data: null, error: null }];
  singleQueues.courses = [
    { data: { language: "el", institution_id: "inst-1" }, error: null },
  ];
});

describe("EvaluationTimeline", () => {
  describe("gating", () => {
    it("shows the minimum-evaluations message with fewer than 2 evaluations", async () => {
      renderTimeline({ evaluations: [makeEvaluation()] });

      expect(
        screen.getByText("Need at least 2 evaluations to show timeline comparison"),
      ).toBeInTheDocument();
      expect(screen.queryByText("Evaluation History")).not.toBeInTheDocument();
    });

    it("does not invoke the edge function with fewer than 2 evaluations", async () => {
      renderTimeline({ evaluations: [makeEvaluation()] });

      await waitFor(() => expect(supabase.from).toHaveBeenCalled());
      expect(invokedFunctions).toHaveLength(0);
    });

    it("skips the cache lookup entirely when courseId is missing", async () => {
      renderTimeline({ courseId: undefined });

      await waitFor(() => expect(screen.getByText("Evaluation History")).toBeInTheDocument());
      const cacheReads = (supabase.from as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([table]) => table === "evaluation_timeline_cache",
      );
      expect(cacheReads).toHaveLength(0);
    });
  });

  describe("analysis generation", () => {
    it("auto-generates an analysis when no cached row exists and renders it", async () => {
      renderTimeline();

      await waitFor(() =>
        expect(
          screen.getByText("AI Progress Analysis: Alice Papadopoulou"),
        ).toBeInTheDocument(),
      );

      expect(invokedFunctions).toHaveLength(1);
      expect(invokedFunctions[0].name).toBe("generate-evaluation-timeline");
      expect(screen.getByText(analysisPayload.summary)).toBeInTheDocument();
      expect(screen.getByText("Consistent practice")).toBeInTheDocument();
      expect(screen.getByText("Speed under time pressure")).toBeInTheDocument();
      expect(screen.getByText("Timed drills")).toBeInTheDocument();
      expect(screen.getByText("Now converts mixed numbers reliably.")).toBeInTheDocument();
      expect(screen.getByText("Angle reasoning has slipped.")).toBeInTheDocument();
    });

    it("sends the course language and the full evaluation list to the edge function", async () => {
      renderTimeline();

      await waitFor(() => expect(invokedFunctions).toHaveLength(1));
      const body = invokedFunctions[0].body as {
        language: string;
        evaluations: Array<{ id: string }>;
      };
      expect(body.language).toBe("el");
      expect(body.evaluations.map((e) => e.id)).toEqual(["eval-old", "eval-new"]);
    });

    it("falls back to the institution default language when the course has none", async () => {
      singleQueues.courses = [{ data: { language: null, institution_id: "inst-1" }, error: null }];
      singleQueues.institutions = [{ data: { default_language: "el" }, error: null }];

      renderTimeline();

      await waitFor(() => expect(invokedFunctions).toHaveLength(1));
      expect((invokedFunctions[0].body as { language: string }).language).toBe("el");
    });

    it("does not send the student name to the edge function (PII guard, #557)", async () => {
      renderTimeline();

      await waitFor(() => expect(invokedFunctions).toHaveLength(1));
      const serialized = JSON.stringify(invokedFunctions[0].body);
      expect(serialized).not.toContain("Alice Papadopoulou");
      expect(serialized).not.toContain("studentName");
    });

    it("persists a freshly generated analysis with an insert when no row exists", async () => {
      renderTimeline();

      await waitFor(() => expect(insertCalls).toHaveLength(1));
      expect(insertCalls[0].table).toBe("evaluation_timeline_cache");
      expect(insertCalls[0].values).toMatchObject({
        course_id: "course-1",
        user_id: "user-1",
        summary: analysisPayload.summary,
        overall_trend: "improving",
        evaluation_count: 2,
      });
      expect(updateCalls).toHaveLength(0);
    });
  });

  describe("cached analysis", () => {
    const cachedRow = {
      id: "cache-1",
      summary: "Cached summary from a previous run.",
      overall_trend: "stable",
      competency_insights: [
        { competencyTitle: "Fractions", trend: "stable", insight: "Holding steady." },
      ],
      strengths: ["Cached strength"],
      areas_for_improvement: ["Cached area"],
      recommendations: ["Cached recommendation"],
      generated_at: "2026-03-10T12:00:00.000Z",
      evaluation_count: 2,
    };

    it("renders the cached analysis without invoking the edge function", async () => {
      singleQueues.evaluation_timeline_cache = [{ data: cachedRow, error: null }];

      renderTimeline();

      await waitFor(() =>
        expect(screen.getByText("Cached summary from a previous run.")).toBeInTheDocument(),
      );
      expect(invokedFunctions).toHaveLength(0);
      expect(screen.getByText("Cached strength")).toBeInTheDocument();
      expect(screen.getByText("Holding steady.")).toBeInTheDocument();
    });

    it("shows the cache generation timestamp", async () => {
      singleQueues.evaluation_timeline_cache = [{ data: cachedRow, error: null }];

      renderTimeline();

      await waitFor(() => expect(screen.getByText(/^Generated /)).toBeInTheDocument());
      expect(screen.getByText(/Mar 10, 2026/)).toBeInTheDocument();
    });

    it("flags newer evaluations when the cache is stale", async () => {
      singleQueues.evaluation_timeline_cache = [
        { data: { ...cachedRow, evaluation_count: 1 }, error: null },
      ];

      renderTimeline();

      await waitFor(() =>
        expect(screen.getByText("1 new evaluation since")).toBeInTheDocument(),
      );
    });

    it("pluralises the stale-cache badge", async () => {
      singleQueues.evaluation_timeline_cache = [
        { data: { ...cachedRow, evaluation_count: 0 }, error: null },
      ];

      renderTimeline();

      await waitFor(() =>
        expect(screen.getByText("2 new evaluations since")).toBeInTheDocument(),
      );
    });

    it("hides the stale badge when the cache is current", async () => {
      singleQueues.evaluation_timeline_cache = [{ data: cachedRow, error: null }];

      renderTimeline();

      await waitFor(() => expect(screen.getByText(/^Generated /)).toBeInTheDocument());
      expect(screen.queryByText(/new evaluation/)).not.toBeInTheDocument();
    });

    it("updates the existing cache row when regenerating", async () => {
      singleQueues.evaluation_timeline_cache = [{ data: cachedRow, error: null }];

      renderTimeline();

      await waitFor(() =>
        expect(screen.getByText("Cached summary from a previous run.")).toBeInTheDocument(),
      );
      await userEvent.click(screen.getByRole("button", { name: /Regenerate Analysis/i }));

      await waitFor(() => expect(updateCalls).toHaveLength(1));
      expect(updateCalls[0].table).toBe("evaluation_timeline_cache");
      expect(updateCalls[0].values).toMatchObject({
        summary: analysisPayload.summary,
        overall_trend: "improving",
        evaluation_count: 2,
      });
      expect(insertCalls).toHaveLength(0);
    });
  });

  describe("error handling", () => {
    it("shows the error card and a retry button when generation fails", async () => {
      invokeResult.error = { message: "boom" };

      renderTimeline();

      await waitFor(() => expect(screen.getByText("boom")).toBeInTheDocument());
      expect(screen.getByRole("button", { name: /Retry/i })).toBeInTheDocument();
    });

    it("surfaces an error returned in the function payload", async () => {
      invokeResult.data = { error: "model unavailable" };

      renderTimeline();

      await waitFor(() =>
        expect(screen.getByText("model unavailable")).toBeInTheDocument(),
      );
    });

    it("re-invokes the edge function when retry is clicked", async () => {
      invokeResult.error = { message: "boom" };

      renderTimeline();

      await waitFor(() => expect(screen.getByText("boom")).toBeInTheDocument());
      invokeResult.error = null;
      invokeResult.data = { analysis: analysisPayload };

      await userEvent.click(screen.getByRole("button", { name: /Retry/i }));

      await waitFor(() =>
        expect(
          screen.getByText("AI Progress Analysis: Alice Papadopoulou"),
        ).toBeInTheDocument(),
      );
      expect(invokedFunctions).toHaveLength(2);
    });

    it("still renders the evaluation history when the analysis fails", async () => {
      invokeResult.error = { message: "boom" };

      renderTimeline();

      await waitFor(() => expect(screen.getByText("boom")).toBeInTheDocument());
      expect(screen.getByText("Evaluation History")).toBeInTheDocument();
    });
  });

  describe("evaluation history", () => {
    const threeEvaluations = [
      makeEvaluation({
        id: "e-mid",
        generatedAt: "2026-02-02T09:00:00.000Z",
        overallAssessment: "Middle evaluation",
      }),
      makeEvaluation({
        id: "e-first",
        generatedAt: "2026-01-01T09:00:00.000Z",
        overallAssessment: "Earliest evaluation",
      }),
      makeEvaluation({
        id: "e-last",
        generatedAt: "2026-03-03T09:00:00.000Z",
        overallAssessment: "Newest evaluation",
      }),
    ];

    it("orders the timeline oldest-first regardless of input order", async () => {
      renderTimeline({ evaluations: threeEvaluations });

      await waitFor(() => expect(screen.getByText("Evaluation History")).toBeInTheDocument());
      const rendered = screen
        .getAllByText(/evaluation$/i)
        .map((el) => el.textContent);
      expect(rendered).toEqual([
        "Earliest evaluation",
        "Middle evaluation",
        "Newest evaluation",
      ]);
    });

    it("badges the oldest as First and the newest as Latest", async () => {
      renderTimeline({ evaluations: threeEvaluations });

      await waitFor(() => expect(screen.getByText("Latest")).toBeInTheDocument());
      expect(screen.getByText("First")).toBeInTheDocument();

      // "First" belongs to the earliest card, "Latest" to the newest.
      const firstCard = screen.getByText("Earliest evaluation").closest("div.relative");
      const lastCard = screen.getByText("Newest evaluation").closest("div.relative");
      expect(within(firstCard as HTMLElement).getByText("First")).toBeInTheDocument();
      expect(within(lastCard as HTMLElement).getByText("Latest")).toBeInTheDocument();
    });

    it("badges both endpoints when exactly two evaluations exist", async () => {
      renderTimeline({ evaluations: twoEvaluations });

      await waitFor(() => expect(screen.getByText("Latest")).toBeInTheDocument());
      expect(screen.getByText("First")).toBeInTheDocument();
    });

    it("distinguishes manual from AI evaluations", async () => {
      renderTimeline({
        evaluations: [
          makeEvaluation({ id: "ai", generatedAt: "2026-01-01T09:00:00.000Z" }),
          makeEvaluation({
            id: "manual",
            generatedAt: "2026-02-01T09:00:00.000Z",
            isManual: true,
          }),
        ],
      });

      await waitFor(() => expect(screen.getByText("Manual")).toBeInTheDocument());
      expect(screen.getByText("AI")).toBeInTheDocument();
    });

    it("counts strengths and weaknesses per evaluation", async () => {
      renderTimeline({
        evaluations: [
          makeEvaluation({
            id: "a",
            generatedAt: "2026-01-01T09:00:00.000Z",
            strengths: ["s1", "s2", "s3"],
            weaknesses: ["w1"],
          }),
          makeEvaluation({
            id: "b",
            generatedAt: "2026-02-01T09:00:00.000Z",
            strengths: [],
            weaknesses: ["w1", "w2"],
          }),
        ],
      });

      await waitFor(() => expect(screen.getByText("3 strengths")).toBeInTheDocument());
      expect(screen.getByText("1 areas")).toBeInTheDocument();
      expect(screen.getByText("0 strengths")).toBeInTheDocument();
      expect(screen.getByText("2 areas")).toBeInTheDocument();
    });

    it("marks evaluations that carry instructor feedback", async () => {
      renderTimeline({
        evaluations: [
          makeEvaluation({ id: "a", generatedAt: "2026-01-01T09:00:00.000Z" }),
          makeEvaluation({
            id: "b",
            generatedAt: "2026-02-01T09:00:00.000Z",
            instructorFeedback: "Keep going",
          }),
        ],
      });

      await waitFor(() => expect(screen.getByText("Has feedback")).toBeInTheDocument());
      expect(screen.getAllByText("Has feedback")).toHaveLength(1);
    });
  });
});
