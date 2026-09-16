/**
 * #873 — OfferingGroupsPanel: loads offering groups + member counts, and
 * creates a new group. Individual (per-student) groups must be filtered out of
 * the manual-grouping view.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

type Result = { data: unknown; error: unknown };

const groupsResponse = vi.hoisted(() => ({ current: { data: [], error: null } as Result }));
const membersResponse = vi.hoisted(() => ({ current: { data: [], error: null } as Result }));
const insertResult = vi.hoisted(() => ({ current: { error: null } as { error: unknown } }));
const inserts = vi.hoisted(() => ({ current: [] as { table: string; rows: unknown }[] }));

vi.mock("@/integrations/supabase/client", () => {
  const buildChain = (table: string) => {
    const chain: Record<string, (...a: unknown[]) => unknown> = {};
    const passThrough = () => chain;
    chain.select = passThrough;
    chain.insert = (rows: unknown) => {
      inserts.current.push({ table, rows });
      // offering_groups create is awaited on the insert result directly.
      return Promise.resolve(insertResult.current);
    };
    chain.update = passThrough;
    chain.delete = passThrough;
    chain.eq = passThrough;
    chain.in = () => {
      // `.in()` is the terminal call for both select queries here.
      if (table === "offering_groups") return Promise.resolve(groupsResponse.current);
      if (table === "offering_group_members") return Promise.resolve(membersResponse.current);
      return chain;
    };
    chain.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(resolve({ data: [], error: null }));
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

// Isolate from child dialogs that run their own supabase queries.
vi.mock("@/components/AutoClusterDialog", () => ({
  AutoClusterDialog: () => null,
}));
vi.mock("@/components/StudentNotesDialog", () => ({
  StudentNotesDialog: () => null,
}));
const generateDialogProps = vi.hoisted(() => ({ current: [] as unknown[] }));
vi.mock("@/components/UnifiedGenerateDialog", () => ({
  UnifiedGenerateDialog: (props: unknown) => {
    generateDialogProps.current.push(props);
    return <div data-testid="unified-generate-dialog" />;
  },
}));

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

import { OfferingGroupsPanel } from "@/components/OfferingGroupsPanel";

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

const twoClasses = [
  ...classes,
  {
    id: "cls-2",
    name: "B2",
    grade_level_id: null,
    section_name: null,
    category: null,
    academic_period: null,
    offering_id: "off-2",
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  inserts.current = [];
  generateDialogProps.current = [];
  insertResult.current = { error: null };
  groupsResponse.current = {
    data: [
      { id: "g-1", offering_id: "off-1", name: "Advanced Track", description: "top", is_individual: false },
      { id: "g-2", offering_id: "off-1", name: "Support Track", description: null, is_individual: false },
      // Individual group — must be hidden.
      { id: "g-ind", offering_id: "off-1", name: "Individual: Alice", description: null, is_individual: true },
    ],
    error: null,
  };
  membersResponse.current = {
    data: [
      { group_id: "g-1" },
      { group_id: "g-1" },
      { group_id: "g-2" },
    ],
    error: null,
  };
});

describe("OfferingGroupsPanel (#873)", () => {
  it("renders the class group count and hides individual groups", async () => {
    render(<OfferingGroupsPanel courseId="course-1" classes={classes} />);

    // The class row shows "2 groups" (the individual group is filtered out).
    await waitFor(() => {
      expect(screen.getByText("2 groups")).toBeInTheDocument();
    });
  });

  it("shows each group's member count and description open by default, and folds on click", async () => {
    render(<OfferingGroupsPanel courseId="course-1" classes={classes} />);

    // Group names, member counts, and descriptions render without expanding.
    expect(await screen.findByText("Advanced Track")).toBeInTheDocument();
    expect(screen.getByText("Support Track")).toBeInTheDocument();
    expect(screen.getByText("2 members")).toBeInTheDocument(); // g-1
    expect(screen.getByText("1 member")).toBeInTheDocument(); // g-2
    expect(screen.getByText("top")).toBeInTheDocument(); // g-1 description
    // The individual group name must not appear.
    expect(screen.queryByText("Individual: Alice")).not.toBeInTheDocument();

    // Clicking the class header folds the section.
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /A1/i }));
    await waitFor(() => {
      expect(screen.queryByText("Advanced Track")).not.toBeInTheDocument();
    });
  });

  it("opens the generate dialog targeted at the clicked group", async () => {
    render(<OfferingGroupsPanel courseId="course-1" classes={classes} />);

    await screen.findByText("Advanced Track");
    expect(screen.queryByTestId("unified-generate-dialog")).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: /Generate questions/i })[0]);

    expect(await screen.findByTestId("unified-generate-dialog")).toBeInTheDocument();
    const props = generateDialogProps.current.at(-1) as {
      courseId: string;
      initialAudience: { kind: string; groupId: string; description: string | null };
    };
    expect(props.courseId).toBe("course-1");
    expect(props.initialAudience).toMatchObject({
      kind: "group",
      groupId: "g-1",
      offeringId: "off-1",
      description: "top",
    });
  });

  it("blocks group creation when the name is blank", async () => {
    render(<OfferingGroupsPanel courseId="course-1" classes={classes} />);

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /New group/i }));

    // Submit the create dialog with an empty name.
    const create = await screen.findByRole("button", { name: /^Create$/i });
    await user.click(create);

    await waitFor(() => {
      expect(toastMocks.error).toHaveBeenCalledWith("Group name is required");
    });
    expect(inserts.current.filter((i) => i.table === "offering_groups")).toHaveLength(0);
  });

  it("inserts a new group into offering_groups on create", async () => {
    render(<OfferingGroupsPanel courseId="course-1" classes={classes} />);

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /New group/i }));

    await user.type(await screen.findByLabelText(/^Name$/i), "Wednesday Lab");
    await user.type(screen.getByLabelText(/Description/i), "lab cohort");
    await user.click(screen.getByRole("button", { name: /^Create$/i }));

    await waitFor(() => {
      expect(toastMocks.success).toHaveBeenCalledWith("Group created");
    });

    const groupInserts = inserts.current.filter((i) => i.table === "offering_groups");
    expect(groupInserts).toHaveLength(1);
    expect(groupInserts[0].rows).toMatchObject({
      offering_id: "off-1",
      name: "Wednesday Lab",
      description: "lab cohort",
    });
  });

  it("creates the group under the class picked in the multi-class dialog", async () => {
    render(<OfferingGroupsPanel courseId="course-1" classes={twoClasses} />);

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /New group/i }));

    // The picker defaults to the first class; switch to the second.
    await user.click(await screen.findByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "B2" }));

    await user.type(screen.getByLabelText(/^Name$/i), "Lab B");
    await user.click(screen.getByRole("button", { name: /^Create$/i }));

    await waitFor(() => {
      expect(toastMocks.success).toHaveBeenCalledWith("Group created");
    });

    const groupInserts = inserts.current.filter((i) => i.table === "offering_groups");
    expect(groupInserts).toHaveLength(1);
    expect(groupInserts[0].rows).toMatchObject({
      offering_id: "off-2",
      name: "Lab B",
    });
  });
});
