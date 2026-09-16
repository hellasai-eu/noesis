import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { TutorState } from '@/types/tutor-state';

// Use vi.hoisted to ensure mocks are available when vi.mock runs
const {
  tableResponses,
  mockFrom,
  mockUpsert,
  mockChannelOn,
  mockChannelSubscribe,
  mockRemoveChannel,
  mockChannelFn,
} = vi.hoisted(() => ({
  /** Per-table result for a terminal maybeSingle()/single(). */
  tableResponses: new Map<string, { data: unknown; error: unknown }>(),
  mockFrom: vi.fn(),
  mockUpsert: vi.fn(),
  mockChannelOn: vi.fn(),
  mockChannelSubscribe: vi.fn(),
  mockRemoveChannel: vi.fn(),
  mockChannelFn: vi.fn(),
}));

/**
 * Chainable query stub.
 *
 * The hook now reads two tables with different chain lengths — the session by
 * (user, question), then its state by session id — so the mock resolves any
 * number of `.eq()` calls rather than a fixed two, and answers by table name.
 * A fixed-shape mock would fail on whichever chain it was not written for.
 */
vi.mock('@/integrations/supabase/client', () => {
  const build = (table: string) => {
    const result = () =>
      Promise.resolve(tableResponses.get(table) ?? { data: null, error: null });
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.maybeSingle = result;
    chain.single = result;
    chain.upsert = (...args: unknown[]) => {
      mockUpsert(table, ...args);
      return chain;
    };
    return chain;
  };

  return {
    supabase: {
      from: (table: string) => {
        mockFrom(table);
        return build(table);
      },
      channel: (...args: unknown[]) => {
        mockChannelFn(...args);
        return {
          on: (...onArgs: unknown[]) => {
            mockChannelOn(...onArgs);
            return {
              subscribe: (...subArgs: unknown[]) => {
                mockChannelSubscribe(...subArgs);
                return {};
              },
            };
          },
        };
      },
      removeChannel: mockRemoveChannel,
    },
  };
});

// Import after mock
import { useSocraticState } from '@/hooks/useSocraticState';

