import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import React from 'react';

type Result = { data: unknown; error: unknown };

const responses: Record<string, Result> = {
  quizzes: { data: [], error: null },
  profiles: { data: [], error: null },
  questions: { data: [], error: null },
  course_competencies: { data: [], error: null },
  offering_groups: { data: [], error: null },
  offering_quizzes: { data: [], error: null },
};

const insertCalls: Array<{ table: string; values: unknown }> = [];
const upsertCalls: Array<{ table: string; values: unknown; opts: unknown }> = [];
const updateCalls: Array<{ table: string; values: unknown }> = [];

vi.mock('@/integrations/supabase/client', () => {
  const buildChain = (table: string) => {
    const chain: Record<string, (...a: unknown[]) => unknown> = {};
    const passThrough = () => chain;
    chain.select = passThrough;
    chain.eq = passThrough;
    chain.neq = passThrough;
    chain.in = passThrough;
    chain.is = passThrough;
    chain.not = passThrough;
    chain.or = passThrough;
    chain.order = passThrough;
    chain.limit = passThrough;
    chain.delete = passThrough;
    chain.insert = (values: unknown) => {
      insertCalls.push({ table, values });
      return chain;
    };
    chain.upsert = (values: unknown, opts: unknown) => {
      upsertCalls.push({ table, values, opts });
      return chain;
    };
    chain.update = (values: unknown) => {
      updateCalls.push({ table, values });
      return chain;
    };
    chain.single = () =>
      Promise.resolve(responses[table] || { data: null, error: null });
    chain.maybeSingle = () =>
      Promise.resolve(responses[table] || { data: null, error: null });
    chain.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(resolve(responses[table] || { data: [], error: null }));
    return chain;
  };
  return {
    supabase: {
      from: vi.fn((table: string) => buildChain(table)),
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }),
      },
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
      functions: { invoke: vi.fn().mockResolvedValue({ data: null, error: null }) },
    },
  };
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock('@/lib/latex-utils', () => ({
  processLatexContent: (text: string) => text,
}));

const resultsProps = vi.hoisted(() => ({
  current: null as {
    quizId: string | null;
    open: boolean;
    initialTab?: string;
    onOpenChange: (o: boolean) => void;
  } | null,
}));
vi.mock('@/components/quiz/QuizResultsDialog', () => ({
  QuizResultsDialog: (props: {
    quizId: string | null;
    open: boolean;
    initialTab?: string;
    onOpenChange: (o: boolean) => void;
  }) => {
    resultsProps.current = props;
    return props.open ? <div data-testid="quiz-results-dialog" /> : null;
  },
}));

const boardProps = vi.hoisted(() => ({
  current: null as { courseId: string; quizId?: string; embedded?: boolean } | null,
}));
vi.mock('@/components/quiz/AssignedQuizzesBoard', () => ({
  AssignedQuizzesBoard: (props: {
    courseId: string;
    quizId?: string;
    embedded?: boolean;
  }) => {
    boardProps.current = props;
    return <div data-testid="embedded-board" />;
  },
}));

import { QuizManager } from '@/components/QuizManager';
import type { CourseClass } from '@/types/content-assignments';
import { toast } from 'sonner';

beforeAll(() => {
  // Radix Select needs the same pointer/scroll shims used elsewhere in the suite.
  if (!Element.prototype.hasPointerCapture) {
    (Element.prototype as unknown as { hasPointerCapture: () => boolean }).hasPointerCapture =
      () => false;
  }
  if (!Element.prototype.setPointerCapture) {
    (Element.prototype as unknown as { setPointerCapture: () => void }).setPointerCapture =
      () => {};
  }
  if (!Element.prototype.releasePointerCapture) {
    (
      Element.prototype as unknown as { releasePointerCapture: () => void }
    ).releasePointerCapture = () => {};
  }
});

function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

