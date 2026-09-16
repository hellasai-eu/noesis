import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import React from 'react';

const selectCallsByTable: Record<string, string[]> = {};

vi.mock('@/integrations/supabase/client', () => {
  function makeChain(table: string) {
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: vi.fn((columns?: string) => {
        if (typeof columns === 'string') {
          if (!selectCallsByTable[table]) selectCallsByTable[table] = [];
          selectCallsByTable[table].push(columns);
        }
        return chain;
      }),
      insert: vi.fn(() => chain),
      update: vi.fn(() => chain),
      delete: vi.fn(() => chain),
      eq: vi.fn(() => chain),
      neq: vi.fn(() => chain),
      in: vi.fn(() => chain),
      is: vi.fn(() => chain),
      not: vi.fn(() => chain),
      or: vi.fn(() => chain),
      order: vi.fn(() => chain),
      limit: vi.fn(() => chain),
      single: vi.fn().mockResolvedValue({ data: null, error: null }),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      then: vi.fn((cb: (v: { data: unknown[]; error: null }) => void) =>
        Promise.resolve(cb({ data: [], error: null }))
      ),
    });
    return chain;
  }
  return {
    supabase: {
      from: vi.fn((table: string) => makeChain(table)),
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
      functions: { invoke: vi.fn().mockResolvedValue({ data: null, error: null }) },
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
    },
  };
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@/lib/latex-utils', () => ({
  processLatexContent: (text: string) => text,
}));

import { TestBuilder } from '@/components/TestBuilder';

function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

describe('TestBuilder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const k of Object.keys(selectCallsByTable)) delete selectCallsByTable[k];
  });

  it('renders without crashing', () => {
    render(
      <QueryClientProvider client={createQueryClient()}>
        <BrowserRouter>
          <TestBuilder courseId="course-123" />
        </BrowserRouter>
      </QueryClientProvider>
    );
    expect(document.body).toBeTruthy();
  });

  it('rerenders with different courseId', () => {
    const { rerender } = render(
      <QueryClientProvider client={createQueryClient()}>
        <BrowserRouter>
          <TestBuilder courseId="course-1" />
        </BrowserRouter>
      </QueryClientProvider>
    );
    rerender(
      <QueryClientProvider client={createQueryClient()}>
        <BrowserRouter>
          <TestBuilder courseId="course-2" />
        </BrowserRouter>
      </QueryClientProvider>
    );
    expect(document.body).toBeTruthy();
  });

  // #579 reader migration / #653 unified bank: questions of all 5 non-interactive
  // types are fetched from the unified `questions` table via `useUnifiedQuestions`,
  // which selects `*`. The legacy `open_questions` table is no longer read.
  it('reads from the unified questions table via the unified loader', async () => {
    render(
      <QueryClientProvider client={createQueryClient()}>
        <BrowserRouter>
          <TestBuilder courseId="course-123" />
        </BrowserRouter>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(selectCallsByTable['questions']?.length ?? 0).toBeGreaterThan(0);
    });

    const questionsSelects = selectCallsByTable['questions'] || [];
    // The unified loader selects "*" — that's the load-bearing assertion;
    // the type/payload/answer_key columns are part of the full row.
    const unifiedSelect = questionsSelects.find(
      (cols) =>
        cols.trim() === '*' ||
        (cols.includes('type') && cols.includes('payload') && cols.includes('answer_key')),
    );
    expect(unifiedSelect).toBeDefined();
  });

  it('does not read questions from the legacy open_questions table', async () => {
    render(
      <QueryClientProvider client={createQueryClient()}>
        <BrowserRouter>
          <TestBuilder courseId="course-123" />
        </BrowserRouter>
      </QueryClientProvider>
    );

    // Wait for the unified read to fire before asserting absence on the legacy table.
    await waitFor(() => {
      expect(selectCallsByTable['questions']?.length ?? 0).toBeGreaterThan(0);
    });

    expect(selectCallsByTable['open_questions']).toBeUndefined();
  });
});
