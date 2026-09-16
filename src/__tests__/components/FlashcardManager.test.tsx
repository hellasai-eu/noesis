import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';

const fromResponses = new Map<string, { chapters?: any[] }>();

function makeChain(table: string) {
  const resolveSelect = () => {
    const data = fromResponses.get(table);
    if (table === 'material_chapters') {
      return Promise.resolve({ data: data?.chapters ?? [], error: null });
    }
    return Promise.resolve({ data: [], error: null });
  };

  const chain: any = {};
  chain.select = vi.fn().mockImplementation(() => {
    const q: any = {};
    q.eq = vi.fn().mockReturnValue(q);
    q.order = vi.fn().mockReturnValue(q);
    q.then = (cb: any) => resolveSelect().then(cb);
    return q;
  });
  chain.update = vi.fn().mockImplementation(() => ({
    eq: vi.fn().mockResolvedValue({ data: null, error: null }),
  }));
  return chain;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (table: string) => makeChain(table),
    functions: { invoke: vi.fn() },
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@/hooks/useContentAssignments', () => ({
  useContentAssignments: () => ({
    getAssignedOfferingIds: () => [],
    getAssignedTargets: () => [],
    saveAssignments: vi.fn().mockResolvedValue(undefined),
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
  AssignedClassesBadges: () => <div data-testid="assigned-classes-badges" />,
}));

vi.mock('@/components/FlashcardViewer', () => ({
  default: () => <div data-testid="flashcard-viewer" />,
}));

import { FlashcardManager } from '@/components/FlashcardManager';

beforeEach(() => {
  vi.clearAllMocks();
  fromResponses.clear();
});

describe('FlashcardManager card wrapper', () => {
  it('renders the Flashcards table inside a Card with a CardHeader title', async () => {
    fromResponses.set('material_chapters', {
      chapters: [
        {
          id: 'ch-1',
          chapter_number: 1,
          title: 'Cells',
          flashcards: [{ q: 'Q', a: 'A' }],
          flashcards_visible: true,
          course_materials: { id: 'mat-1', title: 'Biology', file_name: 'bio.pdf' },
        },
      ],
    });

    const { container } = render(
      <FlashcardManager courseId="course-1" classes={[]} />
    );

    await waitFor(() => {
      expect(screen.getByText(/Ch\. 1: Cells/)).toBeInTheDocument();
    });

    // The "Flashcards" title and the table row must both be inside the same Card wrapper.
    const card = container.querySelector('[data-testid="flashcard-card"]');
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain('Flashcards');
    expect(card!.textContent).toContain('Ch. 1: Cells');

    // Sanity: column headers visible inside the card
    expect(screen.getByText('Chapter')).toBeInTheDocument();
    expect(screen.getByText('Material')).toBeInTheDocument();
    expect(screen.getByText('Status')).toBeInTheDocument();
    expect(screen.getByText('Actions')).toBeInTheDocument();
  });

  it('shows a refresh button in the Card header', async () => {
    fromResponses.set('material_chapters', {
      chapters: [
        {
          id: 'ch-1',
          chapter_number: 1,
          title: 'Cells',
          flashcards: null,
          flashcards_visible: false,
          course_materials: { id: 'mat-1', title: 'Biology', file_name: 'bio.pdf' },
        },
      ],
    });

    render(<FlashcardManager courseId="course-1" classes={[]} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /refresh flashcards/i })).toBeInTheDocument();
    });
  });

  it('renders the empty-state in a single Card (no double-nesting) when there are no chapters', async () => {
    fromResponses.set('material_chapters', { chapters: [] });

    const { container } = render(
      <FlashcardManager courseId="course-1" classes={[]} />
    );

    await waitFor(() => {
      expect(screen.getByText('No Textbook Chapters')).toBeInTheDocument();
    });

    // Empty state should render exactly one Card, not nested cards.
    const cards = container.querySelectorAll('[data-testid="flashcard-card"]');
    expect(cards.length).toBe(1);
  });
});
