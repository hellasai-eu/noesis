import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Hoisted mocks ----------------------------------------------------------
const mockUser = vi.hoisted(() => ({ id: "user-123", email: "reporter@example.com" }));
const mockProfile = vi.hoisted(() => ({
  id: "p-1",
  user_id: "user-123",
  full_name: "Reporter",
  email: "reporter@example.com",
  father_name: null,
  date_of_birth: null,
}));
const mockStorageUpload = vi.hoisted(() => vi.fn());
const mockStorageRemove = vi.hoisted(() => vi.fn());
const mockInsert = vi.hoisted(() => vi.fn());
const mockRpc = vi.hoisted(() => vi.fn());
const mockToastSuccess = vi.hoisted(() => vi.fn());
const mockToastError = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: mockUser, profile: mockProfile }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    storage: {
      from: () => ({
        upload: mockStorageUpload,
        remove: mockStorageRemove,
      }),
    },
    from: () => ({ insert: mockInsert }),
    rpc: mockRpc,
  },
}));

vi.mock("sonner", () => ({
  toast: { success: mockToastSuccess, error: mockToastError },
}));

import { BugReportDialog, MAX_SCREENSHOT_BYTES, MAX_SCREENSHOTS } from "@/components/BugReportDialog";

function makeImageFile(name: string, sizeBytes: number, type = "image/png"): File {
  const buffer = new Uint8Array(sizeBytes);
  return new File([buffer], name, { type });
}

describe("BugReportDialog", () => {
  const user = userEvent.setup();

  beforeEach(() => {
    vi.clearAllMocks();
    mockStorageUpload.mockResolvedValue({ error: null });
    mockStorageRemove.mockResolvedValue({ error: null });
    mockInsert.mockResolvedValue({ error: null });
    mockRpc.mockResolvedValue({ data: null, error: null });
    // Mock crypto.randomUUID for deterministic paths if needed
    if (!globalThis.crypto?.randomUUID) {
      Object.defineProperty(globalThis.crypto ?? {}, "randomUUID", {
        value: () => "uuid-fixed",
        configurable: true,
      });
    }
    sessionStorage.clear();
  });

  it("renders all form controls (Title, Description, Attach screenshot, Cancel, Submit)", () => {
    render(<BugReportDialog open={true} onOpenChange={() => {}} />);
    expect(screen.getByLabelText(/title/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/description/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /attach screenshot/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^cancel$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /submit report/i })).toBeInTheDocument();
  });

  it("surfaces the attached file count in the Screenshots label and list", async () => {
    render(<BugReportDialog open={true} onOpenChange={() => {}} />);
    expect(screen.getByText(`Screenshots (0/${MAX_SCREENSHOTS})`)).toBeInTheDocument();

    const input = screen.getByTestId("bug-screenshot-input") as HTMLInputElement;
    await user.upload(input, makeImageFile("shot.png", 2048));

    expect(screen.getByText(`Screenshots (1/${MAX_SCREENSHOTS})`)).toBeInTheDocument();
    expect(screen.getByText("shot.png")).toBeInTheDocument();
  });

  it("Cancel button closes the dialog without inserting", async () => {
    const onOpenChange = vi.fn();
    render(<BugReportDialog open={true} onOpenChange={onOpenChange} />);
    await user.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("rejects files larger than the size cap", async () => {
    render(<BugReportDialog open={true} onOpenChange={() => {}} />);
    const input = screen.getByTestId("bug-screenshot-input") as HTMLInputElement;
    const tooBig = makeImageFile("big.png", MAX_SCREENSHOT_BYTES + 1);
    await user.upload(input, tooBig);
    expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining("5MB"));
  });

  it("rejects unsupported file types", async () => {
    render(<BugReportDialog open={true} onOpenChange={() => {}} />);
    const input = screen.getByTestId("bug-screenshot-input") as HTMLInputElement;
    const gif = makeImageFile("anim.gif", 1024, "image/gif");
    // userEvent.upload respects the `accept` attribute, so use fireEvent
    // to simulate a browser that lets the file through (e.g. drag-and-drop).
    fireEvent.change(input, { target: { files: [gif] } });
    expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining("PNG or JPG"));
  });

  it("caps attachments at the screenshot limit", async () => {
    render(<BugReportDialog open={true} onOpenChange={() => {}} />);
    const input = screen.getByTestId("bug-screenshot-input") as HTMLInputElement;
    const files = Array.from({ length: MAX_SCREENSHOTS + 2 }, (_, i) =>
      makeImageFile(`s${i}.png`, 1024),
    );
    await user.upload(input, files);
    expect(mockToastError).toHaveBeenCalledWith(
      expect.stringContaining(`Maximum ${MAX_SCREENSHOTS}`),
    );
  });

  it("requires title and description before submit", async () => {
    render(<BugReportDialog open={true} onOpenChange={() => {}} />);
    // Click submit with no input — the form's native required attribute
    // prevents submission, but our zod check is the source of truth.
    // Simulate a blank submit via the API path.
    await user.click(screen.getByRole("button", { name: /submit report/i }));
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("uploads screenshots, inserts the row, and shows success on submit", async () => {
    const onOpenChange = vi.fn();
    render(<BugReportDialog open={true} onOpenChange={onOpenChange} />);

    await user.type(screen.getByLabelText(/title/i), "Login crashes");
    await user.type(screen.getByLabelText(/description/i), "It explodes when I click sign in.");
    const input = screen.getByTestId("bug-screenshot-input") as HTMLInputElement;
    await user.upload(input, makeImageFile("evidence.png", 2048));

    await user.click(screen.getByRole("button", { name: /submit report/i }));

    await waitFor(() => {
      expect(mockStorageUpload).toHaveBeenCalledTimes(1);
    });
    const [uploadPath, uploadedFile] = mockStorageUpload.mock.calls[0];
    expect(uploadPath).toMatch(/^user-123\//);
    expect(uploadedFile).toBeInstanceOf(File);

    await waitFor(() => {
      expect(mockInsert).toHaveBeenCalledTimes(1);
    });
    const inserted = mockInsert.mock.calls[0][0];
    expect(inserted).toMatchObject({
      reporter_id: "user-123",
      reporter_email: "reporter@example.com",
      title: "Login crashes",
      description: "It explodes when I click sign in.",
    });
    expect(inserted.screenshot_paths).toHaveLength(1);
    expect(inserted.page_url).toBeTruthy();
    expect(inserted.user_agent).toBeTruthy();
    expect(inserted.viewport).toMatch(/^\d+x\d+$/);

    expect(mockToastSuccess).toHaveBeenCalledWith(expect.stringContaining("Bug report"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("cleans up uploaded screenshots when the insert fails", async () => {
    mockInsert.mockResolvedValueOnce({ error: { message: "RLS violation" } });
    render(<BugReportDialog open={true} onOpenChange={() => {}} />);
    await user.type(screen.getByLabelText(/title/i), "Title");
    await user.type(screen.getByLabelText(/description/i), "Body");
    const input = screen.getByTestId("bug-screenshot-input") as HTMLInputElement;
    await user.upload(input, makeImageFile("a.png", 1024));

    await user.click(screen.getByRole("button", { name: /submit report/i }));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith("RLS violation");
    });
    expect(mockStorageRemove).toHaveBeenCalledTimes(1);
    const removedPaths = mockStorageRemove.mock.calls[0][0];
    expect(removedPaths).toHaveLength(1);
    expect(removedPaths[0]).toMatch(/^user-123\//);
  });
});
