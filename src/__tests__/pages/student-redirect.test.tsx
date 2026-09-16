import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';

// --- Hoisted mocks ---
const mockNavigate = vi.hoisted(() => vi.fn());
const mockUser = vi.hoisted(() => ({
  id: 'student-user-id',
  email: 'student@test.local',
  email_confirmed_at: '2025-01-01T00:00:00Z',
  user_metadata: { full_name: 'Test Student' },
}));

const mockRpcImpl = vi.hoisted(() => vi.fn());
const mockFromImpl = vi.hoisted(() => vi.fn());

// --- Module mocks ---

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: mockUser,
    session: {
      user: mockUser,
      access_token: 'mock-token',
      refresh_token: 'mock-refresh',
    },
    profile: {
      id: 'profile-id',
      user_id: 'student-user-id',
      full_name: 'Test Student',
      email: 'student@test.local',
    },
    loading: false,
    signIn: vi.fn().mockResolvedValue({ error: null }),
    signUp: vi.fn().mockResolvedValue({ error: null, data: { user: null } }),
    signOut: vi.fn().mockResolvedValue(undefined),
    updatePassword: vi.fn().mockResolvedValue({ error: null }),
  }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Helper to build a self-referencing chain mock
function createChainMock(thenResult: { data: unknown; error: unknown }) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  const methods = [
    'select', 'insert', 'update', 'delete', 'eq', 'neq', 'in', 'not',
    'is', 'or', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'order',
    'limit', 'range', 'upsert',
  ];
  for (const m of methods) {
    chain[m] = vi.fn(() => chain);
  }
  chain.single = vi.fn().mockResolvedValue(thenResult);
  chain.maybeSingle = vi.fn().mockResolvedValue(thenResult);
  chain.then = vi.fn((cb: (val: { data: unknown; error: unknown }) => void) =>
    Promise.resolve(cb(thenResult))
  );
  return chain;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: mockFromImpl,
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
      getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: null }),
      onAuthStateChange: vi.fn().mockReturnValue({
        data: { subscription: { unsubscribe: vi.fn() } },
      }),
    },
    functions: {
      invoke: vi.fn().mockResolvedValue({ data: null, error: null }),
    },
    rpc: mockRpcImpl,
    channel: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }),
    })),
    removeChannel: vi.fn(),
    storage: {
      from: vi.fn(() => ({
        getPublicUrl: vi.fn(() => ({ data: { publicUrl: 'http://example.com/img.png' } })),
      })),
    },
  },
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('@/hooks/use-toast', () => ({
  toast: vi.fn(),
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock('@/lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

vi.mock('@/lib/latex-utils', () => ({
  processLatexContent: (text: string) => text,
  renderLatexInHtml: (text: string) => text,
  sanitizeMathContent: (text: string) => text,
}));

vi.mock('@/components/PasswordStrengthIndicator', () => ({
  default: () => <div data-testid="password-strength" />,
}));

// --- Helpers ---

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

function renderPage(Component: React.ComponentType) {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <MemoryRouter>
        <Component />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

// --- Tests ---

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
});

describe('SelectInstitution student redirect', () => {
  it('redirects student to /student when they have a single institution', async () => {
    // Mock is_super_admin → false
    mockRpcImpl.mockResolvedValue({ data: false, error: null });

    // Mock from() to return student institution data
    mockFromImpl.mockImplementation((table: string) => {
      if (table === 'user_institutions') {
        return createChainMock({
          data: [{
            institution_id: 'inst-1',
            role: 'student',
            institutions: {
              id: 'inst-1',
              name: 'Test School',
              slug: 'test-school',
              logo_url: null,
              is_public: false,
              country: null,
              description: null,
            },
          }],
          error: null,
        });
      }
      // institutions (public) query → empty
      return createChainMock({ data: [], error: null });
    });

    const mod = await import('@/pages/SelectInstitution');
    renderPage(mod.default);

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/student');
    });
    expect(mockNavigate).not.toHaveBeenCalledWith('/dashboard');
  });
});

describe('Dashboard student redirect', () => {
  it('redirects student (role=student) to /student', async () => {
    sessionStorage.setItem('selectedInstitutionId', 'inst-1');

    // is_super_admin → false, get_user_role_in_institution → "student"
    mockRpcImpl
      .mockResolvedValueOnce({ data: false, error: null })    // is_super_admin
      .mockResolvedValueOnce({ data: 'student', error: null }) // get_user_role_in_institution (useEffect)
      .mockResolvedValueOnce({ data: 'student', error: null }); // get_user_role_in_institution (fetchInstitutionData)

    mockFromImpl.mockImplementation(() =>
      createChainMock({ data: null, error: null })
    );

    const mod = await import('@/pages/Dashboard');
    renderPage(mod.default);

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/student');
    });
  });

  it('redirects to /student when get_user_role_in_institution returns null', async () => {
    sessionStorage.setItem('selectedInstitutionId', 'inst-1');

    // is_super_admin → false, get_user_role_in_institution → null
    mockRpcImpl
      .mockResolvedValueOnce({ data: false, error: null }) // is_super_admin
      .mockResolvedValueOnce({ data: null, error: null })  // get_user_role_in_institution (useEffect)
      .mockResolvedValueOnce({ data: null, error: null }); // get_user_role_in_institution (fetchInstitutionData)

    mockFromImpl.mockImplementation(() =>
      createChainMock({ data: null, error: null })
    );

    const mod = await import('@/pages/Dashboard');
    renderPage(mod.default);

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/student');
    });
  });

  // #667 — evaluators land on their own workspace, not on /student.
  it('redirects evaluator (role=evaluator) to /evaluator', async () => {
    sessionStorage.setItem('selectedInstitutionId', 'inst-1');

    mockRpcImpl
      .mockResolvedValueOnce({ data: false, error: null })       // is_super_admin
      .mockResolvedValueOnce({ data: 'evaluator', error: null })  // role check
      .mockResolvedValueOnce({ data: 'evaluator', error: null }); // role re-check in fetchInstitutionData

    mockFromImpl.mockImplementation(() =>
      createChainMock({ data: null, error: null })
    );

    const mod = await import('@/pages/Dashboard');
    renderPage(mod.default);

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/evaluator');
    });
    expect(mockNavigate).not.toHaveBeenCalledWith('/student');
  });
});

describe('SelectInstitution evaluator redirect', () => {
  // #667 — single-institution auto-redirect routes evaluators to /evaluator.
  it('redirects evaluator to /evaluator when they have a single institution', async () => {
    mockRpcImpl.mockResolvedValue({ data: false, error: null });

    mockFromImpl.mockImplementation((table: string) => {
      if (table === 'user_institutions') {
        return createChainMock({
          data: [{
            institution_id: 'inst-1',
            role: 'evaluator',
            institutions: {
              id: 'inst-1',
              name: 'Test School',
              slug: 'test-school',
              logo_url: null,
              is_public: false,
              country: null,
              description: null,
            },
          }],
          error: null,
        });
      }
      return createChainMock({ data: [], error: null });
    });

    const mod = await import('@/pages/SelectInstitution');
    renderPage(mod.default);

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/evaluator');
    });
    expect(mockNavigate).not.toHaveBeenCalledWith('/student');
    expect(mockNavigate).not.toHaveBeenCalledWith('/dashboard');
  });
});
