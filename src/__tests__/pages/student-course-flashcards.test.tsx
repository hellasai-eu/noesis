/**
 * The flashcards count on the course home must mean what it says.
 *
 * `FlashcardSessionManager` only ever shows chapters that are published to the
 * student's offering, still flagged `flashcards_visible`, and still hold a
 * non-empty deck. A `flashcard_reviews` row outlives all three — an assignment
 * withdrawn, a chapter hidden, a deck cleared, a card first seen through
 * another offering of the same course — so a course-wide count can promise
 * reviews the session cannot deliver. Next up makes that the page's primary
 * action, which is what these tests pin.
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

/** `count` is carried so head-only count queries can be exercised. */
type ChainResult = { data: unknown; error: unknown; count?: number };

/** Every `.gte(column, value)` the page issues, in order. */
const gteCalls: unknown[][] = [];

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
  chain.gte = vi.fn((...args: unknown[]) => {
    gteCalls.push(args);
    return chain;
  });
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
import { getStartOfToday } from '@/lib/spaced-repetition';

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

/** Three due reviews, on the first three cards of the fixture chapter. */
const DUE_ROWS = [
  { chapter_id: 'ch-1', flashcard_index: 0 },
  { chapter_id: 'ch-1', flashcard_index: 1 },
  { chapter_id: 'ch-1', flashcard_index: 2 },
];

/** A deck long enough that every row in `DUE_ROWS` still points at a card. */
const FULL_DECK = [
  { front: 'a', back: 'b' },
  { front: 'c', back: 'd' },
  { front: 'e', back: 'f' },
];

function baseTables(): Record<string, ChainResult | ChainResult[]> {
  return {
    courses: { data: COURSE, error: null },
    class_enrollments: { data: [{ class_id: 'class-1' }], error: null },
    offerings: {
      data: [{ id: 'off-1', class_id: 'class-1', course_id: 'course-1' }],
      error: null,
    },
    // `flashcard_reviews` is asked two different questions in order: which
    // rows are due (read as rows, so indices past the end of a regenerated
    // deck can be discarded), then how much of today's quota is already spent
    // (a count). Three cards are due and none of the quota is spent unless a
    // test says otherwise.
    flashcard_reviews: [
      { data: DUE_ROWS, error: null },
      { data: null, error: null, count: 0 },
    ],
  };
}

