import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

type Result = { data: unknown; error: unknown };

// Response the SELECT on quiz_analyses resolves to (via maybeSingle).
let selectResult: Result = { data: null, error: null };
// Response the analyze-quiz function invoke resolves to.
let invokeResult: Result = { data: null, error: null };

const updateCalls: Array<{ values: Record<string, unknown> }> = [];
const invokeCalls: Array<{ name: string; body: unknown }> = [];
// Rows written when the clusters are turned into real offering groups.
const groupInserts: Array<Record<string, unknown>> = [];
const memberInserts: Array<Record<string, unknown>[]> = [];

vi.mock("@/integrations/supabase/client", () => {
  const buildChain = (table: string) => {
    const chain: Record<string, (...a: unknown[]) => unknown> = {};
    const passThrough = () => chain;
    chain.select = passThrough;
    chain.eq = passThrough;
    chain.is = passThrough;
    chain.update = (values: Record<string, unknown>) => {
      updateCalls.push({ values });
      // update chains resolve to { error } after .eq().eq()
      chain.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve(resolve({ error: null }));
      return chain;
    };
    chain.insert = (values: unknown) => {
      if (table === "offering_groups") {
        groupInserts.push(values as Record<string, unknown>);
        return {
          select: () => ({
            single: () =>
              Promise.resolve({ data: { id: `grp-${groupInserts.length}` }, error: null }),
          }),
        };
      }
      memberInserts.push(values as Record<string, unknown>[]);
      return {
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(resolve({ error: null })),
      };
    };
    chain.maybeSingle = () => Promise.resolve(selectResult);
    chain.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(resolve({ error: null }));
    return chain;
  };
  return {
    supabase: {
      from: vi.fn((table: string) => buildChain(table)),
      functions: {
        invoke: vi.fn(async (name: string, opts: { body: unknown }) => {
          invokeCalls.push({ name, body: opts?.body });
          return invokeResult;
        }),
      },
      auth: { getUser: vi.fn(async () => ({ data: { user: { id: "instr-1" } } })) },
    },
  };
});

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { QuizAnalysisPanel } from "@/components/quiz/QuizAnalysisPanel";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

// Radix Select drives itself with Pointer Capture APIs that jsdom doesn't
// implement; polyfill them so the dropdown can open under userEvent.
beforeAll(() => {
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = vi.fn(() => false);
    Element.prototype.setPointerCapture = vi.fn();
    Element.prototype.releasePointerCapture = vi.fn();
  }
});

const ROSTER = [
  { userId: "u1", fullName: "Alice" },
  { userId: "u2", fullName: "Bob" },
  { userId: "u3", fullName: "Carol" },
];

const REPORT = {
  overall_understanding: "The class grasps the basics.",
  common_misconceptions: [
    { title: "Confuses X and Y", description: "Many mixed up X and Y.", related_question_orders: [1, 2] },
  ],
  knowledge_gaps: [{ topic: "Fractions", description: "Struggle with denominators." }],
  question_signals: [{ question_order: 1, difficulty_signal: "hard", note: "Only 30% correct." }],
  summary: "Overall solid with a couple of gaps.",
};

const CLUSTERS = [
  { label: "Strong", rationale: "High scores", summary: "Doing well", member_user_ids: ["u1", "u2"] },
  { label: "Needs help", rationale: "Low scores", summary: "Struggling", member_user_ids: ["u3"] },
];

const renderPanel = (view: "assessment" | "groups" = "assessment") =>
  render(
    <QuizAnalysisPanel
      quizId="quiz-1"
      courseId="course-1"
      offeringId="off-1"
      groupId={null}
      view={view}
      scopeLabel="Whole class"
      submissionCount={8}
      quizTitle="Fractions Quiz"
      roster={ROSTER}
    />,
  );

beforeEach(() => {
  selectResult = { data: null, error: null };
  invokeResult = { data: null, error: null };
  updateCalls.length = 0;
  invokeCalls.length = 0;
  groupInserts.length = 0;
  memberInserts.length = 0;
  vi.clearAllMocks();
});

