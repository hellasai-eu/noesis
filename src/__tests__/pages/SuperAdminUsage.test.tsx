import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// Two ways this page could report something false while looking correct:
//
//   1. A failed query left `stats` null and rendered "No usage data available",
//      so a broken read was indistinguishable from a window with no AI activity
//      at all. Every figure here is an aggregate, so believing a bad one has
//      consequences — someone concludes tutoring stopped, or that costs fell.
//   2. A failed refetch after changing the filters left the *previous* window's
//      numbers on screen, now labelled with the newly-selected date range.
//
// Both are the same failure mode as the unpaginated read this page had: an
// answer that is wrong but carries no sign of being wrong.

const mockNavigate = vi.hoisted(() => vi.fn());
const usageQuery = vi.hoisted(() => ({
  fail: false,
  rows: [] as unknown[],
  /** Resolve a page only when released, so two fetches can be interleaved. */
  gate: null as null | (() => void),
}));

/**
 * Minimal stand-in for the PostgREST builder chain the page uses: every method
 * returns the chain, and the chain is thenable, matching how the real client
 * defers execution until awaited.
 *
 * Thenable rather than resolving on a particular method on purpose — the page
 * paginates by keyset now, so the terminal call is `limit()` plus an optional
 * `or()` cursor filter. A mock that resolved on one named method would keep
 * passing while the page moved to another.
 */
function usageBuilder() {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  for (const method of ['select', 'gte', 'lte', 'order', 'eq', 'limit', 'or']) {
    chain[method] = vi.fn(self);
  }
  chain.then = (resolve: (value: unknown) => unknown) =>
    Promise.resolve(
      usageQuery.fail
        ? { data: null, error: { message: 'statement timeout' } }
        : { data: usageQuery.rows, error: null },
    ).then(resolve);
  return chain;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: vi.fn((table: string) => {
      if (table === 'ai_usage_logs') return usageBuilder();
      if (table === 'institutions') {
        return {
          select: () => ({
            order: () => Promise.resolve({ data: [{ id: 'inst-1', name: 'Acme High' }], error: null }),
          }),
        };
      }
      return { select: () => Promise.resolve({ data: [], error: null }) };
    }),
    rpc: vi.fn(() => Promise.resolve({ data: true, error: null })),
    functions: { invoke: vi.fn() },
  },
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'super-1' },
    profile: { full_name: 'Root', email: 'root@test.local' },
    loading: false,
    signOut: vi.fn(),
  }),
}));

vi.mock('react-router-dom', async () => ({
  useNavigate: () => mockNavigate,
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));

import SuperAdminUsage from '@/pages/SuperAdminUsage';

describe('SuperAdminUsage load failures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usageQuery.fail = false;
    usageQuery.rows = [];
    usageQuery.gate = null;
  });

  it('shows a failed load as a failure, not as an empty window', async () => {
    usageQuery.fail = true;
    render(<SuperAdminUsage />);

    const error = await screen.findByTestId('usage-load-error');
    expect(error).toHaveTextContent('Could not load usage data');
    // The distinction that matters: the reader must not conclude there was no
    // AI activity.
    expect(error).toHaveTextContent('not a quiet period');
    // And the empty state must NOT be what they see.
    expect(screen.queryByTestId('usage-empty-state')).toBeNull();
  });

  it('surfaces the underlying error so the cause is diagnosable', async () => {
    usageQuery.fail = true;
    render(<SuperAdminUsage />);

    expect(await screen.findByTestId('usage-load-error')).toHaveTextContent('statement timeout');
  });

  it('still shows the empty state when the window genuinely has no rows', async () => {
    usageQuery.fail = false;
    usageQuery.rows = [];
    render(<SuperAdminUsage />);

    await waitFor(() => {
      expect(screen.getByTestId('usage-empty-state')).toHaveTextContent('No usage data available');
    });
    expect(screen.queryByTestId('usage-load-error')).toBeNull();
  });

  it('does not render a truncation warning for a window that fits', async () => {
    usageQuery.rows = [
      {
        id: 'row-1',
        model: 'gpt-5.4',
        function_name: 'generate-questions',
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
        input_tokens_cached: 0,
        created_at: new Date().toISOString(),
        outcome: 'success',
        feature: 'question-bank',
        policy_key: 'question-bank.mcq',
        response_time_ms: 1000,
      },
    ];
    render(<SuperAdminUsage />);

    await waitFor(() => {
      expect(screen.queryByTestId('usage-empty-state')).toBeNull();
    });
    expect(screen.queryByTestId('usage-truncated-warning')).toBeNull();
  });
});
