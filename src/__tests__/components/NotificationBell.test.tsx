import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';

beforeAll(() => {
  global.ResizeObserver = class ResizeObserver {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  } as unknown as typeof ResizeObserver;
});

// The bell relies on these:
//   - supabase.from('notifications' | 'admin_notifications')   for fetch + mark-as-read
//   - supabase.channel(...).on(...).subscribe(cb)              for realtime
//   - useAuth().user                                            for the user id
//   - sonner toast.{success,warning,error,default}
//
// We mock each and exercise the surface end-to-end without standing up
// react-router/supabase. The `channel` mock exposes the registered postgres
// handlers so tests can simulate INSERT/UPDATE payloads.

interface ChainSpy {
  table: string;
  args: unknown[];
  method: string;
  chain: Record<string, ReturnType<typeof vi.fn>>;
}

const mockFrom = vi.fn();
const subscribeMock = vi.fn();
let lastSubscribeStatusCb: ((status: string) => void) | null = null;
const channelHandlers: Array<{
  channel: string;
  config: { event: string; table: string; filter?: string };
  handler: (payload: { new: unknown; old?: unknown }) => void;
}> = [];

function makeChannelMock(name: string) {
  const channel = {
    name,
    on: vi.fn(
      (
        _evt: string,
        config: { event: string; table: string; filter?: string },
        handler: (payload: { new: unknown; old?: unknown }) => void,
      ) => {
        channelHandlers.push({ channel: name, config, handler });
        return channel;
      },
    ),
    subscribe: vi.fn((cb?: (status: string) => void) => {
      lastSubscribeStatusCb = cb ?? null;
      subscribeMock(cb);
      return { unsubscribe: vi.fn() };
    }),
  };
  return channel;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (...args: unknown[]) => mockFrom(...args),
    channel: vi.fn((name: string) => makeChannelMock(name)),
    removeChannel: vi.fn(),
  },
}));

vi.mock('@/hooks/useAuth', () => {
  // Stable user/auth object so the bell's `useEffect([user])` doesn't refire
  // on every re-render (otherwise the channel resubscribes and the handlers
  // captured by `channelHandlers[0]` belong to the now-unmounted iteration).
  const stableAuth = {
    user: { id: 'user-1', email: 't@example.com' },
    profile: null,
    session: null,
    loading: false,
    signIn: vi.fn(),
    signUp: vi.fn(),
    signOut: vi.fn(),
    updatePassword: vi.fn(),
  };
  return { useAuth: () => stableAuth };
});

vi.mock('sonner', () => {
  const t: Record<string, ReturnType<typeof vi.fn>> & ReturnType<typeof vi.fn> = vi.fn() as ReturnType<typeof vi.fn> & Record<string, ReturnType<typeof vi.fn>>;
  t.success = vi.fn();
  t.warning = vi.fn();
  t.error = vi.fn();
  return { toast: t };
});

import { NotificationBell } from '@/components/NotificationBell';
import { toast as mockedToast } from 'sonner';

interface ToastMock {
  (msg: string, opts?: unknown): void;
  success: ReturnType<typeof vi.fn>;
  warning: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
}
const toastFns = mockedToast as unknown as ToastMock;

const chainSpies: ChainSpy[] = [];

function createChain(table: string, data: unknown = []) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  const methods = ['select', 'eq', 'neq', 'in', 'not', 'order', 'limit', 'update', 'maybeSingle'];
  for (const m of methods) {
    chain[m] = vi.fn((...args: unknown[]) => {
      chainSpies.push({ table, args, method: m, chain });
      return chain;
    });
  }
  chain.then = vi.fn((cb) => Promise.resolve(cb({ data, error: null })));
  return chain;
}

/**
 * Returns a mockFrom implementation that picks per-table responses by name.
 * Default fixture is an empty array; any table not in `tablesData` returns [].
 */
function fromByTable(tablesData: Record<string, unknown>) {
  return (table: string) => createChain(table, tablesData[table] ?? []);
}

function renderBell(props: { includeAdminFeed?: boolean } = {}) {
  return render(
    <MemoryRouter>
      <NotificationBell {...props} />
    </MemoryRouter>,
  );
}

