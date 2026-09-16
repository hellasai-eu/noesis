import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

vi.mock('@/hooks/useInstitutionGradeLevels', () => ({
  useInstitutionGradeLevels: () => ({
    rows: [],
    options: [],
    loading: false,
    findIdByCode: () => null,
    findCodeById: () => null,
    getLabel: (code: string | null | undefined) => code ?? '',
    getLabelById: () => '',
  }),
}));

import EnrollStudentDialog from '@/components/class-management/EnrollStudentDialog';

const defaultProps = {
  open: true,
  onOpenChange: vi.fn(),
  availableUsers: [
    {
      user_id: 'u1',
      full_name: 'Alice Student',
      email: 'alice@test.com',
      role: 'student',
      tags: [{ id: 'tag-1', name: 'Group A' }],
    },
    {
      user_id: 'u2',
      full_name: 'Bob Student',
      email: 'bob@test.com',
      role: 'student',
      tags: [],
    },
  ],
  availableTags: [{ id: 'tag-1', name: 'Group A' }],
  targetName: '1η Δημοτικού - Τμήμα 1Α',
  filterMode: 'unassigned' as const,
  onFilterModeChange: vi.fn(),
  onEnroll: vi.fn().mockResolvedValue(undefined),
};

describe('EnrollStudentDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders without crashing when open', () => {
    render(<EnrollStudentDialog {...defaultProps} />);
    expect(document.body).toBeTruthy();
  });

  it('does not render dialog content when closed', () => {
    render(<EnrollStudentDialog {...defaultProps} open={false} />);
    expect(screen.queryByText('Alice Student')).not.toBeInTheDocument();
  });

  it('displays available students', () => {
    render(<EnrollStudentDialog {...defaultProps} />);
    expect(screen.getByText('Alice Student')).toBeInTheDocument();
    expect(screen.getByText('Bob Student')).toBeInTheDocument();
  });

  it('displays the target name', () => {
    render(<EnrollStudentDialog {...defaultProps} />);
    expect(screen.getByText(/1η Δημοτικού/)).toBeInTheDocument();
  });

  it('renders search input', () => {
    render(<EnrollStudentDialog {...defaultProps} />);
    expect(screen.getByPlaceholderText(/search/i)).toBeInTheDocument();
  });

  it('renders with empty user list', () => {
    render(<EnrollStudentDialog {...defaultProps} availableUsers={[]} />);
    expect(document.body).toBeTruthy();
  });

  describe('category-aware labels', () => {
    it('shows category in info banner when classCategory is set and filterMode is unassigned', () => {
      render(
        <EnrollStudentDialog
          {...defaultProps}
          classGradeLevel="dim-1"
          classCategory="English"
          filterMode="unassigned"
        />,
      );
      expect(screen.getByText(/dim-1.*English/)).toBeInTheDocument();
    });

    it('shows category in empty state when no unassigned students', () => {
      render(
        <EnrollStudentDialog
          {...defaultProps}
          availableUsers={[]}
          classGradeLevel="dim-1"
          classCategory="English"
          filterMode="unassigned"
        />,
      );
      expect(screen.getByText(/No unassigned students in dim-1 \(English\)/)).toBeInTheDocument();
    });

    it('does not show category when classCategory is null', () => {
      render(
        <EnrollStudentDialog
          {...defaultProps}
          classGradeLevel="dim-1"
          classCategory={null}
          filterMode="unassigned"
        />,
      );
      const banner = screen.getByText(/Showing unassigned students/);
      expect(banner.textContent).toContain('dim-1');
      expect(banner.textContent).not.toContain('(');
    });
  });
});
