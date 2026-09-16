import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

vi.mock('@/lib/language-options', () => ({
  LANGUAGE_OPTIONS: [
    { code: 'en', name: 'English' },
    { code: 'el', name: 'Greek' },
  ],
}));

import CreateCourseDialog from '@/components/class-management/CreateCourseDialog';
import type { GradeLevelOption } from '@/lib/grade-levels';

const gradeLevels: GradeLevelOption[] = [
  { id: 'gl-1', value: 'dimotiko_1', labelEl: '1η Δημοτικού', labelEn: '1st Grade Primary', ordinal: 1, schoolLevel: 'dimotiko', isGeneric: false },
  { id: 'gl-2', value: 'dimotiko_2', labelEl: '2η Δημοτικού', labelEn: '2nd Grade Primary', ordinal: 2, schoolLevel: 'dimotiko', isGeneric: false },
  { id: 'gl-3', value: 'gymnasio_1', labelEl: '1η Γυμνασίου', labelEn: '1st Grade Middle School', ordinal: 7, schoolLevel: 'gymnasio', isGeneric: false },
];

const defaultProps = {
  open: true,
  onOpenChange: vi.fn(),
  gradeLevel: 'dimotiko_1',
  gradeLevels,
  defaultLanguage: 'el',
  categories: [] as string[],
  onCreate: vi.fn().mockResolvedValue(undefined),
};

describe('CreateCourseDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the grade level dropdown', () => {
    render(<CreateCourseDialog {...defaultProps} />);
    expect(screen.getByText('Grade Level *')).toBeInTheDocument();
  });

  it('pre-fills the grade dropdown with the gradeLevel prop', () => {
    render(<CreateCourseDialog {...defaultProps} gradeLevel="dimotiko_1" />);
    const trigger = screen.getByRole('combobox', { name: /grade level/i });
    expect(trigger).toHaveTextContent('1η Δημοτικού');
  });

  it('submit button is disabled when title is empty (even with grade selected)', () => {
    render(<CreateCourseDialog {...defaultProps} />);
    const submitButton = screen.getByRole('button', { name: /create course/i });
    expect(submitButton).toBeDisabled();
  });

  it('submit button is enabled when both grade and title are provided', async () => {
    const user = userEvent.setup();
    render(<CreateCourseDialog {...defaultProps} />);

    const titleInput = screen.getByPlaceholderText('e.g., Mathematics, History');
    await user.type(titleInput, 'Math');

    const submitButton = screen.getByRole('button', { name: /create course/i });
    expect(submitButton).toBeEnabled();
  });

  it('submit button is disabled when grade is empty', () => {
    render(<CreateCourseDialog {...defaultProps} gradeLevel="" />);
    const submitButton = screen.getByRole('button', { name: /create course/i });
    expect(submitButton).toBeDisabled();
  });

  it('shows validation message when no grade is selected', () => {
    render(<CreateCourseDialog {...defaultProps} gradeLevel="" />);
    expect(screen.getByText('Please select a grade level')).toBeInTheDocument();
  });

  it('does not render dialog content when closed', () => {
    render(<CreateCourseDialog {...defaultProps} open={false} />);
    expect(screen.queryByText('Grade Level *')).not.toBeInTheDocument();
  });

  it('calls onCreate with category "Default" when no named categories exist', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<CreateCourseDialog {...defaultProps} onCreate={onCreate} />);

    const titleInput = screen.getByPlaceholderText('e.g., Mathematics, History');
    await user.type(titleInput, 'Math');

    const submitButton = screen.getByRole('button', { name: /create course/i });
    await user.click(submitButton);

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Math',
        grade_level: 'dimotiko_1',
        category: 'Default',
      }),
    );
  });

  it('always shows category dropdown even when categories list is empty', () => {
    render(<CreateCourseDialog {...defaultProps} categories={[]} />);
    expect(screen.getByText('Category *')).toBeInTheDocument();
  });

  it('shows category dropdown when categories are provided', () => {
    render(<CreateCourseDialog {...defaultProps} categories={['English', 'PT']} />);
    expect(screen.getByText('Category *')).toBeInTheDocument();
  });

  it('shows "Default" as default selection in category dropdown', () => {
    render(<CreateCourseDialog {...defaultProps} categories={['English']} />);
    const trigger = screen.getByRole('combobox', { name: /category/i });
    expect(trigger).toHaveTextContent('Default');
  });

  it('description always mentions category', () => {
    render(<CreateCourseDialog {...defaultProps} categories={[]} />);
    expect(screen.getByText(/and category/)).toBeInTheDocument();
  });
});