describe('NotificationBell (generic notifications)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    channelHandlers.length = 0;
    chainSpies.length = 0;
    lastSubscribeStatusCb = null;
  });

  it('renders bell with no badge when there are no unread notifications', async () => {
    mockFrom.mockImplementation(fromByTable({ notifications: [] }));
    renderBell();
    await waitFor(() => {
      expect(screen.getByTestId('user-notification-bell')).toBeTruthy();
    });
    expect(screen.queryByTestId('user-notification-badge')).toBeNull();
  });

  it('shows a badge with the unread count', async () => {
    const rows = [
      { id: 'a', type: 'job.completed', title: 'A', body: 'b', job_id: null, read_at: null, created_at: new Date().toISOString() },
      { id: 'b', type: 'job.failed', title: 'B', body: 'b', job_id: null, read_at: null, created_at: new Date().toISOString() },
      { id: 'c', type: 'job.completed', title: 'C', body: 'b', job_id: null, read_at: new Date().toISOString(), created_at: new Date().toISOString() },
    ];
    mockFrom.mockImplementation(fromByTable({ notifications: rows }));
    renderBell();
    await waitFor(() => {
      const badge = screen.getByTestId('user-notification-badge');
      expect(badge.textContent).toBe('2');
    });
  });

  it('lists notifications when the popover opens', async () => {
    const rows = [
      { id: 'a', type: 'job.completed', title: 'Bulk run finished', body: '12/12 items completed', job_id: null, read_at: null, created_at: new Date().toISOString() },
    ];
    mockFrom.mockImplementation(fromByTable({ notifications: rows }));
    renderBell();
    await waitFor(() => {
      expect(screen.getByTestId('user-notification-bell')).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId('user-notification-bell'));
    await waitFor(() => {
      expect(screen.getByText('Bulk run finished')).toBeTruthy();
      expect(screen.getByText('12/12 items completed')).toBeTruthy();
    });
  });

  it('marks a notification as read when clicked and updates the badge', async () => {
    const rows = [
      { id: 'a', type: 'job.completed', title: 'X', body: null, job_id: null, read_at: null, created_at: new Date().toISOString() },
    ];
    mockFrom.mockImplementation(fromByTable({ notifications: rows }));
    renderBell();
    await waitFor(() => {
      expect(screen.getByTestId('user-notification-badge').textContent).toBe('1');
    });
    fireEvent.click(screen.getByTestId('user-notification-bell'));
    const item = await screen.findByTestId('user-notification-item');
    fireEvent.click(item);
    await waitFor(() => {
      expect(screen.queryByTestId('user-notification-badge')).toBeNull();
    });
  });

  it('raises a toast on incoming realtime INSERT', async () => {
    mockFrom.mockImplementation(fromByTable({ notifications: [] }));
    renderBell();
    await waitFor(() => {
      expect(screen.getByTestId('user-notification-bell')).toBeTruthy();
    });

    const insertHandler = channelHandlers.find(
      (h) => h.config.event === 'INSERT' && h.config.table === 'notifications',
    );
    expect(insertHandler).toBeTruthy();

    insertHandler!.handler({
      new: {
        id: 'incoming-1',
        type: 'job.completed',
        title: 'Done!',
        body: '5/5 completed',
        job_id: null,
        read_at: null,
        created_at: new Date().toISOString(),
      },
    });

    await waitFor(() => {
      expect(toastFns.success).toHaveBeenCalledWith('Done!', { description: '5/5 completed' });
      expect(screen.getByTestId('user-notification-badge').textContent).toBe('1');
    });
  });

  it('shows the manual refresh button when realtime subscription fails', async () => {
    mockFrom.mockImplementation(fromByTable({ notifications: [] }));
    renderBell();
    await waitFor(() => {
      expect(screen.getByTestId('user-notification-bell')).toBeTruthy();
    });
    // Simulate a CHANNEL_ERROR status callback.
    expect(lastSubscribeStatusCb).toBeTruthy();
    lastSubscribeStatusCb!('CHANNEL_ERROR');

    fireEvent.click(screen.getByTestId('user-notification-bell'));
    await waitFor(() => {
      expect(screen.getByTestId('user-notification-refresh')).toBeTruthy();
    });
  });

  it('does not query admin_notifications when admin feed is disabled', async () => {
    const fromFn = vi.fn(fromByTable({ notifications: [] }));
    mockFrom.mockImplementation(fromFn);
    renderBell();
    await waitFor(() => {
      expect(screen.getByTestId('user-notification-bell')).toBeTruthy();
    });
    const tablesQueried = fromFn.mock.calls.map((c) => c[0]);
    expect(tablesQueried).not.toContain('admin_notifications');
  });
});

