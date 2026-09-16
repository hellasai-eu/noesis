import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

/**
 * Who speaks first in a study session.
 *
 * A study session is a topic the instructor set, not a question the student
 * brought, so an empty transcript with a composer under it asked the student to
 * open a conversation about an objective they had only just read. The tutor
 * opens it instead: the panel asks the server for an opening turn (`start`),
 * which is built from that same objective.
 *
 * The rule these tests pin is *when* it fires — never over an existing
 * conversation, and never on a session the student cannot take a turn in.
 */

vi.mock('@/assets/ai-tutor.png', () => ({ default: 'ai-tutor.png' }));

// Created once: a fresh object per render changes the identity of every
// `useCallback` that depends on `t`, which reloads the transcript on every
// render and would make "asked exactly once" measure that loop instead.
// The second argument is a fallback string or, as in the message counter, an
// i18next options object — which real i18next interpolates, never returns.
const translation = {
  t: (k: string, fallback?: string | Record<string, unknown>) =>
    typeof fallback === "string" ? fallback : k,
};
vi.mock('react-i18next', () => ({ useTranslation: () => translation }));

type SessionRow = { id: string; status: string; pause_reason?: string | null };
let sessionRow: SessionRow | null = null;
let messageRows: { id: string; role: string; content: string; created_at: string }[] = [];

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

const WELCOME = 'Καλώς ήρθες! Θα δούμε μαζί το ελληνικό κράτος. Τι θυμάσαι για την περίοδο αυτή;';

/** The frames the streaming endpoint sends, in the order it sends them. */
const sseBody = (text: string) =>
  [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
    'data: [DONE]\n\n',
  ].join('');

/** Every request the panel made to `chat-stream`, as parsed bodies. */
let requests: Record<string, unknown>[] = [];

const stubStream = () =>
  vi.stubGlobal('fetch', (_url: string, init: { body: string }) => {
    requests.push(JSON.parse(init.body));
    return Promise.resolve(
      new Response(sseBody(WELCOME), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    );
  });

const renderPanel = (extra: Record<string, unknown> = {}) =>
  render(
    <StreamingChatPanel
      kind="study_session"
      subjectId="s1"
      courseId="c1"
      heading="Το ελληνικό κράτος 1830-1881"
      openWithTutorTurn
      onBack={() => {}}
      {...extra}
    />,
  );

beforeEach(() => {
  sessionRow = null;
  messageRows = [];
  requests = [];
  stubStream();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('StreamingChatPanel: the tutor opens a study session', () => {
  it('asks for an opening turn when nothing has been said yet', async () => {
    // No session row at all — the student has just opened the session.
    await waitFor(() => expect(renderPanel()).toBeTruthy());

    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({
      kind: 'study_session',
      subjectId: 's1',
      courseId: 'c1',
      start: true,
      // No student turn to answer: the server builds this one from the objective.
      replyTo: null,
    });

    // And the student reads it rather than an empty screen.
    await waitFor(() => expect(screen.getByText(WELCOME)).toBeInTheDocument());
  });

  it('asks only once, however many times the panel re-renders', async () => {
    const { rerender } = renderPanel();

    await waitFor(() => expect(requests).toHaveLength(1));

    rerender(
      <StreamingChatPanel
        kind="study_session"
        subjectId="s1"
        courseId="c1"
        heading="Το ελληνικό κράτος 1830-1881"
        openWithTutorTurn
        onBack={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByText(WELCOME)).toBeInTheDocument());
    expect(requests).toHaveLength(1);
  });

  it('stays quiet when the conversation is already under way', async () => {
    // Reopening a session mid-conversation must not push a welcome in front of
    // what the student and tutor have already said.
    sessionRow = { id: 'sess-1', status: 'in_progress' };
    messageRows = [
      { id: 'm1', role: 'user', content: 'Ξεκινάμε;', created_at: '2026-09-05T10:00:00Z' },
      { id: 'm2', role: 'assistant', content: 'Φυσικά!', created_at: '2026-09-05T10:00:05Z' },
    ];

    renderPanel();

    await waitFor(() => expect(screen.getByText('Φυσικά!')).toBeInTheDocument());
    expect(requests).toEqual([]);
  });

  it('stays quiet on a paused session', async () => {
    // The server would refuse the turn, and the student cannot take one either.
    sessionRow = { id: 'sess-1', status: 'paused', pause_reason: 'message_interval' };

    renderPanel();

    await waitFor(() => expect(screen.getByRole('textbox')).toBeDisabled());
    expect(requests).toEqual([]);
  });

  it('stays quiet unless the surface asked for an opening turn', async () => {
    // An open question is the student's to answer; nothing opens it for them.
    renderPanel({ kind: 'open_question', openWithTutorTurn: false });

    await waitFor(() => expect(screen.getByRole('textbox')).toBeEnabled());
    expect(requests).toEqual([]);
  });
});
