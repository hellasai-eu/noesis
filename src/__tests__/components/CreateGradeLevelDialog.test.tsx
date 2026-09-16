import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import CreateGradeLevelDialog from '@/components/class-management/CreateGradeLevelDialog';
import { GRADE_OPTIONS, type SchoolLevel } from '@/lib/greek-school';

function makeProps(overrides: Partial<React.ComponentProps<typeof CreateGradeLevelDialog>> = {}) {
  return {
    open: true,
    onOpenChange: vi.fn(),
    schoolLevels: [] as SchoolLevel[],
    existingGradeLevels: [] as string[],
    onCreateGradeLevel: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('CreateGradeLevelDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('when schoolLevels is empty (fallback)', () => {
    it('does not show the "all created" message', () => {
      render(<CreateGradeLevelDialog {...makeProps({ schoolLevels: [] })} />);
      expect(
        screen.queryByText(/all grade levels have already been created/i),
      ).not.toBeInTheDocument();
    });

    it('submit is initially disabled before any grade is picked', () => {
      render(<CreateGradeLevelDialog {...makeProps({ schoolLevels: [] })} />);
      const submit = screen.getByRole('button', { name: /create grade level/i });
      expect(submit).toBeDisabled();
    });

    it('renders the grade dropdown rather than the dead-end message', () => {
      render(<CreateGradeLevelDialog {...makeProps({ schoolLevels: [] })} />);
      expect(screen.getByRole('combobox')).toBeInTheDocument();
      expect(
        screen.queryByText(/all grade levels have already been created/i),
      ).not.toBeInTheDocument();
    });
  });

  describe('when schoolLevels is configured', () => {
    it('renders the dropdown with selectable grades', () => {
      render(
        <CreateGradeLevelDialog {...makeProps({ schoolLevels: ['dimotiko'] })} />,
      );
      // Dropdown trigger is shown, fallback dead-end message is not.
      expect(screen.getByRole('combobox')).toBeInTheDocument();
      expect(
        screen.queryByText(/all grade levels have already been created/i),
      ).not.toBeInTheDocument();
    });

    it('shows the "all created" message only when every configured grade exists', () => {
      const dimotikoGrades = GRADE_OPTIONS.filter((g) => g.level === 'dimotiko').map(
        (g) => g.value,
      );
      render(
        <CreateGradeLevelDialog
          {...makeProps({
            schoolLevels: ['dimotiko'],
            existingGradeLevels: dimotikoGrades,
          })}
        />,
      );
      expect(
        screen.getByText(/all grade levels have already been created/i),
      ).toBeInTheDocument();
      // dropdown is replaced by the message
      expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    });
  });

  describe('when every grade already exists (empty fallback + all 12 created)', () => {
    it('shows the "all created" message and disables submit', () => {
      const allGrades = GRADE_OPTIONS.map((g) => g.value);
      render(
        <CreateGradeLevelDialog
          {...makeProps({
            schoolLevels: [],
            existingGradeLevels: allGrades,
          })}
        />,
      );
      expect(
        screen.getByText(/all grade levels have already been created/i),
      ).toBeInTheDocument();
      const submit = screen.getByRole('button', { name: /create grade level/i });
      expect(submit).toBeDisabled();
    });
  });
});
