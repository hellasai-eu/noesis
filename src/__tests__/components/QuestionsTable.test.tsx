import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockSupabaseFrom = vi.hoisted(() => vi.fn());

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: mockSupabaseFrom,
  },
}));

vi.mock('@/lib/latex-utils', () => ({
  processLatexContent: (text: string) => text ?? '',
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import { QuestionsTable } from '@/components/QuestionsTable';

type Row = Record<string, unknown>;

const makeChain = (resolved: { data: Row[] | null; error: null } = { data: [], error: null }) => {
  const chain: Record<string, unknown> = {};
  const methods = ['select', 'eq', 'in', 'order', 'limit'];
  for (const m of methods) {
    chain[m] = () => chain;
  }
  chain.then = (onFulfilled: (v: { data: Row[] | null; error: null }) => unknown) =>
    Promise.resolve(onFulfilled(resolved));
  return chain;
};

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    (globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
      ResizeObserverStub;
  }
});

beforeEach(() => {
  mockSupabaseFrom.mockReset();
  mockSupabaseFrom.mockImplementation(() => makeChain({ data: [], error: null }));
});

const baseQuestion = {
  options: ['A', 'B', 'C', 'D'],
  correctIndices: [0],
  explanation: 'Because A is right.',
  difficulty: 'easy' as const,
  chapters: [],
  upvotes: 0,
  downvotes: 0,
  hidden: false,
};

describe('QuestionsTable — generation rationale', () => {
  it('renders the rationale section in the expanded row when present', async () => {
    const user = userEvent.setup();
    const question = {
      ...baseQuestion,
      id: 'q-with-rationale',
      question: 'Question with rationale',
      generationRationale:
        'Drawn from Chapter 2 "Photosynthesis" to test recall of the light-dependent reactions.',
    };

    render(
      <QuestionsTable
        questions={[question]}
        onQuestionsChange={vi.fn()}
        isAdmin
        courseId="course-1"
      />,
    );

    await user.click(screen.getByText('Question with rationale'));

    const rationale = await screen.findByTestId('generation-rationale');
    expect(rationale).toBeTruthy();
    expect(rationale.textContent).toContain('Photosynthesis');
    expect(screen.getByText(/Why this question was generated/i)).toBeTruthy();
  });

  it('hides the rationale section when generationRationale is null', async () => {
    const user = userEvent.setup();
    const question = {
      ...baseQuestion,
      id: 'q-no-rationale',
      question: 'Question without rationale',
      generationRationale: null,
    };

    render(
      <QuestionsTable
        questions={[question]}
        onQuestionsChange={vi.fn()}
        isAdmin
        courseId="course-1"
      />,
    );

    await user.click(screen.getByText('Question without rationale'));

    await waitFor(() => {
      // Expanded row is rendered (explanation visible), but rationale block is not.
      expect(screen.getByText('Because A is right.')).toBeTruthy();
    });
    expect(screen.queryByTestId('generation-rationale')).toBeNull();
    expect(screen.queryByText(/Why this question was generated/i)).toBeNull();
  });
});

describe('QuestionsTable — T/F badge (#602)', () => {
  it('renders the T/F badge when options.length === 2', () => {
    const tfQuestion = {
      ...baseQuestion,
      id: 'q-tf',
      question: 'Photosynthesis converts light into chemical energy.',
      options: ['True', 'False'],
      correctIndices: [0],
    };

    render(
      <QuestionsTable
        questions={[tfQuestion]}
        onQuestionsChange={vi.fn()}
        isAdmin
        courseId="course-1"
      />,
    );

    expect(screen.getByText('T/F')).toBeTruthy();
  });

  it('does NOT render the T/F badge for a 4-option MCQ', () => {
    const fourOption = {
      ...baseQuestion,
      id: 'q-four',
      question: 'Which is prime?',
    };

    render(
      <QuestionsTable
        questions={[fourOption]}
        onQuestionsChange={vi.fn()}
        isAdmin
        courseId="course-1"
      />,
    );

    expect(screen.queryByText('T/F')).toBeNull();
  });
});

describe('QuestionsTable — unified MCQ shape (#582 + #592 multi-correct)', () => {
  it('handleSaveEdit sends type/payload/answer_key with correct_indices (dual-writes correct_index)', async () => {
    const user = userEvent.setup();
    const question = {
      ...baseQuestion,
      id: 'q-edit-dual-write',
      question: 'What is 2+2?',
    };

    // Capture every supabase call so we can assert on the questions UPDATE.
    const calls: Array<{ table: string; method: string; arg: unknown }> = [];
    mockSupabaseFrom.mockImplementation((table: string) => {
      const chain: Record<string, unknown> = {};
      const passthrough = ['select', 'eq', 'in', 'order', 'limit'];
      for (const m of passthrough) {
        chain[m] = () => chain;
      }
      for (const m of ['insert', 'update', 'delete', 'upsert'] as const) {
        chain[m] = (arg?: unknown) => {
          calls.push({ table, method: m, arg });
          return chain;
        };
      }
      chain.then = (cb: (v: { data: unknown[] | null; error: null }) => unknown) =>
        Promise.resolve(cb({ data: [], error: null }));
      return chain;
    });

    render(
      <QuestionsTable
        questions={[question]}
        onQuestionsChange={vi.fn()}
        isAdmin
        courseId="course-1"
      />,
    );

    // Open the action menu and click Edit.
    const triggers = screen.getAllByRole('button');
    const menuTrigger = triggers.find((b) => b.querySelector('svg.lucide-ellipsis')) ?? triggers[triggers.length - 1];
    await user.click(menuTrigger);
    const editItem = await screen.findByRole('menuitem', { name: /^Edit$/ });
    await user.click(editItem);

    // Click "Save Changes" once the dialog is visible.
    const saveBtn = await screen.findByRole('button', { name: /Save Changes/i });
    await user.click(saveBtn);

    await waitFor(() => {
      const updateCall = calls.find((c) => c.table === 'questions' && c.method === 'update');
      expect(updateCall).toBeTruthy();
      const payload = updateCall!.arg as Record<string, unknown>;
      expect(payload.options).toBeUndefined();
      expect(payload.correct_answer).toBeUndefined();
      expect(payload.type).toBe('mcq');
      expect(payload.payload).toEqual({ options: ['A', 'B', 'C', 'D'], multi_correct: false });
      // Multi-correct (#592): unified shape carries `correct_indices`; the
      // legacy `correct_index` is dual-written so pre-#592 readers still grade
      // single-correct rows correctly.
      expect(payload.answer_key).toEqual({ correct_indices: [0], correct_index: 0 });
    });
  });
});
