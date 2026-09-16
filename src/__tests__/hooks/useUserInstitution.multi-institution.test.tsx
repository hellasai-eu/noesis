import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

/**
 * Multi-institution membership — client side.
 *
 * `user_institutions` is a many-to-many table: a user can belong to two (or
 * more) institutions, potentially with a DIFFERENT role in each. The app picks
 * the "current" one via `sessionStorage.selectedInstitutionId`.
 *
 * `useUserInstitution` resolves that membership with `.maybeSingle()`, which —
 * unlike the shallow mocks in `useUserInstitution.test.tsx` — errors with
 * PostgREST code PGRST116 as soon as the filtered query matches MORE THAN ONE
 * row. That happens for every dual-institution user whenever no institution is
 * selected yet. The fake client below reproduces that real PostgREST semantic.
 *
 * Some of these tests are expected to FAIL until the hook is fixed; each one
 * states the contract it is asserting.
 */

const mockSupabaseFrom = vi.hoisted(() => vi.fn());

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: mockSupabaseFrom },
}));

import { useUserInstitution } from '@/hooks/useUserInstitution';
import {
  fakeUserInstitutionsFrom,
  setSelectedInstitution,
  type Membership,
} from './fakeUserInstitutions';

function installFakeClient(rows: Membership[]) {
  mockSupabaseFrom.mockImplementation(fakeUserInstitutionsFrom(rows));
}

const USER_ID = 'user-dual';

/** Student at Alpha, admin at Beta — different role in each institution. */
const ALPHA: Membership = {
  id: 'membership-alpha',
  user_id: USER_ID,
  institution_id: 'inst-alpha',
  role: 'student',
  created_at: '2026-01-01T00:00:00Z',
};
const BETA: Membership = {
  id: 'membership-beta',
  user_id: USER_ID,
  institution_id: 'inst-beta',
  role: 'admin',
  created_at: '2026-02-01T00:00:00Z',
};

describe('useUserInstitution — user belonging to two institutions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setSelectedInstitution(null);
  });

  it('resolves the membership of the selected institution, not the other one', async () => {
    installFakeClient([ALPHA, BETA]);
    setSelectedInstitution(BETA.institution_id);

    const { result } = renderHook(() => useUserInstitution(USER_ID));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.institutionId).toBe(BETA.institution_id);
    expect(result.current.role).toBe('admin');
    expect(result.current.isAdmin).toBe(true);
    expect(result.current.isStudent).toBe(false);
  });

  it('does not leak the role held in the other institution', async () => {
    installFakeClient([ALPHA, BETA]);
    setSelectedInstitution(ALPHA.institution_id);

    const { result } = renderHook(() => useUserInstitution(USER_ID));

    await waitFor(() => expect(result.current.loading).toBe(false));

    // Admin at Beta must NOT make them an admin while working inside Alpha.
    expect(result.current.institutionId).toBe(ALPHA.institution_id);
    expect(result.current.isStudent).toBe(true);
    expect(result.current.isAdmin).toBe(false);
  });

  it('still resolves a membership when nothing is selected yet', async () => {
    installFakeClient([ALPHA, BETA]);
    setSelectedInstitution(null);

    const { result } = renderHook(() => useUserInstitution(USER_ID));

    await waitFor(() => expect(result.current.loading).toBe(false));

    // The unfiltered query matches two rows and `.maybeSingle()` errors; the
    // hook must recover with one of the user's actual memberships.
    expect(result.current.membership).not.toBeNull();
    expect([ALPHA.institution_id, BETA.institution_id]).toContain(
      result.current.institutionId
    );
  });

  it('keeps the resolved membership across a refetch when nothing is selected', async () => {
    installFakeClient([ALPHA, BETA]);
    setSelectedInstitution(null);

    const { result } = renderHook(() => useUserInstitution(USER_ID));

    await waitFor(() => expect(result.current.membership).not.toBeNull());
    const before = result.current.institutionId;

    await act(async () => {
      await result.current.refetch();
    });

    // `refetch()` re-runs the same two-row query but has no fallback, so the
    // PGRST116 error wipes the membership and the user looks institution-less.
    expect(result.current.membership).not.toBeNull();
    expect(result.current.institutionId).toBe(before);
  });

  it('reconciles the stored selection when it is not one of the memberships', async () => {
    installFakeClient([ALPHA, BETA]);
    // e.g. a stale id left over from an institution the user was removed from
    setSelectedInstitution('inst-ghost');

    const { result } = renderHook(() => useUserInstitution(USER_ID));

    await waitFor(() => expect(result.current.loading).toBe(false));

    // The hook falls back to a real membership, but pages such as Dashboard
    // read `selectedInstitutionId` straight out of
    // sessionStorage — leaving it stale points them at a different institution
    // than the one this hook reports.
    expect(result.current.institutionId).not.toBeNull();
    expect(window.sessionStorage.setItem).toHaveBeenCalledWith(
      'selectedInstitutionId',
      result.current.institutionId
    );
  });

  it('picks up the new role after switching institutions and refetching', async () => {
    installFakeClient([ALPHA, BETA]);
    setSelectedInstitution(ALPHA.institution_id);

    const { result } = renderHook(() => useUserInstitution(USER_ID));

    await waitFor(() => expect(result.current.role).toBe('student'));

    // Institution switchers (StudentDashboard / EvaluatorDashboard) write the
    // new id to sessionStorage; the hook must follow on the next refetch.
    setSelectedInstitution(BETA.institution_id);
    await act(async () => {
      await result.current.refetch();
    });

    expect(result.current.institutionId).toBe(BETA.institution_id);
    expect(result.current.role).toBe('admin');
  });
});
