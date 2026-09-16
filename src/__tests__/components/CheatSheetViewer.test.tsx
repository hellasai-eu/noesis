import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

type Chain = {
  select: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  in: ReturnType<typeof vi.fn>;
  not: ReturnType<typeof vi.fn>;
  is: ReturnType<typeof vi.fn>;
  order: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  then: ReturnType<typeof vi.fn>;
};

const fromResponses = new Map<string, { materials?: any[]; chapters?: any[] }>();

function makeChain(table: string): Chain {
  let updateArgs: any = null;
  const chain: any = {};
  const resolveSelect = () => {
    const data = fromResponses.get(table);
    if (table === 'course_materials') {
      return Promise.resolve({ data: data?.materials ?? [], error: null });
    }
    if (table === 'material_chapters') {
      return Promise.resolve({ data: data?.chapters ?? [], error: null });
    }
    return Promise.resolve({ data: [], error: null });
  };

  chain.select = vi.fn().mockImplementation(() => {
    // Return a thenable chain for select queries
    const queryChain: any = {};
    queryChain.eq = vi.fn().mockReturnValue(queryChain);
    queryChain.in = vi.fn().mockReturnValue(queryChain);
    queryChain.not = vi.fn().mockReturnValue(queryChain);
    queryChain.is = vi.fn().mockReturnValue(queryChain);
    queryChain.order = vi.fn().mockReturnValue(queryChain);
    queryChain.then = (cb: any) => resolveSelect().then(cb);
    return queryChain;
  });

  chain.update = vi.fn().mockImplementation((args: any) => {
    updateArgs = args;
    const updateChain: any = {};
    updateChain.eq = vi.fn().mockResolvedValue({ data: null, error: null });
    return updateChain;
  });

  chain.__getUpdateArgs = () => updateArgs;

  return chain;
}

const fromSpy = vi.fn((table: string) => makeChain(table));
const invokeSpy = vi.fn();

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (table: string) => fromSpy(table),
    functions: {
      invoke: (...args: any[]) => invokeSpy(...args),
    },
  },
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

const getAssignedOfferingIdsMock = vi.fn((_id: string) => [] as string[]);
const saveAssignmentsMock = vi.fn().mockResolvedValue(undefined);

vi.mock('@/hooks/useContentAssignments', () => ({
  useContentAssignments: () => ({
    getAssignedOfferingIds: getAssignedOfferingIdsMock,
    getAssignedTargets: () => [],
    saveAssignments: saveAssignmentsMock,
    isAssigned: () => false,
    saving: false,
    loading: false,
    refetch: vi.fn(),
    refetchGroups: vi.fn(),
    groupsByOffering: {},
    assignments: {},
  }),
}));

vi.mock('@/components/ContentAssignDialog', () => ({
  ContentAssignDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="assign-dialog" /> : null,
}));

vi.mock('@/components/AssignedClassesBadges', () => ({
  AssignedClassesBadges: ({ onClickAssign }: { onClickAssign: () => void }) => (
    <button data-testid="assigned-classes-badges" onClick={onClickAssign}>
      Assign
    </button>
  ),
}));

vi.mock('@/components/CheatSheetEditor', () => ({
  CheatSheetEditor: () => <div data-testid="cheat-sheet-editor" />,
}));

import CheatSheetViewer from '@/components/CheatSheetViewer';

const classes = [
  { class_id: 'class-1', offering_id: 'off-1', grade_level_id: 'gl-9', section_name: 'A' } as any,
];

beforeEach(() => {
  vi.clearAllMocks();
  fromResponses.clear();
  getAssignedOfferingIdsMock.mockReturnValue([]);
});

