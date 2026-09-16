import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { InstructorHomeButton } from "@/components/InstructorHomeButton";

const navigateMock = vi.fn();
const rpcMock = vi.fn();
let role: string | null = "instructor";

vi.mock("react-router-dom", async () => ({
  ...(await vi.importActual("react-router-dom")),
  useNavigate: () => navigateMock,
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "user-1" } }),
}));

vi.mock("@/hooks/useUserInstitution", () => ({
  useUserInstitution: () => ({
    role,
    loading: false,
    isInstructor: role === "instructor",
    isAdmin: role === "admin",
  }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
  },
}));

function renderButton() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <InstructorHomeButton />
    </QueryClientProvider>,
  );
}

describe("InstructorHomeButton", () => {
  beforeEach(() => {
    navigateMock.mockClear();
    rpcMock.mockReset();
    rpcMock.mockResolvedValue({ data: false, error: null });
  });

  it("renders for an instructor and navigates to /instructor on click", async () => {
    role = "instructor";
    renderButton();

    const button = screen.getByRole("button", { name: /home/i });
    await userEvent.click(button);

    expect(navigateMock).toHaveBeenCalledWith("/instructor");
  });

  it("renders for an admin without consulting the super-admin RPC", () => {
    role = "admin";
    renderButton();

    expect(screen.getByRole("button", { name: /home/i })).toBeInTheDocument();
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("renders for a super admin with no membership role", async () => {
    role = null;
    rpcMock.mockResolvedValue({ data: true, error: null });
    renderButton();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /home/i })).toBeInTheDocument(),
    );
    expect(rpcMock).toHaveBeenCalledWith("is_super_admin", { _user_id: "user-1" });
  });

  it.each(["student", "evaluator", null])(
    "renders nothing when the membership role is %s and the user is not a super admin",
    async (nonInstructorRole) => {
      role = nonInstructorRole;
      const { container } = renderButton();

      await waitFor(() => expect(rpcMock).toHaveBeenCalled());
      expect(container).toBeEmptyDOMElement();
    },
  );
});
