import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

type Row = Record<string, unknown>;

interface TableState {
  rows: Row[];
  insert: Mock<(...args: unknown[]) => unknown>;
  lastEqFilters: Array<[string, unknown]>;
  lastInFilters: Array<[string, unknown[]]>;
}

const tableStates: Record<string, TableState> = {
  user_institutions: { rows: [], insert: vi.fn(), lastEqFilters: [], lastInFilters: [] },
  course_instructors: { rows: [], insert: vi.fn(), lastEqFilters: [], lastInFilters: [] },
  profiles: { rows: [], insert: vi.fn(), lastEqFilters: [], lastInFilters: [] },
  course_instructor_sections: {
    rows: [],
    insert: vi.fn(),
    lastEqFilters: [],
    lastInFilters: [],
  },
};

const resetTables = () => {
  for (const key of Object.keys(tableStates)) {
    tableStates[key].rows = [];
    tableStates[key].insert.mockReset();
    tableStates[key].insert.mockResolvedValue({ error: null });
    tableStates[key].lastEqFilters = [];
    tableStates[key].lastInFilters = [];
  }
};

const makeBuilder = (table: string) => {
  const state = tableStates[table];
  const builder: Record<string, unknown> = {};

  const applyFilters = (rows: Row[]) => {
    let result = rows;
    for (const [col, val] of state.lastEqFilters) {
      result = result.filter((r) => r[col] === val);
    }
    for (const [col, vals] of state.lastInFilters) {
      const set = new Set(vals);
      result = result.filter((r) => set.has(r[col] as unknown));
    }
    return result;
  };

  builder.select = vi.fn(() => builder);
  builder.eq = vi.fn((col: string, val: unknown) => {
    state.lastEqFilters.push([col, val]);
    return builder;
  });
  builder.in = vi.fn((col: string, vals: unknown[]) => {
    state.lastInFilters.push([col, vals]);
    return builder;
  });
  builder.insert = vi.fn((rows: Row | Row[]) => {
    state.insert(rows);
    return {
      then: (cb: (v: { data: null; error: null }) => unknown) =>
        Promise.resolve(cb({ data: null, error: null })),
    };
  });
  builder.then = (cb: (v: { data: Row[]; error: null }) => unknown) => {
    const data = applyFilters(state.rows);
    // Reset filters so subsequent calls on the same table start fresh
    state.lastEqFilters = [];
    state.lastInFilters = [];
    return Promise.resolve(cb({ data, error: null }));
  };

  return builder;
};

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: vi.fn((table: string) => makeBuilder(table)),
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/greek-school', () => ({
  getSectionDisplayName: (grade: string, section: string) => `${grade}-${section}`,
}));

import CourseInstructorPicker from '@/components/class-management/CourseInstructorPicker';
import type { GradeSectionInfo } from '@/components/class-management/CourseInstructorPicker';

const defaultProps = {
  open: true,
  onOpenChange: vi.fn(),
  courseId: 'course-1',
  courseTitle: 'Mathematics',
  institutionId: 'inst-123',
  currentInstructorIds: [],
  onChanged: vi.fn(),
};

const gradeSections: GradeSectionInfo[] = [
  { classId: 'c1', sectionName: 'A', category: 'English', gradeLevel: 'dimotiko_1' },
  { classId: 'c2', sectionName: 'B', category: 'English', gradeLevel: 'dimotiko_1' },
];

const seedUsers = (
  entries: Array<{ user_id: string; role: 'instructor' | 'admin'; full_name: string; email: string }>,
) => {
  tableStates.user_institutions.rows = entries.map((e) => ({
    user_id: e.user_id,
    role: e.role,
    institution_id: 'inst-123',
    is_suspended: false,
  }));
  tableStates.profiles.rows = entries.map((e) => ({
    user_id: e.user_id,
    full_name: e.full_name,
    email: e.email,
  }));
};

