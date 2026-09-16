/**
 * The course page is a launcher: one tile per option, each opening the
 * existing sub-view or route.
 *
 * What this file pins is the launcher's contract — every always-on option is
 * a tile whether or not it has work behind it, options the course does not
 * offer are absent rather than disabled, the quizzes tile carries an honest
 * count and opens a list where the individual assignments live, and the
 * quiz-history tile is a navigation. The per-option behaviours (flashcard
 * counting, notes gating, community round trip, deep links) have suites of
 * their own.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import React from 'react';

// See student-course-community.test.tsx: this page's full load is heavier than
// vitest's 5s default allows for under parallel workers.
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
    institutionId: 'inst-123',
    role: 'student',
    isAdmin: false,
    isInstructor: false,
    isStudent: true,
    refetch: vi.fn(),
  }),
}));

type ChainResult = { data: unknown; error: unknown; count?: number };

function createChainMock(result: ChainResult) {
  const chain: Record<string, unknown> = {};
  const methods = [
    'select', 'insert', 'update', 'delete', 'eq', 'neq', 'in', 'not',
    'is', 'or', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'order',
    'limit', 'range', 'upsert',
  ];
  for (const m of methods) {
    chain[m] = vi.fn(() => chain);
  }
  chain.single = vi.fn().mockResolvedValue(result);
  chain.maybeSingle = vi.fn().mockResolvedValue(result);
  chain.then = vi.fn((cb: (val: ChainResult) => void) => Promise.resolve(cb(result)));
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

import StudentCourse from '@/pages/StudentCourse';

const COURSE = {
  id: 'course-1',
  title: 'Mathematics',
  description: null,
  theme: null,
  leaderboard_enabled: false,
  student_questions_enabled: false,
  restrict_to_completed_chapters: false,
  show_difficulty_to_students: false,
};

function baseTables(): Record<string, ChainResult> {
  return {
    courses: { data: COURSE, error: null },
    class_enrollments: { data: [{ class_id: 'class-1' }], error: null },
    offerings: {
      data: [{ id: 'off-1', class_id: 'class-1', course_id: 'course-1' }],
      error: null,
    },
    offering_quizzes: {
      data: [
        {
          id: 'oq-1',
          offering_id: 'off-1',
          quiz_id: 'quiz-1',
          due_date: null,
          time_limit_override: null,
          published_at: '2020-01-01T00:00:00Z',
          answers_released: false,
          closed_at: null,
          quizzes: {
            id: 'quiz-1',
            course_id: 'course-1',
            title: 'Quadratic Equations',
            description: null,
            time_limit_minutes: 20,
            show_answers: true,
            quiz_questions: [{ count: 12 }],
          },
        },
      ],
      error: null,
    },
  };
}

function mockTables(tables: Record<string, ChainResult>) {
  mockFromImpl.mockImplementation((table: string) =>
    createChainMock(tables[table] ?? { data: [], error: null }),
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
      <MemoryRouter initialEntries={['/student/course/course-1']}>
        <Routes>
          <Route path="/student/course/:courseId" element={<StudentCourse />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('StudentCourse — the option launcher', () => {
  it('renders every always-on option, and only the options this course offers', async () => {
    mockTables(baseTables());

    renderCourse();

    const launcher = await screen.findByTestId('course-launcher', {}, { timeout: 15000 });
    for (const tile of [
      'launcher-quizzes',
      'launcher-guides',
      'launcher-practice',
      'launcher-flashcards',
      'launcher-tutoring',
      'launcher-interactive',
      'launcher-quiz-history',
    ]) {
      expect(within(launcher).getByTestId(tile)).toBeInTheDocument();
    }
    // Not offered here: student questions are off, there are no cheat sheets,
    // and no notes were shared. Absent, not disabled.
    for (const tile of [
      'launcher-community',
      'launcher-create-own',
      'launcher-materials',
      'launcher-notes',
    ]) {
      expect(screen.queryByTestId(tile)).not.toBeInTheDocument();
    }
  });

  it('counts the open quizzes on the tile and lists them behind it', async () => {
    const user = userEvent.setup();
    mockTables(baseTables());

    renderCourse();

    const tile = await screen.findByTestId('launcher-quizzes', {}, { timeout: 15000 });
    expect(tile).toHaveTextContent('1 quiz due');

    await user.click(tile);

    // The individual assignment is a tile in the list, with its old test id
    // and its Start action — the same object the shelves used to render.
    const list = await screen.findByTestId('quiz-list', {}, { timeout: 15000 });
    const quiz = within(list).getByTestId('due-tile-quiz-oq-1');
    expect(quiz).toHaveTextContent('Quadratic Equations');
    expect(within(quiz).getByRole('button', { name: 'Start' })).toBeInTheDocument();
  });

  it('navigates to quiz history from its tile', async () => {
    const user = userEvent.setup();
    mockTables(baseTables());

    renderCourse();

    await user.click(await screen.findByTestId('launcher-quiz-history', {}, { timeout: 15000 }));

    expect(mockNavigate).toHaveBeenCalledWith('/student/course/course-1/quiz-history');
  });
});
