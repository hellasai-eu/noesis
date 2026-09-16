import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockSupabaseFrom = vi.hoisted(() => vi.fn());

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: mockSupabaseFrom,
  },
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import { OpenQuestionsTable } from '@/components/OpenQuestionsTable';

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
  modelAnswer: 'Sample model answer.',
  explanation: 'Detailed explanation.',
  difficulty: 'medium' as const,
  chapters: [],
  upvotes: 0,
  downvotes: 0,
  hidden: false,
};

describe('OpenQuestionsTable — generation rationale', () => {
  it('renders the rationale section in the expanded view when present', async () => {
    const user = userEvent.setup();
    const longQuestion = 'A'.repeat(200);
    const question = {
      ...baseQuestion,
      id: 'oq-with-rationale',
      question: longQuestion,
      generationRationale:
        'Derived from Chapter 4 "Newton\'s Laws" to test the student\'s ability to articulate F=ma in plain language.',
    };

    render(
      <OpenQuestionsTable
        questions={[question]}
        onQuestionsChange={vi.fn()}
        isAdmin
      />,
    );

    // The question text in the cell triggers expansion when clicked.
    await user.click(screen.getByText(longQuestion));

    const rationale = await screen.findByTestId('generation-rationale');
    expect(rationale).toBeTruthy();
    expect(rationale.textContent).toContain("Newton's Laws");
    expect(screen.getByText(/Why this question was generated/i)).toBeTruthy();
  });

  it('hides the rationale section when generationRationale is null', async () => {
    const user = userEvent.setup();
    const longQuestion = 'B'.repeat(200);
    const question = {
      ...baseQuestion,
      id: 'oq-no-rationale',
      question: longQuestion,
      generationRationale: null,
    };

    render(
      <OpenQuestionsTable
        questions={[question]}
        onQuestionsChange={vi.fn()}
        isAdmin
      />,
    );

    await user.click(screen.getByText(longQuestion));

    await waitFor(() => {
      // Model answer block is rendered when expanded, but no rationale.
      expect(screen.getByText('Sample model answer.')).toBeTruthy();
    });
    expect(screen.queryByTestId('generation-rationale')).toBeNull();
    expect(screen.queryByText(/Why this question was generated/i)).toBeNull();
  });
});

/**
 * A question's answering mode is fixed when it is created — the AI Interactive
 * tab writes "interactive", the Question Bank's generator writes "single". The
 * inline Switch and the edit-dialog checkbox that used to flip it (#659, #596)
 * are gone, along with the destructive progress wipe they triggered.
 */
