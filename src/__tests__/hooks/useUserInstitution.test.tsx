import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// Create hoisted mocks
const mockSupabaseFrom = vi.hoisted(() => vi.fn());

// Mock the supabase client
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: mockSupabaseFrom,
  },
}));

// Import after mocks are set up
import { useUserInstitution } from '@/hooks/useUserInstitution';
import {
  fakeUserInstitutionsFrom,
  setSelectedInstitution,
  type Membership,
} from './fakeUserInstitutions';

/**
 * The hook reads the caller's whole membership list and picks from it in JS,
 * so these tests drive a fake that behaves like PostgREST rather than
 * asserting on a specific call chain. See fakeUserInstitutions.ts.
 */
function installFakeClient(rows: Membership[]) {
  mockSupabaseFrom.mockImplementation(fakeUserInstitutionsFrom(rows));
}

describe('useUserInstitution hook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setSelectedInstitution(null);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('should start with loading state when userId is provided', async () => {
      installFakeClient([]);

      const { result } = renderHook(() => useUserInstitution('user-123'));

      expect(result.current.loading).toBe(true);

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });
    });

    it('should not load when userId is undefined', async () => {
      const { result } = renderHook(() => useUserInstitution(undefined));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.membership).toBeNull();
      expect(mockSupabaseFrom).not.toHaveBeenCalled();
    });

    it('should return null membership when no data found', async () => {
      installFakeClient([]);

      const { result } = renderHook(() => useUserInstitution('user-123'));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.membership).toBeNull();
    });
  });

  describe('membership fetching', () => {
    it('should fetch membership for user', async () => {
      const mockMembership: Membership = {
        id: 'membership-123',
        user_id: 'user-123',
        institution_id: 'inst-123',
        role: 'student',
      };

      installFakeClient([mockMembership]);

      const { result } = renderHook(() => useUserInstitution('user-123'));

      await waitFor(() => {
        expect(result.current.membership).toEqual(mockMembership);
      });

      expect(result.current.institutionId).toBe('inst-123');
      expect(result.current.role).toBe('student');
    });

    it('should use selected institution from sessionStorage', async () => {
      const other: Membership = {
        id: 'membership-000',
        user_id: 'user-123',
        institution_id: 'other-inst',
        role: 'student',
      };
      const selected: Membership = {
        id: 'membership-123',
        user_id: 'user-123',
        institution_id: 'selected-inst-456',
        role: 'instructor',
      };

      setSelectedInstitution('selected-inst-456');
      installFakeClient([other, selected]);

      const { result } = renderHook(() => useUserInstitution('user-123'));

      await waitFor(() => {
        expect(result.current.membership).toEqual(selected);
      });

      expect(result.current.role).toBe('instructor');
    });

    it('should fallback to first membership if selected institution not found', async () => {
      const firstMembership: Membership = {
        id: 'membership-123',
        user_id: 'user-123',
        institution_id: 'first-inst',
        role: 'admin',
      };

      setSelectedInstitution('non-existent-inst');
      installFakeClient([firstMembership]);

      const { result } = renderHook(() => useUserInstitution('user-123'));

      await waitFor(() => {
        expect(result.current.membership).toEqual(firstMembership);
      });
    });

    it('should only consider memberships belonging to the user', async () => {
      const mine: Membership = {
        id: 'membership-mine',
        user_id: 'user-123',
        institution_id: 'inst-mine',
        role: 'student',
      };
      const someoneElses: Membership = {
        id: 'membership-theirs',
        user_id: 'user-999',
        institution_id: 'inst-theirs',
        role: 'admin',
      };

      installFakeClient([someoneElses, mine]);

      const { result } = renderHook(() => useUserInstitution('user-123'));

      await waitFor(() => {
        expect(result.current.membership).toEqual(mine);
      });
    });
  });

  describe('role helpers', () => {
    const base = { id: 'membership-123', user_id: 'user-123', institution_id: 'inst-123' };

    it('should return isAdmin true for admin role', async () => {
      installFakeClient([{ ...base, role: 'admin' }]);

      const { result } = renderHook(() => useUserInstitution('user-123'));

      await waitFor(() => {
        expect(result.current.isAdmin).toBe(true);
      });

      expect(result.current.isInstructor).toBe(false);
      expect(result.current.isStudent).toBe(false);
      expect(result.current.isEvaluator).toBe(false);
    });

    it('should return isInstructor true for instructor role', async () => {
      installFakeClient([{ ...base, role: 'instructor' }]);

      const { result } = renderHook(() => useUserInstitution('user-123'));

      await waitFor(() => {
        expect(result.current.isInstructor).toBe(true);
      });

      expect(result.current.isAdmin).toBe(false);
      expect(result.current.isStudent).toBe(false);
    });

    it('should return isStudent true for student role', async () => {
      installFakeClient([{ ...base, role: 'student' }]);

      const { result } = renderHook(() => useUserInstitution('user-123'));

      await waitFor(() => {
        expect(result.current.isStudent).toBe(true);
      });

      expect(result.current.isAdmin).toBe(false);
      expect(result.current.isInstructor).toBe(false);
    });

    it('should return isEvaluator true for evaluator role', async () => {
      installFakeClient([{ ...base, role: 'evaluator' }]);

      const { result } = renderHook(() => useUserInstitution('user-123'));

      await waitFor(() => {
        expect(result.current.isEvaluator).toBe(true);
      });

      expect(result.current.isAdmin).toBe(false);
      expect(result.current.isStudent).toBe(false);
    });

    it('should return all role helpers as false when no membership', async () => {
      installFakeClient([]);

      const { result } = renderHook(() => useUserInstitution('user-123'));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.isAdmin).toBe(false);
      expect(result.current.isInstructor).toBe(false);
      expect(result.current.isStudent).toBe(false);
      expect(result.current.isEvaluator).toBe(false);
    });
  });

  describe('refetch', () => {
    it('should refetch membership data', async () => {
      const membership: Membership = {
        id: 'membership-123',
        user_id: 'user-123',
        institution_id: 'inst-123',
        role: 'student',
      };

      const rows = [membership];
      installFakeClient(rows);

      const { result } = renderHook(() => useUserInstitution('user-123'));

      await waitFor(() => {
        expect(result.current.role).toBe('student');
      });

      // Role changed server-side (e.g. an admin promoted them)
      rows[0] = { ...membership, role: 'instructor' };

      await act(async () => {
        await result.current.refetch();
      });

      await waitFor(() => {
        expect(result.current.role).toBe('instructor');
      });
    });

    it('should not refetch when userId is undefined', async () => {
      const { result } = renderHook(() => useUserInstitution(undefined));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      await act(async () => {
        await result.current.refetch();
      });

      // Should not have called supabase
      expect(mockSupabaseFrom).not.toHaveBeenCalled();
    });
  });

  describe('userId changes', () => {
    it('should refetch when userId changes', async () => {
      const user1Membership: Membership = {
        id: 'membership-1',
        user_id: 'user-1',
        institution_id: 'inst-1',
        role: 'student',
      };

      const user2Membership: Membership = {
        id: 'membership-2',
        user_id: 'user-2',
        institution_id: 'inst-2',
        role: 'admin',
      };

      installFakeClient([user1Membership, user2Membership]);

      const { result, rerender } = renderHook(
        ({ userId }) => useUserInstitution(userId),
        { initialProps: { userId: 'user-1' } }
      );

      await waitFor(() => {
        expect(result.current.membership).toEqual(user1Membership);
      });

      rerender({ userId: 'user-2' });

      await waitFor(() => {
        expect(result.current.membership).toEqual(user2Membership);
      });
    });
  });
});
