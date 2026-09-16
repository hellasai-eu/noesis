import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/** What the SELECT on study_guide_analyses resolves to. */
let selectResult: { data: unknown; error: unknown } = { data: null, error: null };
/** Resolved by default; a test can hold it open to keep a save in flight. */
let updateGate: Promise<void> | undefined;

const updateCalls: Array<{ values: Record<string, unknown>; filters: Array<unknown[]> }> = [];
const groupInserts: Array<Record<string, unknown>> = [];
const memberInserts: Array<Record<string, unknown>[]> = [];

vi.mock("@/integrations/supabase/client", () => {
  const from = (table: string) => {
    const filters: Array<unknown[]> = [];
    // deno-lint-ignore-next-line
    const chain: Record<string, (...a: never[]) => unknown> = {};
    const passThrough = (...args: unknown[]) => {
      filters.push(args);
      return chain;
    };
    chain.select = () => chain;
    chain.eq = passThrough as never;
    chain.is = passThrough as never;
    chain.maybeSingle = (() => Promise.resolve(selectResult)) as never;
    chain.update = ((values: Record<string, unknown>) => {
      updateCalls.push({ values, filters });
      // While `updateGate` is unresolved the write stays in flight, which is
      // what the Refresh-race test needs to observe.
      chain.then = ((resolve: (v: unknown) => unknown) =>
        Promise.resolve(updateGate).then(() => resolve({ error: null }))) as never;
      return chain;
    }) as never;
    chain.insert = ((values: unknown) => {
      if (table === "offering_groups") {
        groupInserts.push(values as Record<string, unknown>);
        return {
          select: () => ({
            single: () => Promise.resolve({ data: { id: `grp-${groupInserts.length}` }, error: null }),
          }),
        };
      }
      memberInserts.push(values as Record<string, unknown>[]);
      return {
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(resolve({ error: null })),
      };
    }) as never;
    // Terminal await on an update chain.
    chain.then = ((resolve: (v: unknown) => unknown) =>
      Promise.resolve(resolve({ error: null }))) as never;
    return chain;
  };
  return {
    supabase: {
      from: vi.fn(from),
      functions: { invoke: vi.fn(async () => ({ data: null, error: null })) },
      auth: {
        getUser: vi.fn(async () => ({ data: { user: { id: "instr-1" } } })),
        // The follow-up dialog reads the session before generating; a null
        // session makes generation fail fast without a fetch, which is all
        // the section-level tests need (the flow itself has its own suite).
        getSession: vi.fn(async () => ({ data: { session: null } })),
      },
    },
  };
});

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { StudyGuideAnalysisPanel } from "@/components/study-guide/StudyGuideAnalysisPanel";
import { toast } from "sonner";

// Radix Select and AlertDialog use Pointer Capture APIs jsdom lacks.
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
  overall_narrative: "The class has cleared the first piece.",
  strengths: [],
  weaknesses: [],
  misconceptions: [],
  suggested_actions: [],
  summary: "Addition solid, subtraction shaky.",
  low_confidence_piece_positions: [],
  low_confidence_competency_ids: [],
};

const CLUSTERS = [
  {
    label: "Treats subtraction as commutative",
    rationale: "Both reversed the difference.",
    summary: "Reteach on a number line.",
    member_user_ids: ["u1", "u2"],
  },
  {
    label: "Secure on addition",
    rationale: "Clean run through piece 1.",
    summary: "Ready for extension.",
    member_user_ids: ["u3"],
  },
];

// The student groups live on the panel's "groups" view (their own tab in the
// results dialog); the default "assessment" view renders only the report.
const renderPanel = (groupId: string | null = null) =>
  render(
    <StudyGuideAnalysisPanel
      studyGuideId="guide-1"
      courseId="course-1"
      offeringId="off-1"
      groupId={groupId}
      view="groups"
      scopeLabel="Whole class"
      pieceTitleByPosition={new Map()}
      competencyTitleById={new Map()}
      submissionCount={3}
      guideTitle="Numbers 1-10"
      roster={ROSTER}
    />,
  );

beforeEach(() => {
  selectResult = { data: null, error: null };
  updateGate = undefined;
  updateCalls.length = 0;
  groupInserts.length = 0;
  memberInserts.length = 0;
  vi.clearAllMocks();
});

