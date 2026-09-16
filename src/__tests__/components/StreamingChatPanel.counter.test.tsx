import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

/**
 * The message counter under the composer.
 *
 * The server pauses a session for instructor review every
 * `TURNS_BEFORE_REVIEW` stored messages (`chat-turn.ts`), and until this
 * counter existed nothing on the client said so — the pause arrived
 * unannounced. These tests pin what it counts: user and tutor rows, exactly
 * as the server's history query does, and never an instructor's turns.
 */

vi.mock('@/assets/ai-tutor.png', () => ({ default: 'ai-tutor.png' }));

// Unlike the sibling suites' mock, this one renders the interpolation count
// into the key, so the assertions can see the numbers the component computed.
const translation = {
  t: (k: string, fallback?: string | Record<string, unknown>) => {
    if (typeof fallback === 'object' && fallback !== null && 'count' in fallback) {
      return `${k}:${fallback.count}`;
    }
    return typeof fallback === 'string' ? fallback : k;
  },
};
vi.mock('react-i18next', () => ({ useTranslation: () => translation }));

type SessionRow = { id: string; status: string; pause_reason?: string | null };
let sessionRow: SessionRow | null = null;
let messageRows: {
  id: string;
  role: string;
  content: string;
  created_at: string;
  sender_user_id?: string | null;
}[] = [];

vi.mock('@/integrations/supabase/client', () => {
  const makeQuery = (table: string) => {
    let roles: string[] | null = null;
    const rows = () => {
      if (table !== 'chat_messages') return [];
      return roles ? messageRows.filter((m) => roles!.includes(m.role)) : messageRows;
    };
    const query = {
      select: () => query,
      insert: () => query,
      single: async () => ({ data: { id: 'msg-new' }, error: null }),
      eq: () => query,
      in: (_column: string, values: string[]) => {
        roles = values;
        return query;
      },
      order: () => query,
      maybeSingle: async () =>
        table === 'chat_sessions' ? { data: sessionRow, error: null } : { data: null, error: null },
      then: (resolve: (r: { data: unknown; error: null }) => unknown) =>
        resolve({ data: rows(), error: null }),
    };
    return query;
  };
  return {
    supabase: {
      auth: {
        getUser: () => Promise.resolve({ data: { user: { id: 'u1' } }, error: null }),
        getSession: () =>
          Promise.resolve({ data: { session: { access_token: 't' } }, error: null }),
      },
      from: (table: string) => makeQuery(table),
      channel: () => {
        const ch = { on: () => ch, subscribe: (cb?: (s: string) => void) => { cb?.('SUBSCRIBED'); return ch; } };
        return ch;
      },
      removeChannel: () => {},
      functions: { invoke: () => Promise.resolve({ data: null, error: null }) },
    },
  };
});

import { StreamingChatPanel } from '@/components/chat/StreamingChatPanel';
import { TUTOR_TURNS_BEFORE_REVIEW } from '@/lib/tutor-turns-before-review';

const renderPanel = () =>
  render(
    <StreamingChatPanel
      kind="open_question"
      subjectId="q1"
      courseId="c1"
      onBack={() => {}}
    />,
  );

beforeEach(() => {
  sessionRow = null;
  messageRows = [];
  // No turn is ever requested in this suite; a fetch would be a bug.
  vi.stubGlobal('fetch', () => Promise.reject(new Error('unexpected request')));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('StreamingChatPanel: the message counter', () => {
  it('shows the count and how many messages remain before the review pause', async () => {
    sessionRow = { id: 'sess-1', status: 'in_progress' };
    messageRows = [
      { id: 'm1', role: 'user', content: 'Ερώτηση;', created_at: '2026-09-05T10:00:00Z' },
      { id: 'm2', role: 'assistant', content: 'Απάντηση.', created_at: '2026-09-05T10:00:05Z' },
    ];

    renderPanel();

    await waitFor(() => expect(screen.getByText(/session\.messages:2/)).toBeInTheDocument());
    expect(
      screen.getByText(new RegExp(`session\\.messagesUntilPause:${TUTOR_TURNS_BEFORE_REVIEW - 2}`)),
    ).toBeInTheDocument();
  });

  it('does not count instructor turns, because the server does not', async () => {
    sessionRow = { id: 'sess-1', status: 'in_progress' };
    messageRows = [
      { id: 'm1', role: 'user', content: 'Ερώτηση;', created_at: '2026-09-05T10:00:00Z' },
      { id: 'm2', role: 'assistant', content: 'Απάντηση.', created_at: '2026-09-05T10:00:05Z' },
      {
        id: 'm3',
        role: 'instructor',
        content: 'Μπράβο!',
        created_at: '2026-09-05T10:00:10Z',
        sender_user_id: 'teacher-1',
      },
    ];

    renderPanel();

    await waitFor(() => expect(screen.getByText('Μπράβο!')).toBeInTheDocument());
    expect(screen.getByText(/session\.messages:2/)).toBeInTheDocument();
  });

  it('drops the countdown on a paused session, keeping the count', async () => {
    // At the pause boundary the modulo reads a full interval — "80 left"
    // beside the paused banner would contradict it.
    sessionRow = { id: 'sess-1', status: 'paused', pause_reason: 'message_interval' };
    messageRows = [
      { id: 'm1', role: 'user', content: 'Ερώτηση;', created_at: '2026-09-05T10:00:00Z' },
      { id: 'm2', role: 'assistant', content: 'Απάντηση.', created_at: '2026-09-05T10:00:05Z' },
    ];

    renderPanel();

    await waitFor(() => expect(screen.getByText(/session\.messages:2/)).toBeInTheDocument());
    expect(screen.queryByText(/session\.messagesUntilPause/)).not.toBeInTheDocument();
  });

  it('stays off an empty conversation', async () => {
    renderPanel();

    await waitFor(() => expect(screen.getByRole('textbox')).toBeEnabled());
    expect(screen.queryByText(/session\.messagesUntilPause/)).not.toBeInTheDocument();
  });
});
