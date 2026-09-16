import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Create hoisted mocks
const mockAuthSubscription = vi.hoisted(() => ({
  unsubscribe: vi.fn(),
}));

const mockSupabaseAuth = vi.hoisted(() => ({
  getSession: vi.fn(),
  signInWithPassword: vi.fn(),
  signUp: vi.fn(),
  signOut: vi.fn(),
  updateUser: vi.fn(),
  onAuthStateChange: vi.fn(() => ({
    data: { subscription: mockAuthSubscription },
  })),
}));

const mockSupabaseFrom = vi.hoisted(() => vi.fn(() => ({
  select: vi.fn().mockReturnThis(),
  eq: vi.fn().mockReturnThis(),
  maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
})));

const mockSupabaseFunctions = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue({ data: { ok: true }, error: null }),
}));

// Mock the supabase client
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    auth: mockSupabaseAuth,
    from: mockSupabaseFrom,
    functions: mockSupabaseFunctions,
  },
}));

// Mock fetch for IP address lookup
global.fetch = vi.fn().mockResolvedValue({
  json: vi.fn().mockResolvedValue({ ip: '127.0.0.1' }),
});

// Import after mocks are set up
import { AuthProvider, useAuth } from '@/hooks/useAuth';

// Wrapper component for tests
let queryClient: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>
    <AuthProvider>{children}</AuthProvider>
  </QueryClientProvider>
);

