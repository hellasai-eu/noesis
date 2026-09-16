import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockUser = vi.hoisted(() => ({ id: 'student-1' }));
const mockSupabaseFrom = vi.hoisted(() => vi.fn());
const mockSupabaseRpc = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: mockUser }),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: mockSupabaseFrom,
    rpc: mockSupabaseRpc,
    // `submitQuizAnswers` reads the access token before calling the grading
    // function, and since #1011 that call is what produces the answer key —
    // so the result view does not render until it resolves.
    auth: {
      getSession: vi.fn(async () => ({
        data: { session: { access_token: 'access-token' } },
      })),
    },
  },
}));

vi.mock('@/lib/latex-utils', () => ({
  processLatexContent: (text: string) => text ?? '',
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import { CommunityQuestions } from '@/components/student/CommunityQuestions';
import i18n from '@/i18n';

type Row = Record<string, unknown>;

const makeChain = (
  resolved: { data: Row[] | null; error: null } = { data: [], error: null },
  spies: Record<string, (...args: unknown[]) => unknown> = {},
) => {
  const chain: Record<string, unknown> = {};
  const methods = [
    'select',
    'insert',
    'update',
    'upsert',
    'delete',
    'eq',
    'neq',
    'in',
    'not',
    'gte',
    'order',
    'limit',
  ];
  for (const m of methods) {
    // Vitest 4 types a bare `vi.fn()` as `Mock<Procedure | Constructable>`,
    // a union including a constructor, so it is not callable as a plain
    // function. The explicit signature is what makes the spread call below
    // type-check.
    const spy: (...args: unknown[]) => unknown =
      spies[m] ?? vi.fn<(...args: unknown[]) => unknown>();
    chain[m] = (...args: unknown[]) => {
      spy(...args);
      return chain;
    };
  }
  chain.then = (onFulfilled: (v: { data: Row[] | null; error: null }) => unknown) =>
    Promise.resolve(onFulfilled(resolved));
  return chain;
};

type Tables = {
  questions?: Row[];
  profiles?: Row[];
  quiz_answers?: Row[];
  offering_questions?: Row[];
  question_votes?: Row[];
};

/**
 * A spy here is called, so it needs a call signature. `ReturnType<typeof
 * vi.fn>` resolves to `Mock<Procedure | Constructable>` in Vitest 4 — a union
 * that includes a constructor and therefore is not callable.
 */
type SpyFn = (...args: unknown[]) => unknown;
type TableSpies = Partial<Record<keyof Tables, Record<string, SpyFn>>>;

const setupSupabase = (tables: Tables, spies: TableSpies = {}) => {
  mockSupabaseFrom.mockImplementation((table: string) => {
    const rows = (tables[table as keyof Tables] ?? []) as Row[];
    const tableSpies = spies[table as keyof Tables] ?? {};
    return makeChain({ data: rows, error: null }, tableSpies);
  });
  mockSupabaseRpc.mockImplementation(() => Promise.resolve({ data: false, error: null }));
};

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    (globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
      ResizeObserverStub;
  }
});

describe('CommunityQuestions', () => {
  const defaultProps = {
    courseId: 'course-1',
    offeringId: null as string | null,
    classId: 'class-1',
    showDifficulty: true,
    studentQuestionsEnabled: true,
    onOpenGenerator: vi.fn(),
  };

  // #580: community-question reads now pull options + correct_index from
  // the unified `payload` / `answer_key` jsonb columns.
  const sampleQuestions: Row[] = [
    {
      id: 'q-1',
      question: 'What is the derivative of x^2?',
      payload: { options: ['x', '2x', 'x^3', '2'] },
      answer_key: { correct_indices: [1], correct_index: 1 },
      explanation: 'Power rule: d/dx(x^n) = n*x^(n-1)',
      difficulty: 'easy',
      created_by: 'user-a',
      created_at: '2026-04-01',
    },
    {
      id: 'q-2',
      question: 'Solve for x: 3x + 1 = 10',
      payload: { options: ['1', '2', '3', '4'] },
      answer_key: { correct_indices: [2], correct_index: 2 },
      explanation: 'Subtract and divide.',
      difficulty: 'medium',
      created_by: 'user-b',
      created_at: '2026-04-02',
    },
  ];

  const sampleProfiles: Row[] = [
    { user_id: 'user-a', full_name: 'Alice', email: 'alice@test.local' },
    { user_id: 'user-b', full_name: 'Bob', email: 'bob@test.local' },
  ];

  /**
   * The grading call `submitQuizAnswers` makes. Since #1011 the panel fetches
   * questions WITHOUT their key, so this response is the only thing that can
   * produce the correct/incorrect marks and the explanation — a test that does
   * not stub it sees the question stay unanswered.
   *
   * Each test can decide what the server reveals by setting `serverReveal`.
   */
  let serverReveal: Record<string, unknown> | null;
  /** When set, grading blocks on this until a test resolves it. */
  let gradingGate: Promise<void> | null;
  const stubGradingEndpoint = () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body) as {
          answers: Array<{ questionId: string }>;
        };
        if (gradingGate) await gradingGate;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            results: body.answers.map((a) => ({
              questionId: a.questionId,
              isCorrect: true,
              recordedNow: true,
              ...(serverReveal ? { reveal: serverReveal } : {}),
            })),
            correctCount: body.answers.length,
            totalCount: body.answers.length,
          }),
        };
      }),
    );
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    // The key for `q-1`, which is what the sample rows describe.
    serverReveal = {
      explanation: 'Power rule: d/dx(x^n) = n*x^(n-1)',
      correctIndices: [1],
    };
    gradingGate = null;
    stubGradingEndpoint();
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    (globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
      ResizeObserverStub;
  });

  it('renders rows for each community question with author names', async () => {
    setupSupabase({
      questions: sampleQuestions,
      profiles: sampleProfiles,
      quiz_answers: [],
    });

    render(<CommunityQuestions {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText(/What is the derivative of x\^2\?/)).toBeInTheDocument();
      expect(screen.getByText(/Solve for x: 3x \+ 1 = 10/)).toBeInTheDocument();
    });

    // Author names appear in the detail pane when a question is selected
    const row = screen.getByTestId('community-question-row-q-1');
    await userEvent.click(row);
    await waitFor(() => {
      expect(screen.getByText(/by Alice/)).toBeInTheDocument();
    });
  });

  it('fades already-answered rows', async () => {
    setupSupabase({
      questions: sampleQuestions,
      profiles: sampleProfiles,
      quiz_answers: [{ question_id: 'q-1' }],
    });

    render(<CommunityQuestions {...defaultProps} />);

    const row = await screen.findByTestId('community-question-row-q-1');
    await waitFor(() => {
      expect(row.getAttribute('data-answered')).toBe('true');
    });
    expect(row.className).toContain('opacity-60');
  });

  it('opens the selected question on the right pane when a row is clicked', async () => {
    setupSupabase({
      questions: sampleQuestions,
      profiles: sampleProfiles,
      quiz_answers: [],
    });

    render(<CommunityQuestions {...defaultProps} />);

    const row = await screen.findByTestId('community-question-row-q-2');
    await userEvent.click(row);

    await waitFor(() => {
      expect(screen.getByText(/by Bob/)).toBeInTheDocument();
    });

    // All four option letters render in the answer pane
    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.getByText('B')).toBeInTheDocument();
    expect(screen.getByText('C')).toBeInTheDocument();
    expect(screen.getByText('D')).toBeInTheDocument();
  });

  it('calls onOpenGenerator when the Create Your Own button is clicked', async () => {
    const onOpenGenerator = vi.fn();
    setupSupabase({
      questions: [],
      profiles: [],
      quiz_answers: [],
    });

    render(
      <CommunityQuestions
        {...defaultProps}
        onOpenGenerator={onOpenGenerator}
      />,
    );

    const button = await screen.findByRole('button', { name: /Create Your Own/i });
    await userEvent.click(button);
    expect(onOpenGenerator).toHaveBeenCalledTimes(1);
  });

  it('returns null when studentQuestionsEnabled is false', () => {
    setupSupabase({ questions: [], profiles: [], quiz_answers: [] });

    const { container } = render(
      <CommunityQuestions {...defaultProps} studentQuestionsEnabled={false} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('shows the empty state when there are no community questions', async () => {
    setupSupabase({ questions: [], profiles: [], quiz_answers: [] });

    render(<CommunityQuestions {...defaultProps} />);

    await waitFor(() => {
      expect(
        screen.getByText(/No community questions yet/i),
      ).toBeInTheDocument();
    });
  });

  describe('voting', () => {
    const selectAndAnswer = async (questionId: string) => {
      const row = await screen.findByTestId(`community-question-row-${questionId}`);
      await userEvent.click(row);
      // Multi-correct flow (#592): selecting an option only toggles it.
      // Clicking Submit Answer is what flips showResult and reveals the
      // vote bar.
      const optionA = await screen.findByText('A');
      await userEvent.click(optionA);
      const submitBtn = await screen.findByRole('button', { name: /Submit Answer/i });
      await userEvent.click(submitBtn);
    };

    it('highlights the user\'s existing vote on a question they already voted for', async () => {
      setupSupabase({
        questions: [sampleQuestions[0]],
        profiles: sampleProfiles,
        quiz_answers: [],
        question_votes: [{ question_id: 'q-1', vote_type: 'up', user_id: 'student-1' }],
      });

      render(<CommunityQuestions {...defaultProps} />);

      await selectAndAnswer('q-1');

      const upButton = await screen.findByTestId('community-vote-up-q-1');
      const downButton = await screen.findByTestId('community-vote-down-q-1');
      await waitFor(() => {
        expect(upButton.getAttribute('aria-pressed')).toBe('true');
      });
      expect(downButton.getAttribute('aria-pressed')).toBe('false');
      // Count reflects single upvote
      expect(upButton.textContent).toContain('1');
    });

    it('inserts a vote via upsert when clicking thumbs-up with no prior vote', async () => {
      const upsert = vi.fn();
      setupSupabase(
        {
          questions: [sampleQuestions[0]],
          profiles: sampleProfiles,
          quiz_answers: [],
          question_votes: [],
        },
        { question_votes: { upsert } },
      );

      render(<CommunityQuestions {...defaultProps} />);
      await selectAndAnswer('q-1');

      const upButton = await screen.findByTestId('community-vote-up-q-1');
      await userEvent.click(upButton);

      await waitFor(() => {
        expect(upsert).toHaveBeenCalledTimes(1);
      });
      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: 'student-1',
          question_id: 'q-1',
          vote_type: 'up',
        }),
        expect.objectContaining({ onConflict: 'user_id,question_id' }),
      );
      await waitFor(() => {
        expect(upButton.textContent).toContain('1');
        expect(upButton.getAttribute('aria-pressed')).toBe('true');
      });
    });

    it('removes the vote via delete when clicking the same vote again', async () => {
      const del = vi.fn();
      setupSupabase(
        {
          questions: [sampleQuestions[0]],
          profiles: sampleProfiles,
          quiz_answers: [],
          question_votes: [{ question_id: 'q-1', vote_type: 'up', user_id: 'student-1' }],
        },
        { question_votes: { delete: del } },
      );

      render(<CommunityQuestions {...defaultProps} />);
      await selectAndAnswer('q-1');

      const upButton = await screen.findByTestId('community-vote-up-q-1');
      await waitFor(() => {
        expect(upButton.getAttribute('aria-pressed')).toBe('true');
      });

      await userEvent.click(upButton);

      await waitFor(() => {
        expect(del).toHaveBeenCalledTimes(1);
      });
      await waitFor(() => {
        expect(upButton.getAttribute('aria-pressed')).toBe('false');
        expect(upButton.textContent).toContain('0');
      });
    });

    it('switches vote from up to down and adjusts counts', async () => {
      const upsert = vi.fn();
      setupSupabase(
        {
          questions: [sampleQuestions[0]],
          profiles: sampleProfiles,
          quiz_answers: [],
          question_votes: [{ question_id: 'q-1', vote_type: 'up', user_id: 'student-1' }],
        },
        { question_votes: { upsert } },
      );

      render(<CommunityQuestions {...defaultProps} />);
      await selectAndAnswer('q-1');

      const upButton = await screen.findByTestId('community-vote-up-q-1');
      const downButton = await screen.findByTestId('community-vote-down-q-1');
      await waitFor(() => {
        expect(upButton.getAttribute('aria-pressed')).toBe('true');
        expect(upButton.textContent).toContain('1');
      });

      await userEvent.click(downButton);

      await waitFor(() => {
        expect(upsert).toHaveBeenCalledWith(
          expect.objectContaining({ vote_type: 'down' }),
          expect.objectContaining({ onConflict: 'user_id,question_id' }),
        );
      });
      await waitFor(() => {
        expect(downButton.getAttribute('aria-pressed')).toBe('true');
        expect(upButton.getAttribute('aria-pressed')).toBe('false');
        expect(upButton.textContent).toContain('0');
        expect(downButton.textContent).toContain('1');
      });
    });
  });
  // #1011 — the community feed stops holding the key.
  //
  // This is a whole course's peer questions in one query, so asking for
  // `answer_key` handed over every answer in the feed before the student
  // opened one. The panel also used to flip to the result view before the
  // grading call was even made, because it already had the key to render.
  describe('the answer key is not fetched with the feed (#1011)', () => {
    const selectAndSubmit = async (questionId: string) => {
      await userEvent.click(
        await screen.findByTestId(`community-question-row-${questionId}`),
      );
      await userEvent.click(await screen.findByText('A'));
      await userEvent.click(
        await screen.findByRole('button', { name: /Submit Answer/i }),
      );
    };

    it('asks for neither the key nor the explanation', async () => {
      const select = vi.fn();
      setupSupabase(
        { questions: sampleQuestions, profiles: sampleProfiles, quiz_answers: [] },
        { questions: { select } },
      );

      render(<CommunityQuestions {...defaultProps} />);
      await screen.findByTestId('community-question-row-q-1');

      expect(select).toHaveBeenCalled();
      for (const call of select.mock.calls) {
        const cols = String(call[0]);
        expect(cols).not.toContain('answer_key');
        expect(cols).not.toContain('explanation');
      }
    });

    it('shows the explanation only because the server sent it back', async () => {
      setupSupabase({
        questions: sampleQuestions,
        profiles: sampleProfiles,
        quiz_answers: [],
      });

      render(<CommunityQuestions {...defaultProps} />);
      await screen.findByTestId('community-question-row-q-1');

      // Nothing about the answer is on the page before submitting — and, since
      // the fetch never carried it, nothing about it is in the page's data.
      expect(
        screen.queryByText('Power rule: d/dx(x^n) = n*x^(n-1)'),
      ).not.toBeInTheDocument();

      await selectAndSubmit('q-1');

      expect(
        await screen.findByText('Power rule: d/dx(x^n) = n*x^(n-1)'),
      ).toBeInTheDocument();
    });

    it('reveals nothing when the server returns no reveal', async () => {
      serverReveal = null;
      setupSupabase({
        questions: sampleQuestions,
        profiles: sampleProfiles,
        quiz_answers: [],
      });

      render(<CommunityQuestions {...defaultProps} />);
      await screen.findByTestId('community-question-row-q-1');
      await selectAndSubmit('q-1');

      // The answer was still recorded — the vote bar is the result view — but
      // the panel has no key of its own to fall back on.
      await screen.findByTestId('community-vote-up-q-1');
      expect(
        screen.queryByText('Power rule: d/dx(x^n) = n*x^(n-1)'),
      ).not.toBeInTheDocument();
    });

    it('does not reveal against an attempt the student has already restarted', async () => {
      // Submit q-1, open q-2, then reopen q-1 — all before grading returns.
      // Reopening clears the selected answers, so revealing now would show the
      // correct option and the explanation with nothing of the student's to
      // mark against them. An id-only guard would let this through, because
      // the question on screen IS q-1 again.
      let releaseGrading: () => void = () => {};
      gradingGate = new Promise<void>((resolve) => {
        releaseGrading = resolve;
      });

      setupSupabase({
        questions: sampleQuestions,
        profiles: sampleProfiles,
        quiz_answers: [],
      });

      render(<CommunityQuestions {...defaultProps} />);
      await screen.findByTestId('community-question-row-q-1');
      await selectAndSubmit('q-1');

      await userEvent.click(
        await screen.findByTestId('community-question-row-q-2'),
      );
      await userEvent.click(
        await screen.findByTestId('community-question-row-q-1'),
      );

      releaseGrading();

      // Still answerable, and no result view: the attempt was abandoned.
      expect(
        await screen.findByRole('button', { name: /Submit Answer/i }),
      ).toBeInTheDocument();
      await waitFor(() =>
        expect(
          screen.queryByText('Power rule: d/dx(x^n) = n*x^(n-1)'),
        ).not.toBeInTheDocument(),
      );
    });

    it('takes the multi-answer hint from the payload, not the key', async () => {
      // `payload.multi_correct` exists precisely so a renderer can say "Select
      // all that apply." without holding the answer.
      setupSupabase({
        questions: [
          {
            ...sampleQuestions[0],
            payload: { options: ['x', '2x', 'x^3', '2'], multi_correct: true },
          },
        ],
        profiles: sampleProfiles,
        quiz_answers: [],
      });

      render(<CommunityQuestions {...defaultProps} />);
      await userEvent.click(
        await screen.findByTestId('community-question-row-q-1'),
      );

      expect(
        await screen.findByText(/Select all that apply\./),
      ).toBeInTheDocument();
    });
  });
});

