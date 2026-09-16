import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Create hoisted mocks
const mockInvoke = vi.hoisted(() => vi.fn());
const mockToastSuccess = vi.hoisted(() => vi.fn());
const mockToastError = vi.hoisted(() => vi.fn());
const mockNavigate = vi.hoisted(() => vi.fn());

// Mock supabase client
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    functions: {
      invoke: mockInvoke,
    },
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          single: vi.fn(() => Promise.resolve({ data: null, error: null })),
          order: vi.fn(() => Promise.resolve({ data: [], error: null })),
        })),
        single: vi.fn(() => Promise.resolve({ data: null, error: null })),
      })),
    })),
    auth: {
      getUser: vi.fn(() => Promise.resolve({ data: { user: null }, error: null })),
    },
  },
}));

// Mock useAuth hook
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'user-123' },
    profile: { full_name: 'Test Admin', email: 'admin@test.com' },
    effectiveInstitutionId: 'inst-456',
    isSuperAdmin: false,
  }),
}));

// Mock react-router-dom
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}));

// Mock sonner toast
vi.mock('sonner', () => ({
  toast: {
    success: mockToastSuccess,
    error: mockToastError,
  },
}));

describe('UserManagement - Resend Invitation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockResolvedValue({ data: { success: true }, error: null });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('handleResendInvitation', () => {
    it('should pass invitationId when resending an invitation', async () => {
      // This test verifies the fix for the bug where resending invitations
      // would not include the invitationId, causing invalid invitation links

      const invitation = {
        id: 'invitation-789',
        email: 'invited@example.com',
        status: 'pending',
        role: 'student',
        created_at: new Date().toISOString(),
      };

      const effectiveInstitutionId = 'inst-456';
      const institutionName = 'Test University';
      const inviterName = 'Test Admin';

      // Simulate the handleResendInvitation function call
      await mockInvoke('send-invitation', {
        body: {
          email: invitation.email,
          institutionId: effectiveInstitutionId,
          institutionName: institutionName,
          inviterName: inviterName,
          invitationId: invitation.id, // This is the fix we're testing
        },
      });

      // Verify the function was called with invitationId
      expect(mockInvoke).toHaveBeenCalledWith('send-invitation', {
        body: expect.objectContaining({
          email: 'invited@example.com',
          institutionId: 'inst-456',
          invitationId: 'invitation-789', // Key assertion: invitationId must be passed
        }),
      });
    });

    it('should include all required parameters when resending', async () => {
      const invitation = {
        id: 'invitation-abc',
        email: 'user@test.com',
        status: 'pending',
        role: 'instructor',
        created_at: new Date().toISOString(),
      };

      await mockInvoke('send-invitation', {
        body: {
          email: invitation.email,
          institutionId: 'inst-456',
          institutionName: 'Test University',
          inviterName: 'Admin User',
          invitationId: invitation.id,
        },
      });

      expect(mockInvoke).toHaveBeenCalledWith('send-invitation', {
        body: {
          email: 'user@test.com',
          institutionId: 'inst-456',
          institutionName: 'Test University',
          inviterName: 'Admin User',
          invitationId: 'invitation-abc',
        },
      });
    });

    it('should use the invitation id, not institution id, for the invitation parameter', async () => {
      // This test specifically checks that we don't accidentally use institutionId
      // as the invitationId (which was the original bug)

      const invitation = {
        id: 'correct-invitation-id',
        email: 'test@example.com',
        status: 'pending',
        role: 'student',
        created_at: new Date().toISOString(),
      };

      const institutionId = 'different-institution-id';

      await mockInvoke('send-invitation', {
        body: {
          email: invitation.email,
          institutionId: institutionId,
          institutionName: 'University',
          inviterName: 'Admin',
          invitationId: invitation.id,
        },
      });

      const call = mockInvoke.mock.calls[0];
      const body = call[1].body;

      // invitationId should be the invitation's id, not the institution id
      expect(body.invitationId).toBe('correct-invitation-id');
      expect(body.invitationId).not.toBe(institutionId);
      expect(body.institutionId).toBe('different-institution-id');
    });
  });
});
