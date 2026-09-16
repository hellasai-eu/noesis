import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

type Result = { data: unknown; error: unknown };

// Response the enqueue-followup-practice invoke resolves to.
let invokeResult: Result = { data: null, error: null };
// Response the jobs-poll SELECT resolves to (via maybeSingle).
let jobPollResult: Result = { data: null, error: null };
const invokeCalls: Array<{ name: string; body: any }> = [];

vi.mock("@/integrations/supabase/client", () => {
  const buildChain = () => {
    const chain: Record<string, (...a: unknown[]) => unknown> = {};
    const passThrough = () => chain;
    chain.select = passThrough;
    chain.eq = passThrough;
    chain.maybeSingle = () => Promise.resolve(jobPollResult);
    return chain;
  };
  return {
    supabase: {
      from: vi.fn(() => buildChain()),
      functions: {
        invoke: vi.fn(async (name: string, opts: { body: unknown }) => {
          invokeCalls.push({ name, body: opts?.body });
          return invokeResult;
        }),
      },
    },
  };
});

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { FollowupPracticeDialog, type FollowupTarget } from "@/components/quiz/FollowupPracticeDialog";

const WEAK_AREAS = {
  misconceptions: ["Confuses X and Y"],
  gaps: ["Fractions"],
};

const CLUSTER_TARGET: FollowupTarget = {
  kind: "cluster",
  label: "Needs help",
  memberUserIds: ["u3", "u4"],
  summary: "Struggling with fractions",
};

const renderDialog = (
  target: FollowupTarget | null = CLUSTER_TARGET,
  onAssignmentsChanged?: () => void,
) =>
  render(
    <FollowupPracticeDialog
      open
      onOpenChange={() => {}}
      quizId="quiz-1"
      offeringId="off-1"
      quizTitle="Fractions Quiz"
      target={target}
      weakAreas={WEAK_AREAS}
      onAssignmentsChanged={onAssignmentsChanged}
    />,
  );

beforeEach(() => {
  invokeResult = { data: { jobId: "job-1", draftQuizId: "draft-1" }, error: null };
  jobPollResult = { data: { status: "completed", progress: { created_total: 4 } }, error: null };
  invokeCalls.length = 0;
  vi.clearAllMocks();
});

describe("FollowupPracticeDialog", () => {
  /**
   * The enclosing Assigned Quizzes board loaded its assignments before this
   * set existed. Closing without telling it leaves the instructor looking at a
   * Drafts group that does not yet contain the draft the dialog just sent them
   * to — the one state where the flow visibly dead-ends.
   */
  it("tells the board to refetch when closed after enqueueing", async () => {
    const user = userEvent.setup();
    const onAssignmentsChanged = vi.fn();
    renderDialog(CLUSTER_TARGET, onAssignmentsChanged);

    await user.click(screen.getByTestId("followup-create"));
    await waitFor(() => expect(invokeCalls.length).toBe(1));
    await waitFor(() =>
      expect(screen.getByTestId("followup-progress")).toBeInTheDocument(),
    );
    expect(onAssignmentsChanged).not.toHaveBeenCalled();

    // The footer button, not Radix's corner X — both are named "Close".
    await user.click(screen.getByTestId("followup-close"));
    expect(onAssignmentsChanged).toHaveBeenCalledTimes(1);
  });

  it("stays quiet when cancelled without enqueueing anything", async () => {
    const user = userEvent.setup();
    const onAssignmentsChanged = vi.fn();
    renderDialog(CLUSTER_TARGET, onAssignmentsChanged);

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(invokeCalls.length).toBe(0);
    expect(onAssignmentsChanged).not.toHaveBeenCalled();
  });

  it("shows the target group and the weak areas it will address", () => {
    renderDialog();
    expect(screen.getByText("Needs help")).toBeInTheDocument();
    expect(screen.getByText("2 students (saved as a group)")).toBeInTheDocument();
    expect(screen.getByText("Confuses X and Y")).toBeInTheDocument();
    expect(screen.getByText("Fractions")).toBeInTheDocument();
  });

  it("enqueues generation with the cluster + selected defaults, then shows progress", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByTestId("followup-create"));

    await waitFor(() => expect(invokeCalls.length).toBe(1));
    expect(invokeCalls[0].name).toBe("enqueue-followup-practice");
    const body = invokeCalls[0].body;
    expect(body.quiz_id).toBe("quiz-1");
    expect(body.offering_id).toBe("off-1");
    expect(body.types).toEqual(["mcq", "open"]);
    expect(body.count_per_type).toBe(2);
    expect(body.cluster).toEqual({ label: "Needs help", member_user_ids: ["u3", "u4"] });

    // Transitions to the background-progress view.
    await waitFor(() =>
      expect(screen.getByTestId("followup-progress")).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.getByText("Ready to review")).toBeInTheDocument(),
    );
  });

  it("sends no cluster for a whole-class target", async () => {
    const user = userEvent.setup();
    renderDialog({ kind: "whole_class", studentCount: 12 });

    expect(screen.getByText("Whole class")).toBeInTheDocument();
    await user.click(screen.getByTestId("followup-create"));

    await waitFor(() => expect(invokeCalls.length).toBe(1));
    expect(invokeCalls[0].body.cluster).toBeNull();
  });
});
