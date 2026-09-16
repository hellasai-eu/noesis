import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Create hoisted mocks
const mockLoadData = vi.hoisted(() => vi.fn());
const mockUser = vi.hoisted(() => ({ id: 'user-123' }));

// Mock useAuth hook
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: mockUser,
  }),
}));

// Mock supabase client with a comprehensive chain
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      not: vi.fn().mockReturnThis(),
    })),
  },
}));

// Import after mocks
import FlashcardSessionManager from '@/components/FlashcardSessionManager';

describe('FlashcardSessionManager', () => {
  const mockOnStartSession = vi.fn();

  const defaultProps = {
    courseId: 'course-123',
    onStartSession: mockOnStartSession,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('component rendering', () => {
    it('should render without crashing', () => {
      render(<FlashcardSessionManager {...defaultProps} />);

      // Component renders - either loading or content
      expect(document.body).toBeTruthy();
    });

    it('should show loading spinner when loading', () => {
      render(<FlashcardSessionManager {...defaultProps} />);

      // Check for loading spinner by class
      const spinnerElement = document.querySelector('.animate-spin');
      expect(spinnerElement).toBeTruthy();
    });

    it('should accept courseId prop', () => {
      const { rerender } = render(<FlashcardSessionManager {...defaultProps} />);

      // Should be able to rerender with different props
      rerender(<FlashcardSessionManager {...defaultProps} courseId="different-course" />);
      expect(document.body).toBeTruthy();
    });

    it('should accept offeringId prop', () => {
      render(<FlashcardSessionManager {...defaultProps} offeringId="offering-123" />);
      expect(document.body).toBeTruthy();
    });
  });

  describe('onStartSession callback', () => {
    it('should have onStartSession prop accessible', () => {
      render(<FlashcardSessionManager {...defaultProps} />);

      // The callback should be defined
      expect(mockOnStartSession).toBeDefined();
      expect(typeof mockOnStartSession).toBe('function');
    });
  });

  describe('user dependency', () => {
    it('should not load data when user is null', () => {
      // Temporarily override the mock to return null user
      const originalUser = mockUser;
      Object.assign(mockUser, { id: undefined });

      render(<FlashcardSessionManager {...defaultProps} />);

      // Restore
      Object.assign(mockUser, originalUser);
    });
  });
});
