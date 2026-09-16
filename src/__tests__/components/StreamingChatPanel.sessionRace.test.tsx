import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * The student's turn, when the panel does not know the session id.
 *
 * A conversation is one `chat_sessions` row per (student, subject), and the
 * panel learns its id by reading it on mount. When that read comes back empty
 * the panel opens the session itself — which is right on the first turn, and
 * wrong every other time the read misses a row that exists: a read issued while
 * a token is being refreshed, a second tab, a retried turn. The insert then hit
 * `chat_sessions_unique_open_question`, and the student was shown the
 * constraint's name where the tutor's answer belonged, with the question stuck:
 * every later message failed the same way, because nothing had taught the panel
 * the id.
 *
 * What these pin: the row the insert collides with is the session we wanted, so
 * the turn goes on; and a read that *failed* is never treated as a subject with
 * no session at all.
 */

vi.mock('@/assets/ai-tutor.png', () => ({ default: 'ai-tutor.png' }));

// Interpolates, because the panel also renders counted copy —
// `t("session.messages", { count })` — and a `t` that returned its options
// object would hand React a child it cannot render.
const translation = {
  t: (
    key: string,
    fallback?: string | Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => {
    const [text, vars] = typeof fallback === 'string' ? [fallback, options] : [key, fallback];
    return Object.entries(vars ?? {}).reduce<string>(
      (acc, [name, value]) => acc.split(`{{${name}}}`).join(String(value)),
      text,
    );
  },
};
vi.mock('react-i18next', () => ({ useTranslation: () => translation }));

// `vi.mock` is hoisted above every `const` in this file, so the spy has to be
// created inside the factory and read back through the module.
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
import { toast } from 'sonner';
const toastError = toast.error as ReturnType<typeof vi.fn>;

type Read = { data: { id: string; status: string } | null; error: { message: string } | null };

/** What the fake `chat_sessions` reads answer with, in order. */
let sessionReads: Read[] = [];
/** What an INSERT on `chat_sessions` answers with. */
let sessionInsert: { data: { id: string } | null; error: { code?: string; message: string } | null };
/** Rows the panel tried to insert into `chat_sessions`. */
let sessionInserts: Record<string, unknown>[] = [];
let messageRows: { id: string; role: string; content: string; created_at: string }[] = [];
/**
 * Held in front of the *first* `chat_sessions` read — the transcript load — so
 * a test can land it in the middle of a send, which is the window in which the
 * message list is replaced under an optimistic bubble.
 */
let firstReadGate: Promise<void> | null = null;
/** Held in front of the INSERT, so the send can be finished last. */
let insertGate: Promise<void> | null = null;

vi.mock('@/integrations/supabase/client', () => {
  const makeQuery = (table: string) => {
    let roles: string[] | null = null;
    let payload: Record<string, unknown> | null = null;
    const query = {
      select: () => query,
      insert: (values: Record<string, unknown>) => {
        payload = values;
        if (table === 'chat_sessions') sessionInserts.push(values);
        return query;
      },
      eq: () => query,
      in: (_column: string, values: string[]) => {
        roles = values;
        return query;
      },
      order: () => query,
      single: async () => {
        if (table !== 'chat_sessions' || !payload) return { data: { id: 'msg-new' }, error: null };
        if (insertGate) await insertGate;
        return sessionInsert;
      },
      maybeSingle: async () => {
        if (table !== 'chat_sessions') return { data: null, error: null };
        const gate = firstReadGate;
        firstReadGate = null;
        // Claimed before the gate, so holding a read back does not reorder the
        // queue: the transcript load still takes the first entry.
        const result = sessionReads.shift() ?? { data: null, error: null };
        if (gate) await gate;
        return result;
      },
      then: (resolve: (r: { data: unknown; error: null }) => unknown) =>
        resolve({
          data:
            table === 'chat_messages'
              ? roles
                ? messageRows.filter((m) => roles!.includes(m.role))
                : messageRows
              : [],
          error: null,
        }),
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
        const ch = {
          on: () => ch,
          subscribe: (cb?: (s: string) => void) => {
            cb?.('SUBSCRIBED');
            return ch;
          },
        };
        return ch;
      },
      removeChannel: () => {},
      functions: { invoke: () => Promise.resolve({ data: null, error: null }) },
    },
  };
});

import { StreamingChatPanel } from '@/components/chat/StreamingChatPanel';

const REPLY = 'Καλή αρχή — τι θυμάσαι για τη Συνθήκη των Βερσαλλιών;';
const TURN = 'right?';

const sseBody = (text: string) =>
  [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
    'data: [DONE]\n\n',
  ].join('');

/** Every request the panel made to `chat-stream`, as parsed bodies. */
let requests: Record<string, unknown>[] = [];

const renderPanel = () =>
  render(
    <StreamingChatPanel
      kind="open_question"
      subjectId="q1"
      courseId="c1"
      heading="Να εξηγήσετε γιατί οι συνθήκες ειρήνης…"
      onBack={() => {}}
    />,
  );

