import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';
import type { InstructorContent, InstructorScope } from '@/lib/instructor-surface';

const mockUser = vi.hoisted(() => ({
  id: 'instructor-1',
  email: 'instructor@test.local',
  user_metadata: {},
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: mockUser,
    session: { user: mockUser },
    profile: { id: 'p1', user_id: 'instructor-1', full_name: 'Test Instructor', email: mockUser.email },
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
    institutionId: 'inst-1',
    role: 'instructor',
    isAdmin: false,
    isInstructor: true,
    isStudent: false,
    isEvaluator: false,
    refetch: vi.fn(),
  }),
}));

// The page's own two queries, fed from fixtures — the filter is pure
// client-side scoping over this data, which is exactly what's under test.
const scopeFixture = vi.hoisted(() => ({ current: null as unknown }));
const contentFixture = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('@/hooks/useInstructorSurface', () => ({
  useInstitutionSummary: () => ({
    data: { id: 'inst-1', name: 'Test Inst' },
    isLoading: false,
    isError: false,
  }),
  useInstructorScope: () => ({
    data: scopeFixture.current,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useInstructorContent: () => ({
    data: contentFixture.current,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: vi.fn(() => {
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'order']) {
        chain[m] = vi.fn(() => chain);
      }
      chain.single = vi.fn().mockResolvedValue({ data: { id: 'inst-1', name: 'Test Inst' }, error: null });
      return chain;
    }),
    auth: {
      onAuthStateChange: vi.fn().mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } }),
      getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
    },
  },
}));

vi.mock('@/components/NotificationBell', () => ({
  NotificationBell: () => <div data-testid="bell" />,
}));
vi.mock('@/components/ChangePasswordDialog', () => ({
  ChangePasswordDialog: () => <div data-testid="pw" />,
}));
vi.mock('@/components/BugReportDialog', () => ({
  BugReportDialog: () => null,
}));

import InstructorHome from '@/pages/InstructorHome';

function scope(): InstructorScope {
  return {
    institutionId: 'inst-1',
    courses: [
      { id: 'c-math', title: 'Μαθηματικά', description: null, classNames: ['Τμήμα 1Α', 'Τμήμα 1Β'] },
      { id: 'c-lang', title: 'Γλώσσα', description: null, classNames: ['Τμήμα 1Α'] },
    ],
    courseIds: ['c-math', 'c-lang'],
    classes: [
      { id: 'cls-a', name: 'Τμήμα 1Α' },
      { id: 'cls-b', name: 'Τμήμα 1Β' },
    ],
    classNameByOffering: { 'off-a': 'Τμήμα 1Α', 'off-b': 'Τμήμα 1Β' },
    classIdByOffering: { 'off-a': 'cls-a', 'off-b': 'cls-b' },
    classIdsByCourse: { 'c-math': ['cls-a', 'cls-b'], 'c-lang': ['cls-a'] },
  };
}

function content(): InstructorContent {
  return {
    materialCountByCourse: { 'c-math': 1, 'c-lang': 1 },
    competencyCountByCourse: {},
    guides: [
      {
        id: 'g-lang',
        courseId: 'c-lang',
        title: 'Γλώσσα guide',
        createdAt: '2026-01-01',
        assignedCount: 1,
        doneAssignmentCount: 0,
        nextDueDate: null,
        draftAssignmentCount: 0,
        pieceCount: 5,
        incompletePieceCount: 0,
        assignedClassNames: ['Τμήμα 1Α'],
        assignedClassIds: ['cls-a'],
        studentsCompleted: 0,
      },
    ],
    quizzes: [
      {
        id: 'q-math',
        courseId: 'c-math',
        title: 'Math quiz',
        createdAt: '2026-01-01',
        questionCount: 3,
        openCount: 1,
        closedCount: 0,
        draftAssignmentCount: 0,
        assignedClassNames: ['Τμήμα 1Β'],
        assignedClassIds: ['cls-b'],
        studentsCompleted: 0,
      },
    ],
  };
}

function renderHome() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
    >
      <MemoryRouter initialEntries={['/instructor']}>
        <InstructorHome />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  scopeFixture.current = scope();
  contentFixture.current = content();
});

describe('InstructorHome — class filter', () => {
  it('shows every course, guide, and quiz with no filter', async () => {
    renderHome();
    expect(await screen.findByRole('heading', { name: 'Μαθηματικά' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Γλώσσα' })).toBeInTheDocument();
    expect(screen.getByTestId('guide-tile-g-lang')).toBeInTheDocument();
    expect(screen.getByTestId('quiz-tile-q-math')).toBeInTheDocument();
  });

  it('scopes cards and shelves to the courses offered in the selected class', async () => {
    const user = userEvent.setup();
    renderHome();
    await screen.findByRole('heading', { name: 'Γλώσσα' });

    // Τμήμα 1Β carries only Μαθηματικά: the Γλώσσα card and its guide go.
    await user.click(screen.getByRole('button', { name: 'Τμήμα 1Β' }));
    expect(screen.queryByRole('heading', { name: 'Γλώσσα' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('guide-tile-g-lang')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Μαθηματικά' })).toBeInTheDocument();
    expect(screen.getByTestId('quiz-tile-q-math')).toBeInTheDocument();
  });

  it('clicking the active chip toggles the filter back off', async () => {
    const user = userEvent.setup();
    renderHome();
    await screen.findByRole('heading', { name: 'Γλώσσα' });

    await user.click(screen.getByRole('button', { name: 'Τμήμα 1Β' }));
    expect(screen.queryByRole('heading', { name: 'Γλώσσα' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Τμήμα 1Β' }));
    expect(screen.getByRole('heading', { name: 'Γλώσσα' })).toBeInTheDocument();
  });

  it('hides the chip row for a single-class instructor', async () => {
    const single = scope();
    single.classes = [{ id: 'cls-a', name: 'Τμήμα 1Α' }];
    scopeFixture.current = single;
    renderHome();

    await screen.findByRole('heading', { name: 'Μαθηματικά' });
    expect(screen.queryByRole('button', { name: 'All' })).not.toBeInTheDocument();
  });
});
