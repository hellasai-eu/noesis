/**
 * Deep links from the student surface (#desktop): `?quiz=`, `?guide=`,
 * `?session=` and `?interactive=` open the named activity directly instead of
 * landing on the course overview.
 *
 * The property that matters most is the gate: the link must be at least as
 * strict as the UI it bypasses. A completed, closed, or untouched past-due
 * quiz has no runner to open through any button on the page, so a stale or
 * hand-edited URL must not start one either.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
    session: { user: mockUser, access_token: 'mock-token', refresh_token: 'mock-refresh' },
    profile: {
      id: 'profile-id',
      user_id: 'student-user-id',
      full_name: 'Test Student',
      email: 'student@test.local',
    },
    loading: false,
    signIn: vi.fn().mockResolvedValue({ error: null }),
    signUp: vi.fn().mockResolvedValue({ error: null, data: { user: null } }),
    signOut: vi.fn().mockResolvedValue(undefined),
    updatePassword: vi.fn().mockResolvedValue({ error: null }),
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

type ChainResult = { data: unknown; error: unknown };

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

vi.mock('@/lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
  formatExplanation: (text: string) => text,
}));

vi.mock('@/lib/latex-utils', () => ({
  processLatexContent: (text: string) => text,
  renderLatexInHtml: (text: string) => text,
  sanitizeMathContent: (text: string) => text,
}));

// The activities themselves are not under test — only that the right one
// opens. Markers carry the props the deep link is responsible for.
vi.mock('@/components/StudentQuiz', () => ({
  default: (props: { quizId?: string }) => (
    <div data-testid="quiz-runner" data-quiz-id={props.quizId} />
  ),
}));
vi.mock('@/components/study-guide/StudyGuidePlayer', () => ({
  StudyGuidePlayer: (props: { studyGuideId: string }) => (
    <div data-testid="guide-player" data-guide-id={props.studyGuideId} />
  ),
}));
vi.mock('@/components/StudentStudySession', () => ({
  StudentStudySession: (props: { offeringId?: string; initialSessionId?: string }) => (
    <div
      data-testid="study-session-view"
      data-offering={props.offeringId ?? ''}
      data-initial={props.initialSessionId ?? ''}
    />
  ),
}));

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

const FUTURE = '2999-01-01T00:00:00Z';
const PAST = '2000-01-01T00:00:00Z';

function quizAssignment(dueDate: string | null, closedAt: string | null = null) {
  return {
    id: 'oq-1',
    offering_id: 'off-1',
    quiz_id: 'quiz-1',
    due_date: dueDate,
    time_limit_override: null,
    published_at: '2020-01-01T00:00:00Z',
    answers_released: false,
    closed_at: closedAt,
    quizzes: {
      id: 'quiz-1',
      course_id: 'course-1',
      title: 'Quadratic Equations',
      description: null,
      time_limit_minutes: null,
      show_answers: true,
      quiz_questions: [{ count: 5 }],
    },
  };
}

/** Enrolled, with two offerings for this course. */
function baseTables(): Record<string, ChainResult> {
  return {
    courses: { data: COURSE, error: null },
    class_enrollments: { data: [{ class_id: 'class-1' }], error: null },
    offerings: {
      data: [
        { id: 'off-1', class_id: 'class-1', course_id: 'course-1' },
        { id: 'off-2', class_id: 'class-1', course_id: 'course-1' },
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

function renderCourse(search: string) {
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
      <MemoryRouter initialEntries={[`/student/course/course-1${search}`]}>
        <Routes>
          <Route path="/student/course/:courseId" element={<StudentCourse />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The surface rendered means the deep link (rightly) did not open a runner. */
async function expectOverview() {
  await waitFor(() => expect(screen.getByTestId('course-launcher')).toBeInTheDocument(), {
    timeout: 15000,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('StudentCourse deep links', () => {
  it('?quiz= opens the runner for a startable quiz', async () => {
    mockTables({
      ...baseTables(),
      offering_quizzes: { data: [quizAssignment(FUTURE)], error: null },
      quiz_sessions: { data: [], error: null },
    });

    renderCourse('?quiz=quiz-1');

    const runner = await screen.findByTestId('quiz-runner', {}, { timeout: 15000 });
    expect(runner).toHaveAttribute('data-quiz-id', 'quiz-1');
  });

  it('?quiz= refuses an untouched past-due quiz — the gate matches the disabled row', async () => {
    mockTables({
      ...baseTables(),
      offering_quizzes: { data: [quizAssignment(PAST)], error: null },
      quiz_sessions: { data: [], error: null },
    });

    renderCourse('?quiz=quiz-1');

    await expectOverview();
    expect(screen.queryByTestId('quiz-runner')).not.toBeInTheDocument();
  });

  it('?quiz= still resumes a started attempt past its due date', async () => {
    mockTables({
      ...baseTables(),
      offering_quizzes: { data: [quizAssignment(PAST)], error: null },
      quiz_sessions: {
        data: [
          { quiz_id: 'quiz-1', status: 'in_progress', expired_at: null, started_at: PAST },
        ],
        error: null,
      },
    });

    renderCourse('?quiz=quiz-1');

    const runner = await screen.findByTestId('quiz-runner', {}, { timeout: 15000 });
    expect(runner).toHaveAttribute('data-quiz-id', 'quiz-1');
  });

  it('?quiz= refuses a completed quiz', async () => {
    mockTables({
      ...baseTables(),
      offering_quizzes: { data: [quizAssignment(FUTURE)], error: null },
      quiz_sessions: {
        data: [
          { quiz_id: 'quiz-1', status: 'completed', expired_at: null, started_at: PAST },
        ],
        error: null,
      },
    });

    renderCourse('?quiz=quiz-1');

    await expectOverview();
    expect(screen.queryByTestId('quiz-runner')).not.toBeInTheDocument();
  });

  it('?quiz= opens through any startable assignment when the first is closed', async () => {
    // One entry per offering assignment: the same quiz reaches the student
    // closed through one offering and open through another. The first row
    // being closed must not refuse a link that another assignment can honor.
    const closed = quizAssignment(FUTURE, PAST);
    const open = { ...quizAssignment(FUTURE), id: 'oq-2', offering_id: 'off-2' };
    mockTables({
      ...baseTables(),
      offering_quizzes: { data: [closed, open], error: null },
      quiz_sessions: { data: [], error: null },
    });

    renderCourse('?quiz=quiz-1');

    const runner = await screen.findByTestId('quiz-runner', {}, { timeout: 15000 });
    expect(runner).toHaveAttribute('data-quiz-id', 'quiz-1');
  });

  it('?quiz= refuses a closed assignment', async () => {
    mockTables({
      ...baseTables(),
      offering_quizzes: { data: [quizAssignment(FUTURE, PAST)], error: null },
      quiz_sessions: { data: [], error: null },
    });

    renderCourse('?quiz=quiz-1');

    await expectOverview();
    expect(screen.queryByTestId('quiz-runner')).not.toBeInTheDocument();
  });

  it('?guide= opens the study-guide player directly', async () => {
    mockTables({
      ...baseTables(),
      offering_study_guides: {
        data: [
          {
            study_guide_id: 'sg-1',
            offering_id: 'off-1',
            due_date: null,
            study_guides: { id: 'sg-1', title: 'Roll' },
          },
        ],
        error: null,
      },
      study_guide_pieces: { data: [{ study_guide_id: 'sg-1' }], error: null },
      study_guide_progress: { data: [], error: null },
    });

    renderCourse('?guide=sg-1');

    const player = await screen.findByTestId('guide-player', {}, { timeout: 15000 });
    expect(player).toHaveAttribute('data-guide-id', 'sg-1');
  });

  it('?session= opens the tutor view scoped to the offering the link names', async () => {
    mockTables(baseTables());

    renderCourse('?session=ss-1&offering=off-2');

    const view = await screen.findByTestId('study-session-view', {}, { timeout: 15000 });
    expect(view).toHaveAttribute('data-initial', 'ss-1');
    // The named offering is one of the student's own, so it is trusted over
    // the page's default first offering.
    expect(view).toHaveAttribute('data-offering', 'off-2');
  });

  it('?session= ignores an offering the student does not sit in', async () => {
    mockTables(baseTables());

    renderCourse('?session=ss-1&offering=someone-elses-offering');

    const view = await screen.findByTestId('study-session-view', {}, { timeout: 15000 });
    // Falls back to the student's own preferred offering.
    expect(view).toHaveAttribute('data-offering', 'off-1');
  });

  it('?interactive=1 opens the interactive questions view', async () => {
    mockTables(baseTables());

    renderCourse('?interactive=1');

    // A sub-view names itself and drops the launcher — the heading proves the
    // page loaded, the missing launcher proves the overview was skipped. One
    // waitFor for both: the overview may paint for a frame before the
    // deep-link effect flips the view.
    await waitFor(
      () => {
        expect(screen.getByText('AI interactive questions')).toBeInTheDocument();
        expect(screen.queryByTestId('course-launcher')).not.toBeInTheDocument();
      },
      { timeout: 15000 },
    );
  });

  // `?practice=` and `?cards=` are what the tiles on `/student` link to now
  // that neither surface has tabs. They are the two shelves whose activity is
  // a whole view rather than a row, so a link that only reached the course
  // page would leave the student one click short of where they aimed.
  it('?practice=1 opens the practice list', async () => {
    mockTables(baseTables());

    renderCourse('?practice=1');

    await waitFor(
      () => {
        expect(screen.getByText('Practice Questions')).toBeInTheDocument();
        expect(screen.queryByTestId('course-launcher')).not.toBeInTheDocument();
      },
      { timeout: 15000 },
    );
  });

  it('?cards=1 opens the flashcard sessions', async () => {
    mockTables(baseTables());

    renderCourse('?cards=1');

    await waitFor(
      () => {
        expect(screen.getByRole('heading', { name: 'Flashcards' })).toBeInTheDocument();
        expect(screen.queryByTestId('course-launcher')).not.toBeInTheDocument();
      },
      { timeout: 15000 },
    );
  });
});