const sendTurn = async () => {
  const input = await screen.findByRole('textbox');
  fireEvent.change(input, { target: { value: TURN } });
  fireEvent.submit(input.closest('form')!);
};

beforeEach(() => {
  sessionReads = [];
  sessionInsert = { data: null, error: null };
  sessionInserts = [];
  messageRows = [];
  firstReadGate = null;
  insertGate = null;
  requests = [];
  toastError.mockClear();
  vi.stubGlobal('fetch', (_url: string, init: { body: string }) => {
    requests.push(JSON.parse(init.body));
    return Promise.resolve(
      new Response(sseBody(REPLY), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    );
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('StreamingChatPanel: opening a session the student already has', () => {
  it('answers the turn when the insert collides with the real session', async () => {
    // Nothing found on mount or on the turn, so the panel opens a session — and
    // the constraint says one is already there.
    sessionReads = [
      { data: null, error: null },
      { data: null, error: null },
      { data: { id: 'sess-1', status: 'in_progress' }, error: null },
    ];
    sessionInsert = {
      data: null,
      error: {
        code: '23505',
        message:
          'duplicate key value violates unique constraint "chat_sessions_unique_open_question"',
      },
    };

    renderPanel();
    await sendTurn();

    // The turn was taken against the session that already existed.
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({ kind: 'open_question', subjectId: 'q1' });
    await waitFor(() => expect(screen.getByText(REPLY)).toBeInTheDocument());
    expect(toastError).not.toHaveBeenCalled();
  });

  it('does not open a second session for the next message', async () => {
    sessionReads = [
      { data: null, error: null },
      { data: null, error: null },
      { data: { id: 'sess-1', status: 'in_progress' }, error: null },
    ];
    sessionInsert = { data: null, error: { code: '23505', message: 'duplicate key' } };

    renderPanel();
    await sendTurn();
    await waitFor(() => expect(screen.getByText(REPLY)).toBeInTheDocument());

    await sendTurn();

    await waitFor(() => expect(requests).toHaveLength(2));
    // The recovered id was kept, so the second turn inserted nothing.
    expect(sessionInserts).toHaveLength(1);
  });

  it('does not insert over a session it merely failed to read', async () => {
    // The transcript read failed — which says nothing about whether a session
    // exists. Treated as "there is none", it became a duplicate key; the turn
    // is taken against the row the retried read finds.
    sessionReads = [
      { data: null, error: { message: 'JWT expired' } },
      { data: { id: 'sess-1', status: 'in_progress' }, error: null },
    ];

    renderPanel();
    await sendTurn();

    expect(sessionInserts).toEqual([]);
    await waitFor(() => expect(requests).toHaveLength(1));
    await waitFor(() => expect(screen.getByText(REPLY)).toBeInTheDocument());
    expect(toastError).not.toHaveBeenCalled();
  });

  it('reports a failure that is not a collision, without a turn', async () => {
    sessionReads = [
      { data: null, error: null },
      { data: null, error: null },
    ];
    sessionInsert = { data: null, error: { code: '42501', message: 'permission denied' } };

    renderPanel();
    await sendTurn();

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('permission denied'));
    expect(requests).toEqual([]);
    // Nothing was written, so nothing is left on screen claiming otherwise.
    expect(screen.queryByText(TURN)).not.toBeInTheDocument();
  });

  it('drops its own bubble, not whatever is last on screen', async () => {
    // The transcript load lands mid-send and replaces the list — a teacher's
    // message merging in does the same. Dropping the *tail* would then take a
    // real, persisted message off the screen, so the bubble is dropped by id.
    const EARLIER = 'Οι συνθήκες ειρήνης δεν δημιούργησαν ισορροπημένη τάξη.';
    let landTranscript!: () => void;
    let failInsert!: () => void;
    firstReadGate = new Promise<void>((resolve) => { landTranscript = resolve; });
    insertGate = new Promise<void>((resolve) => { failInsert = resolve; });

    sessionReads = [
      // The transcript load, held until the send is under way.
      { data: { id: 'sess-1', status: 'in_progress' }, error: null },
      // The send's own read, which starts before that one has returned.
      { data: null, error: null },
    ];
    messageRows = [
      { id: 'm1', role: 'user', content: EARLIER, created_at: '2026-09-07T10:37:00Z' },
    ];
    sessionInsert = { data: null, error: { code: '42501', message: 'permission denied' } };

    renderPanel();
    await sendTurn();
    await waitFor(() => expect(sessionInserts).toHaveLength(1));

    // The conversation the student already had arrives, replacing the list.
    landTranscript();
    await waitFor(() => expect(screen.getByText(EARLIER)).toBeInTheDocument());

    failInsert();

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('permission denied'));
    // The turn that was never written is gone; the one that was is still there.
    expect(screen.queryByText(TURN)).not.toBeInTheDocument();
    expect(screen.getByText(EARLIER)).toBeInTheDocument();
  });
});
