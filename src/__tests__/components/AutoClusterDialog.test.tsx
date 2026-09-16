/**
 * #873 — AutoClusterDialog: cluster preview → review/edit → persist.
 *
 * The dialog asks the `cluster-students-by-performance` edge function for a
 * proposal, lets the instructor rename groups and reassign members, then
 * persists to `offering_groups` + `offering_group_members`.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const invokeMock = vi.hoisted(() => vi.fn());

// Captured insert payloads keyed by table, so the persist assertions can check
// exactly what was written.
const inserts = vi.hoisted(
  () => ({ current: [] as { table: string; rows: unknown }[] }),
);
const groupInsertResult = vi.hoisted(() => ({ current: 0 }));

vi.mock("@/integrations/supabase/client", () => {
  const buildChain = (table: string) => {
    const chain: Record<string, (...a: unknown[]) => unknown> = {};
    const passThrough = () => chain;
    chain.insert = (rows: unknown) => {
      inserts.current.push({ table, rows });
      return chain;
    };
    chain.select = passThrough;
    chain.delete = passThrough;
    chain.eq = passThrough;
    chain.in = passThrough;
    // offering_groups.insert(...).select("id").single() → new group id.
    chain.single = () => {
      const id = `group-${groupInsertResult.current++}`;
      return Promise.resolve({ data: { id }, error: null });
    };
    // offering_group_members.insert(...) and delete(...).in(...) awaited directly.
    chain.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(resolve({ data: null, error: null }));
    return chain;
  };
  return {
    supabase: {
      from: vi.fn((t: string) => buildChain(t)),
      functions: { invoke: invokeMock },
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

import { AutoClusterDialog } from "@/components/AutoClusterDialog";

const classes = [
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

const proposal = {
  groups: [
    {
      name: "Strong",
      rationale: "High mastery",
      description: "Advanced cohort",
      members: [
        { user_id: "u1", full_name: "Alice" },
        { user_id: "u2", full_name: "Bob" },
      ],
    },
    {
      name: "Developing",
      rationale: "Needs support",
      description: "Foundational cohort",
      members: [{ user_id: "u3", full_name: "Carol" }],
    },
  ],
  unassigned: [{ user_id: "u4", full_name: "Dan" }],
  stats: { roster_size: 4, with_data: 3, without_data: 1 },
};

beforeEach(() => {
  vi.clearAllMocks();
  inserts.current = [];
  groupInsertResult.current = 0;
});

describe("AutoClusterDialog (#873)", () => {
  it("renders the AI proposal (groups, members, unassigned) after generating", async () => {
    invokeMock.mockResolvedValueOnce({ data: proposal, error: null });

    render(
      <AutoClusterDialog open onOpenChange={() => {}} classes={classes} onPersisted={() => {}} />,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Generate proposal/i }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "cluster-students-by-performance",
        expect.objectContaining({
          body: expect.objectContaining({
            offering_id: "off-1",
            class_id: "cls-1",
            max_group_count: 5,
            avoid_existing_groups: true,
          }),
        }),
      );
    });

    // Proposed group names sit in editable inputs.
    expect((await screen.findByDisplayValue("Strong"))).toBeInTheDocument();
    expect(screen.getByDisplayValue("Developing")).toBeInTheDocument();

    // Members and the unassigned bucket render.
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("Carol")).toBeInTheDocument();
    expect(screen.getByText("Dan")).toBeInTheDocument();
    // Member-count badge on the first group.
    expect(screen.getByText("2 members")).toBeInTheDocument();
  });

  it("passes the instructor's special instructions to the clustering function", async () => {
    invokeMock.mockResolvedValueOnce({ data: proposal, error: null });

    render(
      <AutoClusterDialog open onOpenChange={() => {}} classes={classes} onPersisted={() => {}} />,
    );

    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText(/Special instructions/i),
      "Focus on essay-writing skills",
    );
    await user.click(screen.getByRole("button", { name: /Generate proposal/i }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "cluster-students-by-performance",
        expect.objectContaining({
          body: expect.objectContaining({
            special_instructions: "Focus on essay-writing skills",
          }),
        }),
      );
    });
  });

  it("sends avoid_existing_groups: false when the checkbox is unchecked", async () => {
    invokeMock.mockResolvedValueOnce({ data: proposal, error: null });

    render(
      <AutoClusterDialog open onOpenChange={() => {}} classes={classes} onPersisted={() => {}} />,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("checkbox", { name: /Avoid duplicating existing groups/i }));
    await user.click(screen.getByRole("button", { name: /Generate proposal/i }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "cluster-students-by-performance",
        expect.objectContaining({
          body: expect.objectContaining({ avoid_existing_groups: false }),
        }),
      );
    });
  });

  it("omits special_instructions when the field is left blank", async () => {
    invokeMock.mockResolvedValueOnce({ data: proposal, error: null });

    render(
      <AutoClusterDialog open onOpenChange={() => {}} classes={classes} onPersisted={() => {}} />,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Generate proposal/i }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalled();
    });
    const body = invokeMock.mock.calls[0][1].body as Record<string, unknown>;
    expect(body.special_instructions).toBeUndefined();
  });

  it("persists edited group names to offering_groups and members to offering_group_members", async () => {
    invokeMock.mockResolvedValueOnce({ data: proposal, error: null });
    const onPersisted = vi.fn();
    const onOpenChange = vi.fn();

    render(
      <AutoClusterDialog
        open
        onOpenChange={onOpenChange}
        classes={classes}
        onPersisted={onPersisted}
      />,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Generate proposal/i }));

    const strongInput = await screen.findByDisplayValue("Strong");
    // Rename the first group before persisting.
    await user.clear(strongInput);
    await user.type(strongInput, "Elite");

    await user.click(screen.getByRole("button", { name: /Create groups/i }));

    await waitFor(() => {
      expect(onPersisted).toHaveBeenCalled();
    });

    const groupInserts = inserts.current.filter((i) => i.table === "offering_groups");
    const memberInserts = inserts.current.filter(
      (i) => i.table === "offering_group_members",
    );

    // Two non-empty groups → two group inserts, using the edited name.
    expect(groupInserts).toHaveLength(2);
    expect(groupInserts[0].rows).toMatchObject({
      offering_id: "off-1",
      name: "Elite",
      description: "Advanced cohort",
    });
    expect(groupInserts[1].rows).toMatchObject({ name: "Developing" });

    // Members inserted for each group (group-0 gets u1+u2, group-1 gets u3).
    expect(memberInserts).toHaveLength(2);
    expect(memberInserts[0].rows).toEqual([
      { group_id: "group-0", user_id: "u1" },
      { group_id: "group-0", user_id: "u2" },
    ]);
    expect(memberInserts[1].rows).toEqual([
      { group_id: "group-1", user_id: "u3" },
    ]);

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("blocks persistence and toasts when two groups share a name", async () => {
    invokeMock.mockResolvedValueOnce({ data: proposal, error: null });

    render(
      <AutoClusterDialog open onOpenChange={() => {}} classes={classes} onPersisted={() => {}} />,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Generate proposal/i }));

    const developingInput = await screen.findByDisplayValue("Developing");
    await user.clear(developingInput);
    await user.type(developingInput, "Strong"); // collide with the first group

    await user.click(screen.getByRole("button", { name: /Create groups/i }));

    await waitFor(() => {
      expect(toastMocks.error).toHaveBeenCalledWith("Group names must be unique");
    });
    // Nothing written.
    expect(inserts.current).toHaveLength(0);
  });

  it("surfaces a warning and keeps the picker when no groups can be proposed", async () => {
    invokeMock.mockResolvedValueOnce({
      data: { groups: [], unassigned: [], stats: { roster_size: 0 }, warning: "Roster too small" },
      error: null,
    });

    render(
      <AutoClusterDialog open onOpenChange={() => {}} classes={classes} onPersisted={() => {}} />,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Generate proposal/i }));

    await waitFor(() => {
      expect(toastMocks.warning).toHaveBeenCalledWith("Roster too small");
    });
    // Still on the picker step — the Generate button remains.
    expect(screen.getByRole("button", { name: /Generate proposal/i })).toBeInTheDocument();
  });
});