describe("StudyGuideAnalysisPanel — student groups", () => {
  it("renders the persisted clusters with real student names", async () => {
    selectResult = {
      data: { report: REPORT, clusters: CLUSTERS, submission_count: 6, low_confidence: false },
      error: null,
    };

    renderPanel();

    expect(await screen.findByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();
    expect(screen.getByText("Carol")).toBeInTheDocument();
    // The model's rationale and summary stay visible beside the editable label.
    expect(screen.getByText("Both reversed the difference.")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Treats subtraction as commutative")).toBeInTheDocument();
  });

  it("explains the absence rather than showing an empty groups box", async () => {
    selectResult = {
      data: { report: REPORT, clusters: [], submission_count: 6, low_confidence: false },
      error: null,
    };

    renderPanel();

    expect(await screen.findByText(/no student groups yet/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /save groups/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /create student groups/i })).not.toBeInTheDocument();
  });

  it("saves edited clusters back to this scope's row only", async () => {
    selectResult = {
      data: { report: REPORT, clusters: CLUSTERS, submission_count: 6, low_confidence: false },
      error: null,
    };

    renderPanel("grp-a");
    const user = userEvent.setup();

    // One change event rather than `type`'s per-keystroke sequence: the input is
    // controlled, so under a loaded runner React can coalesce renders between
    // keystrokes and drop characters — which failed this test in CI while
    // passing locally. What is under test is that an edited label reaches the
    // write, not that the input handles individual keypresses.
    const firstName = await screen.findByLabelText("Group 1 name");
    fireEvent.change(firstName, { target: { value: "Reversed subtraction" } });
    await waitFor(() => expect(firstName).toHaveValue("Reversed subtraction"));

    // Move Bob out of the first group.
    const bobRow = screen.getByText("Bob").closest("div")!.parentElement as HTMLElement;
    await user.click(within(bobRow).getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Unassigned" }));

    await user.click(screen.getByRole("button", { name: /save groups/i }));

    await waitFor(() => expect(updateCalls.length).toBe(1));
    const saved = updateCalls[0].values.clusters as typeof CLUSTERS;
    const renamed = saved.find((c) => c.label === "Reversed subtraction");
    expect(renamed?.member_user_ids).toEqual(["u1"]);
    // The model's evidence survives an instructor's rename.
    expect(renamed?.rationale).toBe("Both reversed the difference.");
    // A cached report describes one cohort; the write must carry that scope or
    // a group's edited grouping lands on the whole class's row.
    expect(updateCalls[0].filters).toContainEqual(["group_id", "grp-a"]);
    expect(toast.success).toHaveBeenCalledWith("Groups saved");
  });

  it("creates real offering groups postfixed with the guide's name", async () => {
    selectResult = {
      data: { report: REPORT, clusters: CLUSTERS, submission_count: 6, low_confidence: false },
      error: null,
    };

    renderPanel();
    const user = userEvent.setup();

    await screen.findByText("Alice");
    await user.click(screen.getByTestId("create-offering-groups"));

    // The confirm dialog previews the exact names that will be written.
    expect(
      await screen.findByText("Treats subtraction as commutative — Numbers 1-10 follow ups"),
    ).toBeInTheDocument();

    const dialog = screen.getByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: /create student groups/i }));

    await waitFor(() => expect(groupInserts.length).toBe(2));
    expect(groupInserts[0]).toMatchObject({
      offering_id: "off-1",
      name: "Treats subtraction as commutative — Numbers 1-10 follow ups",
      description: "Reteach on a number line.",
    });
    expect(groupInserts[1]).toMatchObject({
      name: "Secure on addition — Numbers 1-10 follow ups",
    });
    expect(memberInserts[0]).toEqual([
      { group_id: "grp-1", user_id: "u1", added_by: "instr-1" },
      { group_id: "grp-1", user_id: "u2", added_by: "instr-1" },
    ]);
    expect(toast.success).toHaveBeenCalledWith("Created 2 student groups");
  });

  it("does not write anything until the instructor confirms", async () => {
    selectResult = {
      data: { report: REPORT, clusters: CLUSTERS, submission_count: 6, low_confidence: false },
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

  it("leaves out students who are no longer enrolled, and says so", async () => {
    // The clusters are a cached reading that can predate an unenrolment. The
    // member-integrity trigger rejects a whole insert containing a departed
    // student, so one stale id would fail creation for every group.
    selectResult = {
      data: {
        report: REPORT,
        clusters: [
          {
            ...CLUSTERS[0],
            // "gone" is not on the roster any more.
            member_user_ids: ["u1", "gone", "u2"],
          },
          CLUSTERS[1],
        ],
        submission_count: 6,
        low_confidence: false,
      },
      error: null,
    };

    renderPanel();
    const user = userEvent.setup();

    await screen.findByText("Alice");
    await user.click(screen.getByTestId("create-offering-groups"));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: /create student groups/i }));

    await waitFor(() => expect(groupInserts.length).toBe(2));
    // The departed student is simply absent from the write.
    expect(memberInserts[0]).toEqual([
      { group_id: "grp-1", user_id: "u1", added_by: "instr-1" },
      { group_id: "grp-1", user_id: "u2", added_by: "instr-1" },
    ]);
    // And the instructor is told rather than quietly given a smaller group.
    expect(toast.success).toHaveBeenCalledWith(
      expect.stringMatching(/no longer enrolled/),
    );
  });

  it("refuses creation when nobody in the clusters is still enrolled", async () => {
    selectResult = {
      data: {
        report: REPORT,
        clusters: [{ ...CLUSTERS[0], member_user_ids: ["gone-1", "gone-2"] }],
        submission_count: 6,
        low_confidence: false,
      },
      error: null,
    };

    renderPanel();
    const user = userEvent.setup();

    await screen.findByRole("button", { name: /save groups/i });
    await user.click(screen.getByTestId("create-offering-groups"));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: /create student groups/i }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "None of these students are still enrolled in this class.",
      ),
    );
    expect(groupInserts).toHaveLength(0);
  });

  it("creates just that group and opens the follow-up flow from its per-group button", async () => {
    selectResult = {
      data: { report: REPORT, clusters: CLUSTERS, submission_count: 6, low_confidence: false },
      error: null,
    };

    renderPanel();
    const user = userEvent.setup();

    await screen.findByText("Alice");
    // One follow-up button per group — the study-guide surface passes the
    // generation source, so the action is offered here.
    expect(screen.getByTestId("cluster-followup-button-1")).toBeInTheDocument();
    await user.click(screen.getByTestId("cluster-followup-button-0"));

    // No confirm dialog on this path: clicking creates THAT group alone…
    await waitFor(() => expect(groupInserts.length).toBe(1));
    expect(groupInserts[0]).toMatchObject({
      offering_id: "off-1",
      name: "Treats subtraction as commutative — Numbers 1-10 follow ups",
    });
    expect(memberInserts[0]).toEqual([
      { group_id: "grp-1", user_id: "u1", added_by: "instr-1" },
      { group_id: "grp-1", user_id: "u2", added_by: "instr-1" },
    ]);

    // …and the follow-up dialog opens for exactly that group, named as the
    // group was actually created.
    const followup = await screen.findByTestId("cluster-followup-dialog");
    expect(
      within(followup).getByText("Treats subtraction as commutative — Numbers 1-10 follow ups"),
    ).toBeInTheDocument();
    expect(
      within(followup).queryByText("Secure on addition — Numbers 1-10 follow ups"),
    ).not.toBeInTheDocument();

    // The creation is recorded on the analysis row itself (silently, so the
    // editor is not re-seeded), which is what stops any later path — this
    // session or the next — from creating the same group twice.
    await waitFor(() => expect(updateCalls.length).toBe(1));
    const marked = updateCalls[0].values.clusters as Array<Record<string, unknown>>;
    expect(marked[0]).toMatchObject({
      created_group_id: "grp-1",
      created_group_name: "Treats subtraction as commutative — Numbers 1-10 follow ups",
    });
    expect(marked[1].created_group_id).toBeUndefined();
  });

  it("reuses the already-created group instead of writing a duplicate", async () => {
    // The marker persisted by an earlier visit disables creation, not the
    // button: clicking generates another question for the recorded group.
    selectResult = {
      data: {
        report: REPORT,
        clusters: [
          { ...CLUSTERS[0], created_group_id: "grp-existing", created_group_name: "Existing — follow ups" },
          CLUSTERS[1],
        ],
        submission_count: 6,
        low_confidence: false,
      },
      error: null,
    };

    renderPanel();
    const user = userEvent.setup();

    await screen.findByText("Alice");
    await user.click(screen.getByTestId("cluster-followup-button-0"));

    const followup = await screen.findByTestId("cluster-followup-dialog");
    expect(within(followup).getByText("Existing — follow ups")).toBeInTheDocument();
    expect(groupInserts).toHaveLength(0);
  });

  it("carries created-group markers through a Save", async () => {
    // A Save rewrites the clusters wholesale; losing the markers there would
    // re-arm every duplicate-creation path the markers exist to stop.
    selectResult = {
      data: {
        report: REPORT,
        clusters: [
          { ...CLUSTERS[0], created_group_id: "grp-existing", created_group_name: "Existing — follow ups" },
          CLUSTERS[1],
        ],
        submission_count: 6,
        low_confidence: false,
      },
      error: null,
    };

    renderPanel();
    const user = userEvent.setup();

    await screen.findByText("Alice");
    await user.click(screen.getByRole("button", { name: /save groups/i }));

    await waitFor(() => expect(updateCalls.length).toBe(1));
    const saved = updateCalls[0].values.clusters as Array<Record<string, unknown>>;
    expect(saved[0]).toMatchObject({
      created_group_id: "grp-existing",
      created_group_name: "Existing — follow ups",
    });
    expect(saved[1].created_group_id).toBeUndefined();
  });

  it("skips already-created clusters in Create student groups", async () => {
    selectResult = {
      data: {
        report: REPORT,
        clusters: [
          { ...CLUSTERS[0], created_group_id: "grp-existing", created_group_name: "Existing — follow ups" },
          CLUSTERS[1],
        ],
        submission_count: 6,
        low_confidence: false,
      },
      error: null,
    };

    renderPanel();
    const user = userEvent.setup();

    await screen.findByText("Alice");
    await user.click(screen.getByTestId("create-offering-groups"));
    const dialog = await screen.findByRole("alertdialog");
    // The preview only promises what the write will do: the existing group
    // is not listed…
    expect(
      within(dialog).queryByText(/Treats subtraction as commutative/),
    ).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: /create student groups/i }));

    // …and only the not-yet-created cluster is written.
    await waitFor(() => expect(groupInserts.length).toBe(1));
    expect(groupInserts[0]).toMatchObject({
      name: "Secure on addition — Numbers 1-10 follow ups",
    });
  });

  it("never opens the follow-up flow from Create student groups", async () => {
    selectResult = {
      data: { report: REPORT, clusters: CLUSTERS, submission_count: 6, low_confidence: false },
      error: null,
    };

    renderPanel();
    const user = userEvent.setup();

    await screen.findByText("Alice");
    await user.click(screen.getByTestId("create-offering-groups"));
    const dialog = await screen.findByRole("alertdialog");
    // The confirm dialog is a plain preview now — no per-group opt-ins.
    expect(within(dialog).queryByRole("checkbox")).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: /create student groups/i }));

    await waitFor(() => expect(groupInserts.length).toBe(2));
    expect(screen.queryByTestId("cluster-followup-dialog")).not.toBeInTheDocument();
  });

  it("blocks Refresh while a cluster write is in flight", async () => {
    // Refresh upserts the same row the section writes. Letting them race means
    // a save resolving late can put the pre-refresh clusters back.
    selectResult = {
      data: { report: REPORT, clusters: CLUSTERS, submission_count: 6, low_confidence: false },
      error: null,
    };

    let releaseSave: () => void = () => {};
    updateGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });

    renderPanel();
    const user = userEvent.setup();

    await screen.findByText("Alice");
    const refresh = screen.getByTestId("sg-analysis-refresh");
    expect(refresh).not.toBeDisabled();

    await user.click(screen.getByRole("button", { name: /save groups/i }));
    await waitFor(() => expect(screen.getByTestId("sg-analysis-refresh")).toBeDisabled());

    releaseSave();
    await waitFor(() => expect(screen.getByTestId("sg-analysis-refresh")).not.toBeDisabled());
  });

  it("keeps unsaved edits across a flip to the assessment view and back", async () => {
    // The results dialog renders ONE panel instance across the Assessment and
    // Groups tabs and flips `view`; the hidden half stays mounted. A flip that
    // remounted the editor would silently discard renames and moves.
    selectResult = {
      data: { report: REPORT, clusters: CLUSTERS, submission_count: 6, low_confidence: false },
      error: null,
    };

    const props = {
      studyGuideId: "guide-1",
      courseId: "course-1",
      offeringId: "off-1",
      groupId: null,
      scopeLabel: "Whole class",
      pieceTitleByPosition: new Map<number, string>(),
      competencyTitleById: new Map<string, string>(),
      submissionCount: 3,
      guideTitle: "Numbers 1-10",
      roster: ROSTER,
    };
    const view = render(<StudyGuideAnalysisPanel {...props} view="groups" />);

    const firstName = await screen.findByLabelText("Group 1 name");
    fireEvent.change(firstName, { target: { value: "Renamed group" } });
    await waitFor(() => expect(firstName).toHaveValue("Renamed group"));

    view.rerender(<StudyGuideAnalysisPanel {...props} view="assessment" />);
    view.rerender(<StudyGuideAnalysisPanel {...props} view="groups" />);

    expect(screen.getByLabelText("Group 1 name")).toHaveValue("Renamed group");
  });

  it("creates only the groups that still have students after an edit", async () => {
    selectResult = {
      data: { report: REPORT, clusters: CLUSTERS, submission_count: 6, low_confidence: false },
      error: null,
    };

    renderPanel();
    const user = userEvent.setup();

    // Empty the second group by moving Carol out of it.
    const carolRow = (await screen.findByText("Carol")).closest("div")!
      .parentElement as HTMLElement;
    await user.click(within(carolRow).getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Unassigned" }));

    await user.click(screen.getByTestId("create-offering-groups"));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: /create student groups/i }));

    await waitFor(() => expect(groupInserts.length).toBe(1));
    expect(groupInserts[0]).toMatchObject({
      name: "Treats subtraction as commutative — Numbers 1-10 follow ups",
    });
    // Carol is unassigned, so she joins nothing.
    expect(memberInserts.flat().map((m) => m.user_id)).toEqual(["u1", "u2"]);
  });
});
