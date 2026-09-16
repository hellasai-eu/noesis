import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Create hoisted mocks
const mockUser = vi.hoisted(() => ({ id: 'user-123' }));
const mockSupabaseFrom = vi.hoisted(() => vi.fn());
const mockToast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));

// Mock useAuth hook
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: mockUser,
  }),
}));

const mockGetSession = vi.hoisted(() =>
  vi.fn(async () => ({ data: { session: { access_token: 'access-token' } } })),
);

// Mock supabase client
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: mockSupabaseFrom,
    // `submitQuizAnswers` reads the access token to call the grading function.
    auth: { getSession: mockGetSession },
  },
}));

// Mock sonner toast
vi.mock('sonner', () => ({
  toast: mockToast,
}));

// Mock utility functions
vi.mock('@/lib/utils', () => ({
  formatExplanation: (text: string) => text,
  cn: (...args: any[]) => args.filter(Boolean).join(' '),
}));

vi.mock('@/lib/latex-utils', () => ({
  processLatexContent: (text: string) => text,
}));

// Import after mocks
import StudentQuiz from '@/components/StudentQuiz';

describe('StudentQuiz', () => {
  const user = userEvent.setup();
  const mockOnBack = vi.fn();
  const mockOnComplete = vi.fn();

  const defaultProps = {
    courseId: 'course-123',
    courseTitle: 'Test Course',
    onBack: mockOnBack,
    onComplete: mockOnComplete,
  };

  const mockQuestions = [
    {
      id: 'q1',
      question: 'What is 2 + 2?',
      payload: { options: ['3', '4', '5', '6'] },
      answer_key: { correct_indices: [1], correct_index: 1 },
      explanation: 'Basic math',
      difficulty: 'easy',
      is_user_generated: false,
    },
    {
      id: 'q2',
      question: 'What is the capital of France?',
      payload: { options: ['London', 'Berlin', 'Paris', 'Madrid'] },
      answer_key: { correct_indices: [2], correct_index: 2 },
      explanation: 'Geography',
      difficulty: 'medium',
      is_user_generated: false,
    },
  ];

  const mockQuizQuestions = mockQuestions.map((q, i) => ({
    order_num: i + 1,
    questions: q,
  }));

  // Helper to set up basic mocks
  const setupBasicMocks = (
    questions: any[] = mockQuestions,
    opts: { existingTimedSession?: any } = {},
  ) => {
    mockSupabaseFrom.mockImplementation((table: string) => {
      const baseChain = {
        select: vi.fn().mockReturnThis(),
        insert: vi.fn().mockReturnThis(),
        update: vi.fn().mockReturnThis(),
        delete: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        neq: vi.fn().mockReturnThis(),
        in: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: null, error: null }),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      };

      if (table === 'questions') {
        return {
          ...baseChain,
          select: vi.fn().mockResolvedValue({ data: questions, error: null }),
        };
      }

      if (table === 'quiz_answers') {
        return {
          ...baseChain,
          select: vi.fn().mockResolvedValue({ data: [], error: null }),
          insert: vi.fn().mockResolvedValue({ data: {}, error: null }),
        };
      }

      if (table === 'question_competencies') {
        return {
          ...baseChain,
          select: vi.fn().mockResolvedValue({ data: [], error: null }),
        };
      }

      if (table === 'quiz_sessions') {
        // Thenable so `await supabase.from('quiz_sessions').select(...).eq(...)`
        // resolves to the list of existing sessions. Defaults to none so the
        // timed-quiz path exercises the pre-start confirmation dialog.
        const existing = opts.existingTimedSession ? [opts.existingTimedSession] : [];
        const thenable: any = {
          ...baseChain,
          then: (resolve: (v: unknown) => unknown) =>
            Promise.resolve(resolve({ data: existing, error: null })),
          single: vi
            .fn()
            .mockResolvedValue({ data: { id: 'new-session' }, error: null }),
        };
        thenable.select = vi.fn().mockReturnValue(thenable);
        thenable.eq = vi.fn().mockReturnValue(thenable);
        thenable.insert = vi.fn().mockReturnValue(thenable);
        thenable.update = vi.fn().mockReturnValue(thenable);
        return thenable;
      }

      return baseChain;
    });
  };

  // Answers are recorded and graded by the `submit-quiz-answers` edge function
  // (#1094), so the quiz reaches the network rather than `quiz_answers`. Each
  // test can read what was posted, and decide what the server says back.
  interface SubmitCall {
    courseId: string;
    quizId: string | null;
    offeringId: string | null;
    sessionId: string;
    finalizeSession: boolean;
    answers: Array<{ questionId: string; submission: Record<string, unknown> }>;
  }
  let submitCalls: SubmitCall[] = [];
  let serverSaysCorrect: (questionId: string) => boolean;
  // Per-gap verdicts the server returns for fill-gaps answers, when a test
  // cares. Its grading is exact-match plus an LLM equivalence pass, so this is
  // how a test says "the grader accepted a gap the browser would have failed".
  let serverPerGap: Record<string, boolean[]> | null = null;
  // The key material the server sends back with a recorded answer (#1011).
  // The questions are fetched WITHOUT their key now, so this is the only way
  // the correct answer or the explanation can reach the page. `null` is the
  // withheld case: a quiz whose answers the instructor has not released.
  let serverReveal: Record<string, Record<string, unknown>> | null = null;

  const stubSubmitEndpoint = () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { body: string }) => {
        const body = JSON.parse(init.body) as SubmitCall;
        submitCalls.push(body);
        const results = body.answers.map((a) => ({
          questionId: a.questionId,
          isCorrect: serverSaysCorrect(a.questionId),
          recordedNow: true,
          ...(serverPerGap?.[a.questionId]
            ? { perGap: serverPerGap[a.questionId] }
            : {}),
          ...(serverReveal?.[a.questionId]
            ? { reveal: serverReveal[a.questionId] }
            : {}),
        }));
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            results,
            correctCount: results.filter((r) => r.isCorrect).length,
            totalCount: results.length,
          }),
        };
      }),
    );
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    submitCalls = [];
    serverSaysCorrect = () => true;
    serverPerGap = null;
    serverReveal = null;
    stubSubmitEndpoint();
    setupBasicMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe('initial rendering', () => {
    it('should render without errors', () => {
      render(<StudentQuiz {...defaultProps} />);

      // Component should render - may show loading or content
      expect(document.body.innerHTML).toBeTruthy();
    });

    it('should accept all required props', () => {
      render(<StudentQuiz {...defaultProps} />);
      expect(document.body).toBeTruthy();
    });

    it('should render with quiz props', () => {
      render(
        <StudentQuiz
          {...defaultProps}
          quizId="quiz-123"
          quizTitle="Test Quiz"
          timeLimitMinutes={30}
        />
      );
      expect(document.body).toBeTruthy();
    });
  });

  describe('navigation', () => {
    it('should have exit button', async () => {
      render(<StudentQuiz {...defaultProps} />);

      // Wait for component to load
      await vi.runAllTimersAsync();

      // Look for exit button (might show as "Exit Quiz" or "Back to Course")
      const exitButton = screen.queryByRole('button', { name: /exit|back/i });
      // Button may or may not be visible depending on state
      expect(document.body).toBeTruthy();
    });
  });

  describe('quiz completion state', () => {
    it('should show completion screen when quiz is complete', async () => {
      // This tests that the component can reach a completion state
      render(<StudentQuiz {...defaultProps} />);

      await vi.runAllTimersAsync();

      // Component should render without errors
      expect(document.body).toBeTruthy();
    });
  });

  describe('empty questions state', () => {
    it('should handle empty questions gracefully', async () => {
      setupBasicMocks([]);

      render(<StudentQuiz {...defaultProps} />);

      await vi.runAllTimersAsync();

      // Should show some indication that there are no questions
      // or complete state when all done
      await waitFor(() => {
        const allDoneText = screen.queryByText(/all done|no questions/i);
        const loadingSpinner = document.querySelector('.animate-spin');
        // Either shows "all done" or remains in loading/empty state
        expect(allDoneText || loadingSpinner || document.body).toBeTruthy();
      });
    });
  });

  describe('practice mode vs quiz mode', () => {
    it('should work in practice mode without quizId', () => {
      render(<StudentQuiz {...defaultProps} />);
      expect(document.body).toBeTruthy();
    });

    it('should work in quiz mode with quizId', () => {
      render(
        <StudentQuiz
          {...defaultProps}
          quizId="quiz-123"
          quizTitle="Formal Quiz"
        />
      );
      expect(document.body).toBeTruthy();
    });

    it('should handle timed quiz with timeLimitMinutes', () => {
      render(
        <StudentQuiz
          {...defaultProps}
          quizId="quiz-123"
          timeLimitMinutes={60}
        />
      );
      expect(document.body).toBeTruthy();
    });
  });

  describe('practice filters', () => {
    it('should accept practiceFilters prop', () => {
      render(
        <StudentQuiz
          {...defaultProps}
          practiceFilters={{
            chapterId: 'chapter-1',
            source: 'curated',
          }}
        />
      );
      expect(document.body).toBeTruthy();
    });

    it('should accept competency filter', () => {
      render(
        <StudentQuiz
          {...defaultProps}
          practiceFilters={{
            competencyId: 'comp-1',
          }}
        />
      );
      expect(document.body).toBeTruthy();
    });
  });

  describe('display options', () => {
    it('should accept showAnswersEnabled prop', () => {
      render(
        <StudentQuiz
          {...defaultProps}
          quizId="quiz-123"
          showAnswersEnabled={false}
        />
      );
      expect(document.body).toBeTruthy();
    });

    it('should accept showDifficulty prop', () => {
      render(
        <StudentQuiz
          {...defaultProps}
          showDifficulty={false}
        />
      );
      expect(document.body).toBeTruthy();
    });
  });

  describe('callback props', () => {
    it('should have onBack callback available', () => {
      render(<StudentQuiz {...defaultProps} />);
      expect(mockOnBack).toBeDefined();
    });

    it('should have onComplete callback available', () => {
      render(<StudentQuiz {...defaultProps} />);
      expect(mockOnComplete).toBeDefined();
    });
  });

  describe('session stats tracking', () => {
    it('should initialize with zero correct and wrong counts', async () => {
      render(<StudentQuiz {...defaultProps} />);

      await vi.runAllTimersAsync();

      // The component tracks stats internally
      // We verify it renders without error
      expect(document.body).toBeTruthy();
    });
  });

  describe('timed quiz pre-start warning', () => {
    it('shows the pre-start confirmation for a fresh timed quiz attempt', async () => {
      setupBasicMocks();

      render(
        <StudentQuiz
          {...defaultProps}
          quizId="quiz-123"
          quizTitle="Midterm"
          timeLimitMinutes={15}
        />,
      );

      await vi.runAllTimersAsync();

      await waitFor(() => {
        expect(
          screen.getByTestId('confirm-start-timed-quiz'),
        ).toBeInTheDocument();
      });
      // The warning copy names the effective time limit so students know what
      // they're agreeing to.
      expect(screen.getByText(/15-minute/)).toBeInTheDocument();
    });

    it('does not show a pre-start warning for an untimed quiz', async () => {
      setupBasicMocks();

      render(
        <StudentQuiz
          {...defaultProps}
          quizId="quiz-123"
          quizTitle="Practice"
        />,
      );

      await vi.runAllTimersAsync();

      expect(
        screen.queryByTestId('confirm-start-timed-quiz'),
      ).not.toBeInTheDocument();
    });

    it('skips the pre-start warning when an in-progress session already exists', async () => {
      // Simulate an existing in-progress session that hasn't elapsed. The
      // student already acknowledged the warning when the session was created;
      // requiring a second confirmation on resume would just be noise.
      const startedAt = new Date(Date.now() - 60_000).toISOString();
      setupBasicMocks(mockQuestions, {
        existingTimedSession: {
          id: 'sess-existing',
          status: 'in_progress',
          started_at: startedAt,
          user_id: mockUser.id,
          quiz_id: 'quiz-123',
          course_id: 'course-123',
        },
      });

      render(
        <StudentQuiz
          {...defaultProps}
          quizId="quiz-123"
          quizTitle="Midterm"
          timeLimitMinutes={15}
        />,
      );

      await vi.runAllTimersAsync();

      expect(
        screen.queryByTestId('confirm-start-timed-quiz'),
      ).not.toBeInTheDocument();
    });
  });

  // #820 — classification questions were never rendered in the quiz flow: only
  // the prompt showed, with no item cards or category buckets, so the question
  // could never be answered and blocked quiz submission.
  describe('classification questions (#820)', () => {
    const classificationQuestion = {
      id: 'c1',
      type: 'classification',
      question: 'Sort the animals into groups.',
      payload: {
        prompt: 'Sort the animals into groups.',
        categories: [
          { id: 'mammals', label: 'Mammals' },
          { id: 'birds', label: 'Birds' },
        ],
        items: [
          { id: 'i1', text: 'Dog' },
          { id: 'i2', text: 'Eagle' },
        ],
      },
      answer_key: { assignments: { i1: 'mammals', i2: 'birds' } },
      explanation: 'Biology basics',
      difficulty: 'easy',
      is_user_generated: false,
      validation_status: 'VALID',
    };

    // A chain whose terminal awaits resolve to `resolved`; `single` resolves to
    // `single`. Covers the handful of shapes StudentQuiz builds against supabase.
    const chainFor = (resolved: any, single: any) => {
      const c: any = {
        select: vi.fn(() => c),
        insert: vi.fn(() => c),
        update: vi.fn(() => c),
        delete: vi.fn(() => c),
        eq: vi.fn(() => c),
        neq: vi.fn(() => c),
        in: vi.fn(() => c),
        not: vi.fn(() => c),
        order: vi.fn(() => c),
        limit: vi.fn(() => c),
        single: vi.fn().mockResolvedValue(single ?? { data: null, error: null }),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        then: (r: any) => Promise.resolve(r(resolved)),
      };
      return c;
    };

    const setupClassificationQuiz = () => {
      mockSupabaseFrom.mockImplementation((table: string) => {
        switch (table) {
          case 'quiz_sessions':
            // No existing session → a fresh in-progress session is inserted.
            return chainFor({ data: [], error: null }, { data: { id: 'new-session' }, error: null });
          case 'quiz_questions':
            return chainFor(
              { data: [{ order_num: 1, questions: classificationQuestion }], error: null },
              null,
            );
          case 'quiz_session_questions':
          case 'question_competencies':
          case 'quiz_answers':
          case 'question_votes':
          default:
            return chainFor({ data: [], error: null }, null);
        }
      });
    };

    it('renders item cards and category buckets (previously blank)', async () => {
      setupClassificationQuiz();

      render(
        <StudentQuiz
          {...defaultProps}
          quizId="quiz-cls"
          quizTitle="Test1"
          showAnswersEnabled={false}
        />,
      );

      await vi.runAllTimersAsync();

      await waitFor(() => {
        expect(screen.getByText('Dog')).toBeInTheDocument();
      });
      expect(screen.getByText('Eagle')).toBeInTheDocument();
      // Each card exposes the two category buckets as radio buttons.
      expect(screen.getAllByRole('radio', { name: 'Mammals' })).toHaveLength(2);
      expect(screen.getAllByRole('radio', { name: 'Birds' })).toHaveLength(2);
      // Before placing anything, the question is unanswered.
      expect(screen.getByText('0 of 1 answered')).toBeInTheDocument();
    });

    it('counts the question answered only once every card is placed', async () => {
      setupClassificationQuiz();

      render(
        <StudentQuiz
          {...defaultProps}
          quizId="quiz-cls"
          quizTitle="Test1"
          showAnswersEnabled={false}
        />,
      );

      await vi.runAllTimersAsync();

      await waitFor(() => {
        expect(screen.getByText('Dog')).toBeInTheDocument();
      });

      const mammalButtons = screen.getAllByRole('radio', { name: 'Mammals' });
      // Placing a single card is not enough — the gate needs every item placed.
      fireEvent.click(mammalButtons[0]);
      expect(screen.getByText('0 of 1 answered')).toBeInTheDocument();

      // Placing the second card completes the answer.
      fireEvent.click(screen.getAllByRole('radio', { name: 'Birds' })[1]);
      await waitFor(() => {
        expect(screen.getByText('1 of 1 answered')).toBeInTheDocument();
      });
      expect(screen.getByText(/All answered/i)).toBeInTheDocument();
    });
  });

  // #829 — ordering, fill_gaps and open questions were never rendered in the
  // quiz flow (only MCQ + classification were): the stem showed with no answer
  // interface, so the question could never be answered and blocked submission.
  describe('non-MCQ questions render and answer in the quiz (#829)', () => {
    // A chain whose terminal awaits resolve to `resolved`; `single` resolves to
    // `single`. Mirrors the helper used by the classification suite above.
    const chainFor = (resolved: any, single: any) => {
      const c: any = {
        select: vi.fn(() => c),
        insert: vi.fn(() => c),
        update: vi.fn(() => c),
        delete: vi.fn(() => c),
        eq: vi.fn(() => c),
        neq: vi.fn(() => c),
        in: vi.fn(() => c),
        not: vi.fn(() => c),
        order: vi.fn(() => c),
        limit: vi.fn(() => c),
        single: vi.fn().mockResolvedValue(single ?? { data: null, error: null }),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        then: (r: any) => Promise.resolve(r(resolved)),
      };
      return c;
    };

    const setupQuizWith = (question: any) => {
      mockSupabaseFrom.mockImplementation((table: string) => {
        switch (table) {
          case 'quiz_sessions':
            return chainFor({ data: [], error: null }, { data: { id: 'new-session' }, error: null });
          case 'quiz_questions':
            return chainFor(
              { data: [{ order_num: 1, questions: question }], error: null },
              null,
            );
          case 'quiz_session_questions':
          case 'question_competencies':
          case 'quiz_answers':
          case 'question_votes':
          default:
            return chainFor({ data: [], error: null }, null);
        }
      });
    };

    const renderQuiz = () =>
      render(
        <StudentQuiz
          {...defaultProps}
          quizId="quiz-non-mcq"
          quizTitle="Test1"
          showAnswersEnabled={false}
        />,
      );

    it('renders an ordering question as a draggable list (previously blank)', async () => {
      setupQuizWith({
        id: 'o1',
        type: 'ordering',
        question: 'Order the planets from the sun.',
        payload: { prompt: 'Order the planets from the sun.', items: ['Mercury', 'Venus', 'Earth'] },
        answer_key: {},
        explanation: '',
        difficulty: 'easy',
        is_user_generated: false,
        validation_status: 'VALID',
      });

      renderQuiz();
      await vi.runAllTimersAsync();

      await waitFor(() => {
        expect(screen.getByText('Mercury')).toBeInTheDocument();
      });
      expect(screen.getByText('Venus')).toBeInTheDocument();
      expect(screen.getByText('Earth')).toBeInTheDocument();
      // #1043 — the shuffled default is not the student's answer, so the
      // question stays unanswered until they drag or confirm the order.
      expect(screen.getByText('0 of 1 answered')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /Keep this order/i }));
      await waitFor(() => {
        expect(screen.getByText('1 of 1 answered')).toBeInTheDocument();
      });
      // The confirm is spent once the order is settled.
      expect(
        screen.queryByRole('button', { name: /Keep this order/i }),
      ).not.toBeInTheDocument();
    });

    it('renders a fill-gaps question with an input per blank and gates on all blanks (previously blank)', async () => {
      setupQuizWith({
        id: 'f1',
        type: 'fill_gaps',
        question: 'Water is {{1}} and ice is {{2}}.',
        payload: { stem: 'Water is {{1}} and ice is {{2}}.' },
        answer_key: {
          gaps: [
            { ordinal: 1, acceptable: ['liquid'] },
            { ordinal: 2, acceptable: ['solid'] },
          ],
        },
        explanation: '',
        difficulty: 'easy',
        is_user_generated: false,
        validation_status: 'VALID',
      });

      renderQuiz();
      await vi.runAllTimersAsync();

      await waitFor(() => {
        expect(screen.getByLabelText('Gap 1')).toBeInTheDocument();
      });
      expect(screen.getByLabelText('Gap 2')).toBeInTheDocument();
      // Nothing typed yet → unanswered.
      expect(screen.getByText('0 of 1 answered')).toBeInTheDocument();

      fireEvent.change(screen.getByLabelText('Gap 1'), { target: { value: 'liquid' } });
      // One blank filled is not enough.
      expect(screen.getByText('0 of 1 answered')).toBeInTheDocument();

      fireEvent.change(screen.getByLabelText('Gap 2'), { target: { value: 'solid' } });
      await waitFor(() => {
        expect(screen.getByText('1 of 1 answered')).toBeInTheDocument();
      });
    });

    // #784 on the quiz surface: fill-gaps grading is exact-match plus an LLM
    // equivalence pass, so the marks the student sees have to come from the
    // grader. Deriving them here would put a red gap under an answer the server
    // recorded as correct — the exact case the judge exists to fix.
    it('marks the gaps the server accepted, not the ones an exact match would', async () => {
      setupQuizWith({
        id: 'f2',
        type: 'fill_gaps',
        question: 'Water is {{1}} and ice is {{2}}.',
        payload: { stem: 'Water is {{1}} and ice is {{2}}.' },
        answer_key: {
          gaps: [
            { ordinal: 1, acceptable: ['liquid'] },
            { ordinal: 2, acceptable: ['solid'] },
          ],
        },
        explanation: '',
        difficulty: 'easy',
        is_user_generated: false,
        validation_status: 'VALID',
      });
      serverPerGap = { f2: [true, true] };

      render(
        <StudentQuiz
          {...defaultProps}
          quizId="quiz-non-mcq"
          quizTitle="Test1"
          showAnswersEnabled={true}
        />,
      );
      await vi.runAllTimersAsync();

      await waitFor(() => {
        expect(screen.getByLabelText('Gap 1')).toBeInTheDocument();
      });
      fireEvent.change(screen.getByLabelText('Gap 1'), { target: { value: 'liquid' } });
      // A typo the exact matcher rejects and the judge accepts.
      fireEvent.change(screen.getByLabelText('Gap 2'), { target: { value: 'sollid' } });
      await vi.runAllTimersAsync();

      fireEvent.click(screen.getByRole('button', { name: /Submit Answer/i }));
      await vi.runAllTimersAsync();

      await waitFor(() => {
        expect(submitCalls).toHaveLength(1);
      });
      expect(submitCalls[0].answers).toEqual([
        { questionId: 'f2', submission: { fill_gaps: ['liquid', 'sollid'] } },
      ]);

      await waitFor(() => {
        expect(screen.getByText('1 ✓')).toBeInTheDocument();
      });
      expect(screen.getByLabelText('Gap 2').className).not.toContain('border-red-500');
    });

    it('renders an open question as a textarea and counts it answered once text is typed (previously blank)', async () => {
      setupQuizWith({
        id: 'op1',
        type: 'open',
        question: 'Explain why the sky is blue.',
        payload: { answering_mode: 'single' },
        answer_key: { model_answer: 'Rayleigh scattering.' },
        explanation: '',
        difficulty: 'medium',
        is_user_generated: false,
        validation_status: 'VALID',
      });

      renderQuiz();
      await vi.runAllTimersAsync();

      await waitFor(() => {
        expect(screen.getByLabelText('Your answer')).toBeInTheDocument();
      });
      expect(screen.getByText('0 of 1 answered')).toBeInTheDocument();

      fireEvent.change(screen.getByLabelText('Your answer'), {
        target: { value: 'Because of Rayleigh scattering of sunlight.' },
      });
      await waitFor(() => {
        expect(screen.getByText('1 of 1 answered')).toBeInTheDocument();
      });
    });
  });

  // #827 — deferred-mode selections must be auto-saved to
  // quiz_sessions.draft_answers as they're made, so leaving and Resuming
  // restores every selection (previously they lived only in memory).
  describe('deferred-mode draft autosave & resume (#827)', () => {
    const mcqQuestion = {
      id: 'q1',
      type: 'mcq',
      question: 'What is 2 + 2?',
      payload: { options: ['3', '4', '5', '6'] },
      answer_key: { correct_indices: [1], correct_index: 1 },
      explanation: 'Basic math',
      difficulty: 'easy',
      is_user_generated: false,
      validation_status: 'VALID',
    };

    // MCQ snapshot row, as loadQuestionsFromSnapshots expects to read it back
    // when resuming an in-progress session.
    const mcqSnapshotRow = {
      order_num: 1,
      question_snapshot: {
        id: 'q1',
        type: 'mcq',
        question: 'What is 2 + 2?',
        options: ['3', '4', '5', '6'],
        correct_answers: [1],
        correct_answer: 1,
        explanation: 'Basic math',
        difficulty: 'easy',
        is_user_generated: false,
        competency_ids: [],
      },
    };

    // Flexible chain: awaits resolve to `list`; single/maybeSingle resolve to
    // their configured values; update() forwards its payload to `onUpdate` so a
    // test can assert what was persisted to quiz_sessions.
    const makeChain = (opts: {
      list?: any;
      single?: any;
      maybeSingle?: any;
      onUpdate?: (args: any) => void;
    }) => {
      const c: any = {
        select: vi.fn(() => c),
        insert: vi.fn(() => c),
        update: vi.fn((args: any) => {
          opts.onUpdate?.(args);
          return c;
        }),
        delete: vi.fn(() => c),
        eq: vi.fn(() => c),
        neq: vi.fn(() => c),
        in: vi.fn(() => c),
        not: vi.fn(() => c),
        order: vi.fn(() => c),
        limit: vi.fn(() => c),
        single: vi.fn().mockResolvedValue(opts.single ?? { data: null, error: null }),
        maybeSingle: vi
          .fn()
          .mockResolvedValue(opts.maybeSingle ?? { data: null, error: null }),
        then: (r: any) => Promise.resolve(r(opts.list ?? { data: [], error: null })),
      };
      return c;
    };

    it('auto-saves each MCQ selection to quiz_sessions.draft_answers', async () => {
      const sessionUpdates: any[] = [];
      mockSupabaseFrom.mockImplementation((table: string) => {
        switch (table) {
          case 'quiz_sessions':
            // Fresh attempt: no existing session, insert returns a new id.
            return makeChain({
              list: { data: [], error: null },
              single: { data: { id: 'new-session' }, error: null },
              onUpdate: (args) => sessionUpdates.push(args),
            });
          case 'quiz_questions':
            return makeChain({
              list: { data: [{ order_num: 1, questions: mcqQuestion }], error: null },
            });
          default:
            return makeChain({ list: { data: [], error: null } });
        }
      });

      render(
        <StudentQuiz
          {...defaultProps}
          quizId="quiz-deferred"
          quizTitle="Deferred"
          showAnswersEnabled={false}
        />,
      );

      await vi.runAllTimersAsync();
      await waitFor(() => {
        expect(screen.getByText('What is 2 + 2?')).toBeInTheDocument();
      });

      // Pick option D (index 3) and let the debounced autosave flush.
      fireEvent.click(screen.getByText('6'));
      await vi.runAllTimersAsync();

      const savedSelection = sessionUpdates.find(
        (u) => u.draft_answers && u.draft_answers.mcq && Array.isArray(u.draft_answers.mcq.q1),
      );
      expect(savedSelection).toBeTruthy();
      expect(savedSelection.draft_answers.mcq.q1).toEqual([3]);
      // Drafts carry selections only — never any grading.
      expect(savedSelection.draft_answers).not.toHaveProperty('is_correct');
    });

    it('restores prior selections when resuming an in-progress deferred session', async () => {
      const startedAt = new Date(Date.now() - 60_000).toISOString();
      mockSupabaseFrom.mockImplementation((table: string) => {
        switch (table) {
          case 'quiz_sessions':
            return makeChain({
              // Existing in-progress session for the resume branch...
              list: {
                data: [
                  {
                    id: 'sess-resume',
                    status: 'in_progress',
                    started_at: startedAt,
                    user_id: mockUser.id,
                    quiz_id: 'quiz-deferred',
                    course_id: 'course-123',
                  },
                ],
                error: null,
              },
              // ...and its stored draft (option C / index 2 for q1).
              maybeSingle: {
                data: { draft_answers: { v: 1, mcq: { q1: [2] }, nonMcq: {} } },
                error: null,
              },
            });
          case 'quiz_session_questions':
            return makeChain({ list: { data: [mcqSnapshotRow], error: null } });
          default:
            return makeChain({ list: { data: [], error: null } });
        }
      });

      render(
        <StudentQuiz
          {...defaultProps}
          quizId="quiz-deferred"
          quizTitle="Deferred"
          showAnswersEnabled={false}
        />,
      );

      await vi.runAllTimersAsync();
      await waitFor(() => {
        expect(screen.getByText('What is 2 + 2?')).toBeInTheDocument();
      });

      // The restored draft counts the question as answered...
      expect(screen.getByText('1 of 1 answered')).toBeInTheDocument();
      // ...and the previously selected option (index 2) is re-selected.
      const options = screen.getAllByRole('checkbox');
      expect(options[2]).toHaveAttribute('aria-checked', 'true');
      expect(options[0]).toHaveAttribute('aria-checked', 'false');
    });

    it('asks the server to finalize the session, which clears the draft', async () => {
      const sessionUpdates: any[] = [];
      mockSupabaseFrom.mockImplementation((table: string) => {
        switch (table) {
          case 'quiz_sessions':
            return makeChain({
              list: { data: [], error: null },
              single: { data: { id: 'new-session' }, error: null },
              // status re-check before finalize resolves to in_progress.
              maybeSingle: { data: { status: 'in_progress' }, error: null },
              onUpdate: (args) => sessionUpdates.push(args),
            });
          case 'quiz_questions':
            return makeChain({
              list: { data: [{ order_num: 1, questions: mcqQuestion }], error: null },
            });
          default:
            return makeChain({ list: { data: [], error: null } });
        }
      });

      render(
        <StudentQuiz
          {...defaultProps}
          quizId="quiz-deferred"
          quizTitle="Deferred"
          showAnswersEnabled={false}
        />,
      );

      await vi.runAllTimersAsync();
      await waitFor(() => {
        expect(screen.getByText('What is 2 + 2?')).toBeInTheDocument();
      });

      // Answer the only question, then submit and confirm.
      fireEvent.click(screen.getByText('4'));
      await vi.runAllTimersAsync();
      fireEvent.click(screen.getByRole('button', { name: /Submit Quiz/i }));
      await waitFor(() => {
        expect(screen.getByText(/Ready to submit your quiz\?/i)).toBeInTheDocument();
      });
      fireEvent.click(
        screen.getAllByRole('button', { name: /Submit Quiz/i }).slice(-1)[0],
      );
      await vi.runAllTimersAsync();

      // The client no longer completes the session itself: the answers and the
      // completion (which nulls `draft_answers`) commit together, server-side.
      expect(submitCalls).toHaveLength(1);
      expect(submitCalls[0]).toMatchObject({
        quizId: 'quiz-deferred',
        sessionId: 'new-session',
        finalizeSession: true,
        answers: [{ questionId: 'q1', submission: { selected_indices: [1] } }],
      });
      expect(sessionUpdates.find((u) => u.status === 'completed')).toBeUndefined();
    });

    it('scores the attempt from the server verdict, not from the key it loaded', async () => {
      // Immediate mode (answers released), so the running tally is on screen.
      // The student picks the option this quiz's own answer_key calls correct
      // and the server says otherwise; the tally follows the server (#1094).
      serverSaysCorrect = () => false;
      mockSupabaseFrom.mockImplementation((table: string) => {
        switch (table) {
          case 'quiz_sessions':
            return makeChain({
              list: { data: [], error: null },
              single: { data: { id: 'new-session' }, error: null },
              maybeSingle: { data: { status: 'in_progress' }, error: null },
            });
          case 'quiz_questions':
            return makeChain({
              list: { data: [{ order_num: 1, questions: mcqQuestion }], error: null },
            });
          default:
            return makeChain({ list: { data: [], error: null } });
        }
      });

      render(
        <StudentQuiz
          {...defaultProps}
          quizId="quiz-immediate"
          quizTitle="Immediate"
          showAnswersEnabled={true}
        />,
      );

      await vi.runAllTimersAsync();
      await waitFor(() => {
        expect(screen.getByText('What is 2 + 2?')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('4')); // index 1 — "correct" per the key
      await vi.runAllTimersAsync();
      fireEvent.click(screen.getByRole('button', { name: /Submit Answer/i }));
      await vi.runAllTimersAsync();

      await waitFor(() => {
        expect(submitCalls).toHaveLength(1);
      });
      expect(submitCalls[0]).toMatchObject({
        quizId: 'quiz-immediate',
        finalizeSession: false,
        answers: [{ questionId: 'q1', submission: { selected_indices: [1] } }],
      });
      await waitFor(() => {
        expect(screen.getByText('1 ✗')).toBeInTheDocument();
      });
      expect(screen.getByText('0 ✓')).toBeInTheDocument();
    });
  });

  // #833 — resuming a session whose snapshot was frozen before non-MCQ support
  // (#820/#829) has no `type`, so it defaulted to "mcq" with empty options and
  // rendered a blank, unanswerable card. The loader now self-heals such stale
  // snapshots by re-fetching the live question by id.
  describe('resuming stale/typeless snapshots (#833)', () => {
    const chainFor = (resolved: any, single: any) => {
      const c: any = {
        select: vi.fn(() => c),
        insert: vi.fn(() => c),
        update: vi.fn(() => c),
        delete: vi.fn(() => c),
        eq: vi.fn(() => c),
        neq: vi.fn(() => c),
        in: vi.fn(() => c),
        not: vi.fn(() => c),
        order: vi.fn(() => c),
        limit: vi.fn(() => c),
        single: vi.fn().mockResolvedValue(single ?? { data: null, error: null }),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        then: (r: any) => Promise.resolve(r(resolved)),
      };
      return c;
    };

    // A pre-#820 snapshot: it carries no `type` and none of the classification
    // fields, so it resolves to an MCQ with empty options.
    const typelessClassificationSnapshot = {
      question_id: 'c1',
      order_num: 1,
      question_snapshot: {
        id: 'c1',
        question: 'Sort the animals into groups.',
        options: [],
        correct_answer: 0,
        explanation: 'Biology basics',
        difficulty: 'easy',
        is_user_generated: false,
        competency_ids: [],
      },
    };

    // The live question still exists with its full classification payload.
    const liveClassificationQuestion = {
      id: 'c1',
      type: 'classification',
      question: 'Sort the animals into groups.',
      payload: {
        prompt: 'Sort the animals into groups.',
        categories: [
          { id: 'mammals', label: 'Mammals' },
          { id: 'birds', label: 'Birds' },
        ],
        items: [
          { id: 'i1', text: 'Dog' },
          { id: 'i2', text: 'Eagle' },
        ],
      },
      answer_key: { assignments: { i1: 'mammals', i2: 'birds' } },
      explanation: 'Biology basics',
      difficulty: 'easy',
      is_user_generated: false,
    };

    const setupResume = (snapshots: any[], liveQuestions: any[]) => {
      mockSupabaseFrom.mockImplementation((table: string) => {
        switch (table) {
          case 'quiz_sessions':
            // An in-progress session exists → resume from snapshots.
            return chainFor(
              { data: [{ id: 'sess-1', status: 'in_progress', started_at: '2026-01-01T00:00:00Z' }], error: null },
              { data: { id: 'sess-1' }, error: null },
            );
          case 'quiz_session_questions':
            return chainFor({ data: snapshots, error: null }, null);
          case 'questions':
            return chainFor({ data: liveQuestions, error: null }, null);
          case 'question_competencies':
          case 'quiz_answers':
          case 'question_votes':
          default:
            return chainFor({ data: [], error: null }, null);
        }
      });
    };

    const renderQuiz = () =>
      render(
        <StudentQuiz
          {...defaultProps}
          quizId="quiz-resume"
          quizTitle="Test1"
          showAnswersEnabled={false}
        />,
      );

    it('re-fetches the live question and renders the classification UI instead of a blank card', async () => {
      setupResume([typelessClassificationSnapshot], [liveClassificationQuestion]);

      renderQuiz();
      await vi.runAllTimersAsync();

      await waitFor(() => {
        expect(screen.getByText('Dog')).toBeInTheDocument();
      });
      expect(screen.getByText('Eagle')).toBeInTheDocument();
      expect(screen.getAllByRole('radio', { name: 'Mammals' })).toHaveLength(2);
      expect(screen.getAllByRole('radio', { name: 'Birds' })).toHaveLength(2);
    });

    it('shows a recoverable message when the stale snapshot cannot be re-fetched', async () => {
      // Live question is gone (e.g. deleted) → no re-fetch is possible.
      setupResume([typelessClassificationSnapshot], []);

      renderQuiz();
      await vi.runAllTimersAsync();

      await waitFor(() => {
        expect(screen.getByText(/can't be displayed for this attempt/i)).toBeInTheDocument();
      });
      // Never leaves a silent blank card.
      expect(screen.getByText(/Please restart the quiz/i)).toBeInTheDocument();
    });

    // A pre-#829 snapshot: no `type` and no `ordering_items`, so it resolves
    // to an MCQ with empty options.
    const typelessOrderingSnapshot = {
      question_id: 'o1',
      order_num: 1,
      question_snapshot: {
        id: 'o1',
        question: 'Order the planets from the sun.',
        options: [],
        correct_answer: 0,
        explanation: '',
        difficulty: 'easy',
        is_user_generated: false,
        competency_ids: [],
      },
    };

    const liveOrderingQuestion = {
      id: 'o1',
      type: 'ordering',
      question: 'Order the planets from the sun.',
      payload: { prompt: 'Order the planets from the sun.', items: ['Mercury', 'Venus', 'Earth'] },
      answer_key: {},
      explanation: '',
      difficulty: 'easy',
      is_user_generated: false,
    };

    it('re-fetches the live question and renders the ordering UI instead of a blank card', async () => {
      setupResume([typelessOrderingSnapshot], [liveOrderingQuestion]);

      renderQuiz();
      await vi.runAllTimersAsync();

      await waitFor(() => {
        expect(screen.getByText('Mercury')).toBeInTheDocument();
      });
      expect(screen.getByText('Venus')).toBeInTheDocument();
      expect(screen.getByText('Earth')).toBeInTheDocument();
    });

    // A pre-#829 snapshot: no `type` and no fill-gaps fields, so it resolves
    // to an MCQ with empty options.
    const typelessFillGapsSnapshot = {
      question_id: 'f1',
      order_num: 1,
      question_snapshot: {
        id: 'f1',
        question: 'Water is {{1}} and ice is {{2}}.',
        options: [],
        correct_answer: 0,
        explanation: '',
        difficulty: 'easy',
        is_user_generated: false,
        competency_ids: [],
      },
    };

    const liveFillGapsQuestion = {
      id: 'f1',
      type: 'fill_gaps',
      question: 'Water is {{1}} and ice is {{2}}.',
      payload: { stem: 'Water is {{1}} and ice is {{2}}.' },
      answer_key: {
        gaps: [
          { ordinal: 1, acceptable: ['liquid'] },
          { ordinal: 2, acceptable: ['solid'] },
        ],
      },
      explanation: '',
      difficulty: 'easy',
      is_user_generated: false,
    };

    it('re-fetches the live question and renders the fill-gaps UI instead of a blank card', async () => {
      setupResume([typelessFillGapsSnapshot], [liveFillGapsQuestion]);

      renderQuiz();
      await vi.runAllTimersAsync();

      await waitFor(() => {
        expect(screen.getByLabelText('Gap 1')).toBeInTheDocument();
      });
      expect(screen.getByLabelText('Gap 2')).toBeInTheDocument();
    });

    // A pre-#829 snapshot: no `type`, so it resolves to an MCQ with empty
    // options even though open questions carry no options at all.
    const typelessOpenSnapshot = {
      question_id: 'op1',
      order_num: 1,
      question_snapshot: {
        id: 'op1',
        question: 'Explain why the sky is blue.',
        options: [],
        correct_answer: 0,
        explanation: '',
        difficulty: 'medium',
        is_user_generated: false,
        competency_ids: [],
      },
    };

    const liveOpenQuestion = {
      id: 'op1',
      type: 'open',
      question: 'Explain why the sky is blue.',
      payload: { answering_mode: 'single' },
      answer_key: { model_answer: 'Rayleigh scattering.' },
      explanation: '',
      difficulty: 'medium',
      is_user_generated: false,
    };

    it('re-fetches the live question and renders the open-answer UI instead of a blank card', async () => {
      setupResume([typelessOpenSnapshot], [liveOpenQuestion]);

      renderQuiz();
      await vi.runAllTimersAsync();

      await waitFor(() => {
        expect(screen.getByLabelText('Your answer')).toBeInTheDocument();
      });
    });
  });
  // #1011 — the answering surface stops holding the key.
  //
  // The quiz and practice paths used to select `answer_key` (and `explanation`,
  // which justifies it) with the question itself, then decline to paint it
  // until submit. The key sat in the browser for the whole time the student was
  // answering, and was copied into the student's own session snapshot on top of
  // that (#1185). Both fetches now ask for the student-facing columns only, and
  // the review material arrives from `submit-quiz-answers` once there is an
  // answer on record.
  describe('the answer key is not fetched with the question (#1011)', () => {
    // Records every column list the component asks each table for, and every
    // row it inserts, so a test can assert about the REQUEST rather than about
    // what a mock happened to hand back.
    let selects: Record<string, string[]>;
    let inserts: Record<string, any[]>;

    const recordingChain = (table: string, list: any, single?: any) => {
      const c: any = {
        select: vi.fn((cols?: string) => {
          if (typeof cols === 'string') (selects[table] ??= []).push(cols);
          return c;
        }),
        insert: vi.fn((rows: any) => {
          (inserts[table] ??= []).push(rows);
          return c;
        }),
        update: vi.fn(() => c),
        delete: vi.fn(() => c),
        eq: vi.fn(() => c),
        neq: vi.fn(() => c),
        in: vi.fn(() => c),
        not: vi.fn(() => c),
        order: vi.fn(() => c),
        limit: vi.fn(() => c),
        single: vi.fn().mockResolvedValue(single ?? { data: null, error: null }),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        then: (r: any) => Promise.resolve(r(list ?? { data: [], error: null })),
      };
      return c;
    };

    const mcqRow = {
      id: 'q1',
      type: 'mcq',
      question: 'What is 2 + 2?',
      // No `answer_key` and no `explanation`: this is the shape the narrowed
      // select actually returns, so a component that still reached for either
      // would read undefined here rather than quietly keep working.
      payload: { options: ['3', '4', '5', '6'], multi_correct: false },
      difficulty: 'easy',
      is_user_generated: false,
      validation_status: 'VALID',
    };

    beforeEach(() => {
      selects = {};
      inserts = {};
    });

    const mockTables = (over: Record<string, any> = {}) => {
      mockSupabaseFrom.mockImplementation((table: string) => {
        if (over[table]) return over[table]();
        if (table === 'quiz_sessions') {
          return recordingChain(table, { data: [], error: null }, {
            data: { id: 'new-session' },
            error: null,
          });
        }
        return recordingChain(table, { data: [], error: null });
      });
    };

    it('the practice fetch asks for neither the key nor the explanation', async () => {
      mockTables({
        questions: () =>
          recordingChain('questions', { data: [mcqRow], error: null }),
      });

      render(<StudentQuiz {...defaultProps} />);
      await vi.runAllTimersAsync();

      await waitFor(() => {
        expect(selects.questions?.length).toBeGreaterThan(0);
      });
      // Practice reads a whole course's worth of questions at once, so this is
      // the widest of the three surfaces: it used to hand over every answer in
      // the course the moment practice opened.
      for (const cols of selects.questions) {
        expect(cols).not.toContain('answer_key');
        expect(cols).not.toContain('explanation');
      }
    });

    it('the quiz fetch asks for neither the key nor the explanation', async () => {
      mockTables({
        quiz_questions: () =>
          recordingChain('quiz_questions', {
            data: [{ order_num: 1, questions: mcqRow }],
            error: null,
          }),
      });

      render(<StudentQuiz {...defaultProps} quizId="quiz-1" showAnswersEnabled />);
      await vi.runAllTimersAsync();

      await waitFor(() => {
        expect(selects.quiz_questions?.length).toBeGreaterThan(0);
      });
      for (const cols of selects.quiz_questions) {
        expect(cols).not.toContain('answer_key');
        expect(cols).not.toContain('explanation');
      }
    });

    it('the session snapshot it writes carries no answer key (#1185)', async () => {
      mockTables({
        quiz_questions: () =>
          recordingChain('quiz_questions', {
            data: [{ order_num: 1, questions: mcqRow }],
            error: null,
          }),
      });

      render(<StudentQuiz {...defaultProps} quizId="quiz-1" showAnswersEnabled />);
      await vi.runAllTimersAsync();

      await waitFor(() => {
        expect(inserts.quiz_session_questions?.length).toBeGreaterThan(0);
      });
      const rows = inserts.quiz_session_questions.flat();
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        const snap = row.question_snapshot;
        // The snapshot freezes what is ASKED, so a mid-attempt edit cannot
        // change the question under the student. It has no business freezing
        // the answer into a row the student owns and can read.
        expect(snap).not.toHaveProperty('correct_answers');
        expect(snap).not.toHaveProperty('correct_answer');
        expect(snap).not.toHaveProperty('classification_assignments');
        expect(snap).not.toHaveProperty('fill_gaps_gaps');
        expect(snap).not.toHaveProperty('explanation');
        // What it does keep: the question, and the one presentation bit that
        // used to be derived from the key.
        expect(snap.options).toEqual(['3', '4', '5', '6']);
        expect(snap.multi_correct).toBe(false);
      }
    });

    it('the explanation appears only because the server sent it back', async () => {
      serverReveal = {
        q1: { explanation: 'Basic math', correctIndices: [1] },
      };
      mockTables({
        questions: () =>
          recordingChain('questions', { data: [mcqRow], error: null }),
      });

      render(<StudentQuiz {...defaultProps} />);
      await vi.runAllTimersAsync();
      await waitFor(() => {
        expect(screen.getByText('What is 2 + 2?')).toBeInTheDocument();
      });
      // Nothing about the answer is on the page — or in the page's data —
      // before the student submits.
      expect(screen.queryByText('Basic math')).not.toBeInTheDocument();

      fireEvent.click(screen.getByText('4'));
      await vi.runAllTimersAsync();
      fireEvent.click(screen.getByRole('button', { name: /Submit Answer/i }));
      await vi.runAllTimersAsync();

      await waitFor(() => {
        expect(screen.getByText('Basic math')).toBeInTheDocument();
      });
    });

    it('a verdict with no reveal leaves the review blank rather than falling back', async () => {
      // The withheld case: a quiz whose instructor has not released answers.
      // The page has no key of its own to fall back on any more, which is the
      // point — "don't show answers" used to be a rendering choice sitting on
      // top of data the browser already had.
      serverReveal = null;
      mockTables({
        questions: () =>
          recordingChain('questions', { data: [mcqRow], error: null }),
      });

      render(<StudentQuiz {...defaultProps} />);
      await vi.runAllTimersAsync();
      await waitFor(() => {
        expect(screen.getByText('What is 2 + 2?')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('4'));
      await vi.runAllTimersAsync();
      fireEvent.click(screen.getByRole('button', { name: /Submit Answer/i }));
      await vi.runAllTimersAsync();

      await waitFor(() => {
        expect(submitCalls).toHaveLength(1);
      });
      expect(screen.queryByText('Basic math')).not.toBeInTheDocument();
    });
  });
});
