/**
 * #1068 — creating an institution from the super-admin dashboard.
 *
 * `buildStarterClasses` hands back templates keyed by grade CODE, and #799
 * (20260710000000_grade_levels_contract.sql) left `classes` with only the
 * `grade_level_id` FK. This page went on posting the templates verbatim, so
 * PostgREST rejected the batch on an unknown `grade_code` column and the
 * rollback below it deleted the institution again — every create from this page
 * failed, and nothing caught it: the extra property survives tsc (the payload
 * is a typed variable, not an object literal, so no excess-property check), and
 * the only E2E cover was quarantined.
 *
 * What is pinned here is the shape of the write, not the happy-path toast:
 * every starter class carries a resolved `grade_level_id` and no `grade_code`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockNavigate = vi.hoisted(() => vi.fn());

// The page's bootstrap effect keys on `user`, and its fetch replaces the
// institution list. Both have to be referentially stable or every render
// re-runs the effect, which re-runs the fetch, which renders again — an
// unbounded loop that userEvent then never gets a quiet moment inside.
const auth = vi.hoisted(() => ({
  user: { id: 'super-1' },
  profile: { full_name: 'Root', email: 'root@test.local' },
  loading: false,
  signOut: vi.fn(),
}));
const NO_INSTITUTIONS: unknown[] = vi.hoisted(() => []);

const db = vi.hoisted(() => ({
  /** Rows passed to `classes.insert`, as sent. */
  insertedClasses: [] as Record<string, unknown>[],
  /** Payloads passed to `institutions.insert`. */
  insertedInstitutions: [] as Record<string, unknown>[],
  /** ids the institution row was deleted by — a rollback leaves a mark here. */
  deletedInstitutions: [] as unknown[],
  /** (institution_id, code) pairs ensureGradeLevel looked up. */
  gradeLevelLookups: [] as { institutionId: unknown; code: unknown }[],
}));

vi.mock('@/integrations/supabase/client', () => {
  const institutions = () => ({
    select: () => ({
      order: () => Promise.resolve({ data: NO_INSTITUTIONS, error: null }),
    }),
    insert: (payload: Record<string, unknown>) => {
      db.insertedInstitutions.push(payload);
      return {
        select: () => ({
          single: () =>
            Promise.resolve({ data: { id: 'inst-new', ...payload }, error: null }),
        }),
      };
    },
    delete: () => ({
      eq: (_col: string, value: unknown) => {
        db.deletedInstitutions.push(value);
        return Promise.resolve({ error: null });
      },
    }),
  });

  // The AFTER INSERT trigger on `institutions` seeds a greek school's taxonomy,
  // so ensureGradeLevel finds every code already present and never inserts.
  const gradeLevels = () => ({
    select: () => ({
      eq: (_c1: string, institutionId: unknown) => ({
        eq: (_c2: string, code: unknown) => ({
          maybeSingle: () => {
            db.gradeLevelLookups.push({ institutionId, code });
            return Promise.resolve({ data: { id: `gl-${code}` }, error: null });
          },
        }),
      }),
    }),
  });

  const classes = () => ({
    insert: (rows: Record<string, unknown>[]) => {
      db.insertedClasses.push(...rows);
      return Promise.resolve({ error: null });
    },
  });

  return {
    supabase: {
      from: vi.fn((table: string) => {
        if (table === 'institutions') return institutions();
        if (table === 'grade_levels') return gradeLevels();
        if (table === 'classes') return classes();
        return { insert: () => Promise.resolve({ error: null }) };
      }),
      rpc: vi.fn(() => Promise.resolve({ data: true, error: null })),
      functions: {
        invoke: vi.fn(() =>
          Promise.resolve({ data: { success: true }, error: null }),
        ),
      },
    },
  };
});

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => auth }));

vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

// Pulls its own data over supabase; irrelevant to the create path.
vi.mock('@/components/NotificationBell', () => ({
  NotificationBell: () => null,
}));

import SuperAdminDashboard from '@/pages/SuperAdminDashboard';
import { GRADE_OPTIONS } from '@/lib/greek-school';

describe('SuperAdminDashboard — create institution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.insertedClasses = [];
    db.insertedInstitutions = [];
    db.deletedInstitutions = [];
    db.gradeLevelLookups = [];
  });

  it('resolves each starter class to a grade_level_id before inserting', async () => {
    const user = userEvent.setup();
    render(<SuperAdminDashboard />);

    await waitFor(() =>
      expect(screen.getByText('Institution Management')).toBeTruthy(),
    );

    await user.click(screen.getByRole('button', { name: /add institution/i }));
    // Defaults are left alone: a Greek school across all three levels, which is
    // what the form opens on and what an operator submits.
    await user.type(screen.getByLabelText(/institution name/i), 'Athens Academy');
    await user.click(screen.getByRole('button', { name: /create institution/i }));

    await waitFor(() => expect(db.insertedClasses.length).toBeGreaterThan(0));

    // One starter class per grade across dimotiko + gymnasio + lykeio.
    expect(db.insertedClasses).toHaveLength(GRADE_OPTIONS.length);
    for (const row of db.insertedClasses) {
      expect(row).not.toHaveProperty('grade_code');
      expect(row.grade_level_id).toMatch(/^gl-/);
      expect(row.institution_id).toBe('inst-new');
    }
    // Every code was resolved against the institution that was just created.
    expect(db.gradeLevelLookups).toHaveLength(GRADE_OPTIONS.length);
    expect(
      db.gradeLevelLookups.every((l) => l.institutionId === 'inst-new'),
    ).toBe(true);
    expect(db.gradeLevelLookups.map((l) => l.code)).toEqual(
      GRADE_OPTIONS.map((g) => g.value),
    );

    // The institution survived — a failed class insert would have rolled it back.
    expect(db.deletedInstitutions).toEqual([]);
  });
});
