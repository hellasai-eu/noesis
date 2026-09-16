import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockFunctionsInvoke = vi.hoisted(() => vi.fn());
const mockToastSuccess = vi.hoisted(() => vi.fn());
const mockToastInfo = vi.hoisted(() => vi.fn());
const mockToastError = vi.hoisted(() => vi.fn());

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    functions: {
      invoke: mockFunctionsInvoke,
    },
  },
}));

vi.mock('sonner', () => ({
  toast: {
    success: mockToastSuccess,
    info: mockToastInfo,
    error: mockToastError,
  },
}));

import { RemoveUserMfaDialog } from '@/components/RemoveUserMfaDialog';

describe('RemoveUserMfaDialog', () => {
  const user = userEvent.setup();

  const renderOpen = (props: Partial<React.ComponentProps<typeof RemoveUserMfaDialog>> = {}) => {
    const onOpenChange = vi.fn();
    render(
      <RemoveUserMfaDialog
        userId="user-1"
        userLabel="Test Student"
        open
        onOpenChange={onOpenChange}
        {...props}
      />
    );
    return { onOpenChange };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockFunctionsInvoke.mockResolvedValue({ data: { success: true, removed: 1 }, error: null });
  });

  it('shows the target user in the confirmation copy', () => {
    renderOpen();

    expect(screen.getByText('Remove two-factor authentication?')).toBeInTheDocument();
    expect(screen.getByText(/Test Student's account/)).toBeInTheDocument();
  });

  it('invokes the edge function on confirm and closes on success', async () => {
    const { onOpenChange } = renderOpen();

    await user.click(screen.getByRole('button', { name: /^remove$/i }));

    await waitFor(() => {
      expect(mockFunctionsInvoke).toHaveBeenCalledWith('admin-reset-user-mfa', {
        body: { userId: 'user-1' },
      });
    });
    expect(mockToastSuccess).toHaveBeenCalledWith(
      'Two-factor authentication removed. The user has been signed out of all sessions.'
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('uses self-directed copy and toast when isSelf', async () => {
    renderOpen({ isSelf: true });

    expect(
      screen.getByText(/You will be signed out of ALL sessions — including this one/)
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^remove$/i }));

    await waitFor(() => {
      expect(mockToastSuccess).toHaveBeenCalledWith(
        'Two-factor authentication removed. You have been signed out of all sessions, including this one — sign in again with your password.'
      );
    });
  });

  it('shows an informational toast when the user had no factors', async () => {
    mockFunctionsInvoke.mockResolvedValue({ data: { success: true, removed: 0 }, error: null });
    const { onOpenChange } = renderOpen();

    await user.click(screen.getByRole('button', { name: /^remove$/i }));

    await waitFor(() => {
      expect(mockToastInfo).toHaveBeenCalledWith('This user has no two-factor authentication enrolled.');
    });
    expect(mockToastSuccess).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('does not invoke the function when cancelled', async () => {
    const { onOpenChange } = renderOpen();

    await user.click(screen.getByRole('button', { name: /cancel/i }));

    expect(mockFunctionsInvoke).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("surfaces the function's real error message from the response body", async () => {
    mockFunctionsInvoke.mockResolvedValue({
      data: null,
      error: Object.assign(new Error('Edge Function returned a non-2xx status code'), {
        context: {
          json: async () => ({
            error: "You are not authorized to remove this user's two-factor authentication",
          }),
        },
      }),
    });
    const { onOpenChange } = renderOpen();

    await user.click(screen.getByRole('button', { name: /^remove$/i }));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(
        "You are not authorized to remove this user's two-factor authentication"
      );
    });
    // Dialog stays open on failure.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('shows a generic message when the error body is not JSON', async () => {
    mockFunctionsInvoke.mockResolvedValue({
      data: null,
      error: Object.assign(new Error('Edge Function returned a non-2xx status code'), {
        context: {
          json: async () => {
            throw new Error('not json');
          },
        },
      }),
    });
    renderOpen();

    await user.click(screen.getByRole('button', { name: /^remove$/i }));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('Edge Function returned a non-2xx status code');
    });
  });
});
