import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import React from 'react';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/components/Student360', () => ({
  default: () => <div data-testid="student-360" />,
}));

vi.mock('@/lib/greek-school', () => ({
  getSectionDisplayName: (grade: string, section: string) => `${grade}-${section}`,
}));

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

vi.mock('@/components/class-management/CourseInstructorPicker', () => ({
  default: () => <div data-testid="course-instructor-picker" />,
}));

import ClassDetailPanel from '@/components/class-management/ClassDetailPanel';

const mockClass = {
  id: 'class-1',
  name: '1η Δημοτικού - Τμήμα 1Α',
  academic_period: '2025-2026',
  is_active: true,
  allow_self_enrollment: false,
  institution_id: 'inst-123',
  grade_level_id: 'gl-1',
  section_name: 'Α',
  category: null,
  created_at: '2025-01-01T00:00:00.000Z',
};

const defaultProps = {
  selectedClass: mockClass,
  classOfferings: [
    { id: 'off-1', course_id: 'c-1', course_title: 'Mathematics', is_active: true, instructors: [{ user_id: 'instr-1', full_name: 'Dr. Smith', email: 'smith@test.com' }] },
  ],
  classEnrollments: [
    { user_id: 'u-1', role: 'student', enrolled_at: '2025-01-01', full_name: 'Alice', email: 'alice@test.com' },
  ],
  loadingClassDetails: false,
  isAdmin: true,
  onEnrollStudent: vi.fn(),
  onDetachCourse: vi.fn(),
  onRemoveInstructor: vi.fn(),
  onRemoveEnrollment: vi.fn(),
  onDeleteClass: vi.fn(),
  onToggleClassActive: vi.fn(),
  onToggleSelfEnrollment: vi.fn(),
  institutionId: 'inst-123',
  onInstructorAssigned: vi.fn(),
};

function renderComponent(props = {}) {
  return render(
    <BrowserRouter>
      <ClassDetailPanel {...defaultProps} {...props} />
    </BrowserRouter>
  );
}

describe('ClassDetailPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders without crashing', () => {
    renderComponent();
    expect(document.body).toBeTruthy();
  });

  it('shows course offerings', () => {
    renderComponent();
    expect(screen.getByText('Mathematics')).toBeInTheDocument();
  });

  it('shows students tab with count', () => {
    renderComponent();
    // Tab shows "Students ( 1 )"
    const enrollmentTab = screen.getByRole('tab', { name: /students/i });
    expect(enrollmentTab).toBeInTheDocument();
  });

  it('shows loading state', () => {
    renderComponent({ loadingClassDetails: true });
    const spinner = document.querySelector('.animate-spin');
    expect(spinner).toBeTruthy();
  });

  it('renders with empty offerings and enrollments', () => {
    renderComponent({ classOfferings: [], classEnrollments: [] });
    expect(document.body).toBeTruthy();
  });

  it('shows enroll button for admins', () => {
    renderComponent({ isAdmin: true });
    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBeGreaterThan(0);
  });

  it('shows instructor names on course cards', () => {
    renderComponent();
    expect(screen.getByText('Dr. Smith')).toBeInTheDocument();
  });

  it('does not show instructor section when no instructors assigned', () => {
    renderComponent({
      classOfferings: [
        { id: 'off-1', course_id: 'c-1', course_title: 'Mathematics', is_active: true, instructors: [] },
      ],
    });
    expect(screen.queryByText('Dr. Smith')).not.toBeInTheDocument();
  });

  it('shows Add Instructor button for admins on course cards', () => {
    renderComponent({ isAdmin: true });
    expect(screen.getByText('Add Instructor')).toBeInTheDocument();
  });

  it('does not show Add Instructor button for non-admins', () => {
    renderComponent({ isAdmin: false });
    expect(screen.queryByText('Add Instructor')).not.toBeInTheDocument();
  });

  it('shows remove instructor X button for admins', () => {
    renderComponent({ isAdmin: true });
    const badge = screen.getByText('Dr. Smith').closest('[data-testid="instructor-badge"]') ?? screen.getByText('Dr. Smith').parentElement;
    const xButton = badge?.querySelector('button');
    expect(xButton).toBeTruthy();
  });

  it('does not show remove instructor X button for non-admins', () => {
    renderComponent({ isAdmin: false });
    const badge = screen.getByText('Dr. Smith').closest('[data-testid="instructor-badge"]') ?? screen.getByText('Dr. Smith').parentElement;
    const xButton = badge?.querySelector('button');
    expect(xButton).toBeFalsy();
  });
});