/**
 * A table maps to one result, or to a queue of results consumed in call order
 * — the last one repeats. The queue is what lets a single table answer two
 * different questions in one page load.
 */
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
      {/* Every shelf of the course surface is on the one page, so a plain
          course URL is enough: the assertions below read the Cards shelf and
          its one tile, both of which are always mounted. */}
      <MemoryRouter initialEntries={['/student/course/course-1']}>
        <Routes>
          <Route path="/student/course/:courseId" element={<StudentCourse />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const queriedTables = () => mockFromImpl.mock.calls.map((c) => c[0]);

beforeEach(() => {
  vi.clearAllMocks();
  gteCalls.length = 0;
});

describe('StudentCourse flashcards count', () => {
  it('counts reviews for chapters published to the offering and still visible', async () => {
    mockTables({
      ...baseTables(),
      offering_chapter_flashcards: { data: [{ chapter_id: 'ch-1' }], error: null },
      material_chapters: { data: [{ id: 'ch-1', flashcards: FULL_DECK }], error: null },
    });

    renderCourse();

    const tile = await screen.findByTestId('launcher-flashcards', {}, { timeout: 15000 });
    expect(tile).toHaveTextContent('3 due');
  });

  it('does not count reviews whose chapter is no longer assigned to the offering', async () => {
    mockTables({
      ...baseTables(),
      // The assignment was withdrawn; the review rows survive it.
      offering_chapter_flashcards: { data: [], error: null },
      material_chapters: { data: [{ id: 'ch-1', flashcards: FULL_DECK }], error: null },
    });

    renderCourse();

    const tile = await screen.findByTestId('launcher-flashcards', {}, { timeout: 15000 });
    expect(tile).toHaveTextContent('Nothing due');
    expect(tile).not.toHaveTextContent('3 due');
    // The count query is skipped entirely — there is nothing it could reach.
    expect(queriedTables()).not.toContain('flashcard_reviews');
  });

  it('does not count reviews whose chapter has its flashcards hidden', async () => {
    mockTables({
      ...baseTables(),
      offering_chapter_flashcards: { data: [{ chapter_id: 'ch-1' }], error: null },
      // `flashcards_visible` is false, so the visibility filter returns nothing.
      material_chapters: { data: [], error: null },
    });

    renderCourse();

    const tile = await screen.findByTestId('launcher-flashcards', {}, { timeout: 15000 });
    expect(tile).toHaveTextContent('Nothing due');
    await waitFor(() => {
      expect(tile).not.toHaveTextContent('3 due');
    });
    expect(queriedTables()).not.toContain('flashcard_reviews');
  });

  it('counts only what today\'s remaining quota can still deliver', async () => {
    mockTables({
      ...baseTables(),
      offering_chapter_flashcards: { data: [{ chapter_id: 'ch-1' }], error: null },
      material_chapters: {
        data: [{ id: 'ch-1', flashcards: FULL_DECK }],
        error: null,
      },
      // Three due, but 14 of the 15 daily due cards are already spent.
      flashcard_reviews: [
        { data: DUE_ROWS, error: null },
        { data: null, error: null, count: 14 },
      ],
    });

    renderCourse();

    const tile = await screen.findByTestId('launcher-flashcards', {}, { timeout: 15000 });
    expect(tile).toHaveTextContent('1 due');
  });

  it('does not count reviews pointing past the end of a regenerated deck', async () => {
    mockTables({
      ...baseTables(),
      offering_chapter_flashcards: { data: [{ chapter_id: 'ch-1' }], error: null },
      // The deck was regenerated from three cards down to one. Reviews key on
      // chapter plus index, so two of the three now point at cards the session
      // will never build.
      material_chapters: {
        data: [{ id: 'ch-1', flashcards: [{ front: 'a', back: 'b' }] }],
        error: null,
      },
    });

    renderCourse();

    const tile = await screen.findByTestId('launcher-flashcards', {}, { timeout: 15000 });
    expect(tile).toHaveTextContent('1 due');
  });

  it("measures the quota from the session's own day boundary", async () => {
    mockTables({
      ...baseTables(),
      offering_chapter_flashcards: { data: [{ chapter_id: 'ch-1' }], error: null },
      material_chapters: {
        data: [{ id: 'ch-1', flashcards: FULL_DECK }],
        error: null,
      },
    });

    renderCourse();

    await screen.findByTestId('launcher-flashcards', {}, { timeout: 15000 });
    // Not merely "some boundary": local midnight differs from this by the
    // viewer's UTC offset, and the session would then compute a different
    // remaining quota from the same reviews.
    await waitFor(() => {
      expect(gteCalls).toContainEqual([
        'last_reviewed',
        getStartOfToday().toISOString(),
      ]);
    });
  });

  it('stops recommending flashcards once the daily quota is spent', async () => {
    mockTables({
      ...baseTables(),
      offering_chapter_flashcards: { data: [{ chapter_id: 'ch-1' }], error: null },
      material_chapters: {
        data: [{ id: 'ch-1', flashcards: FULL_DECK }],
        error: null,
      },
      // The full daily allowance of due cards has been reviewed today, so the
      // session would open on "come back tomorrow".
      flashcard_reviews: [
        { data: DUE_ROWS, error: null },
        { data: null, error: null, count: 15 },
      ],
    });

    renderCourse();

    const tile = await screen.findByTestId('launcher-flashcards', {}, { timeout: 15000 });
    expect(tile).toHaveTextContent('Nothing due');
    expect(tile).not.toHaveTextContent('3 due');
  });

  it('does not count reviews whose chapter no longer holds any cards', async () => {
    mockTables({
      ...baseTables(),
      offering_chapter_flashcards: { data: [{ chapter_id: 'ch-1' }], error: null },
      // Assigned and visible, but the deck was cleared or regenerated away.
      // The reviews survive it: they key on chapter plus card index.
      material_chapters: { data: [{ id: 'ch-1', flashcards: [] }], error: null },
    });

    renderCourse();

    const tile = await screen.findByTestId('launcher-flashcards', {}, { timeout: 15000 });
    expect(tile).toHaveTextContent('Nothing due');
    await waitFor(() => {
      expect(tile).not.toHaveTextContent('3 due');
    });
    expect(queriedTables()).not.toContain('flashcard_reviews');
  });
});
