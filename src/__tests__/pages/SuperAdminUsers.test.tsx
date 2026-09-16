import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';

// The super-admin user list knew nothing about the `evaluator` role: evaluators
// were counted in no stats card, could not be filtered for, and opening "Edit
// role" on one showed an empty dropdown. Users belonging to no institution were
// counted nowhere either, which is what made the total look wrong next to the
// role cards.

const mockNavigate = vi.hoisted(() => vi.fn());

const PROFILES = [
  { user_id: 'u-admin', full_name: 'Ada Admin', email: 'admin@test.local' },
  { user_id: 'u-instructor', full_name: 'Ivo Instructor', email: 'instructor@test.local' },
  { user_id: 'u-evaluator', full_name: 'Eve Evaluator', email: 'evaluator@test.local' },
  { user_id: 'u-student', full_name: 'Sam Student', email: 'student@test.local' },
  { user_id: 'u-orphan', full_name: 'Otto Orphan', email: 'orphan@test.local' },
];

const MEMBERSHIPS = [
  { user_id: 'u-admin', institution_id: 'inst-1', role: 'admin', institutions: { name: 'Acme High' } },
  { user_id: 'u-instructor', institution_id: 'inst-1', role: 'instructor', institutions: { name: 'Acme High' } },
  { user_id: 'u-evaluator', institution_id: 'inst-1', role: 'evaluator', institutions: { name: 'Acme High' } },
  { user_id: 'u-student', institution_id: 'inst-1', role: 'student', institutions: { name: 'Acme High' } },
];

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: vi.fn((table: string) => {
      if (table === 'profiles') {
        return {
          select: () => ({ order: () => Promise.resolve({ data: PROFILES, error: null }) }),
        };
      }
      if (table === 'user_institutions') {
        return { select: () => Promise.resolve({ data: MEMBERSHIPS, error: null }) };
      }
      if (table === 'institutions') {
        return {
          select: () => ({
            order: () => Promise.resolve({ data: [{ id: 'inst-1', name: 'Acme High' }], error: null }),
          }),
        };
      }
      return { select: () => Promise.resolve({ data: [], error: null }) };
    }),
    rpc: vi.fn((fn: string) =>
      fn === 'is_super_admin'
        ? Promise.resolve({ data: true, error: null })
        : Promise.resolve({ data: [{ last_sign_in_at: null }], error: null })
    ),
    functions: { invoke: vi.fn() },
  },
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'super-1' },
    profile: { full_name: 'Root', email: 'root@test.local' },
    loading: false,
    signOut: vi.fn(),
  }),
}));

vi.mock('react-router-dom', async () => ({
  useNavigate: () => mockNavigate,
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import SuperAdminUsers from '@/pages/SuperAdminUsers';

/** The number rendered on the stats card with the given label. */
function statValue(label: string): string {
  const card = screen.getByTestId(`stat-${label}`);
  // The card renders the count first, then the label.
  return within(card).getAllByText(/^\d+$/)[0].textContent ?? '';
}

describe('SuperAdminUsers stats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('counts evaluators and users with no institution', async () => {
    render(<SuperAdminUsers />);

    await waitFor(() => expect(screen.getByText('Total Users')).toBeTruthy());

    expect(statValue('Total Users')).toBe('5');
    expect(statValue('Admins')).toBe('1');
    expect(statValue('Instructors')).toBe('1');
    // Both were missing before: an evaluator fell into no bucket at all, and so
    // did the user with no membership, leaving the total unexplained.
    expect(statValue('Evaluators')).toBe('1');
    expect(statValue('Students')).toBe('1');
    expect(statValue('No institution')).toBe('1');
  });

  it("labels an evaluator's membership in the users table", async () => {
    render(<SuperAdminUsers />);
    await waitFor(() => expect(screen.getByText('Total Users')).toBeTruthy());

    // The role filter's options live in a portal that only exists once the
    // select is opened, which Radix cannot do under jsdom without pointer
    // shims; the badge is the part of evaluator awareness reachable here.
    expect(screen.getByText(/Acme High \(evaluator\)/)).toBeTruthy();
  });
});
