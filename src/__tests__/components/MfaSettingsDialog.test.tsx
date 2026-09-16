import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// input-otp polls document.elementFromPoint on a timer; jsdom doesn't
// implement it, and the uncaught TypeError would fail the run even with
// every test green.
if (!document.elementFromPoint) {
  document.elementFromPoint = () => null;
}

const mockListFactors = vi.hoisted(() => vi.fn());
const mockEnroll = vi.hoisted(() => vi.fn());
const mockChallengeAndVerify = vi.hoisted(() => vi.fn());
const mockUnenroll = vi.hoisted(() => vi.fn());
const mockToastSuccess = vi.hoisted(() => vi.fn());
const mockToastError = vi.hoisted(() => vi.fn());

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    auth: {
      mfa: {
        listFactors: mockListFactors,
        enroll: mockEnroll,
        challengeAndVerify: mockChallengeAndVerify,
        unenroll: mockUnenroll,
      },
    },
  },
}));

vi.mock('sonner', () => ({
  toast: {
    success: mockToastSuccess,
    error: mockToastError,
  },
}));

import { MfaSettingsDialog } from '@/components/MfaSettingsDialog';

const noFactors = { data: { all: [], totp: [] }, error: null };
const verifiedFactor = {
  id: 'factor-1',
  friendly_name: 'Authenticator app',
  factor_type: 'totp',
  status: 'verified',
  created_at: '2026-01-15T10:00:00Z',
  updated_at: '2026-01-15T10:00:00Z',
};
const withVerifiedFactor = {
  data: { all: [verifiedFactor], totp: [verifiedFactor] },
  error: null,
};

describe('MfaSettingsDialog', () => {
  const user = userEvent.setup();

  const openDialog = async () => {
    render(<MfaSettingsDialog />);
    await user.click(screen.getByRole('button', { name: /two-factor auth/i }));
    await waitFor(() => {
      expect(mockListFactors).toHaveBeenCalled();
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockListFactors.mockResolvedValue(noFactors);
    mockEnroll.mockResolvedValue({
      data: {
        id: 'factor-new',
        totp: { qr_code: 'data:image/svg+xml;utf-8,<svg/>', secret: 'SECRET123' },
      },
      error: null,
    });
    mockChallengeAndVerify.mockResolvedValue({ data: {}, error: null });
    mockUnenroll.mockResolvedValue({ data: {}, error: null });
  });

  describe('without an enrolled factor', () => {
    it('offers to set up an authenticator app', async () => {
      await openDialog();

      expect(
        await screen.findByRole('button', { name: /set up authenticator app/i })
      ).toBeInTheDocument();
    });

    it('shows QR code and secret after starting enrollment', async () => {
      await openDialog();
      await user.click(await screen.findByRole('button', { name: /set up authenticator app/i }));

      expect(await screen.findByAltText(/qr code/i)).toBeInTheDocument();
      expect(screen.getByTestId('mfa-secret')).toHaveTextContent('SECRET123');
      expect(mockEnroll).toHaveBeenCalledWith({
        factorType: 'totp',
        friendlyName: 'Authenticator app',
      });
    });

    it('removes unverified leftovers before enrolling again', async () => {
      mockListFactors.mockResolvedValue({
        data: {
          all: [{ id: 'stale-1', factor_type: 'totp', status: 'unverified' }],
          totp: [],
        },
        error: null,
      });

      await openDialog();
      await user.click(await screen.findByRole('button', { name: /set up authenticator app/i }));

      await waitFor(() => {
        expect(mockUnenroll).toHaveBeenCalledWith({ factorId: 'stale-1' });
      });
      expect(mockEnroll).toHaveBeenCalled();
    });

    it('activates the factor when a valid code is entered', async () => {
      await openDialog();
      await user.click(await screen.findByRole('button', { name: /set up authenticator app/i }));
      await screen.findByAltText(/qr code/i);

      // After activation the dialog reloads factors; return the enrolled one.
      mockListFactors.mockResolvedValue(withVerifiedFactor);

      await user.type(screen.getByTestId('mfa-enroll-code-input'), '123456');
      await user.click(screen.getByRole('button', { name: /activate/i }));

      await waitFor(() => {
        expect(mockChallengeAndVerify).toHaveBeenCalledWith({
          factorId: 'factor-new',
          code: '123456',
        });
      });
      expect(mockToastSuccess).toHaveBeenCalledWith('Two-factor authentication enabled');
    });

    it('keeps the enrollment view up when the code is rejected', async () => {
      mockChallengeAndVerify.mockResolvedValue({ data: null, error: new Error('invalid') });

      await openDialog();
      await user.click(await screen.findByRole('button', { name: /set up authenticator app/i }));
      await screen.findByAltText(/qr code/i);

      await user.type(screen.getByTestId('mfa-enroll-code-input'), '999999');
      await user.click(screen.getByRole('button', { name: /activate/i }));

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith('Invalid or expired code. Please try again.');
      });
      expect(screen.getByAltText(/qr code/i)).toBeInTheDocument();
    });

    it('discards the pending factor on cancel', async () => {
      await openDialog();
      await user.click(await screen.findByRole('button', { name: /set up authenticator app/i }));
      await screen.findByAltText(/qr code/i);

      await user.click(screen.getByRole('button', { name: /cancel/i }));

      await waitFor(() => {
        expect(mockUnenroll).toHaveBeenCalledWith({ factorId: 'factor-new' });
      });
      expect(
        await screen.findByRole('button', { name: /set up authenticator app/i })
      ).toBeInTheDocument();
    });
  });

  describe('with an enrolled factor', () => {
    beforeEach(() => {
      mockListFactors.mockResolvedValue(withVerifiedFactor);
    });

    it('lists the enrolled factor', async () => {
      await openDialog();

      expect(await screen.findByText('Authenticator app')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /remove/i })).toBeInTheDocument();
    });

    it('unenrolls after confirming removal', async () => {
      await openDialog();
      await user.click(await screen.findByRole('button', { name: /remove/i }));
      // Confirmation dialog
      await user.click(await screen.findByRole('button', { name: /^disable$/i }));

      await waitFor(() => {
        expect(mockUnenroll).toHaveBeenCalledWith({ factorId: 'factor-1' });
      });
      expect(mockToastSuccess).toHaveBeenCalledWith('Two-factor authentication disabled');
    });

    it('does not unenroll when removal is cancelled', async () => {
      await openDialog();
      await user.click(await screen.findByRole('button', { name: /remove/i }));
      await user.click(await screen.findByRole('button', { name: /keep enabled/i }));

      expect(mockUnenroll).not.toHaveBeenCalled();
    });
  });
});
