import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';

beforeAll(() => {
  global.ResizeObserver = class ResizeObserver {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  } as unknown as typeof ResizeObserver;
});

const mockFrom = vi.fn();
const mockInvoke = vi.fn();
const channelHandlers: Array<{
  config: { event: string; table: string; filter?: string };
  handler: (payload: { new: unknown; old?: unknown }) => void;
}> = [];
let lastSubscribeStatusCb: ((status: string) => void) | null = null;

const channelMock = {
  on: vi.fn((_evt: string, config: { event: string; table: string; filter?: string }, handler: (payload: { new: unknown; old?: unknown }) => void) => {
    channelHandlers.push({ config, handler });
    return channelMock;
  }),
  subscribe: vi.fn((cb?: (status: string) => void) => {
    lastSubscribeStatusCb = cb ?? null;
    return { unsubscribe: vi.fn() };
  }),
};

// Default RPC behavior: caller is admin (so the Retry button is visible
// in tests that exercise retry-able rows). Individual tests can override
// this with mockRpc.mockImplementation(...) before render.
const mockRpc = vi.fn((name: string) => {
  if (name === 'is_super_admin') return Promise.resolve({ data: false, error: null });
  if (name === 'is_admin') return Promise.resolve({ data: true, error: null });
  return Promise.resolve({ data: null, error: null });
});

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (...args: unknown[]) => mockFrom(...args),
    channel: vi.fn(() => channelMock),
    removeChannel: vi.fn(),
    rpc: (...args: unknown[]) => mockRpc(...(args as [string])),
    auth: {
      getUser: vi.fn(() => Promise.resolve({ data: { user: { id: 'admin-1' } }, error: null })),
    },
    functions: {
      invoke: (...args: unknown[]) => mockInvoke(...args),
    },
  },
}));

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  }),
}));

import { JobProgressList } from '@/components/JobProgressList';

function createChain(data: unknown = []) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  const methods = ['select', 'eq', 'neq', 'in', 'not', 'order', 'limit', 'update'];
  for (const m of methods) {
    chain[m] = vi.fn(() => chain);
  }
  chain.then = vi.fn((cb) => Promise.resolve(cb({ data, error: null })));
  for (const key of Object.keys(chain)) {
    if (typeof chain[key] === 'function' && key !== 'then') {
      (chain[key] as ReturnType<typeof vi.fn>).mockReturnValue(chain);
    }
  }
  return chain;
}