const CLASSES: CourseClass[] = [
  {
    id: 'cls-1',
    name: 'A1',
    grade_level_id: null,
    section_name: null,
    category: null,
    academic_period: null,
    offering_id: 'off-1',
  },
];

function renderManager() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <BrowserRouter>
        <QuizManager courseId="course-123" isAdmin classes={CLASSES} />
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

// A single published quiz on the course, plus one class with one manual group.
function seedAssignFixtures() {
  responses.quizzes = {
    data: [
      {
        id: 'quiz-1',
        title: 'Quiz One',
        description: null,
        is_published: true,
        time_limit_minutes: null,
        created_at: '2026-01-01T00:00:00Z',
        created_by: null,
        quiz_questions: [{ count: 3 }],
        offering_quizzes: [],
      },
    ],
    error: null,
  };
  responses.offering_groups = {
    data: [
      {
        id: 'grp-1',
        offering_id: 'off-1',
        name: 'Struggling Readers',
        description: null,
        is_individual: false,
        owner_user_id: null,
      },
    ],
    error: null,
  };
}

// One open (assigned + published) quiz, one closed quiz, one unassigned quiz
// and one draft-only quiz, exercising the table's Classes / Due columns and
// the study-guide-style actions lane.
function seedTableFixtures() {
  responses.quizzes = {
    data: [
      {
        id: 'quiz-open',
        title: 'Open Quiz',
        description: null,
        is_published: true,
        time_limit_minutes: 10,
        created_at: '2026-01-02T00:00:00Z',
        created_by: null,
        quiz_questions: [{ count: 4 }],
        offering_quizzes: [
          {
            id: 'oq-1',
            offering_id: 'off-1',
            group_id: null,
            published_at: '2026-01-03T00:00:00Z',
            closed_at: null,
            due_date: '2026-02-01T10:00:00Z',
            offerings: {
              classes: {
                name: 'A1',
                grade_level_id: null,
                section_name: '',
                category: null,
                academic_period: null,
              },
            },
            offering_groups: null,
          },
        ],
      },
      {
        id: 'quiz-closed',
        title: 'Closed Quiz',
        description: null,
        is_published: true,
        time_limit_minutes: null,
        created_at: '2026-01-01T12:00:00Z',
        created_by: null,
        quiz_questions: [{ count: 5 }],
        offering_quizzes: [
          {
            id: 'oq-closed',
            offering_id: 'off-1',
            group_id: null,
            published_at: '2026-01-02T00:00:00Z',
            closed_at: '2026-01-20T00:00:00Z',
            due_date: null,
            offerings: {
              classes: {
                name: 'A1',
                grade_level_id: null,
                section_name: '',
                category: null,
                academic_period: null,
              },
            },
            offering_groups: null,
          },
        ],
      },
      {
        id: 'quiz-un',
        title: 'Unassigned Quiz',
        description: null,
        is_published: true,
        time_limit_minutes: null,
        created_at: '2026-01-01T00:00:00Z',
        created_by: null,
        quiz_questions: [{ count: 2 }],
        offering_quizzes: [],
      },
      {
        // Only a DRAFT assignment carries a due date — the Due column must
        // stay empty, because a draft's deadline is not live for anyone.
        id: 'quiz-draft',
        title: 'Draft Quiz',
        description: null,
        is_published: true,
        time_limit_minutes: null,
        created_at: '2025-12-31T00:00:00Z',
        created_by: null,
        quiz_questions: [{ count: 1 }],
        offering_quizzes: [
          {
            id: 'oq-2',
            offering_id: 'off-1',
            group_id: null,
            published_at: null,
            closed_at: null,
            due_date: '2026-01-15T10:00:00Z',
            offerings: {
              classes: {
                name: 'A1',
                grade_level_id: null,
                section_name: '',
                category: null,
                academic_period: null,
              },
            },
            offering_groups: null,
          },
        ],
      },
    ],
    error: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(responses)) {
    responses[key] = { data: [], error: null };
  }
  insertCalls.length = 0;
  upsertCalls.length = 0;
  updateCalls.length = 0;
  resultsProps.current = null;
  boardProps.current = null;
});

