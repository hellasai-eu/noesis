import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mockInvoke = vi.hoisted(() => vi.fn());
const mockToastSuccess = vi.hoisted(() => vi.fn());
const mockToastError = vi.hoisted(() => vi.fn());

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    functions: { invoke: mockInvoke },
  },
}));

vi.mock("sonner", () => ({
  toast: { success: mockToastSuccess, error: mockToastError },
}));

vi.mock("@/hooks/useInstitutionGradeLevels", () => ({
  useInstitutionGradeLevels: () => ({
    rows: [],
    options: [
      {
        id: "gl-dim-1",
        value: "dimotiko_1",
        labelEl: "1η Δημοτικού",
        labelEn: "1st Grade Primary",
        ordinal: 1,
        schoolLevel: "dimotiko",
        isGeneric: false,
      },
    ],
    loading: false,
    findIdByCode: (code: string | null | undefined) =>
      code === "dimotiko_1" ? "gl-dim-1" : null,
    findCodeById: (id: string | null | undefined) =>
      id === "gl-dim-1" ? "dimotiko_1" : null,
    getLabel: (code: string | null | undefined) =>
      code === "dimotiko_1" ? "1η Δημοτικού" : (code ?? ""),
    getLabelById: (id: string | null | undefined) =>
      id === "gl-dim-1" ? "1η Δημοτικού" : "",
  }),
}));

import { BulkImportDialog } from "@/components/BulkImportDialog";

const DEFAULT_PROPS = {
  open: true,
  onOpenChange: vi.fn(),
  institutionId: "inst-1",
  institutionName: "Test School",
  inviterName: "Admin",
  existingMemberEmails: new Set<string>(),
  existingInvitationEmails: new Set<string>(),
  classes: [
    { id: "class-1", grade_level: "dimotiko_1", grade_level_id: "gl-dim-1", section_name: "Α" },
    { id: "class-2", grade_level: "dimotiko_1", grade_level_id: "gl-dim-1", section_name: "Β" },
  ],
};

describe("BulkImportDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockResolvedValue({
      data: {
        success: true,
        results: [{ email: "ada@example.com", status: "invited" }],
        summary: { invited: 1, skipped: 0, failed: 0 },
      },
      error: null,
    });
  });

  it("renders the configure step for students with grade and section pickers", () => {
    render(<BulkImportDialog {...DEFAULT_PROPS} role="student" />);
    expect(screen.getByText(/bulk import students/i)).toBeInTheDocument();
    expect(screen.getAllByText(/grade level/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/assign all students to the same section/i)).toBeInTheDocument();
  });

  it("renders a simpler configure step for instructors (no grade picker)", () => {
    render(<BulkImportDialog {...DEFAULT_PROPS} role="instructor" />);
    expect(screen.getByText(/bulk import instructors/i)).toBeInTheDocument();
    expect(screen.queryByText(/assign all students to the same section/i)).not.toBeInTheDocument();
  });

  it("blocks Preview when grade level not chosen for students", async () => {
    const user = userEvent.setup();
    render(<BulkImportDialog {...DEFAULT_PROPS} role="student" />);
    await user.click(screen.getByRole("button", { name: /preview/i }));
    expect(mockToastError).toHaveBeenCalledWith("Pick a grade level first");
  });

  it("parses pasted CSV and shows preview with row count", async () => {
    const user = userEvent.setup();
    render(<BulkImportDialog {...DEFAULT_PROPS} role="instructor" />);

    const textarea = screen.getByRole("textbox");
    await user.click(textarea);
    await user.paste("email,first_name,last_name\nada@example.com,Ada,Lovelace\ngrace@example.com,Grace,Hopper");

    await user.click(screen.getByRole("button", { name: /preview/i }));

    await waitFor(() => {
      expect(screen.getByText("ada@example.com")).toBeInTheDocument();
      expect(screen.getByText("grace@example.com")).toBeInTheDocument();
    });
    // Two rows ready
    expect(screen.getByText(/2 ready/i)).toBeInTheDocument();
  });

  it("flags rows whose email matches an existing member as skipped", async () => {
    const user = userEvent.setup();
    render(
      <BulkImportDialog
        {...DEFAULT_PROPS}
        role="instructor"
        existingMemberEmails={new Set(["dup@example.com"])}
      />,
    );

    const textarea = screen.getByRole("textbox");
    await user.click(textarea);
    await user.paste("email\ndup@example.com\nfresh@example.com");

    await user.click(screen.getByRole("button", { name: /preview/i }));

    await waitFor(() => expect(screen.getByText("dup@example.com")).toBeInTheDocument());
    expect(screen.getByText(/1 ready/i)).toBeInTheDocument();
    expect(screen.getByText(/1 skip/i)).toBeInTheDocument();
  });

  it("flags invalid emails as errors", async () => {
    const user = userEvent.setup();
    render(<BulkImportDialog {...DEFAULT_PROPS} role="instructor" />);
    const textarea = screen.getByRole("textbox");
    await user.click(textarea);
    await user.paste("email\nnot-an-email\nvalid@example.com");
    await user.click(screen.getByRole("button", { name: /preview/i }));
    await waitFor(() => expect(screen.getByText("not-an-email")).toBeInTheDocument());
    expect(screen.getByText(/1 error/i)).toBeInTheDocument();
  });

  it("invokes bulk-invite-users with the structured payload on commit", async () => {
    const user = userEvent.setup();
    render(<BulkImportDialog {...DEFAULT_PROPS} role="instructor" />);
    const textarea = screen.getByRole("textbox");
    await user.click(textarea);
    await user.paste("email\nada@example.com");
    await user.click(screen.getByRole("button", { name: /preview/i }));
    await waitFor(() => expect(screen.getByText("ada@example.com")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /invite 1 instructor/i }));

    await waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(1));
    const [name, opts] = mockInvoke.mock.calls[0];
    expect(name).toBe("bulk-invite-users");
    expect(opts.body.role).toBe("instructor");
    expect(opts.body.rows[0].email).toBe("ada@example.com");
    expect(opts.body.institutionId).toBe("inst-1");
  });
});