describe('JobProgressList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    channelHandlers.length = 0;
    lastSubscribeStatusCb = null;
    mockInvoke.mockReset();
    // Restore the "caller is admin" default after clearAllMocks wipes it.
    mockRpc.mockImplementation((name: string) => {
      if (name === 'is_super_admin') return Promise.resolve({ data: false, error: null });
      if (name === 'is_admin') return Promise.resolve({ data: true, error: null });
      return Promise.resolve({ data: null, error: null });
    });
  });

  it('renders nothing when there are no jobs and realtime is healthy', async () => {
    mockFrom.mockReturnValue(createChain([]));
    const { container } = render(<JobProgressList courseId="course-1" />);
    // Wait for the fetch to resolve and the render to settle.
    await waitFor(() => {
      expect(screen.queryByTestId('job-progress-list')).toBeNull();
    });
    expect(container.firstChild).toBeNull();
  });

  it('renders one card per job with humanized type and status badge', async () => {
    const jobs = [
      {
        id: 'j1',
        type: 'bulk_question_generation',
        status: 'processing',
        progress: { total: 4, completed: 1, failed: 0 },
        created_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        ended_at: null,
        error: null,
      },
      {
        id: 'j2',
        type: 'bulk_question_generation',
        status: 'completed',
        progress: { total: 2, completed: 2, failed: 0, created_total: 10 },
        created_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        ended_at: new Date().toISOString(),
        error: null,
      },
    ];
    mockFrom.mockReturnValue(createChain(jobs));
    render(<JobProgressList courseId="course-1" />);
    await waitFor(() => {
      expect(screen.getAllByTestId('job-progress-item')).toHaveLength(2);
    });
    expect(screen.getAllByText('Bulk Question Generation')).toHaveLength(2);
    expect(screen.getByText('Running')).toBeTruthy();
    expect(screen.getByText('Completed')).toBeTruthy();
    expect(screen.getByText('10 created')).toBeTruthy();
  });

  // The `@ai` E2E harness has no other handle on a single job: it enqueues one,
  // gets its id back, and must assert about that card alone. Losing either
  // attribute silently returns it to page-wide assertions, which failed a retry
  // on a stale neighbour's failed batch (#1067).
  it('identifies each card by job id and publishes its raw status', async () => {
    const jobs = [
      {
        id: 'j1',
        type: 'bulk_question_generation',
        status: 'processing',
        progress: { total: 4, completed: 1, failed: 0 },
        created_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        ended_at: null,
        error: null,
      },
      {
        id: 'j2',
        type: 'bulk_question_generation',
        status: 'partially_completed',
        progress: { total: 2, completed: 1, failed: 1 },
        created_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        ended_at: new Date().toISOString(),
        error: null,
      },
    ];
    mockFrom.mockReturnValue(createChain(jobs));
    render(<JobProgressList courseId="course-1" />);
    await waitFor(() => {
      expect(screen.getAllByTestId('job-progress-item')).toHaveLength(2);
    });

    const cards = screen.getAllByTestId('job-progress-item');
    expect(cards.map((c) => c.getAttribute('data-job-id'))).toEqual(['j1', 'j2']);
    expect(cards.map((c) => c.getAttribute('data-status'))).toEqual([
      'processing',
      'partially_completed',
    ]);
  });

  it('updates a job card when a realtime UPDATE arrives', async () => {
    const jobs = [
      {
        id: 'j1',
        type: 'bulk_question_generation',
        status: 'processing',
        progress: { total: 4, completed: 1, failed: 0 },
        created_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        ended_at: null,
        error: null,
      },
    ];
    mockFrom.mockReturnValue(createChain(jobs));
    render(<JobProgressList courseId="course-1" />);
    await waitFor(() => {
      expect(screen.getByText('Running')).toBeTruthy();
    });

    const updateHandler = channelHandlers.find((h) => h.config.event === 'UPDATE');
    expect(updateHandler).toBeTruthy();
    updateHandler!.handler({
      new: {
        ...jobs[0],
        status: 'completed',
        progress: { total: 4, completed: 4, failed: 0 },
        ended_at: new Date().toISOString(),
      },
    });
    await waitFor(() => {
      expect(screen.getByText('Completed')).toBeTruthy();
    });
  });

  it('renders a Cancel button on non-terminal jobs and invokes the cancel-job function', async () => {
    const jobs = [
      {
        id: 'j1',
        type: 'bulk_question_generation',
        status: 'processing',
        progress: { total: 4, completed: 1, failed: 0 },
        created_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        ended_at: null,
        error: null,
      },
      {
        id: 'j2',
        type: 'bulk_question_generation',
        status: 'completed',
        progress: { total: 2, completed: 2, failed: 0 },
        created_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        ended_at: new Date().toISOString(),
        error: null,
      },
    ];
    mockFrom.mockReturnValue(createChain(jobs));
    mockInvoke.mockResolvedValue({ data: { ok: true, status: 'cancelled' }, error: null });

    render(<JobProgressList courseId="course-1" />);
    await waitFor(() => {
      expect(screen.getAllByTestId('job-progress-item')).toHaveLength(2);
    });

    // Only the non-terminal (processing) job should expose a cancel button.
    const cancelButtons = screen.getAllByTestId('job-cancel-button');
    expect(cancelButtons).toHaveLength(1);

    // Click → confirm in the AlertDialog → cancel-job invoked.
    cancelButtons[0].click();
    await waitFor(() => {
      expect(screen.getByTestId('job-cancel-confirm')).toBeTruthy();
    });
    screen.getByTestId('job-cancel-confirm').click();

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('cancel-job', {
        body: { jobId: 'j1' },
      });
    });
  });

  it('omits course_id filter when courseId is not provided (global mode)', async () => {
    const eqSpy = vi.fn();
    const chain = createChain([]);
    chain.eq = vi.fn((col: string, val: unknown) => {
      eqSpy(col, val);
      return chain;
    });
    mockFrom.mockReturnValue(chain);
    render(<JobProgressList />);
    await waitFor(() => {
      expect(chain.select).toHaveBeenCalled();
    });
    // No `.eq("course_id", …)` filter when courseId is omitted.
    expect(eqSpy).not.toHaveBeenCalledWith('course_id', expect.anything());
  });

  it('renders a Stalled badge for processing jobs with a stale heartbeat', async () => {
    // Heartbeat 10 minutes ago — well past the 5-min stall threshold.
    const staleHeartbeat = new Date(Date.now() - 10 * 60_000).toISOString();
    const jobs = [
      {
        id: 'j1',
        type: 'bulk_question_generation',
        status: 'processing',
        progress: { total: 4, completed: 1, failed: 0, updated_at: staleHeartbeat },
        created_at: new Date().toISOString(),
        started_at: staleHeartbeat,
        ended_at: null,
        error: null,
        last_heartbeat: staleHeartbeat,
      },
    ];
    mockFrom.mockReturnValue(createChain(jobs));
    render(<JobProgressList courseId="course-1" />);
    await waitFor(() => {
      expect(screen.getByTestId('job-stalled-badge')).toBeTruthy();
    });
    expect(screen.queryByText('Running')).toBeNull();
    // Resume button appears alongside the badge.
    expect(screen.getByTestId('job-resume-button')).toBeTruthy();
  });

  it('does NOT render the Stalled badge for a fresh processing job', async () => {
    const fresh = new Date().toISOString();
    const jobs = [
      {
        id: 'j1',
        type: 'bulk_question_generation',
        status: 'processing',
        progress: { total: 4, completed: 1, failed: 0, updated_at: fresh },
        created_at: fresh,
        started_at: fresh,
        ended_at: null,
        error: null,
        last_heartbeat: fresh,
      },
    ];
    mockFrom.mockReturnValue(createChain(jobs));
    render(<JobProgressList courseId="course-1" />);
    await waitFor(() => {
      expect(screen.getByText('Running')).toBeTruthy();
    });
    expect(screen.queryByTestId('job-stalled-badge')).toBeNull();
    expect(screen.queryByTestId('job-resume-button')).toBeNull();
  });

  it('does NOT render the Stalled badge for terminal jobs even when timestamps are old', async () => {
    const old = new Date(Date.now() - 60 * 60_000).toISOString();
    const jobs = [
      {
        id: 'j1',
        type: 'bulk_question_generation',
        status: 'completed',
        progress: { total: 2, completed: 2, failed: 0, updated_at: old },
        created_at: old,
        started_at: old,
        ended_at: old,
        error: null,
      },
    ];
    mockFrom.mockReturnValue(createChain(jobs));
    render(<JobProgressList courseId="course-1" />);
    await waitFor(() => {
      expect(screen.getByText('Completed')).toBeTruthy();
    });
    expect(screen.queryByTestId('job-stalled-badge')).toBeNull();
    expect(screen.queryByTestId('job-resume-button')).toBeNull();
  });

  it('invokes resume-job when the Resume button is clicked', async () => {
    const staleHeartbeat = new Date(Date.now() - 10 * 60_000).toISOString();
    const jobs = [
      {
        id: 'j1',
        type: 'bulk_question_generation',
        status: 'processing',
        progress: { total: 4, completed: 1, failed: 0, updated_at: staleHeartbeat },
        created_at: staleHeartbeat,
        started_at: staleHeartbeat,
        ended_at: null,
        error: null,
      },
    ];
    mockFrom.mockReturnValue(createChain(jobs));
    mockInvoke.mockResolvedValue({ data: { ok: true, status: 'resumed' }, error: null });

    render(<JobProgressList courseId="course-1" />);
    await waitFor(() => {
      expect(screen.getByTestId('job-resume-button')).toBeTruthy();
    });

    screen.getByTestId('job-resume-button').click();

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('resume-job', {
        body: { jobId: 'j1' },
      });
    });
  });

  it('renders a Retry button on failed jobs and invokes retry-job', async () => {
    const jobs = [
      {
        id: 'j-failed',
        type: 'bulk_question_generation',
        status: 'failed',
        progress: { total: 4, completed: 1, failed: 3 },
        created_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        ended_at: new Date().toISOString(),
        error: 'OpenAI 500',
        locked_until: '1970-01-01T00:00:00.000Z',
      },
    ];
    mockFrom.mockReturnValue(createChain(jobs));
    mockInvoke.mockResolvedValue({ data: { ok: true, status: 'retried' }, error: null });

    render(<JobProgressList courseId="course-1" />);
    await waitFor(() => {
      expect(screen.getByTestId('job-retry-button')).toBeTruthy();
    });
    // Failed jobs still show their error message.
    expect(screen.getByText('OpenAI 500')).toBeTruthy();

    screen.getByTestId('job-retry-button').click();
    await waitFor(() => {
      expect(screen.getByTestId('job-retry-confirm')).toBeTruthy();
    });
    screen.getByTestId('job-retry-confirm').click();

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('retry-job', {
        body: { jobId: 'j-failed' },
      });
    });
  });

  it('treats a fresh-heartbeat job with a past lease as Running, not Stalled', async () => {
    // Regression guard for the "always stalled" bug: the runner writes
    // `locked_until` to the Unix epoch on every clean mid-slice exit so the
    // next pg_cron tick can reclaim immediately. A healthy multi-slice job
    // therefore sits with a past `locked_until` between ticks. It must NOT be
    // flagged as stalled — heartbeat freshness is the real signal.
    const fresh = new Date().toISOString();
    const jobs = [
      {
        id: 'j-healthy',
        type: 'bulk_question_generation',
        status: 'processing',
        progress: { total: 4, completed: 1, failed: 0, updated_at: fresh },
        created_at: fresh,
        started_at: fresh,
        ended_at: null,
        error: null,
        // Lease released to the epoch (between slices) but heartbeat is fresh.
        locked_until: '1970-01-01T00:00:00.000Z',
        last_heartbeat: fresh,
      },
    ];
    mockFrom.mockReturnValue(createChain(jobs));
    render(<JobProgressList courseId="course-1" />);
    await waitFor(() => {
      expect(screen.getByText('Running')).toBeTruthy();
    });
    expect(screen.queryByTestId('job-stalled-badge')).toBeNull();
    expect(screen.queryByTestId('job-retry-button')).toBeNull();
    expect(screen.queryByTestId('job-resume-button')).toBeNull();
  });

  it('renders Stalled + Retry on a processing job whose heartbeat has aged out', async () => {
    const stale = new Date(Date.now() - 10 * 60_000).toISOString();
    const jobs = [
      {
        id: 'j-stuck',
        type: 'bulk_question_generation',
        status: 'processing',
        progress: { total: 4, completed: 1, failed: 0, updated_at: stale },
        created_at: stale,
        started_at: stale,
        ended_at: null,
        error: null,
        // A dead worker leaves both the lease and the heartbeat in the past.
        locked_until: '1970-01-01T00:00:00.000Z',
        last_heartbeat: stale,
      },
    ];
    mockFrom.mockReturnValue(createChain(jobs));
    render(<JobProgressList courseId="course-1" />);
    await waitFor(() => {
      expect(screen.getByTestId('job-retry-button')).toBeTruthy();
    });
    expect(screen.getByTestId('job-stalled-badge')).toBeTruthy();
  });

  it('does NOT render Retry on partially_completed jobs for non-admin callers', async () => {
    mockRpc.mockImplementation((name: string) => {
      if (name === 'is_super_admin') return Promise.resolve({ data: false, error: null });
      if (name === 'is_admin') return Promise.resolve({ data: false, error: null });
      return Promise.resolve({ data: null, error: null });
    });
    const jobs = [
      {
        id: 'j-partial',
        type: 'bulk_question_generation',
        status: 'partially_completed',
        progress: { total: 4, completed: 3, failed: 1, created_total: 15, failed_total: 2 },
        created_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        ended_at: new Date().toISOString(),
        error: null,
        locked_until: '1970-01-01T00:00:00.000Z',
      },
    ];
    mockFrom.mockReturnValue(createChain(jobs));
    render(<JobProgressList courseId="course-1" />);
    await waitFor(() => {
      expect(screen.getByText('Partial')).toBeTruthy();
    });
    // Non-admin: button is hidden even though the job is in a retryable state.
    expect(screen.queryByTestId('job-retry-button')).toBeNull();
    // Per-item counts still render for visibility.
    expect(screen.getByText(/15 created/)).toBeTruthy();
  });

  it('does NOT render Retry on completed jobs', async () => {
    const jobs = [
      {
        id: 'j-done',
        type: 'bulk_question_generation',
        status: 'completed',
        progress: { total: 2, completed: 2, failed: 0 },
        created_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        ended_at: new Date().toISOString(),
        error: null,
        locked_until: '1970-01-01T00:00:00.000Z',
      },
    ];
    mockFrom.mockReturnValue(createChain(jobs));
    render(<JobProgressList courseId="course-1" />);
    await waitFor(() => {
      expect(screen.getByText('Completed')).toBeTruthy();
    });
    expect(screen.queryByTestId('job-retry-button')).toBeNull();
  });

  it('shows refresh button when realtime subscribe fails', async () => {
    const jobs = [
      {
        id: 'j1',
        type: 'bulk_question_generation',
        status: 'processing',
        progress: { total: 4, completed: 1, failed: 0 },
        created_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        ended_at: null,
        error: null,
      },
    ];
    mockFrom.mockReturnValue(createChain(jobs));
    render(<JobProgressList courseId="course-1" />);
    await waitFor(() => {
      expect(screen.getByTestId('job-progress-list')).toBeTruthy();
    });
    expect(lastSubscribeStatusCb).toBeTruthy();
    lastSubscribeStatusCb!('CHANNEL_ERROR');
    await waitFor(() => {
      expect(screen.getByTestId('job-progress-refresh')).toBeTruthy();
    });
  });

  // ── Per-batch detail (#809) ─────────────────────────────────────────
  //
  // The detail drawer lazy-fetches `job_items` scoped to a single job and
  // resolves chapter titles from `material_chapters`. These tests set
  // `mockFrom` to a table-routing implementation so each SELECT lands on the
  // right fixture and the `.eq("job_id", …)` filter can be inspected.

  it('lazy-fetches job_items only after the details toggle is clicked', async () => {
    const jobs = [
      {
        id: 'j-detail',
        type: 'bulk_question_generation',
        status: 'processing',
        progress: { total: 2, completed: 0, failed: 0 },
        created_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        ended_at: null,
        error: null,
      },
    ];
    const items = [
      {
        id: 'it-1',
        item_key: 'ch-a:mcq',
        item_type: 'mcq',
        status: 'failed',
        error: 'OpenAI 500: upstream timeout',
        attempts: 3,
        payload: { chapterId: 'ch-a', type: 'mcq' },
        updated_at: new Date().toISOString(),
      },
      {
        id: 'it-2',
        item_key: 'ch-b:open',
        item_type: 'open',
        status: 'completed',
        error: null,
        attempts: 1,
        payload: { chapterId: 'ch-b', type: 'open' },
        updated_at: new Date().toISOString(),
      },
    ];
    const chapters = [
      { id: 'ch-a', title: 'Chapter A: Photosynthesis' },
      { id: 'ch-b', title: 'Chapter B: Respiration' },
    ];
    const itemsChain = createChain(items);
    const chaptersChain = createChain(chapters);
    const jobItemsFromSpy = vi.fn(() => itemsChain);
    const chaptersFromSpy = vi.fn(() => chaptersChain);
    mockFrom.mockImplementation((table: string) => {
      if (table === 'job_items') return jobItemsFromSpy();
      if (table === 'material_chapters') return chaptersFromSpy();
      return createChain(jobs);
    });

    render(<JobProgressList courseId="course-1" />);
    await waitFor(() => {
      expect(screen.getByText('Bulk Question Generation')).toBeTruthy();
    });

    // Lazy: nothing hit `job_items` before the toggle.
    expect(jobItemsFromSpy).not.toHaveBeenCalled();

    screen.getByTestId('job-details-toggle').click();

    await waitFor(() => {
      expect(jobItemsFromSpy).toHaveBeenCalled();
    });
    // Query was scoped to the expanded job's id.
    expect(itemsChain.eq).toHaveBeenCalledWith('job_id', 'j-detail');

    // Both batch rows render, with the failed one showing its error string.
    await waitFor(() => {
      expect(screen.getAllByTestId('job-item-row').length).toBe(2);
    });
    expect(screen.getByText('OpenAI 500: upstream timeout')).toBeTruthy();
    expect(screen.getByText(/Chapter A: Photosynthesis/)).toBeTruthy();
    expect(screen.getByText(/Chapter B: Respiration/)).toBeTruthy();

    // Failed row is sorted first.
    const rows = screen.getAllByTestId('job-item-row');
    expect(rows[0].getAttribute('data-status')).toBe('failed');
  });

  it('falls back to raw item_key when the chapter title cannot be resolved', async () => {
    const jobs = [
      {
        id: 'j-detail',
        type: 'bulk_question_generation',
        status: 'processing',
        progress: { total: 1, completed: 0, failed: 0 },
        created_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        ended_at: null,
        error: null,
      },
    ];
    // Payload references a chapter id that doesn't exist in `material_chapters`.
    const items = [
      {
        id: 'it-orphan',
        item_key: 'ch-missing:mcq',
        item_type: 'mcq',
        status: 'processing',
        error: null,
        attempts: 1,
        payload: { chapterId: 'ch-missing', type: 'mcq' },
        updated_at: new Date().toISOString(),
      },
    ];
    mockFrom.mockImplementation((table: string) => {
      if (table === 'job_items') return createChain(items);
      if (table === 'material_chapters') return createChain([]);
      return createChain(jobs);
    });

    render(<JobProgressList courseId="course-1" />);
    await waitFor(() => {
      expect(screen.getByTestId('job-details-toggle')).toBeTruthy();
    });
    screen.getByTestId('job-details-toggle').click();

    await waitFor(() => {
      expect(screen.getAllByTestId('job-item-row').length).toBe(1);
    });
    // Chapter title fallback: raw id is shown.
    expect(screen.getByText('ch-missing')).toBeTruthy();
    // Question type still resolves via QUESTION_TYPE_LABELS.
    expect(screen.getByText('MCQ')).toBeTruthy();
  });

  it('updates a batch row live when a job_items UPDATE arrives', async () => {
    const jobs = [
      {
        id: 'j-live',
        type: 'bulk_question_generation',
        status: 'processing',
        progress: { total: 1, completed: 0, failed: 0 },
        created_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        ended_at: null,
        error: null,
      },
    ];
    const items = [
      {
        id: 'it-1',
        item_key: 'ch-a:mcq',
        item_type: 'mcq',
        status: 'processing',
        error: null,
        attempts: 1,
        payload: { chapterId: 'ch-a', type: 'mcq' },
        updated_at: new Date().toISOString(),
      },
    ];
    mockFrom.mockImplementation((table: string) => {
      if (table === 'job_items') return createChain(items);
      if (table === 'material_chapters') return createChain([{ id: 'ch-a', title: 'Chapter A' }]);
      return createChain(jobs);
    });

    render(<JobProgressList courseId="course-1" />);
    await waitFor(() => {
      expect(screen.getByTestId('job-details-toggle')).toBeTruthy();
    });
    screen.getByTestId('job-details-toggle').click();

    await waitFor(() => {
      const row = screen.getByTestId('job-item-row');
      expect(row.getAttribute('data-status')).toBe('processing');
    });

    // Realtime UPDATE flips the same item to failed with a new error message.
    const updateHandler = channelHandlers.find(
      (h) => h.config.event === 'UPDATE' && h.config.table === 'job_items',
    );
    expect(updateHandler).toBeTruthy();
    updateHandler!.handler({
      new: {
        ...items[0],
        status: 'failed',
        error: 'moderation blocked',
      },
    });

    await waitFor(() => {
      expect(screen.getByText('moderation blocked')).toBeTruthy();
    });
    expect(
      screen.getByTestId('job-item-row').getAttribute('data-status'),
    ).toBe('failed');
  });

  it('renders a processing batch under a cancelled job as Cancelled, not Running', async () => {
    // Regression for the "Running under Cancelled" bug: a batch that was
    // mid-flight when the job was cancelled stays `processing` in the DB, but
    // a terminal parent means no worker will ever advance it. The UI must
    // collapse it to Cancelled so the batch never contradicts its parent.
    const jobs = [
      {
        id: 'j-cancelled',
        type: 'bulk_question_generation',
        status: 'cancelled',
        progress: { total: 2, completed: 1, failed: 0 },
        created_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        ended_at: new Date().toISOString(),
        error: null,
      },
    ];
    const items = [
      {
        id: 'it-stuck',
        item_key: 'ch-1:open',
        item_type: 'open',
        status: 'processing',
        error: null,
        attempts: 1,
        payload: { chapterId: 'ch-1', type: 'open' },
        updated_at: new Date().toISOString(),
      },
      {
        id: 'it-done',
        item_key: 'ch-1:mcq',
        item_type: 'mcq',
        status: 'completed',
        error: null,
        attempts: 1,
        payload: { chapterId: 'ch-1', type: 'mcq' },
        updated_at: new Date().toISOString(),
      },
    ];
    mockFrom.mockImplementation((table: string) => {
      if (table === 'job_items') return createChain(items);
      if (table === 'material_chapters') return createChain([]);
      return createChain(jobs);
    });

    render(<JobProgressList courseId="course-1" />);
    await waitFor(() => {
      expect(screen.getByTestId('job-details-toggle')).toBeTruthy();
    });
    screen.getByTestId('job-details-toggle').click();

    await waitFor(() => {
      expect(screen.getAllByTestId('job-item-row').length).toBe(2);
    });

    const stuck = screen.getAllByTestId('job-item-row').find(
      (r) => r.textContent?.includes('Open'),
    );
    // The mid-flight batch is shown as Cancelled, never Running.
    expect(stuck?.getAttribute('data-status')).toBe('cancelled');
    expect(screen.queryByText('Running')).toBeNull();
    // The genuinely-finished batch still reads Done.
    expect(screen.getByText('Done')).toBeTruthy();
  });
});