describe('QuizManager', () => {
  it('renders without crashing', () => {
    renderManager();
    expect(document.body).toBeTruthy();
  });

  it('accepts courseId prop', () => {
    const { rerender } = renderManager();
    rerender(
      <QueryClientProvider client={createQueryClient()}>
        <BrowserRouter>
          <QuizManager courseId="course-2" isAdmin classes={CLASSES} />
        </BrowserRouter>
      </QueryClientProvider>,
    );
    expect(document.body).toBeTruthy();
  });

  it('renders one table row per quiz with the study-guide columns and actions', async () => {
    seedTableFixtures();
    renderManager();

    await waitFor(() => expect(screen.getByTestId('quiz-table')).toBeInTheDocument());

    const openRow = screen.getByTestId('quiz-row-quiz-open');
    // Class badge from the embedded offerings→classes join.
    expect(within(openRow).getByText('A1')).toBeInTheDocument();
    expect(within(openRow).queryByTestId('quiz-needs-assign-quiz-open')).toBeNull();
    // An open quiz offers live results, the AI assessment, mark-done and
    // manage — the study-guide model, where results are live.
    expect(within(openRow).getByTestId('quiz-mark-done-quiz-open')).toBeInTheDocument();
    expect(within(openRow).getByTestId('quiz-results-quiz-open')).toBeInTheDocument();
    expect(within(openRow).getByTestId('quiz-assessment-quiz-open')).toBeInTheDocument();
    expect(within(openRow).getByTestId('quiz-manage-quiz-open')).toBeInTheDocument();
    expect(within(openRow).queryByTestId('quiz-done-badge-quiz-open')).toBeNull();

    // A closed quiz wears the Done badge and offers results, reopen and the
    // assessment/manage actions.
    const closedRow = screen.getByTestId('quiz-row-quiz-closed');
    expect(within(closedRow).getByTestId('quiz-done-badge-quiz-closed')).toBeInTheDocument();
    expect(within(closedRow).getByTestId('quiz-results-quiz-closed')).toBeInTheDocument();
    expect(within(closedRow).getByTestId('quiz-reopen-quiz-closed')).toBeInTheDocument();
    expect(within(closedRow).getByTestId('quiz-assessment-quiz-closed')).toBeInTheDocument();
    expect(within(closedRow).getByTestId('quiz-manage-quiz-closed')).toBeInTheDocument();
    expect(within(closedRow).queryByTestId('quiz-mark-done-quiz-closed')).toBeNull();

    const unassignedRow = screen.getByTestId('quiz-row-quiz-un');
    // Unassigned rows offer the ghost Assign affordance and no results/done
    // actions.
    expect(
      within(unassignedRow).getByTestId('quiz-needs-assign-quiz-un'),
    ).toBeInTheDocument();
    expect(within(unassignedRow).queryByTestId('quiz-results-quiz-un')).toBeNull();
    expect(within(unassignedRow).queryByTestId('quiz-manage-quiz-un')).toBeNull();
    expect(within(unassignedRow).queryByTestId('quiz-mark-done-quiz-un')).toBeNull();

    // A due date carried only by a DRAFT assignment is not live for anyone —
    // the Due cell (Title, Questions, Classes, Due, Actions) stays empty. The
    // draft badge itself is the way into the manage dialog (to publish), and
    // manage is offered since the draft can only be published from there.
    const draftRow = screen.getByTestId('quiz-row-quiz-draft');
    expect(within(draftRow).getByTestId('quiz-draft-badge-oq-2')).toBeInTheDocument();
    expect(within(draftRow).getAllByRole('cell')[3]).toHaveTextContent('—');
    expect(within(draftRow).getByTestId('quiz-manage-quiz-draft')).toBeInTheDocument();
    expect(within(draftRow).queryByTestId('quiz-results-quiz-draft')).toBeNull();
    expect(within(draftRow).queryByTestId('quiz-mark-done-quiz-draft')).toBeNull();
  });

  it('opens the Track & manage dialog scoped to the clicked quiz', async () => {
    seedTableFixtures();
    renderManager();
    const user = userEvent.setup();

    await waitFor(() => expect(screen.getByTestId('quiz-table')).toBeInTheDocument());
    await user.click(screen.getByTestId('quiz-manage-quiz-closed'));

    await waitFor(() => expect(screen.getByTestId('embedded-board')).toBeInTheDocument());
    expect(boardProps.current).toMatchObject({
      courseId: 'course-123',
      quizId: 'quiz-closed',
      embedded: true,
    });
  });

  it('opens the Track & manage dialog from a draft badge, to publish the draft', async () => {
    seedTableFixtures();
    renderManager();
    const user = userEvent.setup();

    await waitFor(() => expect(screen.getByTestId('quiz-table')).toBeInTheDocument());
    await user.click(screen.getByTestId('quiz-draft-badge-oq-2'));

    await waitFor(() => expect(screen.getByTestId('embedded-board')).toBeInTheDocument());
    expect(boardProps.current).toMatchObject({
      courseId: 'course-123',
      quizId: 'quiz-draft',
      embedded: true,
    });
  });

  it('opens the results dialog on Students from the results action', async () => {
    seedTableFixtures();
    renderManager();
    const user = userEvent.setup();

    await waitFor(() => expect(screen.getByTestId('quiz-table')).toBeInTheDocument());
    await user.click(screen.getByTestId('quiz-results-quiz-closed'));

    await waitFor(() => expect(screen.getByTestId('quiz-results-dialog')).toBeInTheDocument());
    expect(resultsProps.current).toMatchObject({
      quizId: 'quiz-closed',
      open: true,
      initialTab: 'students',
    });
  });

  it('opens the results dialog on Assessment from the AI action', async () => {
    seedTableFixtures();
    renderManager();
    const user = userEvent.setup();

    await waitFor(() => expect(screen.getByTestId('quiz-table')).toBeInTheDocument());
    await user.click(screen.getByTestId('quiz-assessment-quiz-open'));

    await waitFor(() => expect(screen.getByTestId('quiz-results-dialog')).toBeInTheDocument());
    expect(resultsProps.current).toMatchObject({
      quizId: 'quiz-open',
      open: true,
      initialTab: 'assessment',
    });
  });

  it('marks every open published assignment done via the RPC', async () => {
    seedTableFixtures();
    renderManager();
    const user = userEvent.setup();
    const { supabase } = await import('@/integrations/supabase/client');

    await waitFor(() => expect(screen.getByTestId('quiz-table')).toBeInTheDocument());
    await user.click(screen.getByTestId('quiz-mark-done-quiz-open'));

    await waitFor(() =>
      expect(supabase.rpc).toHaveBeenCalledWith('mark_offering_quiz_done', {
        p_offering_quiz_id: 'oq-1',
      }),
    );
    expect(toast.success).toHaveBeenCalledWith(
      expect.stringMatching(/marked as done/i),
    );
  });

  it('reopens every closed assignment via the RPC', async () => {
    seedTableFixtures();
    renderManager();
    const user = userEvent.setup();
    const { supabase } = await import('@/integrations/supabase/client');

    await waitFor(() => expect(screen.getByTestId('quiz-table')).toBeInTheDocument());
    await user.click(screen.getByTestId('quiz-reopen-quiz-closed'));

    await waitFor(() =>
      expect(supabase.rpc).toHaveBeenCalledWith('reopen_offering_quiz', {
        p_offering_quiz_id: 'oq-closed',
      }),
    );
    expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/reopened/i));
  });

  it('reports a partial mark-done outcome per class instead of a generic failure', async () => {
    seedTableFixtures();
    // A second open assignment on the open quiz, in another class, so the
    // bulk close spans two RPCs.
    (responses.quizzes.data as any[])[0].offering_quizzes.push({
      id: 'oq-1b',
      offering_id: 'off-2',
      group_id: null,
      published_at: '2026-01-03T00:00:00Z',
      closed_at: null,
      due_date: null,
      offerings: {
        classes: {
          name: 'B1',
          grade_level_id: null,
          section_name: '',
          category: null,
          academic_period: null,
        },
      },
      offering_groups: null,
    });
    renderManager();
    const user = userEvent.setup();
    const { supabase } = await import('@/integrations/supabase/client');
    (supabase.rpc as ReturnType<typeof vi.fn>).mockImplementation(
      (_fn: string, args: { p_offering_quiz_id: string }) =>
        Promise.resolve(
          args.p_offering_quiz_id === 'oq-1b'
            ? { data: null, error: { message: 'stale' } }
            : { data: null, error: null },
        ),
    );

    try {
      await waitFor(() => expect(screen.getByTestId('quiz-table')).toBeInTheDocument());
      await user.click(screen.getByTestId('quiz-mark-done-quiz-open'));

      // The one class that failed is named, so the instructor knows the quiz
      // is in a mixed state and what to retry.
      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(
          expect.stringMatching(/1 of 2 class assignments.*B1/i),
        ),
      );
      expect(toast.success).not.toHaveBeenCalled();
    } finally {
      // Implementations survive vi.clearAllMocks(); restore the default so
      // later tests keep the always-succeeding RPC.
      (supabase.rpc as ReturnType<typeof vi.fn>).mockReset();
      (supabase.rpc as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: null,
        error: null,
      });
    }
  });

  it('assigns whole class + a group in one save, with a per-section due date', async () => {
    seedAssignFixtures();
    renderManager();
    const user = userEvent.setup();

    await waitFor(() => expect(screen.getByText('Quiz One')).toBeInTheDocument());

    // Open the shared assign dialog from the ghost Assign affordance.
    await user.click(screen.getByTestId('quiz-needs-assign-quiz-1'));
    await waitFor(() => expect(screen.getByText('Assign quiz')).toBeInTheDocument());

    // Check the whole class and its manual group in the same opening.
    await user.click(screen.getByLabelText(/A1/));
    await user.click(screen.getByLabelText('Struggling Readers'));

    // Give this section a due date (the study-guide per-section control).
    const dueInput = screen.getByTestId('quiz-assign-due-date-off-1');
    fireEvent.change(dueInput, { target: { value: '2026-03-01' } });

    await user.click(screen.getByRole('button', { name: /^save$/i }));

    // Both targets go through the shared upsert…
    await waitFor(() => {
      const rows = upsertCalls
        .filter((c) => c.table === 'offering_quizzes')
        .map((c) => c.values as Record<string, unknown>);
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => (r.group_id ?? null) === null)).toMatchObject({
        quiz_id: 'quiz-1',
        offering_id: 'off-1',
      });
      expect(rows.find((r) => r.group_id === 'grp-1')).toMatchObject({
        quiz_id: 'quiz-1',
        offering_id: 'off-1',
      });
    });

    // …and the section's due date lands on its assignment rows afterwards.
    await waitFor(() => {
      const due = updateCalls.find(
        (c) =>
          c.table === 'offering_quizzes' &&
          (c.values as Record<string, unknown>).due_date,
      );
      expect(due).toBeTruthy();
    });
  });
});

