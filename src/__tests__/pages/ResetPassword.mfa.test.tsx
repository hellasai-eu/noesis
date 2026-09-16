import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// input-otp polls document.elementFromPoint on a timer; jsdom doesn't
// implement it, and the uncaught TypeError would fail the run even with
// every test green.
if (!document.elementFromPoint) {
  document.elementFromPoint = () => null;
}

const mockGetSession = vi.hoisted(() => vi.fn());
const mockOnAuthStateChange = vi.hoisted(() => vi.fn());
const mockListFactors = vi.hoisted(() => vi.fn());
const mockChallengeAndVerify = vi.hoisted(() => vi.fn());
const mockUpdateUser = vi.hoisted(() => vi.fn());
const mockSignOut = vi.hoisted(() => vi.fn());
const mockNavigate = vi.hoisted(() => vi.fn());
const mockToastError = vi.hoisted(() => vi.fn());
const mockToastSuccess = vi.hoisted(() => vi.fn());

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    auth: {
      getSession: mockGetSession,
      onAuthStateChange: mockOnAuthStateChange,
      updateUser: mockUpdateUser,
      signOut: mockSignOut,
      mfa: {
        listFactors: mockListFactors,
        challengeAndVerify: mockChallengeAndVerify,
      },
    },
  },
}));

vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => mockNavigate,
}));

vi.mock('sonner', () => ({
  toast: { error: mockToastError, success: mockToastSuccess },
}));

import ResetPassword from '@/pages/ResetPassword';

// isMfaPending decodes the real access token, so the fixtures carry a real
// (unsigned) JWT payload with the aal claim.
function sessionWithAal(aal: string, factors: Array<{ factor_type: string; status: string }>) {
  const payload = Buffer.from(JSON.stringify({ aal })).toString('base64url');
  return {
    access_token: `header.${payload}.sig`,
    user: { id: 'user-1', factors },
  };
}

const VERIFIED = [{ factor_type: 'totp', status: 'verified' }];

function arrange(session: unknown) {
  mockGetSession.mockResolvedValue({ data: { session }, error: null });
  mockOnAuthStateChange.mockReturnValue({
    data: { subscription: { unsubscribe: vi.fn() } },
  });
}

describe('ResetPassword — recovery MFA challenge', () => {
  const user = userEvent.setup();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the password form directly for an unenrolled user', async () => {
    arrange(sessionWithAal('aal1', []));
    render(<ResetPassword />);

    expect(await screen.findByText('Set New Password')).toBeTruthy();
    expect(screen.queryByTestId('mfa-code-input')).toBeNull();
  });

  it('shows the TOTP challenge, not the password form, for an enrolled aal1 session', async () => {
    arrange(sessionWithAal('aal1', VERIFIED));
    render(<ResetPassword />);

    expect(await screen.findByTestId('mfa-code-input')).toBeTruthy();
    expect(screen.getByText('Two-Factor Authentication')).toBeTruthy();
    expect(screen.queryByText('Set New Password')).toBeNull();
  });

  it('skips the challenge when the recovery session is already aal2', async () => {
    arrange(sessionWithAal('aal2', VERIFIED));
    render(<ResetPassword />);

    expect(await screen.findByText('Set New Password')).toBeTruthy();
    expect(screen.queryByTestId('mfa-code-input')).toBeNull();
  });

  it('a valid code unlocks the password form', async () => {
    arrange(sessionWithAal('aal1', VERIFIED));
    mockListFactors.mockResolvedValue({
      data: { totp: [{ id: 'factor-1', status: 'verified' }] },
      error: null,
    });
    mockChallengeAndVerify.mockResolvedValue({ error: null });
    render(<ResetPassword />);

    await user.type(await screen.findByTestId('mfa-code-input'), '123456');
    await user.click(screen.getByRole('button', { name: /verify/i }));

    await waitFor(() => {
      expect(mockChallengeAndVerify).toHaveBeenCalledWith({
        factorId: 'factor-1',
        code: '123456',
      });
    });
    expect(await screen.findByText('Set New Password')).toBeTruthy();
  });

  it('a wrong code keeps the challenge up', async () => {
    arrange(sessionWithAal('aal1', VERIFIED));
    mockListFactors.mockResolvedValue({
      data: { totp: [{ id: 'factor-1', status: 'verified' }] },
      error: null,
    });
    mockChallengeAndVerify.mockResolvedValue({ error: { message: 'invalid' } });
    render(<ResetPassword />);

    await user.type(await screen.findByTestId('mfa-code-input'), '999999');
    await user.click(screen.getByRole('button', { name: /verify/i }));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('Invalid or expired code. Please try again.');
    });
    expect(screen.getByTestId('mfa-code-input')).toBeTruthy();
    expect(screen.queryByText('Set New Password')).toBeNull();
  });

  it('a failed sign-out is reported, not silently swallowed', async () => {
    arrange(sessionWithAal('aal1', VERIFIED));
    mockSignOut.mockResolvedValue({ error: { message: 'network down' } });
    render(<ResetPassword />);

    await screen.findByTestId('mfa-code-input');
    await user.click(screen.getByRole('button', { name: /back to sign in/i }));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(
        'Sign-out did not complete. If this is a shared device, close this browser tab.'
      );
    });
    expect(mockNavigate).toHaveBeenCalledWith('/auth');
  });

  it('backing out signs the recovery session out', async () => {
    arrange(sessionWithAal('aal1', VERIFIED));
    mockSignOut.mockResolvedValue({ error: null });
    render(<ResetPassword />);

    await screen.findByTestId('mfa-code-input');
    await user.click(screen.getByRole('button', { name: /back to sign in/i }));

    await waitFor(() => expect(mockSignOut).toHaveBeenCalled());
    expect(mockNavigate).toHaveBeenCalledWith('/auth');
  });
});
