/**
 * Study guides belong with the rest of the deadline-bearing work.
 *
 * They used to render inside "Learn", between the AI tutoring card and Key
 * Concepts. A guide is assigned coursework with its own progress and often a
 * due date, which is a different kind of thing from the always-available
 * tutoring and reference material Learn collects — and burying it there put
 * the one item with a deadline in the middle of a list of things that never
 * expire.
 *
 * The course surface (#1287) settles that by kind rather than by section: a
 * guide is a tile on the Due shelf, next to the quizzes, and never on the
 * self-paced shelves below it. These tests pin exactly that — which shelf the
 * guide lands on, and that its absence leaves the shelf saying so.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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

/** Enrolled, with one offering — the precondition for any guide to load. */
function baseTables(): Record<string, ChainResult> {
  return {
    courses: { data: COURSE, error: null },
    class_enrollments: { data: [{ class_id: 'class-1' }], error: null },
    offerings: { data: [{ id: 'off-1', class_id: 'class-1', course_id: 'course-1' }], error: null },
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

// Study guides are one option on the course launcher: a tile carrying the
// open-guide count, opening a list of guide cards. These tests pin that the
// assigned guide is reachable through that tile (with its old card test id —
// three E2E specs reach for it), and that an empty course says so instead of
// hiding the option.
describe('StudentCourse study guides', () => {
  it('renders an assigned guide in the list behind the launcher tile', async () => {
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
      study_guide_pieces: {
        data: [
          { study_guide_id: 'sg-1' },
          { study_guide_id: 'sg-1' },
          { study_guide_id: 'sg-1' },
        ],
        error: null,
      },
      study_guide_progress: { data: [], error: null },
    });

    renderCourse();

    // The launcher tile carries the open count, so a student can see there is
    // work behind it without opening the list.
    const tile = await screen.findByTestId('launcher-guides', {}, { timeout: 15000 });
    expect(tile).toHaveTextContent('1 guide due');

    await userEvent.click(tile);

    const list = await screen.findByTestId('guide-list', {}, { timeout: 15000 });
    const card = within(list).getByTestId('study-guide-card-sg-1');
    expect(within(card).getByText('Roll')).toBeInTheDocument();
    expect(within(card).getByText(/0 of 3 pieces done/)).toBeInTheDocument();
  });

  it('keeps the option visible, muted, when the student has no guides', async () => {
    mockTables({ ...baseTables(), offering_study_guides: { data: [], error: null } });

    renderCourse();

    // The tile stays on the launcher rather than disappearing — the page
    // keeps a learnable shape — and says there is nothing behind it.
    const tile = await screen.findByTestId('launcher-guides', {}, { timeout: 15000 });
    expect(tile).toHaveAttribute('data-tone', 'muted');
    expect(tile).toHaveTextContent('All clear');

    await userEvent.click(tile);

    await waitFor(
      () => {
        expect(screen.getByText('No study guides are waiting for you.')).toBeInTheDocument();
      },
      { timeout: 15000 },
    );
    expect(screen.queryByTestId('study-guide-card-sg-1')).not.toBeInTheDocument();
  });

  it('keeps the guide out of the quizzes list', async () => {
    // The regression this guards: quizzes and guides used to share one shelf,
    // and a future edit that merges them again would still satisfy "the card
    // renders". A guide card must appear in the guides list and only there.
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

    renderCourse();

    await userEvent.click(await screen.findByTestId('launcher-quizzes', {}, { timeout: 15000 }));
    // The quizzes list is empty in this fixture — and the guide is not in it.
    await screen.findByText('No quizzes are waiting for you.', {}, { timeout: 15000 });
    expect(screen.queryByTestId('study-guide-card-sg-1')).not.toBeInTheDocument();
  });
});