describe('useSocraticState', () => {
  const mockUserId = 'user-123';
  const mockQuestionId = 'question-456';
  const mockCourseId = 'course-789';

  const mockCurrentState: TutorState = {
    decision: 'ASK',
    state_update: {
      goal: 'Test goal',
      frustration: 2,
    },
  };

  /** State lives on its own row now, reached through the session. */
  const givenSessionWithState = (state: TutorState | null) => {
    tableResponses.set('chat_sessions', { data: { id: 'session-abc' }, error: null });
    tableResponses.set('chat_session_state', {
      data: state ? { current_state: state } : null,
      error: null,
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    tableResponses.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
    tableResponses.clear();
  });

  describe('initialization', () => {
    it('should start with loading state', () => {
      const { result } = renderHook(() =>
        useSocraticState({
          userId: mockUserId,
          openQuestionId: mockQuestionId,
          courseId: mockCourseId,
        })
      );

      expect(result.current.isLoading).toBe(true);
      expect(result.current.state).toBeNull();
    });

    it('should return null state when userId is missing', async () => {
      const { result } = renderHook(() =>
        useSocraticState({
          userId: null,
          openQuestionId: mockQuestionId,
          courseId: mockCourseId,
        })
      );

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.state).toBeNull();
    });

    it('should return null state when openQuestionId is missing', async () => {
      const { result } = renderHook(() =>
        useSocraticState({
          userId: mockUserId,
          openQuestionId: null,
          courseId: mockCourseId,
        })
      );

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.state).toBeNull();
    });
  });

  describe('fetching state', () => {
    it('should fetch state from database on mount', async () => {
      givenSessionWithState(mockCurrentState);

      const { result } = renderHook(() =>
        useSocraticState({
          userId: mockUserId,
          openQuestionId: mockQuestionId,
          courseId: mockCourseId,
        })
      );

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      // The session is resolved first, then its state.
      expect(mockFrom).toHaveBeenCalledWith('chat_sessions');
      expect(mockFrom).toHaveBeenCalledWith('chat_session_state');
      expect(result.current.state).toEqual(mockCurrentState);
    });

    it('should handle no existing state gracefully', async () => {
      givenSessionWithState(null);

      const { result } = renderHook(() =>
        useSocraticState({
          userId: mockUserId,
          openQuestionId: mockQuestionId,
          courseId: mockCourseId,
        })
      );

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.state).toBeNull();
      expect(result.current.error).toBeNull();
    });

    it('should set error on fetch failure', async () => {
      tableResponses.set('chat_sessions', {
        data: null,
        error: { message: 'Database error' },
      });

      const { result } = renderHook(() =>
        useSocraticState({
          userId: mockUserId,
          openQuestionId: mockQuestionId,
          courseId: mockCourseId,
        })
      );

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.error).toBeTruthy();
    });
  });

  describe('updateState', () => {
    it('should upsert state to database', async () => {
      const newState: TutorState = {
        decision: 'HINT',
        state_update: {
          goal: 'Updated goal',
          hint_level: 2,
        },
      };

      givenSessionWithState(mockCurrentState);

      const { result } = renderHook(() =>
        useSocraticState({
          userId: mockUserId,
          openQuestionId: mockQuestionId,
          courseId: mockCourseId,
        })
      );

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      // The upsert echoes the stored row back, as PostgREST does.
      tableResponses.set('chat_session_state', {
        data: { current_state: newState },
        error: null,
      });

      await act(async () => {
        await result.current.updateState(newState);
      });

      expect(mockUpsert).toHaveBeenCalledWith(
        'chat_session_state',
        expect.objectContaining({ session_id: 'session-abc' }),
        expect.objectContaining({ onConflict: 'session_id' }),
      );
      expect(result.current.state).toEqual(newState);
    });

    it('should throw error when parameters are missing', async () => {
      const { result } = renderHook(() =>
        useSocraticState({
          userId: null,
          openQuestionId: mockQuestionId,
          courseId: mockCourseId,
        })
      );

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      await expect(
        result.current.updateState({ decision: 'ASK' })
      ).rejects.toThrow('Missing required parameters');
    });
  });

  describe('refreshState', () => {
    it('should refetch state from database', async () => {
      givenSessionWithState(mockCurrentState);

      const { result } = renderHook(() =>
        useSocraticState({
          userId: mockUserId,
          openQuestionId: mockQuestionId,
          courseId: mockCourseId,
        })
      );

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      // Clear mock to track refresh call
      mockFrom.mockClear();

      await act(async () => {
        await result.current.refreshState();
      });

      expect(mockFrom).toHaveBeenCalledWith('chat_sessions');
    });
  });

  describe('real-time subscription', () => {
    it('should subscribe once the session is resolved', async () => {
      givenSessionWithState(null);

      renderHook(() =>
        useSocraticState({
          userId: mockUserId,
          openQuestionId: mockQuestionId,
          courseId: mockCourseId,
        })
      );

      await waitFor(() => {
        expect(mockChannelFn).toHaveBeenCalled();
        expect(mockChannelOn).toHaveBeenCalled();
        expect(mockChannelSubscribe).toHaveBeenCalled();
      });
    });

    it('should unsubscribe on unmount', async () => {
      givenSessionWithState(null);

      const { unmount } = renderHook(() =>
        useSocraticState({
          userId: mockUserId,
          openQuestionId: mockQuestionId,
          courseId: mockCourseId,
        })
      );

      await waitFor(() => {
        expect(mockChannelSubscribe).toHaveBeenCalled();
      });

      unmount();

      expect(mockRemoveChannel).toHaveBeenCalled();
    });

    it('filters the subscription to this session, not to the student', async () => {
      givenSessionWithState(null);

      renderHook(() =>
        useSocraticState({
          userId: mockUserId,
          openQuestionId: mockQuestionId,
          courseId: mockCourseId,
        })
      );

      await waitFor(() => {
        expect(mockChannelOn).toHaveBeenCalled();
      });

      // `chat_session_state` has no user column, so a user filter is not
      // available — an unfiltered subscription would deliver other students'
      // rows for the client to discard.
      expect(mockChannelOn).toHaveBeenCalledWith(
        'postgres_changes',
        expect.objectContaining({
          table: 'chat_session_state',
          filter: 'session_id=eq.session-abc',
        }),
        expect.any(Function),
      );
    });

    it('does not subscribe before a session exists', async () => {
      tableResponses.set('chat_sessions', { data: null, error: null });

      const { result } = renderHook(() =>
        useSocraticState({
          userId: mockUserId,
          openQuestionId: mockQuestionId,
          courseId: mockCourseId,
        })
      );

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(mockChannelSubscribe).not.toHaveBeenCalled();
    });
  });
});