describe('QuizManager — initialReportQuizId deep link', () => {
  function renderWithDeepLink(quizId: string) {
    return render(
      <QueryClientProvider client={createQueryClient()}>
        <BrowserRouter>
          <QuizManager
            courseId="course-123"
            isAdmin
            classes={CLASSES}
            initialReportQuizId={quizId}
          />
        </BrowserRouter>
      </QueryClientProvider>,
    );
  }

  it('opens the results dialog once the list contains the linked quiz', async () => {
    seedAssignFixtures();
    renderWithDeepLink('quiz-1');

    await waitFor(() => {
      expect(screen.getByTestId('quiz-results-dialog')).toBeInTheDocument();
    });
    expect(resultsProps.current).toMatchObject({ quizId: 'quiz-1', initialTab: 'students' });
  });

  it('opens nothing for an id the list does not contain', async () => {
    seedAssignFixtures();
    renderWithDeepLink('quiz-that-was-deleted');

    // The list finished loading — and no dialog appeared.
    await waitFor(() => expect(screen.getByText('Quiz One')).toBeInTheDocument());
    expect(screen.queryByTestId('quiz-results-dialog')).not.toBeInTheDocument();
  });

  it('does not reopen the dialog after the instructor closes it', async () => {
    seedAssignFixtures();
    renderWithDeepLink('quiz-1');
    await waitFor(() => expect(screen.getByTestId('quiz-results-dialog')).toBeInTheDocument());

    act(() => resultsProps.current!.onOpenChange(false));

    // The preselect was consumed on open: the state update above re-runs the
    // effect with the id still set and the quiz still in the list, and the
    // dialog must stay closed.
    await waitFor(() =>
      expect(screen.queryByTestId('quiz-results-dialog')).not.toBeInTheDocument()
    );
  });

  it('re-arms for a changed preselect id', async () => {
    seedAssignFixtures();
    responses.quizzes = {
      data: [
        ...(responses.quizzes.data as unknown[]),
        {
          id: 'quiz-2',
          title: 'Quiz Two',
          description: null,
          is_published: true,
          time_limit_minutes: null,
          created_at: '2026-01-02T00:00:00Z',
          created_by: null,
          quiz_questions: [{ count: 2 }],
          offering_quizzes: [],
        },
      ],
      error: null,
    };
    const { rerender } = renderWithDeepLink('quiz-1');
    await waitFor(() => expect(resultsProps.current?.quizId).toBe('quiz-1'));

    act(() => resultsProps.current!.onOpenChange(false));
    rerender(
      <QueryClientProvider client={createQueryClient()}>
        <BrowserRouter>
          <QuizManager
            courseId="course-123"
            isAdmin
            classes={CLASSES}
            initialReportQuizId="quiz-2"
          />
        </BrowserRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(resultsProps.current?.quizId).toBe('quiz-2'));
    expect(screen.getByTestId('quiz-results-dialog')).toBeInTheDocument();
  });

  it('opens once a later load finally contains the linked quiz', async () => {
    // First load: the linked quiz is missing (e.g. the fetch raced a create).
    seedAssignFixtures();
    const { rerender } = renderWithDeepLink('quiz-2');
    await waitFor(() => expect(screen.getByText('Quiz One')).toBeInTheDocument());
    expect(screen.queryByTestId('quiz-results-dialog')).not.toBeInTheDocument();

    // A later fetch (here: triggered by a courseId change) returns it.
    responses.quizzes = {
      data: [
        {
          id: 'quiz-2',
          title: 'Quiz Two',
          description: null,
          is_published: true,
          time_limit_minutes: null,
          created_at: '2026-01-02T00:00:00Z',
          created_by: null,
          quiz_questions: [{ count: 2 }],
          offering_quizzes: [],
        },
      ],
      error: null,
    };
    rerender(
      <QueryClientProvider client={createQueryClient()}>
        <BrowserRouter>
          <QuizManager
            courseId="course-456"
            isAdmin
            classes={CLASSES}
            initialReportQuizId="quiz-2"
          />
        </BrowserRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('quiz-results-dialog')).toBeInTheDocument());
    expect(resultsProps.current?.quizId).toBe('quiz-2');
  });
});