describe('CourseInstructorPicker', () => {
  beforeEach(() => {
    resetTables();
    vi.clearAllMocks();
  });

  it('renders without crashing when open', () => {
    render(<CourseInstructorPicker {...defaultProps} />);
    expect(document.body).toBeTruthy();
  });

  it('does not show content when closed', () => {
    render(<CourseInstructorPicker {...defaultProps} open={false} />);
    expect(screen.queryByText('Mathematics')).not.toBeInTheDocument();
  });

  it('displays course title when open', () => {
    render(<CourseInstructorPicker {...defaultProps} />);
    expect(screen.getByText(/Mathematics/)).toBeInTheDocument();
  });

  it('accepts currentInstructorIds', () => {
    render(
      <CourseInstructorPicker {...defaultProps} currentInstructorIds={['u-1', 'u-2']} />,
    );
    expect(document.body).toBeTruthy();
  });

  it('shows section-aware description when gradeSections are provided', () => {
    render(
      <CourseInstructorPicker {...defaultProps} gradeSections={gradeSections} />,
    );
    expect(
      screen.getByText(/Select which sections each instructor will have access to/),
    ).toBeInTheDocument();
  });

  it('shows generic description when no gradeSections provided', () => {
    render(<CourseInstructorPicker {...defaultProps} />);
    expect(screen.getByText(/course across all sections/)).toBeInTheDocument();
  });

  it('lists admin members alongside instructors with distinct role badges', async () => {
    seedUsers([
      { user_id: 'u-instr', role: 'instructor', full_name: 'Iris Instructor', email: 'iris@test.local' },
      { user_id: 'u-admin', role: 'admin', full_name: 'Alex Admin', email: 'alex@test.local' },
    ]);

    render(<CourseInstructorPicker {...defaultProps} />);

    expect(await screen.findByText('Iris Instructor')).toBeInTheDocument();
    expect(await screen.findByText('Alex Admin')).toBeInTheDocument();
    expect(screen.getByText('Admin')).toBeInTheDocument();
    expect(screen.getByText('Instructor')).toBeInTheDocument();
  });

  it('does not insert course_instructor_sections rows when only admins are assigned with partial sections', async () => {
    seedUsers([
      { user_id: 'u-admin', role: 'admin', full_name: 'Alex Admin', email: 'alex@test.local' },
    ]);

    const user = userEvent.setup();
    render(
      <CourseInstructorPicker {...defaultProps} gradeSections={gradeSections} />,
    );

    await user.click(await screen.findByText('Alex Admin'));

    // Deselect one section so "not all checked" is true — would normally trigger
    // section restriction inserts, but must be skipped for admin selections.
    const sectionBoxes = screen.getAllByRole('checkbox');
    // first checkbox is the user selection, subsequent ones are section selections
    await user.click(sectionBoxes[sectionBoxes.length - 1]);

    await user.click(screen.getByRole('button', { name: /Assign 1 Instructor/i }));

    await waitFor(() => {
      expect(tableStates.course_instructors.insert).toHaveBeenCalledTimes(1);
    });
    expect(tableStates.course_instructors.insert).toHaveBeenCalledWith([
      { course_id: 'course-1', user_id: 'u-admin' },
    ]);
    expect(tableStates.course_instructor_sections.insert).not.toHaveBeenCalled();
  });

  it('still inserts section restrictions for instructors when not all sections are selected', async () => {
    seedUsers([
      { user_id: 'u-instr', role: 'instructor', full_name: 'Iris Instructor', email: 'iris@test.local' },
    ]);

    const user = userEvent.setup();
    render(
      <CourseInstructorPicker {...defaultProps} gradeSections={gradeSections} />,
    );

    await user.click(await screen.findByText('Iris Instructor'));

    const sectionBoxes = screen.getAllByRole('checkbox');
    await user.click(sectionBoxes[sectionBoxes.length - 1]);

    await user.click(screen.getByRole('button', { name: /Assign 1 Instructor/i }));

    await waitFor(() => {
      expect(tableStates.course_instructor_sections.insert).toHaveBeenCalledTimes(1);
    });
    const args = tableStates.course_instructor_sections.insert.mock.calls[0][0];
    expect(args).toEqual([
      { course_id: 'course-1', user_id: 'u-instr', class_id: 'c1' },
    ]);
  });

  it('inserts only instructor section rows when both admin and instructor are selected', async () => {
    seedUsers([
      { user_id: 'u-instr', role: 'instructor', full_name: 'Iris Instructor', email: 'iris@test.local' },
      { user_id: 'u-admin', role: 'admin', full_name: 'Alex Admin', email: 'alex@test.local' },
    ]);

    const user = userEvent.setup();
    render(
      <CourseInstructorPicker {...defaultProps} gradeSections={gradeSections} />,
    );

    await user.click(await screen.findByText('Iris Instructor'));
    await user.click(await screen.findByText('Alex Admin'));

    const sectionBoxes = screen.getAllByRole('checkbox');
    await user.click(sectionBoxes[sectionBoxes.length - 1]);

    await user.click(screen.getByRole('button', { name: /Assign 2 Instructors/i }));

    await waitFor(() => {
      expect(tableStates.course_instructors.insert).toHaveBeenCalledTimes(1);
    });
    expect(tableStates.course_instructors.insert).toHaveBeenCalledWith(
      expect.arrayContaining([
        { course_id: 'course-1', user_id: 'u-instr' },
        { course_id: 'course-1', user_id: 'u-admin' },
      ]),
    );
    const sectionArgs = tableStates.course_instructor_sections.insert.mock.calls[0][0];
    // Only the instructor should appear; admin is skipped.
    expect(sectionArgs).toEqual([
      { course_id: 'course-1', user_id: 'u-instr', class_id: 'c1' },
    ]);
  });
});
