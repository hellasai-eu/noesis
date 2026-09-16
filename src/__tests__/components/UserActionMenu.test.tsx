import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

// input-otp (rendered by MfaSettingsDialog) polls document.elementFromPoint on
// a timer; jsdom doesn't implement it.
if (!document.elementFromPoint) {
  document.elementFromPoint = () => null;
}

const mockListFactors = vi.hoisted(() => vi.fn());
const mockUnenroll = vi.hoisted(() => vi.fn());
const mockAuthState = vi.hoisted(() => ({
  user: { email: 'menu-user@example.com', email_confirmed_at: '2026-01-01T00:00:00Z' },
  profile: { email: 'menu-user@example.com', full_name: 'Menu User' },
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => mockAuthState,
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    auth: {
      mfa: {
        listFactors: mockListFactors,
        unenroll: mockUnenroll,
      },
    },
    functions: { invoke: vi.fn() },
  },
}));

vi.mock('@/lib/verify-password', () => ({
  verifyCurrentPassword: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { UserActionMenu } from '@/components/UserActionMenu';

const renderMenu = (props: Partial<React.ComponentProps<typeof UserActionMenu>> = {}) =>
  render(
    <MemoryRouter>
      <UserActionMenu onSignOut={props.onSignOut ?? vi.fn()} {...props} />
    </MemoryRouter>
  );

describe('UserActionMenu', () => {
  const user = userEvent.setup();

  const openMenu = async () => {
    await user.click(screen.getByTestId('user-menu-trigger'));
    await screen.findByRole('menu');
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockListFactors.mockResolvedValue({ data: { all: [], totp: [] }, error: null });
  });

  it('labels the trigger with the user name and shows email + role in the menu', async () => {
    renderMenu({ roleLabel: 'Super Admin' });

    expect(screen.getByTestId('user-menu-trigger')).toHaveTextContent('Menu User');

    await openMenu();
    expect(screen.getByText('menu-user@example.com')).toBeInTheDocument();
    expect(screen.getByText('Super Admin')).toBeInTheDocument();
  });

  it('opens the change-password dialog from the menu and closes it again', async () => {
    renderMenu();
    await openMenu();

    await user.click(screen.getByRole('menuitem', { name: /change password/i }));
    expect(await screen.findByLabelText(/current password/i)).toBeInTheDocument();

    // Dismissal must propagate to the parent's controlled state, unmounting
    // the dialog — not just requesting a close that nothing applies.
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByLabelText(/current password/i)).not.toBeInTheDocument();
    });
  });

  it('opens the two-factor dialog from the menu and loads factors', async () => {
    renderMenu();
    await openMenu();

    await user.click(screen.getByRole('menuitem', { name: /two-factor auth/i }));

    // The controlled open bypasses Radix onOpenChange; the load must still fire.
    await waitFor(() => {
      expect(mockListFactors).toHaveBeenCalled();
    });
    expect(await screen.findByText(/set up authenticator app/i)).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByText(/set up authenticator app/i)).not.toBeInTheDocument();
    });
  });

  it('shows "Report a bug" only when a handler is provided, and calls it', async () => {
    const onReportBug = vi.fn();
    const { unmount } = renderMenu({ onReportBug });
    await openMenu();

    await user.click(screen.getByRole('menuitem', { name: /report a bug/i }));
    expect(onReportBug).toHaveBeenCalledTimes(1);
    unmount();

    renderMenu();
    await openMenu();
    expect(screen.queryByRole('menuitem', { name: /report a bug/i })).not.toBeInTheDocument();
  });

  it('calls onSignOut from the sign-out item', async () => {
    const onSignOut = vi.fn();
    renderMenu({ onSignOut });
    await openMenu();

    await user.click(screen.getByRole('menuitem', { name: /sign out/i }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });
});
