import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// input-otp (inside MfaSettingsDialog) polls document.elementFromPoint on a
// timer; jsdom doesn't implement it.
if (!document.elementFromPoint) {
  document.elementFromPoint = () => null;
}

const mockRpc = vi.hoisted(() => vi.fn());
const mockSignOut = vi.hoisted(() => vi.fn());
const mockListFactors = vi.hoisted(() => vi.fn());
const mockUseAuth = vi.hoisted(() => vi.fn());

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: mockRpc,
    auth: {
      signOut: mockSignOut,
      mfa: {
        listFactors: mockListFactors,
        enroll: vi.fn(),
        challengeAndVerify: vi.fn(),
        unenroll: vi.fn(),
      },
    },
  },
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: mockUseAuth,
}));

import { MfaEnrollmentGate } from '@/components/MfaEnrollmentGate';

function renderGate() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MfaEnrollmentGate />
    </QueryClientProvider>
  );
}

function statusResponse(status: { required: boolean; recommended: boolean; deadline: string | null }) {
  mockRpc.mockResolvedValue({ data: status, error: null });
}

describe('MfaEnrollmentGate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    mockUseAuth.mockReturnValue({ user: { id: 'user-1' } });
    mockListFactors.mockResolvedValue({ data: { all: [], totp: [] }, error: null });
  });

  it('renders nothing when signed out', () => {
    mockUseAuth.mockReturnValue({ user: null });
    renderGate();
    expect(mockRpc).not.toHaveBeenCalled();
    expect(screen.queryByTestId('mfa-enrollment-gate')).toBeNull();
  });

  it('renders nothing when neither required nor recommended', async () => {
    statusResponse({ required: false, recommended: false, deadline: null });
    renderGate();
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('mfa_enrollment_status'));
    expect(screen.queryByTestId('mfa-enrollment-gate')).toBeNull();
    expect(screen.queryByTestId('mfa-recommendation-banner')).toBeNull();
  });

  it('hard-gates when required, with setup and sign-out as the only exits', async () => {
    statusResponse({ required: true, recommended: false, deadline: null });
    renderGate();

    expect(await screen.findByTestId('mfa-enrollment-gate')).toBeTruthy();
    expect(screen.getByText('Two-factor authentication required')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(mockSignOut).toHaveBeenCalled();
  });

  it('opens the enrollment dialog from the gate and refetches on close', async () => {
    statusResponse({ required: true, recommended: false, deadline: null });
    renderGate();

    await userEvent.click(await screen.findByTestId('mfa-gate-setup'));
    // The settings dialog is open (its title joins the gate's heading).
    expect(await screen.findByText('Two-Factor Authentication')).toBeTruthy();

    const callsBefore = mockRpc.mock.calls.length;
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(mockRpc.mock.calls.length).toBeGreaterThan(callsBefore));
  });

  it('shows a dismissible banner naming the deadline when recommended', async () => {
    statusResponse({ required: false, recommended: true, deadline: '2026-11-01T00:00:00Z' });
    renderGate();

    expect(await screen.findByTestId('mfa-recommendation-banner')).toBeTruthy();
    expect(screen.getByText(/November 1, 2026/)).toBeTruthy();
    expect(screen.queryByTestId('mfa-enrollment-gate')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('mfa-recommendation-banner')).toBeNull();
    expect(sessionStorage.getItem('mfa-recommendation-dismissed')).toBe('1');
  });

  it('keeps the banner dismissed for the session', async () => {
    sessionStorage.setItem('mfa-recommendation-dismissed', '1');
    statusResponse({ required: false, recommended: true, deadline: '2026-11-01T00:00:00Z' });
    renderGate();

    await waitFor(() => expect(mockRpc).toHaveBeenCalled());
    expect(screen.queryByTestId('mfa-recommendation-banner')).toBeNull();
  });
});
