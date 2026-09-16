import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  AssessmentBuilderPanel,
  type AssessmentQuestion,
} from '@/components/assessment/AssessmentBuilderPanel';

vi.mock('@/lib/latex-utils', () => ({
  processLatexContent: (text: string) => text,
}));

function makeQuestion(
  overrides: Partial<AssessmentQuestion> = {},
): AssessmentQuestion {
  return {
    id: 'q-1',
    type: 'classification',
    question: 'Classify the items below.',
    difficulty: 'hard',
    points: 3,
    competency_id: null,
    ...overrides,
  };
}

const noopHandlers = {
  onTitleChange: vi.fn(),
  onDescriptionChange: vi.fn(),
  onRemoveQuestion: vi.fn(),
  onUpdatePoints: vi.fn(),
  onMoveQuestion: vi.fn(),
  onPreview: vi.fn(),
  onSave: vi.fn(),
};

describe('AssessmentBuilderPanel — issue #733 regression', () => {
  it('renders the header (Q#, type label, difficulty) for the first question', () => {
    // The reporter saw the Q1 header missing while Q2/Q3 rendered normally.
    // The header is the same flex row for every index — verify it shows for index 0.
    const questions = [
      makeQuestion({ id: 'q-1', type: 'classification', difficulty: 'hard' }),
      makeQuestion({ id: 'q-2', type: 'mcq', difficulty: 'medium' }),
    ];

    render(
      <AssessmentBuilderPanel
        mode="test"
        title="My Test"
        description=""
        questions={questions}
        saving={false}
        {...noopHandlers}
      />,
    );

    // First question's header is rendered.
    expect(screen.getByText('Q1')).toBeInTheDocument();
    expect(screen.getByText('Classification')).toBeInTheDocument();
    // Difficulty label is shown for the first question (also used by Q2).
    expect(screen.getAllByText('hard').length).toBeGreaterThan(0);
  });

  it('enables Save when title is non-empty and at least one question exists', () => {
    render(
      <AssessmentBuilderPanel
        mode="test"
        title="My Test"
        description=""
        questions={[makeQuestion()]}
        saving={false}
        {...noopHandlers}
      />,
    );

    const saveButton = screen.getByRole('button', { name: /^Save$/i });
    expect(saveButton).toBeEnabled();
  });

  it('disables Save when title is empty', () => {
    render(
      <AssessmentBuilderPanel
        mode="test"
        title=""
        description=""
        questions={[makeQuestion()]}
        saving={false}
        {...noopHandlers}
      />,
    );

    const saveButton = screen.getByRole('button', { name: /^Save$/i });
    expect(saveButton).toBeDisabled();
  });

  it('disables Save when there are no questions', () => {
    render(
      <AssessmentBuilderPanel
        mode="test"
        title="My Test"
        description=""
        questions={[]}
        saving={false}
        {...noopHandlers}
      />,
    );

    const saveButton = screen.getByRole('button', { name: /^Save$/i });
    expect(saveButton).toBeDisabled();
  });

  it('renders three action buttons in a wrap-capable row when onEditDocument is provided', () => {
    // The #728 "Edit document" button added a third flex-1 button to the action
    // row. In a narrow column, three non-wrapping flex-1 buttons overflowed and
    // pushed Save off-screen / behind the sidebar (#733). The row must wrap.
    render(
      <AssessmentBuilderPanel
        mode="test"
        title="My Test"
        description=""
        questions={[makeQuestion()]}
        saving={false}
        onEditDocument={vi.fn()}
        hasEditedDocument={false}
        {...noopHandlers}
      />,
    );

    expect(screen.getByRole('button', { name: /Preview/i })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Generate document/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Save$/i })).toBeInTheDocument();
  });
});

describe('AssessmentBuilderPanel — quiz builder fields', () => {
  it('does not offer a time limit or an answer-release toggle when creating a quiz', () => {
    render(
      <AssessmentBuilderPanel
        mode="quiz"
        title="My Quiz"
        description=""
        questions={[makeQuestion()]}
        saving={false}
        {...noopHandlers}
      />,
    );

    // Time limit lives on the assignment, and answers are released per class
    // once the assignment is marked as done — neither belongs in the builder.
    expect(screen.queryByLabelText(/time limit/i)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Release answers to students/i),
    ).not.toBeInTheDocument();
  });

  it('marks the description as student-visible', () => {
    render(
      <AssessmentBuilderPanel
        mode="quiz"
        title="My Quiz"
        description=""
        questions={[makeQuestion()]}
        saving={false}
        {...noopHandlers}
      />,
    );

    expect(screen.getByText(/Visible to students/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Students see this description when they open the quiz/i),
    ).toBeInTheDocument();
  });
});
