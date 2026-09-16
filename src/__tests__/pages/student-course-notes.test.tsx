/**
 * Instructor notes on the student course home.
 *
 * The row is worth pinning for two reasons. It is count-driven, so a course
 * whose notes are all drafts (or all targeted at a section this student is not
 * in) must render nothing at all rather than an empty list — RLS is what makes
 * the count trustworthy, and the page must not second-guess it with a filter
 * of its own. And the row leads to a sub-view, so "Open" has to actually reach
 * the list rather than sitting inert like a heading.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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
const createSignedUrl = vi.hoisted(() =>
  vi.fn(async () => ({ data: { signedUrl: 'https://signed.test/notes.pdf' }, error: null })),
);

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
        createSignedUrl,
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

const NOTE_ROWS = [
  {
    id: 'note-1',
    title: 'Chapter 3 handout',
    description: 'Read before Friday',
    file_path: 'course-1/key-1-handout.pdf',
    file_name: 'handout.pdf',
    file_size: 2048,
    created_at: '2026-08-20T10:00:00Z',
  },
  {
    id: 'note-2',
    title: 'Reading list',
    description: null,
    file_path: 'course-1/key-2-reading.txt',
    file_name: 'reading.txt',
    file_size: 512,
    created_at: '2026-08-18T10:00:00Z',
  },
];

function baseTables(): Record<string, ChainResult | ChainResult[]> {
  return {
    courses: { data: COURSE, error: null },
    class_enrollments: { data: [{ class_id: 'class-1' }], error: null },
    offerings: {
      data: [{ id: 'off-1', class_id: 'class-1', course_id: 'course-1' }],
      error: null,
    },
  };
}

/** A table maps to one result, or a queue consumed in call order (last repeats). */
function mockTables(tables: Record<string, ChainResult | ChainResult[]>) {
  const queues = new Map<string, ChainResult[]>();
  mockFromImpl.mockImplementation((table: string) => {
    const spec = tables[table];
    if (Array.isArray(spec)) {
      const queue = queues.get(table) ?? [...spec];
      const next = queue.length > 1 ? queue.shift()! : queue[0];
      queues.set(table, queue);
      return createChainMock(next ?? { data: [], error: null });
    }
    return createChainMock(spec ?? { data: [], error: null });
  });
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

/**
 * Instructor notes are a tile on the course launcher. The launcher renders
 * once the course has loaded, so waiting for it is how an assertion — the
 * absence one especially — knows the page has finished loading rather than
 * passing against a still-fetching one.
 */
async function waitForLauncher() {
  return screen.findByTestId('course-launcher', {}, { timeout: 15000 });
}

describe('StudentCourse — instructor notes', () => {
  it('shows the Notes tile with the visible-note count', async () => {
    mockTables({
      ...baseTables(),
      // The page asks for a head count first; the sub-view then asks for rows.
      course_notes: [
        { data: null, error: null, count: 2 },
        { data: NOTE_ROWS, error: null },
      ],
    });

    renderCourse();
    await waitForLauncher();

    const row = await screen.findByTestId('launcher-notes', {}, { timeout: 15000 });
    expect(row).toHaveTextContent('Notes');
    expect(row).toHaveTextContent('2 documents shared by your teacher');
  });

  it('hides the tile entirely when no note is visible to this student', async () => {
    mockTables({
      ...baseTables(),
      course_notes: { data: null, error: null, count: 0 },
    });

    renderCourse();

    // Wait for the page to finish loading before asserting an absence, and
    // for the launcher the tile would be on — otherwise the query passes for
    // the wrong reason.
    await screen.findByRole('heading', { name: 'Mathematics', level: 1 }, { timeout: 15000 });
    await waitForLauncher();
    expect(screen.queryByTestId('launcher-notes')).not.toBeInTheDocument();
  });

  it('opens the notes list, and a note resolves to a signed URL', async () => {
    const user = userEvent.setup();
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    mockTables({
      ...baseTables(),
      course_notes: [
        { data: null, error: null, count: 2 },
        { data: NOTE_ROWS, error: null },
      ],
    });

    renderCourse();
    await waitForLauncher();

    const row = await screen.findByTestId('launcher-notes', {}, { timeout: 15000 });
    await user.click(row);

    expect(await screen.findByText('Chapter 3 handout')).toBeInTheDocument();
    expect(screen.getByText('Reading list')).toBeInTheDocument();
    expect(screen.getByText(/PDF · 2 KB/)).toBeInTheDocument();

    await user.click(screen.getAllByRole('button', { name: /download/i })[0]);

    expect(createSignedUrl).toHaveBeenCalledWith('course-1/key-1-handout.pdf', 600);
    expect(openSpy).toHaveBeenCalledWith(
      'https://signed.test/notes.pdf',
      '_blank',
      'noopener,noreferrer',
    );
    openSpy.mockRestore();
  });
});
