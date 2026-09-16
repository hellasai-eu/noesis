import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// Changing a filter starts a new paginated read while the previous one may
// still be running — and paging makes those reads long, so overlap is routine
// rather than a rare race. Whichever finished LAST used to win, which meant a
// slow 90-day read could land after a quick 7-day one and paint the old
// window's figures under the new window's labels.
//
// `fetchAllPages` stops a superseded read between pages and reports
// `aborted: true`; the rows it collected are then an arbitrary prefix. This
// asserts the page refuses to commit them, which is the whole point of the
// flag — a prefix rendered as a report is the same wrongness-that-looks-right
// as the truncation and the swallowed error before it.

const mockNavigate = vi.hoisted(() => vi.fn());
const pager = vi.hoisted(() => ({ aborted: false, rows: [] as unknown[] }));

vi.mock('@/lib/fetch-all-pages', () => ({
  fetchAllPages: vi.fn(async () => ({
    rows: pager.rows,
    truncated: false,
    aborted: pager.aborted,
  })),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: vi.fn(() => ({
      select: () => ({
        order: () => Promise.resolve({ data: [{ id: 'inst-1', name: 'Acme High' }], error: null }),
      }),
    })),
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

const ROW = {
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
};

describe('SuperAdminUsage superseded reads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pager.aborted = false;
    pager.rows = [];
  });

  it('does not render figures from a read that was superseded mid-flight', async () => {
    // Rows were collected, but the read was abandoned for a newer one — so they
    // describe filters nobody is looking at any more.
    pager.aborted = true;
    pager.rows = [ROW];

    render(<SuperAdminUsage />);

    await waitFor(() => {
      expect(screen.queryByTestId('usage-by-model-panel')).toBeNull();
    });
    // Specifically, the prefix must not be presented as a report.
    expect(screen.queryByTestId('usage-by-model-row-gpt-5.4')).toBeNull();
    // Nor should it be reported as a failure — nothing failed.
    expect(screen.queryByTestId('usage-load-error')).toBeNull();
  });

  it('renders normally when the read completes', async () => {
    pager.aborted = false;
    pager.rows = [ROW];

    render(<SuperAdminUsage />);

    await waitFor(() => {
      expect(screen.getByTestId('usage-by-model-panel')).toBeInTheDocument();
    });
    expect(screen.getByTestId('usage-by-model-row-gpt-5.4')).toBeInTheDocument();
  });
});