describe('NotificationBell (unified feed)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    channelHandlers.length = 0;
    chainSpies.length = 0;
    lastSubscribeStatusCb = null;
  });

  it('combines unread counts from notifications + admin_notifications', async () => {
    const userRows = [
      { id: 'u1', type: 'job.completed', title: 'Job', body: null, job_id: null, read_at: null, created_at: new Date().toISOString() },
      { id: 'u2', type: 'job.failed', title: 'Job 2', body: null, job_id: null, read_at: null, created_at: new Date().toISOString() },
    ];
    const adminRows = [
      { id: 'a1', type: 'content_moderation', title: 'Flagged', message: 'Student flagged', read: false, created_at: new Date().toISOString() },
      { id: 'a2', type: 'content_moderation', title: 'Old', message: 'Already read', read: true, created_at: new Date().toISOString() },
    ];
    mockFrom.mockImplementation(
      fromByTable({ notifications: userRows, admin_notifications: adminRows }),
    );
    renderBell({ includeAdminFeed: true });
    await waitFor(() => {
      const badge = screen.getByTestId('user-notification-badge');
      // 2 unread user + 1 unread admin = 3
      expect(badge.textContent).toBe('3');
    });
  });

  it('renders items from both feeds in the popover', async () => {
    const userRows = [
      { id: 'u1', type: 'job.completed', title: 'Job completed', body: '5/5 done', job_id: null, read_at: null, created_at: new Date().toISOString() },
    ];
    const adminRows = [
      { id: 'a1', type: 'content_moderation', title: 'Student flagged', message: 'Inappropriate text', read: false, created_at: new Date().toISOString() },
    ];
    mockFrom.mockImplementation(
      fromByTable({ notifications: userRows, admin_notifications: adminRows }),
    );
    renderBell({ includeAdminFeed: true });
    await waitFor(() => {
      expect(screen.getByTestId('user-notification-bell')).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId('user-notification-bell'));
    await waitFor(() => {
      expect(screen.getByText('Job completed')).toBeTruthy();
      expect(screen.getByText('Student flagged')).toBeTruthy();
      expect(screen.getByText('Inappropriate text')).toBeTruthy();
    });
  });

  it('marking an admin item writes to admin_notifications (not notifications)', async () => {
    const adminRows = [
      { id: 'a1', type: 'content_moderation', title: 'Flagged', message: 'msg', read: false, created_at: new Date().toISOString() },
    ];
    mockFrom.mockImplementation(
      fromByTable({ notifications: [], admin_notifications: adminRows }),
    );
    renderBell({ includeAdminFeed: true });
    await waitFor(() => {
      expect(screen.getByTestId('user-notification-badge').textContent).toBe('1');
    });
    fireEvent.click(screen.getByTestId('user-notification-bell'));
    const item = await screen.findByTestId('user-notification-item');
    fireEvent.click(item);

    await waitFor(() => {
      expect(screen.queryByTestId('user-notification-badge')).toBeNull();
    });
    // The update call should target admin_notifications, never notifications,
    // because the only item shown originated from the admin feed.
    const updateOnNotifications = chainSpies.find(
      (s) => s.table === 'notifications' && s.method === 'update',
    );
    const updateOnAdmin = chainSpies.find(
      (s) => s.table === 'admin_notifications' && s.method === 'update',
    );
    expect(updateOnNotifications).toBeUndefined();
    expect(updateOnAdmin).toBeTruthy();
  });

  it('admin realtime INSERT raises a toast and bumps the badge', async () => {
    mockFrom.mockImplementation(
      fromByTable({ notifications: [], admin_notifications: [] }),
    );
    renderBell({ includeAdminFeed: true });
    await waitFor(() => {
      expect(screen.getByTestId('user-notification-bell')).toBeTruthy();
    });

    const adminInsert = channelHandlers.find(
      (h) => h.config.event === 'INSERT' && h.config.table === 'admin_notifications',
    );
    expect(adminInsert).toBeTruthy();

    adminInsert!.handler({
      new: {
        id: 'admin-1',
        type: 'content_moderation',
        title: 'New flag',
        message: 'A student was flagged',
        read: false,
        created_at: new Date().toISOString(),
      },
    });

    await waitFor(() => {
      expect(toastFns.warning).toHaveBeenCalledWith('New flag', { description: 'A student was flagged' });
      expect(screen.getByTestId('user-notification-badge').textContent).toBe('1');
    });
  });
});