describe('CheatSheetViewer admin table', () => {
  it('renders the six expected column headers when admin with classes', async () => {
    fromResponses.set('course_materials', {
      materials: [
        { id: 'mat-1', title: 'Biology 101', file_name: 'bio.pdf', material_type: 'textbook' },
      ],
    });
    fromResponses.set('material_chapters', {
      chapters: [
        {
          id: 'ch-1',
          chapter_number: 1,
          title: 'Cells',
          cheat_sheet: '<p>stuff</p>',
          cheat_sheet_visible: true,
          material_id: 'mat-1',
        },
      ],
    });

    render(<CheatSheetViewer courseId="course-1" isAdmin classes={classes} />);

    await waitFor(() => {
      expect(screen.getByText('Chapter')).toBeInTheDocument();
    });

    expect(screen.getByText('Material')).toBeInTheDocument();
    expect(screen.getByText('Status')).toBeInTheDocument();
    expect(screen.getByText('Visible')).toBeInTheDocument();
    expect(screen.getByText('Classes')).toBeInTheDocument();
    expect(screen.getByText('Actions')).toBeInTheDocument();
  });

  it('renders a Generated badge and offers preview/edit/regenerate/delete in the row actions menu', async () => {
    fromResponses.set('course_materials', {
      materials: [
        { id: 'mat-1', title: 'Biology', file_name: 'bio.pdf', material_type: 'textbook' },
      ],
    });
    fromResponses.set('material_chapters', {
      chapters: [
        {
          id: 'ch-1',
          chapter_number: 1,
          title: 'Cells',
          cheat_sheet: '<p>content</p>',
          cheat_sheet_visible: true,
          material_id: 'mat-1',
        },
      ],
    });

    const user = userEvent.setup();
    render(<CheatSheetViewer courseId="course-1" isAdmin classes={classes} />);

    await waitFor(() => {
      expect(screen.getByText('Generated')).toBeInTheDocument();
    });

    expect(screen.getByTestId('assigned-classes-badges')).toBeInTheDocument();

    // The row actions live behind a single trigger now, so nothing but the
    // trigger is on screen until it is opened.
    expect(screen.queryByText('Preview')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cheat sheet actions for Cells' }));

    expect(await screen.findByText('Preview')).toBeInTheDocument();
    expect(screen.getByText('Edit')).toBeInTheDocument();
    expect(screen.getByText('Regenerate')).toBeInTheDocument();
    expect(screen.getByText('Delete')).toBeInTheDocument();
  });

  it('shows a Generate button and no actions menu for a chapter without a cheat sheet', async () => {
    fromResponses.set('course_materials', {
      materials: [
        { id: 'mat-1', title: 'Biology', file_name: 'bio.pdf', material_type: 'textbook' },
      ],
    });
    fromResponses.set('material_chapters', {
      chapters: [
        {
          id: 'ch-1',
          chapter_number: 1,
          title: 'Cells',
          cheat_sheet: null,
          cheat_sheet_visible: false,
          material_id: 'mat-1',
        },
      ],
    });

    render(<CheatSheetViewer courseId="course-1" isAdmin classes={classes} />);

    await waitFor(() => {
      expect(screen.getByText('Generate')).toBeInTheDocument();
    });

    expect(
      screen.queryByRole('button', { name: 'Cheat sheet actions for Cells' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Preview')).not.toBeInTheDocument();
    expect(screen.queryByText('Regenerate')).not.toBeInTheDocument();
    expect(screen.queryByText('Generated')).not.toBeInTheDocument();
  });

  it('does not render the admin table in student (onlyVisible) view', async () => {
    fromResponses.set('course_materials', {
      materials: [
        { id: 'mat-1', title: 'Biology', file_name: 'bio.pdf', material_type: 'textbook' },
      ],
    });
    fromResponses.set('material_chapters', {
      chapters: [
        {
          id: 'ch-1',
          chapter_number: 1,
          title: 'Cells',
          cheat_sheet: '<p>content</p>',
          cheat_sheet_visible: true,
          material_id: 'mat-1',
        },
      ],
    });

    render(<CheatSheetViewer courseId="course-1" onlyVisible />);

    await waitFor(() => {
      expect(screen.getByText(/Ch\. 1: Cells/)).toBeInTheDocument();
    });

    // Admin table headers must NOT appear in student view
    expect(screen.queryByText('Status')).not.toBeInTheDocument();
    expect(screen.queryByText('Visible')).not.toBeInTheDocument();
    expect(screen.queryByText('Actions')).not.toBeInTheDocument();
  });

  it('shows "Untitled Material" placeholder when material title is null', async () => {
    fromResponses.set('course_materials', {
      materials: [
        { id: 'mat-1', title: null, file_name: 'fallback.pdf', material_type: 'textbook' },
      ],
    });
    fromResponses.set('material_chapters', {
      chapters: [
        {
          id: 'ch-1',
          chapter_number: 1,
          title: 'Cells',
          cheat_sheet: null,
          cheat_sheet_visible: false,
          material_id: 'mat-1',
        },
      ],
    });

    render(<CheatSheetViewer courseId="course-1" isAdmin />);

    // When title is null the component always stores "Untitled Material"
    await waitFor(() => {
      expect(screen.getByText('Untitled Material')).toBeInTheDocument();
    });
    expect(screen.queryByText('fallback.pdf')).not.toBeInTheDocument();
  });
});
