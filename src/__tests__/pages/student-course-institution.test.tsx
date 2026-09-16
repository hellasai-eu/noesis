/**
 * Whose school, and whose class, the course surface says it is showing.
 *
 * The course page resolves the course through `class_enrollments`, which is
 * institution-wide — so a bookmarked link to a course in institution B opens
 * fine while the session still has institution A selected. Everything the
 * shell wraps around it, though, is built from the *selected* institution: the
 * switcher's label, the course chips, the grade level. Left alone, the page
 * would present institution B's course under institution A's identity.
 *
 * The other half is narrower and the same kind of mistake: `scope.classes` is
 * every class the student attends, which is the right list on the dashboard
 * and a misleading one in a course header, where it reads as "the classes
 * taking this course".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import React from 'react';

import { clearSelectedInstitutionId, setSelectedInstitutionId } from '@/lib/selected-institution';

// The page's full load is heavier than vitest's 5s default allows for under
// parallel workers — see student-course-community.test.tsx.
vi.setConfig({ testTimeout: 20000 });

const mockNavigate = vi.hoisted(() => vi.fn());
const mockUser = vi.hoisted(() => ({
  id: 'student-user-id',
  email: 'student@test.local',
  user_metadata: { full_name: 'Test Student' },
}));
const mockFromImpl = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: mockUser,
    session: { user: mockUser, access_token: 't', refresh_token: 'r' },
    profile: {
      id: 'profile-id',
      user_id: 'student-user-id',
      full_name: 'Test Student',
      email: 'student@test.local',
    },
    loading: false,
    signIn: vi.fn(),
    signUp: vi.fn(),
    signOut: vi.fn(),
    updatePassword: vi.fn(),
  }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/hooks/useUserInstitution', () => ({
  useUserInstitution: () => ({
    membership: null,
    loading: false,
    institutionId: 'inst-a',
    role: 'student',
    isAdmin: false,
    isInstructor: false,
    isStudent: true,
    isEvaluator: false,
    refetch: vi.fn(),
  }),
}));

type ChainResult = { data: unknown; error: unknown; count?: number };
/** The `.eq()` / `.in()` arguments a query recorded, in call order. */
type Filters = [string, unknown][];
type Rows = ChainResult | ((filters: Filters) => ChainResult);

/**
 * A chain mock that can see its own filters.
 *
 * Both fixtures below turn on a query the page runs twice against one table
 * with different arguments — `courses` once per institution, `offerings` once
 * per course — so a mock that answers every call with the same rows cannot
 * express the thing under test.
 */
function createChainMock(rows: Rows, single?: ChainResult) {
  const filters: Filters = [];
  const chain: Record<string, unknown> = {};
  const methods = [
    'select', 'insert', 'update', 'delete', 'neq', 'not',
    'is', 'or', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'order',
    'limit', 'range', 'upsert',
  ];
  for (const m of methods) chain[m] = vi.fn(() => chain);
  for (const m of ['eq', 'in']) {
    chain[m] = vi.fn((column: string, value: unknown) => {
      filters.push([column, value]);
      return chain;
    });
  }
  const resolve = () => (typeof rows === 'function' ? rows(filters) : rows);
  chain.single = vi.fn(() => Promise.resolve(single ?? resolve()));
  chain.maybeSingle = vi.fn(() => Promise.resolve(single ?? resolve()));
  chain.then = vi.fn((cb: (val: ChainResult) => void) => Promise.resolve(cb(resolve())));
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
    functions: { invoke: vi.fn().mockResolvedValue({ data: null, error: null }) },
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
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
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock('@/hooks/use-toast', () => ({
  toast: vi.fn(),
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('@/lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
  formatExplanation: (text: string) => text,
}));

vi.mock('@/lib/latex-utils', () => ({
  processLatexContent: (text: string) => text,
  renderLatexInHtml: (text: string) => text,
  sanitizeMathContent: (text: string) => text,
}));

import StudentCourse from '@/pages/StudentCourse';

const COURSE_B = {
  id: 'course-b',
  institution_id: 'inst-b',
  title: 'Physics',
  description: null,
  theme: null,
  leaderboard_enabled: false,
  student_questions_enabled: false,
  restrict_to_completed_chapters: false,
  show_difficulty_to_students: false,
};

const COURSE_A = {
  id: 'course-a',
  institution_id: 'inst-a',
  title: 'History',
  description: null,
  theme: null,
};

/** One class per institution, plus a second class in B that has no offering. */
const CLASS_ROWS = [
  {
    class_id: 'class-a',
    role: 'student',
    classes: {
      id: 'class-a',
      name: 'A1',
      grade_level_id: null,
      section_name: 'A1',
      category: null,
      academic_period: null,
      institution_id: 'inst-a',
      is_active: true,
    },
  },
  {
    class_id: 'class-b1',
    role: 'student',
    classes: {
      id: 'class-b1',
      name: 'B1',
      grade_level_id: null,
      section_name: 'B1',
      category: null,
      academic_period: null,
      institution_id: 'inst-b',
      is_active: true,
    },
  },
  {
    class_id: 'class-b2',
    role: 'student',
    classes: {
      id: 'class-b2',
      name: 'B2',
      grade_level_id: null,
      section_name: 'B2',
      category: null,
      academic_period: null,
      institution_id: 'inst-b',
      is_active: true,
    },
  },
];

const OFFERING_ROWS = [
  { id: 'off-a', class_id: 'class-a', course_id: 'course-a', is_active: true },
  { id: 'off-b', class_id: 'class-b1', course_id: 'course-b', is_active: true },
];

const filterValue = (filters: Filters, column: string) =>
  filters.find(([c]) => c === column)?.[1];

/**
 * @param memberOf  which institutions the student actually belongs to.
 * @param suspended which of those memberships are suspended.
 */
function mockTables(memberOf: string[], suspended: string[] = []) {
  const tables: Record<string, Rows> = {
    user_institutions: {
      data: memberOf.map((id) => ({
        institution_id: id,
        is_suspended: suspended.includes(id),
      })),
      error: null,
    },
    institutions: {
      data: [
        { id: 'inst-a', name: 'School A', slug: 'a', logo_url: null, is_public: false },
        { id: 'inst-b', name: 'School B', slug: 'b', logo_url: null, is_public: false },
      ].filter((i) => memberOf.includes(i.id)),
      error: null,
    },
    class_enrollments: { data: CLASS_ROWS, error: null },
    // The scope loader asks by class; the course page asks by course.
    offerings: (filters) => {
      const courseId = filterValue(filters, 'course_id');
      return {
        data: courseId
          ? OFFERING_ROWS.filter((o) => o.course_id === courseId)
          : OFFERING_ROWS,
        error: null,
      };
    },
    // The list form is the scope loader's, scoped to one institution.
    courses: (filters) => {
      const institutionId = filterValue(filters, 'institution_id');
      return {
        data: [COURSE_A, COURSE_B].filter((c) => c.institution_id === institutionId),
        error: null,
      };
    },
  };

  mockFromImpl.mockImplementation((table: string) =>
    createChainMock(
      tables[table] ?? { data: [], error: null },
      // `courses.maybeSingle()` is the course page loading the course itself,
      // which succeeds whatever institution is selected — that is exactly the
      // gap this file is about.
      table === 'courses' ? { data: COURSE_B, error: null } : undefined,
    ),
  );
}

function renderCourse() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: {
            queries: { retry: false, gcTime: 0, staleTime: 0 },
            mutations: { retry: false },
          },
        })
      }
    >
      <MemoryRouter initialEntries={['/student/course/course-b']}>
        <Routes>
          <Route path="/student/course/:courseId" element={<StudentCourse />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  clearSelectedInstitutionId();
});

