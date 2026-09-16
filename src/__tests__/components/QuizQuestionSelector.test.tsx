import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

vi.mock('@/lib/latex-utils', () => ({
  processLatexContent: (text: string) => text,
}));

import { QuizQuestionSelector } from '@/components/QuizQuestionSelector';

const mockQuestions = [
  {
    id: 'q1',
    question: 'What is 2+2?',
    options: ['1', '2', '3', '4'],
    correct_answer: 3,
    explanation: 'Basic math',
    difficulty: 'easy',
    hidden: false,
  },
  {
    id: 'q2',
    question: 'What is the capital of France?',
    options: ['London', 'Paris', 'Berlin', 'Rome'],
    correct_answer: 1,
    explanation: null,
    difficulty: 'medium',
    hidden: false,
  },
  {
    id: 'q3',
    question: 'Hidden question',
    options: ['A', 'B'],
    correct_answer: 0,
    explanation: null,
    difficulty: 'hard',
    hidden: true,
  },
];

const defaultProps = {
  questions: mockQuestions,
  selectedQuestionIds: [] as string[],
  onToggleQuestion: vi.fn(),
  onSelectAll: vi.fn(),
  getQuizzesForQuestion: vi.fn().mockReturnValue([]),
};

describe('QuizQuestionSelector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders without crashing', () => {
    render(<QuizQuestionSelector {...defaultProps} />);
    expect(document.body).toBeTruthy();
  });

  it('displays question text', () => {
    render(<QuizQuestionSelector {...defaultProps} />);
    expect(screen.getByText('What is 2+2?')).toBeInTheDocument();
    expect(screen.getByText('What is the capital of France?')).toBeInTheDocument();
  });

  it('shows search input', () => {
    render(<QuizQuestionSelector {...defaultProps} />);
    expect(screen.getByPlaceholderText(/search/i)).toBeInTheDocument();
  });

  it('filters questions by search', async () => {
    const user = userEvent.setup();
    render(<QuizQuestionSelector {...defaultProps} />);

    const searchInput = screen.getByPlaceholderText(/search/i);
    await user.type(searchInput, 'capital');

    expect(screen.getByText('What is the capital of France?')).toBeInTheDocument();
    expect(screen.queryByText('What is 2+2?')).not.toBeInTheDocument();
  });

  it('renders with selected questions', () => {
    render(<QuizQuestionSelector {...defaultProps} selectedQuestionIds={['q1']} />);
    expect(document.body).toBeTruthy();
  });

  it('renders with empty questions array', () => {
    render(<QuizQuestionSelector {...defaultProps} questions={[]} />);
    expect(document.body).toBeTruthy();
  });
});
