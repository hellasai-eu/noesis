import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/tooltip';

// Mock pointer capture methods not available in jsdom (required by Radix Select)
beforeAll(() => {
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();

  // ResizeObserver needs to be a proper class constructor for floating-ui
  global.ResizeObserver = class ResizeObserver {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
});

vi.mock('@/lib/latex-utils', () => ({
  processLatexContent: (text: string) => text,
}));

import { render } from '../test-utils';
import {
  AssessmentQuestionBank,
  type Competency,
} from '@/components/assessment/AssessmentQuestionBank';
import type { UnifiedQuestion } from '@/lib/unified-question';

const mockCompetencies: Competency[] = [
  { id: 'comp-1', title: 'Algebra' },
  { id: 'comp-2', title: 'Calculus' },
];

function makeMcq(overrides: Partial<UnifiedQuestion> = {}): UnifiedQuestion {
  return {
    id: 'mcq-1',
    type: 'mcq',
    preview: 'What is 2+2?',
    searchText: 'What is 2+2?',
    difficulty: 'easy',
    authorName: 'Alice Smith',
    createdBy: 'user-1',
    createdAt: '2026-01-01T00:00:00Z',
    hidden: false,
    upvotes: 0,
    downvotes: 0,
    chapters: [],
    competencies: [],
    raw: {
      question: 'What is 2+2?',
      payload: { options: ['3', '4', '5', '6'] },
      answer_key: { correct_indices: [1] },
      explanation: null,
      generation_rationale: null,
    },
    ...overrides,
  };
}

function makeOpen(overrides: Partial<UnifiedQuestion> = {}): UnifiedQuestion {
  return {
    id: 'open-1',
    type: 'open',
    preview: 'Explain derivatives.',
    searchText: 'Explain derivatives.',
    difficulty: 'medium',
    authorName: 'Bob Jones',
    createdBy: 'user-2',
    createdAt: '2026-01-15T00:00:00Z',
    hidden: false,
    upvotes: 0,
    downvotes: 0,
    chapters: [],
    competencies: [],
    answeringMode: 'single',
    raw: {
      question: 'Explain derivatives.',
      payload: { answering_mode: 'single' },
      answer_key: { model_answer: 'A derivative measures rate of change.' },
      explanation: null,
      generation_rationale: null,
    },
    ...overrides,
  };
}

function makeFillGaps(overrides: Partial<UnifiedQuestion> = {}): UnifiedQuestion {
  return {
    id: 'fg-1',
    type: 'fill_gaps',
    preview: 'The capital of France is ‗‗‗.',
    searchText: 'The capital of France is .',
    difficulty: 'easy',
    authorName: 'Alice Smith',
    createdBy: 'user-1',
    createdAt: '2026-02-01T00:00:00Z',
    hidden: false,
    upvotes: 0,
    downvotes: 0,
    chapters: [],
    competencies: [],
    raw: {
      question: null,
      payload: { stem: 'The capital of France is {{1}}.' },
      answer_key: { gaps: [{ ordinal: 1, acceptable: ['Paris'] }] },
      explanation: null,
      generation_rationale: null,
    },
    ...overrides,
  };
}

function renderQuestionBank(
  props: Partial<Parameters<typeof AssessmentQuestionBank>[0]> = {},
) {
  const defaultProps: Parameters<typeof AssessmentQuestionBank>[0] = {
    questions: [],
    competencies: mockCompetencies,
    selectedQuestionIds: new Set<string>(),
    onAddQuestion: vi.fn(),
    mode: 'test',
    ...props,
  };
  return render(
    <TooltipProvider>
      <AssessmentQuestionBank {...defaultProps} />
    </TooltipProvider>,
  );
}

describe('AssessmentQuestionBank — type chips', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders all 5 type chips in test mode', () => {
    renderQuestionBank({ mode: 'test' });
    expect(screen.getByTestId('assessment-bank-type-chip-mcq')).toBeInTheDocument();
    expect(screen.getByTestId('assessment-bank-type-chip-open')).toBeInTheDocument();
    expect(screen.getByTestId('assessment-bank-type-chip-fill_gaps')).toBeInTheDocument();
    expect(screen.getByTestId('assessment-bank-type-chip-ordering')).toBeInTheDocument();
    expect(screen.getByTestId('assessment-bank-type-chip-classification')).toBeInTheDocument();
  });

  it('renders all 5 type chips in quiz mode (no longer MCQ-only)', () => {
    renderQuestionBank({ mode: 'quiz' });
    expect(screen.getByTestId('assessment-bank-type-chip-mcq')).toBeInTheDocument();
    expect(screen.getByTestId('assessment-bank-type-chip-open')).toBeInTheDocument();
    expect(screen.getByTestId('assessment-bank-type-chip-fill_gaps')).toBeInTheDocument();
    expect(screen.getByTestId('assessment-bank-type-chip-ordering')).toBeInTheDocument();
    expect(screen.getByTestId('assessment-bank-type-chip-classification')).toBeInTheDocument();
  });

  it('shows fill_gaps, ordering, classification rows alongside mcq/open', () => {
    renderQuestionBank({
      questions: [
        makeMcq({ id: 'mcq-a', preview: 'MCQ question' }),
        makeOpen({ id: 'open-a', preview: 'Open question' }),
        makeFillGaps({ id: 'fg-a', preview: 'Fill question' }),
      ],
      validationByQuestionId: {
        'mcq-a': { status: 'CORRECT', confidence: 0.95 },
      },
    });

    expect(screen.getByText('MCQ question')).toBeInTheDocument();
    expect(screen.getByText('Open question')).toBeInTheDocument();
    expect(screen.getByText('Fill question')).toBeInTheDocument();
  });

  it('toggling a type chip hides that type from the list', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderQuestionBank({
      questions: [
        makeMcq({ id: 'mcq-a', preview: 'MCQ row' }),
        makeFillGaps({ id: 'fg-a', preview: 'Fill row' }),
      ],
      validationByQuestionId: {
        'mcq-a': { status: 'CORRECT', confidence: 0.95 },
      },
    });

    expect(screen.getByText('Fill row')).toBeInTheDocument();
    await user.click(screen.getByTestId('assessment-bank-type-chip-fill_gaps'));
    expect(screen.queryByText('Fill row')).not.toBeInTheDocument();
    // MCQ still shown.
    expect(screen.getByText('MCQ row')).toBeInTheDocument();
  });

  it('hides unverified MCQs but always renders non-MCQ types', () => {
    renderQuestionBank({
      questions: [
        makeMcq({ id: 'mcq-a', preview: 'Unverified MCQ' }),
        makeFillGaps({ id: 'fg-a', preview: 'Always shown' }),
      ],
      validationByQuestionId: {
        // mcq has null status — caller marks unverified.
        'mcq-a': { status: null, confidence: null },
      },
    });

    expect(screen.queryByText('Unverified MCQ')).not.toBeInTheDocument();
    expect(screen.getByText('Always shown')).toBeInTheDocument();
  });

  it('clicking Add fires onAddQuestion with the UnifiedQuestion', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const onAddQuestion = vi.fn();
    const fg = makeFillGaps({ id: 'fg-x', preview: 'Cloze item' });
    renderQuestionBank({
      questions: [fg],
      onAddQuestion,
    });

    const addBtn = screen.getByRole('button', { name: /Add/i });
    await user.click(addBtn);
    expect(onAddQuestion).toHaveBeenCalledWith(fg);
  });
});