describe("QuizAnalysisPanel", () => {
  it("renders a persisted analysis without invoking the function", async () => {
    selectResult = {
      data: {
        report: REPORT,
        clusters: CLUSTERS,
        submission_count: 8,
        low_confidence: false,
        generated_at: "2026-05-01T00:00:00Z",
        model: "gpt-5.2",
      },
      error: null,
    };

    renderPanel();

    expect(await screen.findByText("The class grasps the basics.")).toBeInTheDocument();
    expect(screen.getByText("Confuses X and Y")).toBeInTheDocument();
    expect(screen.getByText("Fractions")).toBeInTheDocument();
    // Names resolved client-side from the roster.
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("Carol")).toBeInTheDocument();
    // No generation needed when a row already exists.
    expect(supabase.functions.invoke).not.toHaveBeenCalled();
  });

  it("never auto-generates — Generate is explicit and carries the scope", async () => {
    selectResult = { data: null, error: null };
    invokeResult = {
      data: { analysis: { report: REPORT, clusters: CLUSTERS, submission_count: 8, low_confidence: false } },
      error: null,
    };

    renderPanel();
    const user = userEvent.setup();

    // No cached row → an invitation to generate, not a billed model call.
    expect(await screen.findByText(/no assessment yet/i)).toBeInTheDocument();
    expect(supabase.functions.invoke).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("quiz-analysis-refresh"));

    await waitFor(() => expect(supabase.functions.invoke).toHaveBeenCalled());
    expect(invokeCalls[0]).toEqual({
      name: "analyze-quiz",
      body: { quiz_id: "quiz-1", offering_id: "off-1", group_id: null },
    });
    expect(await screen.findByText("The class grasps the basics.")).toBeInTheDocument();
  });

  it("shows the insufficient-data message instead of an empty panel", async () => {
    selectResult = { data: null, error: null };
    invokeResult = {
      data: {
        analysis: null,
        insufficientData: true,
        submission_count: 2,
        message: "Only 2 students have submitted this quiz. At least 3 submissions are needed.",
      },
      error: null,
    };

    renderPanel();
    const user = userEvent.setup();

    await screen.findByText(/no assessment yet/i);
    await user.click(screen.getByTestId("quiz-analysis-refresh"));

    expect(
      await screen.findByText(/at least 3 submissions are needed/i),
    ).toBeInTheDocument();
  });

  it("surfaces a low-confidence caveat", async () => {
    selectResult = {
      data: { report: REPORT, clusters: CLUSTERS, submission_count: 3, low_confidence: true },
      error: null,
    };

    renderPanel();

    expect(await screen.findByText(/low-confidence analysis/i)).toBeInTheDocument();
  });

  it("saves edited clusters back to quiz_analyses", async () => {
    selectResult = {
      data: { report: REPORT, clusters: CLUSTERS, submission_count: 8, low_confidence: false },
      error: null,
    };

    renderPanel();
    const user = userEvent.setup();

    // Rename the first group. One change event rather than `type`'s
    // per-keystroke sequence: the input is controlled, and under a loaded
    // runner React can coalesce renders between keystrokes and drop
    // characters. The sibling study-guide test failed in CI exactly that way
    // while passing locally; both drive the same shared input.
    const firstNameInput = await screen.findByLabelText("Group 1 name");
    fireEvent.change(firstNameInput, { target: { value: "Top performers" } });
    await waitFor(() => expect(firstNameInput).toHaveValue("Top performers"));

    // Move Bob (u2) from group 0 to Unassigned.
    const bobRow = screen.getByText("Bob").closest("div")!.parentElement as HTMLElement;
    const bobSelect = within(bobRow).getByRole("combobox");
    await user.click(bobSelect);
    const unassignedOption = await screen.findByRole("option", { name: "Unassigned" });
    await user.click(unassignedOption);

    await user.click(screen.getByRole("button", { name: /save groups/i }));

    await waitFor(() => expect(updateCalls.length).toBe(1));
    const saved = updateCalls[0].values.clusters as typeof CLUSTERS;
    const top = saved.find((c) => c.label === "Top performers");
    expect(top).toBeTruthy();
    expect(top!.member_user_ids).toEqual(["u1"]); // Bob removed
    // Rationale/summary preserved from the original cluster.
    expect(top!.rationale).toBe("High scores");
    expect(toast.success).toHaveBeenCalledWith("Groups saved");
  });

  it("shows the empty-state and hides Save only when clusters are genuinely absent", async () => {
    selectResult = {
      data: { report: REPORT, clusters: [], submission_count: 8, low_confidence: false },
      error: null,
    };

    renderPanel();

    // Report still renders, but the groups section explains there are none…
    expect(await screen.findByText("The class grasps the basics.")).toBeInTheDocument();
    expect(screen.getByText(/no student groups for this quiz yet/i)).toBeInTheDocument();
    // …and Save groups is not offered when there's nothing to save.
    expect(screen.queryByRole("button", { name: /save groups/i })).not.toBeInTheDocument();
  });

  it("offers Save groups when clusters are present", async () => {
    selectResult = {
      data: { report: REPORT, clusters: CLUSTERS, submission_count: 8, low_confidence: false },
      error: null,
    };

    renderPanel();

    expect(await screen.findByText("Alice")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save groups/i })).toBeInTheDocument();
  });

  it("re-runs the function only after the instructor confirms Refresh", async () => {
    selectResult = {
      data: { report: REPORT, clusters: CLUSTERS, submission_count: 8, low_confidence: false },
      error: null,
    };
    invokeResult = {
      data: { analysis: { report: REPORT, clusters: CLUSTERS, submission_count: 9, low_confidence: false } },
      error: null,
    };

    renderPanel();
    const user = userEvent.setup();

    await screen.findByText("The class grasps the basics.");
    // An existing analysis (possibly with curated groups) is never replaced
    // without an explicit confirmation.
    await user.click(screen.getByTestId("quiz-analysis-refresh"));
    expect(supabase.functions.invoke).not.toHaveBeenCalled();

    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: /^refresh$/i }));

    await waitFor(() => expect(supabase.functions.invoke).toHaveBeenCalledTimes(1));
    expect(invokeCalls[0].name).toBe("analyze-quiz");
  });

  it("cancelling the Refresh confirmation runs nothing", async () => {
    selectResult = {
      data: { report: REPORT, clusters: CLUSTERS, submission_count: 8, low_confidence: false },
      error: null,
    };

    renderPanel();
    const user = userEvent.setup();

    await screen.findByText("The class grasps the basics.");
    await user.click(screen.getByTestId("quiz-analysis-refresh"));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: /cancel/i }));

    expect(supabase.functions.invoke).not.toHaveBeenCalled();
  });

  it("creates real offering groups postfixed with the quiz's name", async () => {
    selectResult = {
      data: { report: REPORT, clusters: CLUSTERS, submission_count: 8, low_confidence: false },
      error: null,
    };

    renderPanel();
    const user = userEvent.setup();

    await screen.findByText("Alice");
    await user.click(screen.getByTestId("create-offering-groups"));

    // The confirmation previews the exact names that will be written — the
    // clusters leave the analysis at this point and outlive it.
    expect(await screen.findByText("Strong — Fractions Quiz follow ups")).toBeInTheDocument();
    const dialog = screen.getByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: /create student groups/i }));

    await waitFor(() => expect(groupInserts.length).toBe(2));
    expect(groupInserts[0]).toMatchObject({
      offering_id: "off-1",
      name: "Strong — Fractions Quiz follow ups",
      description: "Doing well",
    });
    expect(groupInserts[1]).toMatchObject({ name: "Needs help — Fractions Quiz follow ups" });
    expect(memberInserts[0]).toEqual([
      { group_id: "grp-1", user_id: "u1", added_by: "instr-1" },
      { group_id: "grp-1", user_id: "u2", added_by: "instr-1" },
    ]);
    expect(toast.success).toHaveBeenCalledWith("Created 2 student groups");
  });

  it("writes nothing when the instructor backs out of the confirmation", async () => {
    selectResult = {
      data: { report: REPORT, clusters: CLUSTERS, submission_count: 8, low_confidence: false },
      error: null,
    };

    renderPanel();
    const user = userEvent.setup();

    await screen.findByText("Alice");
    await user.click(screen.getByTestId("create-offering-groups"));
    await screen.findByRole("alertdialog");
    await user.click(screen.getByRole("button", { name: /cancel/i }));

    expect(groupInserts).toHaveLength(0);
  });
});
