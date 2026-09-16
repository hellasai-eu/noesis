import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import React from 'react';

// Mock dependencies
const { mockInsert } = vi.hoisted(() => ({
  mockInsert: vi.fn().mockResolvedValue({ data: null, error: null }),
}));

vi.mock('@/integrations/supabase/client', () => {
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    neq: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    insert: mockInsert,
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: null, error: null }),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    then: vi.fn((cb: (v: { data: unknown[]; error: null }) => void) =>
      Promise.resolve(cb({ data: [], error: null }))
    ),
  };
  for (const key of Object.keys(chain)) {
    const fn = chain[key as keyof typeof chain];
    if (typeof fn === 'function' && !['then', 'single', 'maybeSingle', 'insert'].includes(key)) {
      (fn as ReturnType<typeof vi.fn>).mockReturnValue(chain);
    }
  }
  return {
    supabase: {
      from: vi.fn(() => chain),
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    },
  };
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@/components/class-management/CourseInstructorPicker', () => ({
  default: () => <div data-testid="course-instructor-picker" />,
}));

import GradeLevelDetailPanel from '@/components/class-management/GradeLevelDetailPanel';

function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

function renderComponent(props = {}) {
  const defaultProps = {
    gradeLevel: 'dimotiko_1',
    gradeSections: [
      {
        id: 'class-1',
        name: '1η Δημοτικού - Τμήμα 1Α',
        academic_period: '2025-2026',
        is_active: true,
        allow_self_enrollment: false,
        created_at: '2025-01-01T00:00:00Z',
        grade_level_id: 'gl-1',
        section_name: 'Α',
        category: null,
      },
    ],
    institutionId: 'inst-123',
    isAdmin: true,
    onSectionAdded: vi.fn(),
    onSectionRemoved: vi.fn(),
    onSectionRenamed: vi.fn(),
    onSelectSection: vi.fn(),
    onAttachCourseToGrade: vi.fn(),
    onCreateCourseForGrade: vi.fn(),
    ...props,
  };

  return render(
    <QueryClientProvider client={createQueryClient()}>
      <BrowserRouter>
        <GradeLevelDetailPanel {...defaultProps} />
      </BrowserRouter>
    </QueryClientProvider>
  );
}

