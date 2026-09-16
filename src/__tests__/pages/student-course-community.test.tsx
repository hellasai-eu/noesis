import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import React from 'react';

// The course home resolves enrolments, offerings, quizzes, guides, flashcard
// scope and the practice count before it renders a section, and jsdom does all
// of that under whatever CPU the parallel workers leave. The 5s default is not
// a meaningful assertion about any of it — it just decides which runs flake.
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
    session: {
      user: mockUser,
      access_token: 'mock-token',
      refresh_token: 'mock-refresh',
    },
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
  chain.then = vi.fn((cb: (val: ChainResult) => void) =>
    Promise.resolve(cb(result))
  );
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
    functions: {
      invoke: vi.fn().mockResolvedValue({ data: null, error: null }),
    },
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
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('@/hooks/use-toast', () => ({
  toast: vi.fn(),
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
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

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

function renderStudentCourse(Component: React.ComponentType) {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      {/* Both rows live on the Practice tab, so the page opens there — on
          another tab they would be unmounted, and "hides both" would pass
          without proving anything. */}
      <MemoryRouter initialEntries={['/student/course/course-1']}>
        <Routes>
          <Route path="/student/course/:courseId" element={<Component />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

type CourseRow = {
  id: string;
  title: string;
  description: string | null;
  theme: string | null;
  leaderboard_enabled: boolean;
  student_questions_enabled: boolean;
  restrict_to_completed_chapters: boolean;
  show_difficulty_to_students: boolean;
};

function mockSupabaseWithCourse(course: CourseRow) {
  mockFromImpl.mockImplementation((table: string) => {
    if (table === 'courses') {
      return createChainMock({ data: course, error: null });
    }
    return createChainMock({ data: [], error: null });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// The community entry is a tile on the course launcher; it is still gated on
// `student_questions_enabled`, which is what these tests pin.
describe('StudentCourse community questions entry', () => {
  const baseCourse: CourseRow = {
    id: 'course-1',
    title: 'Test Course',
    description: null,
    theme: null,
    leaderboard_enabled: false,
    student_questions_enabled: false,
    restrict_to_completed_chapters: false,
    show_difficulty_to_students: true,
  };

  it('offers community questions and the generator when student_questions_enabled=true', async () => {
    mockSupabaseWithCourse({ ...baseCourse, student_questions_enabled: true });

    const mod = await import('@/pages/StudentCourse');
    renderStudentCourse(mod.default);

    await waitFor(
      () => {
        expect(screen.getByText('Community questions')).toBeInTheDocument();
      },
      { timeout: 15000 },
    );
    expect(screen.getByText('Questions written by other students')).toBeInTheDocument();
    expect(screen.getByText('Create your own')).toBeInTheDocument();
  });

  it('hides both when student_questions_enabled=false', async () => {
    mockSupabaseWithCourse({ ...baseCourse, student_questions_enabled: false });

    const mod = await import('@/pages/StudentCourse');
    renderStudentCourse(mod.default);

    await waitFor(
      () => {
        expect(
          screen.getByRole('heading', { name: 'Test Course', level: 1 }),
        ).toBeInTheDocument();
      },
      { timeout: 15000 },
    );
    expect(screen.queryByText('Community questions')).not.toBeInTheDocument();
    expect(screen.queryByText('Create your own')).not.toBeInTheDocument();
  });

  it('says what is due even when nothing is', async () => {
    // A course with nothing assigned still shows its launcher: the quizzes
    // tile renders muted and says there is nothing behind it, and the summary
    // line above says so too — an honest "nothing here", not a blank page.
    mockSupabaseWithCourse({ ...baseCourse, student_questions_enabled: false });

    const mod = await import('@/pages/StudentCourse');
    renderStudentCourse(mod.default);

    const tile = await screen.findByTestId('launcher-quizzes', {}, { timeout: 15000 });
    expect(tile).toHaveAttribute('data-tone', 'muted');
    expect(within(tile).getByText('All clear')).toBeInTheDocument();
    expect(screen.getByText(/Nothing is due — a good/)).toBeInTheDocument();
  });
});
/**
 * The round trip between the course launcher and Community Questions.
 *
 * Community Questions is a separate route, so leaving it is a fresh navigation
 * rather than a pop. Both legs are plain course URLs — but they still have to
 * be the *same* URL, or "back" deposits the student somewhere they were never.
 */
describe('Course launcher ↔ Community Questions round trip', () => {
  const course: CourseRow = {
    id: 'course-1',
    title: 'Test Course',
    description: null,
    theme: null,
    leaderboard_enabled: false,
    student_questions_enabled: true,
    restrict_to_completed_chapters: false,
    show_difficulty_to_students: true,
  };

  function renderCommunityQuestions(Component: React.ComponentType) {
    return render(
      <QueryClientProvider client={createTestQueryClient()}>
        <MemoryRouter initialEntries={['/student/course/course-1/community-questions']}>
          <Routes>
            <Route
              path="/student/course/:courseId/community-questions"
              element={<Component />}
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('leaves the course surface for the community route', async () => {
    const user = userEvent.setup();
    mockSupabaseWithCourse(course);

    const mod = await import('@/pages/StudentCourse');
    renderStudentCourse(mod.default);

    const row = await screen.findByText('Community questions', {}, { timeout: 15000 });
    await user.click(row);

    expect(mockNavigate).toHaveBeenCalledWith(
      '/student/course/course-1/community-questions',
    );
  });

  it('returns to the course surface it was opened from', async () => {
    const user = userEvent.setup();
    mockSupabaseWithCourse(course);

    const mod = await import('@/pages/StudentCommunityQuestions');
    renderCommunityQuestions(mod.default);

    const back = await screen.findByRole('button', { name: /back to/i }, { timeout: 15000 });
    await user.click(back);

    expect(mockNavigate).toHaveBeenCalledWith('/student/course/course-1');
  });
});
