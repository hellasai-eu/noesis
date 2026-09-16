import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Create hoisted mocks
const mockUpdatePassword = vi.hoisted(() => vi.fn());
const mockVerifyCurrentPassword = vi.hoisted(() => vi.fn());
const mockFunctionsInvoke = vi.hoisted(() => vi.fn());
const mockToastSuccess = vi.hoisted(() => vi.fn());
const mockToastError = vi.hoisted(() => vi.fn());
const mockUser = vi.hoisted(() => ({ email: 'test@example.com' }));

// Mock useAuth hook
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: mockUser,
    updatePassword: mockUpdatePassword,
  }),
}));

// Mock supabase client
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    functions: {
      invoke: mockFunctionsInvoke,
    },
  },
}));

// Current-password verification goes through a throwaway client (so the real
// session — possibly aal2 — is never replaced); mock the wrapper.
vi.mock('@/lib/verify-password', () => ({
  verifyCurrentPassword: mockVerifyCurrentPassword,
}));

// Mock sonner toast
vi.mock('sonner', () => ({
  toast: {
    success: mockToastSuccess,
    error: mockToastError,
  },
}));

// Import after mocks
import { ChangePasswordDialog } from '@/components/ChangePasswordDialog';

describe('ChangePasswordDialog', () => {
  const user = userEvent.setup();

  const fillAndSubmit = async (
    current = 'currentpass123',
    next = 'newpassword123',
    confirm = 'newpassword123'
  ) => {
    await user.type(screen.getByLabelText(/current password/i), current);
    await user.type(screen.getByLabelText(/new password/i), next);
    await user.type(screen.getByLabelText(/confirm password/i), confirm);
    await user.click(screen.getByRole('button', { name: /update password/i }));
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdatePassword.mockResolvedValue({ error: null });
    mockVerifyCurrentPassword.mockResolvedValue({ error: null });
    mockFunctionsInvoke.mockResolvedValue({ data: { success: true }, error: null });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('dialog rendering', () => {
    it('should render the trigger button', () => {
      render(<ChangePasswordDialog />);

      expect(screen.getByRole('button', { name: /change password/i })).toBeInTheDocument();
    });

    it('should open dialog when trigger is clicked', async () => {
      render(<ChangePasswordDialog />);

      await user.click(screen.getByRole('button', { name: /change password/i }));

      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(
        screen.getByText('Enter your current password and choose a new one')
      ).toBeInTheDocument();
    });

    it('should show password input fields when dialog is open', async () => {
      render(<ChangePasswordDialog />);

      await user.click(screen.getByRole('button', { name: /change password/i }));

      expect(screen.getByLabelText(/current password/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/new password/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/confirm password/i)).toBeInTheDocument();
    });
  });

  describe('validation', () => {
    it('should show error when password is less than 8 characters', async () => {
      render(<ChangePasswordDialog />);

      await user.click(screen.getByRole('button', { name: /change password/i }));
      await fillAndSubmit('currentpass123', '1234567', '1234567');

      expect(mockToastError).toHaveBeenCalledWith('Password must be at least 8 characters');
      expect(mockVerifyCurrentPassword).not.toHaveBeenCalled();
      expect(mockUpdatePassword).not.toHaveBeenCalled();
    });

    it('should require at least one letter and one number', async () => {
      render(<ChangePasswordDialog />);

      await user.click(screen.getByRole('button', { name: /change password/i }));
      await fillAndSubmit('currentpass123', '12345678', '12345678');

      expect(mockToastError).toHaveBeenCalledWith(
        'Password must contain at least one letter and one number',
      );
      expect(mockVerifyCurrentPassword).not.toHaveBeenCalled();
      expect(mockUpdatePassword).not.toHaveBeenCalled();
    });

    it('should show error when passwords do not match', async () => {
      render(<ChangePasswordDialog />);

      await user.click(screen.getByRole('button', { name: /change password/i }));
      await fillAndSubmit('currentpass123', 'password123', 'password456');

      expect(mockToastError).toHaveBeenCalledWith('Passwords do not match');
      expect(mockVerifyCurrentPassword).not.toHaveBeenCalled();
      expect(mockUpdatePassword).not.toHaveBeenCalled();
    });
  });

  describe('current password verification', () => {
    it('should call signInWithPassword with user email and current password', async () => {
      render(<ChangePasswordDialog />);

      await user.click(screen.getByRole('button', { name: /change password/i }));
      await fillAndSubmit('currentpass123', 'newpassword123', 'newpassword123');

      await waitFor(() => {
        expect(mockVerifyCurrentPassword).toHaveBeenCalledWith(
          'test@example.com',
          'currentpass123',
        );
      });
    });

    it('should show "Current password is incorrect" and NOT update password when verification fails', async () => {
      mockVerifyCurrentPassword.mockResolvedValue({
        error: new Error('Invalid login credentials'),
      });

      render(<ChangePasswordDialog />);

      await user.click(screen.getByRole('button', { name: /change password/i }));
      await fillAndSubmit('wrongpass', 'newpassword123', 'newpassword123');

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith('Current password is incorrect');
      });

      expect(mockUpdatePassword).not.toHaveBeenCalled();
      // Dialog should remain open
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('should proceed to updatePassword when verification succeeds', async () => {
      render(<ChangePasswordDialog />);

      await user.click(screen.getByRole('button', { name: /change password/i }));
      await fillAndSubmit('currentpass123', 'newpassword123', 'newpassword123');

      await waitFor(() => {
        expect(mockUpdatePassword).toHaveBeenCalledWith('newpassword123');
      });
    });
  });

  describe('submission', () => {
    it('should show success toast on successful password update', async () => {
      render(<ChangePasswordDialog />);

      await user.click(screen.getByRole('button', { name: /change password/i }));
      await fillAndSubmit();

      await waitFor(() => {
        expect(mockToastSuccess).toHaveBeenCalledWith('Password updated successfully');
      });
    });

    it('should close dialog on successful password update', async () => {
      render(<ChangePasswordDialog />);

      await user.click(screen.getByRole('button', { name: /change password/i }));

      expect(screen.getByRole('dialog')).toBeInTheDocument();

      await fillAndSubmit();

      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });
    });

    it('should clear all form fields after successful submission', async () => {
      render(<ChangePasswordDialog />);

      await user.click(screen.getByRole('button', { name: /change password/i }));
      await fillAndSubmit();

      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });

      // Reopen dialog
      await user.click(screen.getByRole('button', { name: /change password/i }));

      expect(screen.getByLabelText(/current password/i)).toHaveValue('');
      expect(screen.getByLabelText(/new password/i)).toHaveValue('');
      expect(screen.getByLabelText(/confirm password/i)).toHaveValue('');
    });

    it('should clear fields when dialog is closed without submitting', async () => {
      render(<ChangePasswordDialog />);

      await user.click(screen.getByRole('button', { name: /change password/i }));

      await user.type(screen.getByLabelText(/current password/i), 'somecurrent');
      await user.type(screen.getByLabelText(/new password/i), 'somenewpass');
      await user.type(screen.getByLabelText(/confirm password/i), 'somenewpass');

      // Close dialog via Escape key (triggers onOpenChange with false)
      await user.keyboard('{Escape}');

      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });

      // Reopen and verify fields are cleared
      await user.click(screen.getByRole('button', { name: /change password/i }));

      expect(screen.getByLabelText(/current password/i)).toHaveValue('');
      expect(screen.getByLabelText(/new password/i)).toHaveValue('');
      expect(screen.getByLabelText(/confirm password/i)).toHaveValue('');
    });
  });

  describe('password change notification', () => {
    // The change goes straight from here to GoTrue, so nothing server-side of
    // ours sees it. This callback is what gets the account holder an email and
    // writes the audit row.
    it('should notify the backend after a successful password change', async () => {
      render(<ChangePasswordDialog />);

      await user.click(screen.getByRole('button', { name: /change password/i }));
      await fillAndSubmit();

      await waitFor(() => {
        expect(mockFunctionsInvoke).toHaveBeenCalledWith('notify-password-changed');
      });
    });

    it('should not notify when the password change itself failed', async () => {
      mockUpdatePassword.mockResolvedValue({ error: new Error('Password is too weak') });

      render(<ChangePasswordDialog />);

      await user.click(screen.getByRole('button', { name: /change password/i }));
      await fillAndSubmit();

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalled();
      });
      expect(mockFunctionsInvoke).not.toHaveBeenCalled();
    });

    it('should not notify when the current password is wrong', async () => {
      mockVerifyCurrentPassword.mockResolvedValue({ error: new Error('Invalid credentials') });

      render(<ChangePasswordDialog />);

      await user.click(screen.getByRole('button', { name: /change password/i }));
      await fillAndSubmit();

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith('Current password is incorrect');
      });
      expect(mockFunctionsInvoke).not.toHaveBeenCalled();
    });

    it('should still report success when the notification fails', async () => {
      // The password IS changed by this point. Surfacing the notify failure
      // would tell the user otherwise and invite them to redo a done change.
      mockFunctionsInvoke.mockRejectedValue(new Error('network down'));
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      render(<ChangePasswordDialog />);

      await user.click(screen.getByRole('button', { name: /change password/i }));
      await fillAndSubmit();

      await waitFor(() => {
        expect(mockToastSuccess).toHaveBeenCalledWith('Password updated successfully');
      });
      expect(mockToastError).not.toHaveBeenCalled();

      consoleError.mockRestore();
    });
  });

  describe('error handling', () => {
    it('should show error toast when updatePassword fails', async () => {
      const errorMessage = 'Password is too weak';
      mockUpdatePassword.mockResolvedValue({ error: new Error(errorMessage) });

      render(<ChangePasswordDialog />);

      await user.click(screen.getByRole('button', { name: /change password/i }));
      await fillAndSubmit();

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith(errorMessage);
      });
    });

    it('should show generic error message when error has no message', async () => {
      mockUpdatePassword.mockResolvedValue({ error: {} });

      render(<ChangePasswordDialog />);

      await user.click(screen.getByRole('button', { name: /change password/i }));
      await fillAndSubmit();

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith('Failed to update password');
      });
    });

    it('should keep dialog open on error', async () => {
      mockUpdatePassword.mockResolvedValue({ error: new Error('Failed') });

      render(<ChangePasswordDialog />);

      await user.click(screen.getByRole('button', { name: /change password/i }));
      await fillAndSubmit();

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalled();
      });

      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
  });

  describe('password visibility toggle', () => {
    it('should toggle password visibility when eye icon is clicked', async () => {
      render(<ChangePasswordDialog />);

      await user.click(screen.getByRole('button', { name: /change password/i }));

      const newPasswordInput = screen.getByLabelText(/new password/i);

      expect(newPasswordInput).toHaveAttribute('type', 'password');

      const toggleButtons = screen.getAllByRole('button');
      const toggleButton = toggleButtons.find(
        (btn) =>
          btn.querySelector('svg') &&
          !btn.textContent?.includes('Change') &&
          !btn.textContent?.includes('Update')
      );

      if (toggleButton) {
        await user.click(toggleButton);

        expect(newPasswordInput).toHaveAttribute('type', 'text');
      }
    });
  });
});
