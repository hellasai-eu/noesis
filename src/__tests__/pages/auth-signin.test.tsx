import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';

// --- Hoisted mocks ---
const mockNavigate = vi.hoisted(() => vi.fn());
const mockSignIn = vi.hoisted(() => vi.fn());
const mockToastError = vi.hoisted(() => vi.fn());
const mockToastSuccess = vi.hoisted(() => vi.fn());
const mockToastInfo = vi.hoisted(() => vi.fn());

// --- Module mocks ---

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: null,
    session: null,
    profile: null,
    loading: false,
    signIn: mockSignIn,
    signUp: vi.fn().mockResolvedValue({ error: null, data: { user: null } }),
    signOut: vi.fn().mockResolvedValue(undefined),
    updatePassword: vi.fn().mockResolvedValue({ error: null }),
  }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SIGNOUT_REASON_STORAGE_KEY: 'signoutReason',
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    })),
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: null }),
      getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
      resetPasswordForEmail: vi.fn().mockResolvedValue({ error: null }),
    },
    functions: {
      invoke: vi.fn().mockResolvedValue({ data: null, error: null }),
    },
  },
}));

vi.mock('sonner', () => ({
  toast: {
    success: mockToastSuccess,
    error: mockToastError,
    info: mockToastInfo,
    warning: vi.fn(),
  },
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock('@/lib/versionCheck', () => ({
  checkVersionAndNavigate: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/components/PasswordStrengthIndicator', () => ({
  default: () => <div data-testid="password-strength" />,
}));

function renderAuth() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  // Lazy import so module mocks above are in place.
  return import('@/pages/Auth').then(({ default: Auth }) =>
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <Auth />
        </MemoryRouter>
      </QueryClientProvider>
    )
  );
}

async function submitSignIn() {
  const emailInput = (await screen.findByLabelText(/email/i)) as HTMLInputElement;
  const passwordInput = (await screen.findByLabelText(/password/i)) as HTMLInputElement;
  fireEvent.change(emailInput, { target: { value: 'banned@example.com' } });
  fireEvent.change(passwordInput, { target: { value: 'password123' } });

  // Submit the form directly to avoid ambiguity with the TabsTrigger "Sign In" button.
  const form = passwordInput.closest('form');
  if (!form) throw new Error('Sign-in form not found');
  fireEvent.submit(form);
}

describe('Auth handleSignIn — banned user error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
  });

  it('shows generic admin-contact toast when signIn returns code "user_banned"', async () => {
    mockSignIn.mockResolvedValue({
      error: Object.assign(new Error('User is banned'), { code: 'user_banned' }),
    });

    await renderAuth();
    await submitSignIn();

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(
        'Login failed. Please contact an administrator.'
      );
    });
    expect(mockToastError).not.toHaveBeenCalledWith('User is banned');
  });

  it('falls back to message-substring match when error has no code (older SDK)', async () => {
    mockSignIn.mockResolvedValue({
      // No `code` field — only the message indicates banned status.
      error: new Error('User is banned'),
    });

    await renderAuth();
    await submitSignIn();

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(
        'Login failed. Please contact an administrator.'
      );
    });
  });

  it('still shows "Invalid email or password" for invalid-credentials errors', async () => {
    mockSignIn.mockResolvedValue({
      error: new Error('Invalid login credentials'),
    });

    await renderAuth();
    await submitSignIn();

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('Invalid email or password');
    });
    expect(mockToastError).not.toHaveBeenCalledWith(
      'Login failed. Please contact an administrator.'
    );
  });

  it('surfaces the raw message for other Supabase errors', async () => {
    mockSignIn.mockResolvedValue({
      error: new Error('Email not confirmed'),
    });

    await renderAuth();
    await submitSignIn();

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('Email not confirmed');
    });
  });
});

describe('Auth — terms and privacy agreement (#937)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
  });

  it('tells a new account holder what they are agreeing to, with working links', async () => {
    await renderAuth();

    // The Sign Up tab holds the public form. Both signup forms carry the line,
    // so finding it here is the wiring check.
    // Radix only mounts the active tab's content, and it activates on a real
    // pointer sequence rather than a bare click event.
    await userEvent.click(await screen.findByRole('tab', { name: /sign up/i }));

    const agreement = await screen.findByTestId('signup-agreement');
    expect(agreement).toHaveTextContent(/By creating an account you agree to/i);

    expect(
      within(agreement).getByRole('link', { name: /Terms of Service/i })
    ).toHaveAttribute('href', '/legal/terms');
    expect(
      within(agreement).getByRole('link', { name: /Privacy Policy/i })
    ).toHaveAttribute('href', '/legal/privacy');
  });

  it('does not ask for a consent tick', async () => {
    // The platform does not rely on the account holder's consent — the school
    // is the controller, and most account holders are minors. A checkbox would
    // record a consent nothing acts on.
    await renderAuth();
    await userEvent.click(await screen.findByRole('tab', { name: /sign up/i }));

    const agreement = await screen.findByTestId('signup-agreement');
    expect(agreement.querySelector('input[type="checkbox"]')).toBeNull();
  });
});