describe('GradeLevelDetailPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInsert.mockResolvedValue({ data: null, error: null });
  });

  it('renders without crashing', () => {
    renderComponent();
    expect(document.body).toBeTruthy();
  });

  it('displays the grade level label', () => {
    renderComponent();
    expect(screen.getByText(/1η Δημοτικού/)).toBeInTheDocument();
  });

  it('renders section information', () => {
    renderComponent();
    expect(screen.getByText(/Α/)).toBeInTheDocument();
  });

  it('shows inline Add Section button for admins', () => {
    renderComponent({ isAdmin: true });
    expect(screen.getByRole('button', { name: /Add Section/i })).toBeInTheDocument();
  });

  it('does not show auto-generated section letter button', () => {
    renderComponent({ isAdmin: true });
    const buttons = screen.getAllByRole('button');
    const autoLetterButton = buttons.find((b) => /Add Section [Α-Ω]/.test(b.textContent || ''));
    expect(autoLetterButton).toBeUndefined();
  });

  it('renders with empty sections', () => {
    renderComponent({ gradeSections: [] });
    expect(document.body).toBeTruthy();
  });

  it('opens dialog when Add Section is clicked', async () => {
    const user = userEvent.setup();
    renderComponent({ isAdmin: true });

    await user.click(screen.getByRole('button', { name: /Add Section/i }));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByLabelText(/Section name/i)).toBeInTheDocument();
  });

  it('shows duplicate error in dialog', async () => {
    const user = userEvent.setup();
    renderComponent({ isAdmin: true });

    await user.click(screen.getByRole('button', { name: /Add Section/i }));
    const input = screen.getByLabelText(/Section name/i);
    await user.type(input, 'Α');

    expect(screen.getByText(/already exists/i)).toBeInTheDocument();
  });

  it('submits dialog with user-provided name', async () => {
    const onSectionAdded = vi.fn();
    const user = userEvent.setup();
    renderComponent({ isAdmin: true, onSectionAdded });

    await user.click(screen.getByRole('button', { name: /Add Section/i }));
    const input = screen.getByLabelText(/Section name/i);
    await user.type(input, 'Β');

    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /Create/i }));

    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({ section_name: 'Β' }),
    );
  });

  it('shows Add Section button per category when multiple categories exist', () => {
    renderComponent({
      isAdmin: true,
      gradeSections: [
        {
          id: 'class-1',
          name: '1η Δημοτικού - Τμήμα Α',
          academic_period: '2025-2026',
          is_active: true,
          allow_self_enrollment: false,
          created_at: '2025-01-01T00:00:00Z',
          grade_level_id: 'gl-1',
          section_name: 'Α',
          category: null,
        },
        {
          id: 'class-2',
          name: '1η Δημοτικού - Τμήμα Α (English)',
          academic_period: '2025-2026',
          is_active: true,
          allow_self_enrollment: false,
          created_at: '2025-01-01T00:00:00Z',
          grade_level_id: 'gl-1',
          section_name: 'Α',
          category: 'English',
        },
      ],
    });

    const addSectionButtons = screen.getAllByRole('button', { name: /Add Section/i });
    expect(addSectionButtons.length).toBe(2);
  });

  it('Add Category → inline form → Next opens dialog with category description', async () => {
    const user = userEvent.setup();
    renderComponent({ isAdmin: true });

    await user.click(screen.getByRole('button', { name: /Add Category/i }));
    const categoryInput = screen.getByPlaceholderText(/Category name/i);
    await user.type(categoryInput, 'English');
    await user.click(screen.getByRole('button', { name: /^Next$/i }));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(/English/i)).toBeInTheDocument();
  });

  it('shows Add Student button on active section cards for admins', () => {
    renderComponent({ isAdmin: true });
    const addStudentBtn = screen.getByRole('button', { name: /Add Student/i });
    expect(addStudentBtn).toBeInTheDocument();
  });

  it('does not show Add Student button for non-admins', () => {
    renderComponent({ isAdmin: false });
    const addStudentBtn = screen.queryByRole('button', { name: /Add Student/i });
    expect(addStudentBtn).not.toBeInTheDocument();
  });

  it('does not show Add Student button on inactive sections', () => {
    renderComponent({
      isAdmin: true,
      gradeSections: [
        {
          id: 'class-1',
          name: '1η Δημοτικού - Τμήμα 1Α',
          academic_period: '2025-2026',
          is_active: false,
          allow_self_enrollment: false,
          created_at: '2025-01-01T00:00:00Z',
          grade_level_id: 'gl-1',
          section_name: 'Α',
          category: null,
        },
      ],
    });
    const addStudentBtn = screen.queryByRole('button', { name: /Add Student/i });
    expect(addStudentBtn).not.toBeInTheDocument();
  });

  it('calls onEnrollStudentInSection when Add Student is clicked', async () => {
    const onEnrollStudentInSection = vi.fn();
    const user = userEvent.setup();
    renderComponent({ isAdmin: true, onEnrollStudentInSection });

    await user.click(screen.getByRole('button', { name: /Add Student/i }));

    expect(onEnrollStudentInSection).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'class-1', section_name: 'Α' }),
    );
  });

  it('renders with sections in multiple categories', () => {
    renderComponent({
      gradeSections: [
        {
          id: 'class-1',
          name: '1η Δημοτικού - Τμήμα 1Α',
          academic_period: '2025-2026',
          is_active: true,
          allow_self_enrollment: false,
          created_at: '2025-01-01T00:00:00Z',
          grade_level_id: 'gl-1',
          section_name: 'Α',
          category: null,
        },
        {
          id: 'class-2',
          name: '1η Δημοτικού - Τμήμα 1Α (English)',
          academic_period: '2025-2026',
          is_active: true,
          allow_self_enrollment: false,
          created_at: '2025-01-01T00:00:00Z',
          grade_level_id: 'gl-1',
          section_name: 'Α',
          category: 'English',
        },
      ],
    });
    expect(screen.getByText('Default')).toBeInTheDocument();
    expect(screen.getByText('English')).toBeInTheDocument();
  });
});