describe('OpenQuestionsTable — answering mode is not switchable', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://test.supabase.co');
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'anon-test');
  });

  it('renders no per-row mode Switch and no AI Interactive column', () => {
    render(
      <OpenQuestionsTable
        questions={[
          { ...baseQuestion, id: 'q-i', question: 'Interactive question' },
        ]}
        onQuestionsChange={vi.fn()}
        isAdmin
      />,
    );

    expect(screen.queryAllByRole('switch')).toHaveLength(0);
    expect(
      screen.queryByRole('columnheader', { name: /ai interactive/i }),
    ).not.toBeInTheDocument();
  });

  it('offers no mode control in the edit dialog, and saving hits no reset endpoint', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch;
    global.fetch = fetchSpy;

    const calls: Array<{ table: string; method: string; arg: unknown }> = [];
    mockSupabaseFrom.mockImplementation((table: string) => {
      const chain: Record<string, unknown> = {};
      const passthrough = ['select', 'eq', 'in', 'order', 'limit', 'single', 'maybeSingle'];
      for (const m of passthrough) chain[m] = () => chain;
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
      <OpenQuestionsTable
        questions={[{ ...baseQuestion, id: 'q-edit', question: 'Edit me' }]}
        onQuestionsChange={vi.fn()}
        isAdmin
      />,
    );

    const triggers = screen.getAllByRole('button');
    const menuTrigger =
      triggers.find((b) => b.querySelector('svg.lucide-ellipsis')) ?? triggers[triggers.length - 1];
    await user.click(menuTrigger);
    await user.click(await screen.findByRole('menuitem', { name: /^Edit$/ }));

    const saveBtn = await screen.findByRole('button', { name: /Save Changes/i });
    expect(screen.queryByLabelText(/AI Interactive Learning/i)).not.toBeInTheDocument();

    await user.click(saveBtn);

    await waitFor(() => {
      expect(calls.find((c) => c.table === 'questions' && c.method === 'update')).toBeTruthy();
    });
    // No destructive progress wipe is involved any more.
    expect((fetchSpy as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
  });

  it("preserves the row's stored mode through an edit rather than rewriting it", async () => {
    const user = userEvent.setup();
    const calls: Array<{ table: string; method: string; arg: unknown }> = [];
    mockSupabaseFrom.mockImplementation((table: string) => {
      const chain: Record<string, unknown> = {};
      const passthrough = ['select', 'eq', 'in', 'order', 'limit', 'single', 'maybeSingle'];
      for (const m of passthrough) chain[m] = () => chain;
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
      <OpenQuestionsTable
        questions={[
          {
            ...baseQuestion,
            id: 'q-single',
            question: 'A single-answer row',
            answeringMode: 'single' as const,
          },
        ]}
        onQuestionsChange={vi.fn()}
        isAdmin
      />,
    );

    const triggers = screen.getAllByRole('button');
    const menuTrigger =
      triggers.find((b) => b.querySelector('svg.lucide-ellipsis')) ?? triggers[triggers.length - 1];
    await user.click(menuTrigger);
    await user.click(await screen.findByRole('menuitem', { name: /^Edit$/ }));
    await user.click(await screen.findByRole('button', { name: /Save Changes/i }));

    await waitFor(() => {
      const update = calls.find((c) => c.table === 'questions' && c.method === 'update');
      expect(update).toBeTruthy();
      expect((update!.arg as Record<string, unknown>).payload).toEqual({
        answering_mode: 'single',
      });
    });
  });
});

describe('OpenQuestionsTable — unified questions write (#582)', () => {
  it('handleSaveEdit updates the questions row with the unified open shape only (open_questions table is gone)', async () => {
    const user = userEvent.setup();
    const longQuestion = 'C'.repeat(200);
    const question = {
      ...baseQuestion,
      id: 'oq-edit-dual-write',
      question: longQuestion,
    };

    const calls: Array<{ table: string; method: string; arg: unknown }> = [];
    mockSupabaseFrom.mockImplementation((table: string) => {
      const chain: Record<string, unknown> = {};
      const passthrough = ['select', 'eq', 'in', 'order', 'limit', 'single', 'maybeSingle'];
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
      <OpenQuestionsTable
        questions={[question]}
        onQuestionsChange={vi.fn()}
        isAdmin
      />,
    );

    const triggers = screen.getAllByRole('button');
    const menuTrigger = triggers.find((b) => b.querySelector('svg.lucide-ellipsis')) ?? triggers[triggers.length - 1];
    await user.click(menuTrigger);
    const editItem = await screen.findByRole('menuitem', { name: /^Edit$/ });
    await user.click(editItem);

    const saveBtn = await screen.findByRole('button', { name: /Save Changes/i });
    await user.click(saveBtn);

    await waitFor(() => {
      // The legacy `open_questions` table is gone — only `questions` is written.
      const legacyOpenUpdate = calls.find((c) => c.table === 'open_questions');
      expect(legacyOpenUpdate).toBeUndefined();

      const questionUpdate = calls.find((c) => c.table === 'questions' && c.method === 'update');
      expect(questionUpdate).toBeTruthy();
      const payload = questionUpdate!.arg as Record<string, unknown>;
      // Edit-dialog saves now always stamp the answering mode explicitly
      // (single OR interactive). Loaded value here defaulted to interactive.
      expect(payload.payload).toEqual({ answering_mode: 'interactive' });
      expect(payload.answer_key).toEqual({
        model_answer: 'Sample model answer.',
        rubric: null,
        explanation: 'Detailed explanation.',
      });
    });
  });
});

/**
 * #1084 — the AI Interactive Questions table dropped the Votes column to buy
 * width.
 */
describe('OpenQuestionsTable — Votes column removed (#1084)', () => {
  it('renders no Votes header', () => {
    render(
      <OpenQuestionsTable
        questions={[{ ...baseQuestion, id: 'q1', question: 'Q one' }]}
        onQuestionsChange={() => {}}
        isAdmin
      />,
    );
    expect(screen.queryByRole('columnheader', { name: /votes/i })).not.toBeInTheDocument();
  });

  it('still renders the columns either side of where Votes used to sit', () => {
    render(
      <OpenQuestionsTable
        questions={[{ ...baseQuestion, id: 'q1', question: 'Q one' }]}
        onQuestionsChange={() => {}}
        isAdmin
      />,
    );
    // Guards against deleting one <TableHead> too many.
    expect(screen.getByRole('columnheader', { name: /difficulty/i })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /author/i })).toBeInTheDocument();
  });
});

