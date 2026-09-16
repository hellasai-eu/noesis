/* eslint-disable react-refresh/only-export-components */
import React, { ReactElement, ReactNode } from 'react';
import { render, RenderOptions } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { vi, Mock } from 'vitest';

// Create a mock Supabase client factory
export function createMockSupabaseClient() {
  const mockFrom = vi.fn(() => ({
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    neq: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: null, error: null }),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
  }));

  const mockAuth = {
    getSession: vi.fn().mockResolvedValue({
      data: { session: null },
      error: null,
    }),
    getUser: vi.fn().mockResolvedValue({
      data: { user: null },
      error: null,
    }),
    signInWithPassword: vi.fn().mockResolvedValue({
      data: { user: null, session: null },
      error: null,
    }),
    signUp: vi.fn().mockResolvedValue({
      data: { user: null, session: null },
      error: null,
    }),
    signOut: vi.fn().mockResolvedValue({ error: null }),
    updateUser: vi.fn().mockResolvedValue({
      data: { user: null },
      error: null,
    }),
    onAuthStateChange: vi.fn().mockReturnValue({
      data: {
        subscription: {
          unsubscribe: vi.fn(),
        },
      },
    }),
  };

  return {
    from: mockFrom,
    auth: mockAuth,
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  };
}

// Mock Supabase module
export const mockSupabase = createMockSupabaseClient();

// Mock the supabase import
vi.mock('@/integrations/supabase/client', () => ({
  supabase: mockSupabase,
}));

// Mock toast
export const mockToast = {
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
};

vi.mock('sonner', () => ({
  toast: mockToast,
}));

// Create test QueryClient
function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
        staleTime: 0,
      },
      mutations: {
        retry: false,
      },
    },
  });
}

// Auth context mock types
interface MockUser {
  id: string;
  email: string;
  user_metadata?: Record<string, unknown>;
}

interface MockSession {
  user: MockUser;
  access_token: string;
  refresh_token: string;
}

interface MockProfile {
  id: string;
  user_id: string;
  full_name: string | null;
  email: string | null;
}

interface MockAuthContextValue {
  user: MockUser | null;
  session: MockSession | null;
  profile: MockProfile | null;
  loading: boolean;
  signIn: Mock;
  signUp: Mock;
  signOut: Mock;
  updatePassword: Mock;
}

// Create Auth context mock
export function createMockAuthContext(overrides: Partial<MockAuthContextValue> = {}): MockAuthContextValue {
  return {
    user: null,
    session: null,
    profile: null,
    loading: false,
    signIn: vi.fn().mockResolvedValue({ error: null }),
    signUp: vi.fn().mockResolvedValue({ error: null, data: { user: null } }),
    signOut: vi.fn().mockResolvedValue(undefined),
    updatePassword: vi.fn().mockResolvedValue({ error: null }),
    ...overrides,
  };
}

// Create authenticated mock context
export function createAuthenticatedMockContext(
  userId = 'test-user-id',
  email = 'test@example.com',
  fullName = 'Test User'
): MockAuthContextValue {
  const mockUser: MockUser = {
    id: userId,
    email,
    user_metadata: { full_name: fullName },
  };

  const mockSession: MockSession = {
    user: mockUser,
    access_token: 'mock-access-token',
    refresh_token: 'mock-refresh-token',
  };

  const mockProfile: MockProfile = {
    id: 'profile-id',
    user_id: userId,
    full_name: fullName,
    email,
  };

  return createMockAuthContext({
    user: mockUser,
    session: mockSession,
    profile: mockProfile,
    loading: false,
  });
}

// Mock AuthProvider component
interface MockAuthProviderProps {
  children: ReactNode;
  value?: MockAuthContextValue;
}

const MockAuthContext = React.createContext<MockAuthContextValue | undefined>(undefined);

export function MockAuthProvider({ children, value }: MockAuthProviderProps) {
  const contextValue = value || createMockAuthContext();
  return (
    <MockAuthContext.Provider value={contextValue}>
      {children}
    </MockAuthContext.Provider>
  );
}

// Hook to use mock auth in tests
export function useMockAuth() {
  const context = React.useContext(MockAuthContext);
  if (context === undefined) {
    throw new Error('useMockAuth must be used within a MockAuthProvider');
  }
  return context;
}

// All providers wrapper
interface AllProvidersProps {
  children: ReactNode;
  authValue?: MockAuthContextValue;
}

function AllProviders({ children, authValue }: AllProvidersProps) {
  const queryClient = createTestQueryClient();

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <MockAuthProvider value={authValue}>
          {children}
        </MockAuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

// Custom render function
interface CustomRenderOptions extends Omit<RenderOptions, 'wrapper'> {
  authValue?: MockAuthContextValue;
}

function customRender(
  ui: ReactElement,
  { authValue, ...options }: CustomRenderOptions = {}
) {
  return render(ui, {
    wrapper: ({ children }) => (
      <AllProviders authValue={authValue}>{children}</AllProviders>
    ),
    ...options,
  });
}

// Re-export everything from testing library
export * from '@testing-library/react';
export { customRender as render };

// Helper to wait for async updates
export function waitForLoadingToFinish() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// Helper to reset all mocks
export function resetAllMocks() {
  vi.clearAllMocks();
  mockSupabase.from.mockClear();
  mockSupabase.auth.getSession.mockClear();
  mockSupabase.auth.signInWithPassword.mockClear();
  mockSupabase.auth.signUp.mockClear();
  mockSupabase.auth.signOut.mockClear();
  mockSupabase.auth.updateUser.mockClear();
  mockSupabase.auth.onAuthStateChange.mockClear();
  mockToast.success.mockClear();
  mockToast.error.mockClear();
}

// Helper to setup supabase mock responses
export function setupSupabaseMockResponse(
  tableName: string,
  method: 'select' | 'insert' | 'update' | 'delete',
  response: { data: unknown; error: unknown }
) {
  const mockChain = {
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    neq: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue(response),
    maybeSingle: vi.fn().mockResolvedValue(response),
  };

  mockSupabase.from.mockReturnValue(mockChain);
  return mockChain;
}