afterEach(() => {
  clearSelectedInstitutionId();
});

describe('StudentCourse — which institution the surface belongs to', () => {
  it('follows the course into its own institution', async () => {
    // The session is on School A; the bookmarked course is School B's.
    setSelectedInstitutionId('inst-a');
    mockTables(['inst-a', 'inst-b']);

    renderCourse();

    // The chips are the tell: they list the selected institution's courses, so
    // the course being viewed showing up in them — and selected — means the
    // shell resolved to School B rather than to whatever was left over.
    await waitFor(
      () => {
        expect(screen.getByRole('radio', { name: /Physics/ })).toHaveAttribute(
          'aria-checked',
          'true',
        );
      },
      { timeout: 15000 },
    );
    expect(screen.queryByRole('radio', { name: /History/ })).not.toBeInTheDocument();
    // And the choice sticks, so going back to /student does not bounce the
    // student to the school they just left.
    expect(sessionStorage.getItem('selectedInstitutionId')).toBe('inst-b');
  });

  it('does not switch to an institution the student does not belong to', async () => {
    setSelectedInstitutionId('inst-a');
    mockTables(['inst-a']);

    renderCourse();

    await screen.findByRole('heading', { name: 'Physics', level: 1 }, { timeout: 15000 });
    // No membership to follow, so the selection is left exactly as it was...
    expect(sessionStorage.getItem('selectedInstitutionId')).toBe('inst-a');
    // ...and rather than offer School A's chips next to School B's course —
    // navigation away from a course the row does not show as selected — the
    // page shows no chips at all.
    await waitFor(() => {
      expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    });
  });

  it('does not follow the course into a suspended membership', async () => {
    // The membership exists, so the institution is in the switcher — that is
    // what it has always done, and RLS is the real boundary. What must not
    // happen is the page quietly moving the student into it and persisting
    // that as their selection.
    setSelectedInstitutionId('inst-a');
    mockTables(['inst-a', 'inst-b'], ['inst-b']);

    renderCourse();

    await screen.findByRole('heading', { name: 'Physics', level: 1 }, { timeout: 15000 });
    expect(sessionStorage.getItem('selectedInstitutionId')).toBe('inst-a');
    await waitFor(() => {
      expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    });
  });

  it('names only the classes that carry this course', async () => {
    setSelectedInstitutionId('inst-b');
    mockTables(['inst-a', 'inst-b']);

    renderCourse();

    // class-b1 has the offering; class-b2 is another class in the same school,
    // and class-a is another school's. Only the first belongs in the header.
    expect(await screen.findByText(/Section B1/, {}, { timeout: 15000 })).toBeInTheDocument();
    expect(screen.queryByText(/Section B2/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Section A1/)).not.toBeInTheDocument();
  });
});