describe('OpenQuestionsTable — assignment', () => {
  const classes = [
    { id: 'c1', offering_id: 'o1', name: 'Class A', grade_level: null, section_name: null },
  ] as never;

  const interactiveQ = {
    ...baseQuestion,
    id: 'q-i',
    question: 'Interactive question',
    answeringMode: 'interactive' as const,
  };
  const otherQ = {
    ...baseQuestion,
    id: 'q-i2',
    question: 'Another interactive question',
    answeringMode: 'interactive' as const,
  };

  function renderTable(questions: unknown[], onBulkAssign = vi.fn()) {
    const onOpenAssignDialog = vi.fn();
    render(
      <OpenQuestionsTable
        questions={questions as never}
        onQuestionsChange={() => {}}
        isAdmin
        classes={classes}
        assignmentsByQuestionId={{ 'q-i': [], 'q-i2': [] }}
        onOpenAssignDialog={onOpenAssignDialog}
        onBulkAssign={onBulkAssign}
      />,
    );
    return { onOpenAssignDialog, onBulkAssign };
  }

  it('offers the per-row Assign affordance — every row on this tab is AI Interactive', () => {
    renderTable([interactiveQ]);
    expect(screen.getByRole('button', { name: /assign/i })).toBeInTheDocument();
    expect(screen.queryByTestId('assign-blocked-q-i')).not.toBeInTheDocument();
  });

  it('bulk assign passes on every selected row', async () => {
    const user = userEvent.setup();
    const onBulkAssign = vi.fn();
    renderTable([interactiveQ, otherQ], onBulkAssign);

    // Select every row via the header checkbox.
    const checkboxes = screen.getAllByRole('checkbox');
    await user.click(checkboxes[0]);

    const bulk = await screen.findByTestId('bulk-assign');
    expect(bulk).toHaveTextContent('Assign (2)');

    await user.click(bulk);
    expect(onBulkAssign).toHaveBeenCalledWith(['q-i', 'q-i2']);
  });

  it('ignores selected ids whose question no longer exists (#1084 review)', async () => {
    // `selectedIds` survives a change to `questions` (a delete, or a filter
    // change), so it can hold ids with no row behind them. Those must not be
    // counted as assignable.
    const user = userEvent.setup();
    const onBulkAssign = vi.fn();
    const { rerender } = render(
      <OpenQuestionsTable
        questions={[interactiveQ, otherQ] as never}
        onQuestionsChange={() => {}}
        isAdmin
        classes={classes}
        assignmentsByQuestionId={{ 'q-i': [], 'q-i2': [] }}
        onOpenAssignDialog={vi.fn()}
        onBulkAssign={onBulkAssign}
      />,
    );

    await user.click(screen.getAllByRole('checkbox')[0]);
    expect(await screen.findByTestId('bulk-assign')).toHaveTextContent('Assign (2)');

    // One row disappears from the dataset; its id stays selected.
    rerender(
      <OpenQuestionsTable
        questions={[interactiveQ] as never}
        onQuestionsChange={() => {}}
        isAdmin
        classes={classes}
        assignmentsByQuestionId={{ 'q-i': [] }}
        onOpenAssignDialog={vi.fn()}
        onBulkAssign={onBulkAssign}
      />,
    );

    const bulk = await screen.findByTestId('bulk-assign');
    expect(bulk).toHaveTextContent('Assign (1)');

    await user.click(bulk);
    expect(onBulkAssign).toHaveBeenCalledWith(['q-i']);
  });

  it('disables bulk assign when nothing is selected', async () => {
    renderTable([interactiveQ]);
    expect(screen.queryByTestId('bulk-assign')).not.toBeInTheDocument();
  });
});
