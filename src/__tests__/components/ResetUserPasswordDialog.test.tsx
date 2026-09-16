/**
 * #818 — ResetUserPasswordDialog: an admin/super-admin sets a new password for
 * another user via the `admin-set-user-password` edge function. Validation is
 * client-side (min 8 chars, match); the function is the real authorization gate
 * and its error text must surface to the user.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    functions: { invoke: invokeMock },
  },
}));

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: toastMocks }));

// jsdom shims for Radix.
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
  if (typeof globalThis.ResizeObserver === "undefined") {
    class RO {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    (globalThis as unknown as { ResizeObserver: typeof RO }).ResizeObserver = RO;
  }
});

import { ResetUserPasswordDialog } from "@/components/ResetUserPasswordDialog";

const renderDialog = () =>
  render(
    <ResetUserPasswordDialog
      userId="target-1"
      userLabel="Jane Doe"
      open
      onOpenChange={() => {}}
    />,
  );

beforeEach(() => {
  invokeMock.mockReset();
  toastMocks.success.mockReset();
  toastMocks.error.mockReset();
});

describe("ResetUserPasswordDialog", () => {
  it("rejects a password shorter than 8 characters without calling the function", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText("New Password"), "short");
    await user.type(screen.getByLabelText("Confirm Password"), "short");
    await user.click(screen.getByRole("button", { name: /reset password/i }));

    expect(invokeMock).not.toHaveBeenCalled();
    expect(toastMocks.error).toHaveBeenCalledWith(
      "Password must be at least 8 characters",
    );
  });

  it("rejects mismatched passwords without calling the function", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText("New Password"), "password123");
    await user.type(screen.getByLabelText("Confirm Password"), "password999");
    await user.click(screen.getByRole("button", { name: /reset password/i }));

    expect(invokeMock).not.toHaveBeenCalled();
    expect(toastMocks.error).toHaveBeenCalledWith("Passwords do not match");
  });

  it("invokes the function and toasts success on a valid submit", async () => {
    invokeMock.mockResolvedValue({ data: { success: true }, error: null });
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText("New Password"), "password123");
    await user.type(screen.getByLabelText("Confirm Password"), "password123");
    await user.click(screen.getByRole("button", { name: /reset password/i }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("admin-set-user-password", {
        body: { userId: "target-1", newPassword: "password123" },
      });
    });
    expect(toastMocks.success).toHaveBeenCalledWith("Password reset successfully");
  });

  it("surfaces the function's real error text from FunctionsHttpError context", async () => {
    invokeMock.mockResolvedValue({
      data: null,
      error: {
        message: "Edge Function returned a non-2xx status code",
        context: {
          json: async () => ({
            error: "Only a super-admin can reset another super-admin's password",
          }),
        },
      },
    });
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText("New Password"), "password123");
    await user.type(screen.getByLabelText("Confirm Password"), "password123");
    await user.click(screen.getByRole("button", { name: /reset password/i }));

    await waitFor(() => {
      expect(toastMocks.error).toHaveBeenCalledWith(
        "Only a super-admin can reset another super-admin's password",
      );
    });
    expect(toastMocks.success).not.toHaveBeenCalled();
  });
});