describe('CommunityQuestions — locale', () => {
  const defaultProps = {
    courseId: 'course-1',
    offeringId: null as string | null,
    classId: 'class-1',
    showDifficulty: true,
    studentQuestionsEnabled: true,
    onOpenGenerator: vi.fn(),
  };

  const questions: Row[] = [
    {
      id: 'q-1',
      question: 'What is the derivative of x^2?',
      payload: { options: ['x', '2x'] },
      answer_key: { correct_indices: [1], correct_index: 1 },
      explanation: 'Power rule.',
      difficulty: 'easy',
      created_by: 'user-a',
      created_at: '2026-04-01',
    },
  ];
  const profiles: Row[] = [
    { user_id: 'user-a', full_name: 'Alice', email: 'alice@test.local' },
  ];

  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('translates the table chrome and filters', async () => {
    setupSupabase({ questions, profiles, quiz_answers: [] });
    await i18n.changeLanguage('el');

    render(<CommunityQuestions {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Ερώτηση')).toBeInTheDocument();
    });
    expect(screen.getByText('Δυσκολία')).toBeInTheDocument();
    expect(screen.getByText('Ψήφοι')).toBeInTheDocument();
    expect(screen.getByText('Κατάσταση')).toBeInTheDocument();
    expect(screen.getByText('Φτιάξε τη δική σου')).toBeInTheDocument();
    expect(screen.queryByText('Question')).not.toBeInTheDocument();
  });

  it('translates the empty state', async () => {
    setupSupabase({ questions: [], profiles: [], quiz_answers: [] });
    await i18n.changeLanguage('el');

    render(<CommunityQuestions {...defaultProps} />);

    await waitFor(() => {
      expect(
        screen.getByText(
          'Δεν υπάρχουν ερωτήσεις κοινότητας ακόμα. Γίνε ο πρώτος που θα φτιάξει μία.',
        ),
      ).toBeInTheDocument();
    });
  });

  it('re-resolves the anonymous author when the language changes mid-session', async () => {
    // No profile row, so the byline falls back to the anonymous label.
    setupSupabase({ questions, profiles: [], quiz_answers: [] });
    await i18n.changeLanguage('en');

    render(<CommunityQuestions {...defaultProps} />);

    const row = await screen.findByTestId('community-question-row-q-1');
    await userEvent.click(row);
    await waitFor(() => {
      expect(screen.getByText('by Anonymous')).toBeInTheDocument();
    });

    // The page stays mounted; only the language changes. A fallback baked into
    // state at fetch time would still read "Anonymous" here.
    await act(async () => {
      await i18n.changeLanguage('el');
    });

    await waitFor(() => {
      expect(screen.getByText('από Ανώνυμος')).toBeInTheDocument();
    });
    expect(screen.queryByText(/Anonymous/)).not.toBeInTheDocument();
  });

  it('translates the detail pane once a row is selected', async () => {
    setupSupabase({ questions, profiles, quiz_answers: [] });
    await i18n.changeLanguage('el');

    render(<CommunityQuestions {...defaultProps} />);

    const row = await screen.findByTestId('community-question-row-q-1');
    await userEvent.click(row);

    await waitFor(() => {
      expect(screen.getByText('από Alice')).toBeInTheDocument();
    });
    expect(screen.getByText('Κοινότητα')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Υποβολή απάντησης' }),
    ).toBeInTheDocument();
  });
});