describe('useAuth hook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    mockSupabaseAuth.getSession.mockResolvedValue({
      data: { session: null },
      error: null,
    });
    mockSupabaseAuth.onAuthStateChange.mockReturnValue({
      data: { subscription: mockAuthSubscription },
    });
    mockSupabaseFunctions.invoke.mockResolvedValue({ data: { ok: true }, error: null });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('should start with loading state', async () => {
      const { result } = renderHook(() => useAuth(), { wrapper });

      // Initially loading is true
      expect(result.current.loading).toBe(true);

      // Wait for loading to complete
      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });
    });

    it('should have null user when not authenticated', async () => {
      const { result } = renderHook(() => useAuth(), { wrapper });

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.user).toBeNull();
      expect(result.current.session).toBeNull();
      expect(result.current.profile).toBeNull();
    });

    it('should subscribe to auth state changes on mount', async () => {
      renderHook(() => useAuth(), { wrapper });

      await waitFor(() => {
        expect(mockSupabaseAuth.onAuthStateChange).toHaveBeenCalled();
      });
    });

    it('should unsubscribe from auth state changes on unmount', async () => {
      const { unmount } = renderHook(() => useAuth(), { wrapper });

      await waitFor(() => {
        expect(mockSupabaseAuth.onAuthStateChange).toHaveBeenCalled();
      });

      unmount();

      expect(mockAuthSubscription.unsubscribe).toHaveBeenCalled();
    });
  });

  describe('session restoration', () => {
    it('should restore session from getSession', async () => {
      const mockUser = {
        id: 'user-123',
        email: 'test@example.com',
      };
      const mockSession = {
        user: mockUser,
        access_token: 'token-123',
      };

      mockSupabaseAuth.getSession.mockResolvedValue({
        data: { session: mockSession },
        error: null,
      });

      const { result } = renderHook(() => useAuth(), { wrapper });

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.user).toEqual(mockUser);
      expect(result.current.session).toEqual(mockSession);
    });

    it('should fetch profile when session exists', async () => {
      const mockUser = {
        id: 'user-123',
        email: 'test@example.com',
      };
      const mockSession = {
        user: mockUser,
        access_token: 'token-123',
      };
      const mockProfile = {
        id: 'profile-123',
        user_id: 'user-123',
        full_name: 'Test User',
        email: 'test@example.com',
      };

      mockSupabaseAuth.getSession.mockResolvedValue({
        data: { session: mockSession },
        error: null,
      });

      mockSupabaseFrom.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: mockProfile, error: null }),
      });

      const { result } = renderHook(() => useAuth(), { wrapper });

      await waitFor(() => {
        expect(result.current.profile).toEqual(mockProfile);
      });
    });
  });

  describe('signIn', () => {
    it('should call supabase signInWithPassword', async () => {
      mockSupabaseAuth.signInWithPassword.mockResolvedValue({
        data: { user: { id: 'user-123' }, session: {} },
        error: null,
      });

      const { result } = renderHook(() => useAuth(), { wrapper });

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      await act(async () => {
        const response = await result.current.signIn('test@example.com', 'password123');
        expect(response.error).toBeNull();
      });

      expect(mockSupabaseAuth.signInWithPassword).toHaveBeenCalledWith({
        email: 'test@example.com',
        password: 'password123',
      });
    });

    it('should return error on failed sign in', async () => {
      const mockError = new Error('Invalid credentials');
      mockSupabaseAuth.signInWithPassword.mockResolvedValue({
        data: null,
        error: mockError,
      });

      const { result } = renderHook(() => useAuth(), { wrapper });

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      await act(async () => {
        const response = await result.current.signIn('test@example.com', 'wrongpassword');
        expect(response.error).toEqual(mockError);
      });
    });

    // A failed sign-in used to be toasted and dropped: login_history is only
    // written on success and the browser talks to GoTrue directly, so nothing
    // recorded it anywhere. These pin the reporting path shut.
    it('should report a failed sign-in to record-login-attempt', async () => {
      mockSupabaseAuth.signInWithPassword.mockResolvedValue({
        data: null,
        error: { message: 'Invalid login credentials' },
      });

      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current.loading).toBe(false));

      await act(async () => {
        await result.current.signIn('test@example.com', 'wrongpassword');
        // Reporting is deferred so it cannot block the login flow.
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(mockSupabaseFunctions.invoke).toHaveBeenCalledWith(
        'record-login-attempt',
        { body: { email: 'test@example.com', reason: 'invalid_credentials' } },
      );
      // The password must never leave the browser on this path.
      const payload = JSON.stringify(mockSupabaseFunctions.invoke.mock.calls);
      expect(payload).not.toContain('wrongpassword');
    });

    it('should classify a banned account distinctly', async () => {
      mockSupabaseAuth.signInWithPassword.mockResolvedValue({
        data: null,
        error: { code: 'user_banned', message: 'User is banned' },
      });

      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current.loading).toBe(false));

      await act(async () => {
        await result.current.signIn('banned@example.com', 'pw');
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(mockSupabaseFunctions.invoke).toHaveBeenCalledWith(
        'record-login-attempt',
        { body: { email: 'banned@example.com', reason: 'user_banned' } },
      );
    });

    it('should not report anything on a successful sign-in', async () => {
      mockSupabaseAuth.signInWithPassword.mockResolvedValue({
        data: { user: { id: 'user-123' }, session: {} },
        error: null,
      });

      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current.loading).toBe(false));

      await act(async () => {
        await result.current.signIn('test@example.com', 'correct');
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(mockSupabaseFunctions.invoke).not.toHaveBeenCalledWith(
        'record-login-attempt',
        expect.anything(),
      );
    });

    it('should still surface the sign-in error when reporting fails', async () => {
      const mockError = { message: 'Invalid login credentials' };
      mockSupabaseAuth.signInWithPassword.mockResolvedValue({ data: null, error: mockError });
      mockSupabaseFunctions.invoke.mockRejectedValue(new Error('network down'));

      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current.loading).toBe(false));

      await act(async () => {
        // The user is already looking at a failed login; a broken reporter must
        // not turn that into a second, different failure.
        const response = await result.current.signIn('test@example.com', 'wrongpassword');
        expect(response.error).toEqual(mockError);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    });
  });

  describe('signUp', () => {
    it('should call supabase signUp with correct parameters', async () => {
      const mockUser = { id: 'new-user-123', email: 'new@example.com' };
      mockSupabaseAuth.signUp.mockResolvedValue({
        data: { user: mockUser, session: null },
        error: null,
      });

      const { result } = renderHook(() => useAuth(), { wrapper });

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      await act(async () => {
        const response = await result.current.signUp('new@example.com', 'password123', 'New User');
        expect(response.error).toBeNull();
        expect(response.data?.user).toEqual(mockUser);
      });

      expect(mockSupabaseAuth.signUp).toHaveBeenCalledWith({
        email: 'new@example.com',
        password: 'password123',
        options: {
          emailRedirectTo: expect.any(String),
          data: {
            full_name: 'New User',
          },
        },
      });
    });

    it('should return error on failed sign up', async () => {
      const mockError = new Error('Email already registered');
      mockSupabaseAuth.signUp.mockResolvedValue({
        data: null,
        error: mockError,
      });

      const { result } = renderHook(() => useAuth(), { wrapper });

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      await act(async () => {
        const response = await result.current.signUp('existing@example.com', 'password123', 'User');
        expect(response.error).toEqual(mockError);
      });
    });
  });

  describe('signOut', () => {
    it('should clear user state and call supabase signOut', async () => {
      const mockUser = {
        id: 'user-123',
        email: 'test@example.com',
      };
      const mockSession = {
        user: mockUser,
        access_token: 'token-123',
      };

      mockSupabaseAuth.getSession.mockResolvedValue({
        data: { session: mockSession },
        error: null,
      });
      mockSupabaseAuth.signOut.mockResolvedValue({ error: null });

      const { result } = renderHook(() => useAuth(), { wrapper });

      await waitFor(() => {
        expect(result.current.user).toEqual(mockUser);
      });

      await act(async () => {
        await result.current.signOut();
      });

      expect(result.current.user).toBeNull();
      expect(result.current.session).toBeNull();
      expect(result.current.profile).toBeNull();
      expect(mockSupabaseAuth.signOut).toHaveBeenCalledWith({ scope: 'global' });
    });

    it('should clear the react-query cache on sign out', async () => {
      const mockUser = { id: 'user-123', email: 'test@example.com' };
      const mockSession = { user: mockUser, access_token: 'token-123' };

      mockSupabaseAuth.getSession.mockResolvedValue({
        data: { session: mockSession },
        error: null,
      });
      mockSupabaseAuth.signOut.mockResolvedValue({ error: null });

      const clearSpy = vi.spyOn(queryClient, 'clear');

      const { result } = renderHook(() => useAuth(), { wrapper });

      await waitFor(() => {
        expect(result.current.user).toEqual(mockUser);
      });

      await act(async () => {
        await result.current.signOut();
      });

      expect(clearSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('updatePassword', () => {
    it('should call supabase updateUser with new password', async () => {
      mockSupabaseAuth.updateUser.mockResolvedValue({
        data: { user: {} },
        error: null,
      });

      const { result } = renderHook(() => useAuth(), { wrapper });

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      await act(async () => {
        const response = await result.current.updatePassword('newpassword123');
        expect(response.error).toBeNull();
      });

      expect(mockSupabaseAuth.updateUser).toHaveBeenCalledWith({
        password: 'newpassword123',
      });
    });

    it('should return error on failed password update', async () => {
      const mockError = new Error('Password too weak');
      mockSupabaseAuth.updateUser.mockResolvedValue({
        data: null,
        error: mockError,
      });

      const { result } = renderHook(() => useAuth(), { wrapper });

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      await act(async () => {
        const response = await result.current.updatePassword('weak');
        expect(response.error).toEqual(mockError);
      });
    });
  });

  describe('useAuth outside provider', () => {
    it('should throw error when used outside AuthProvider', () => {
      // Suppress console.error for this test
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      expect(() => {
        renderHook(() => useAuth());
      }).toThrow('useAuth must be used within an AuthProvider');

      consoleSpy.mockRestore();
    });
  });
});
