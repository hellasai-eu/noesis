import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * A teacher's message reaching a pupil who is sitting in the session.
 *
 * The panel only ever read instructor messages on load, so one sent to a pupil
 * mid-session arrived whenever they next refreshed — which, on a surface they
 * stay on for a whole session, is never.
 *
 * The signal rides `chat_sessions.last_instructor_message_at` (20260906180000)
 * rather than a subscription on `chat_messages`, so these tests drive the same
 * channel the moderation pause uses. What they pin is the merge: it arrives, it
 * does not arrive twice, and it does not land underneath a turn in flight —
 * where the streaming path, which addresses the reply by position, would
 * overwrite it.
 */

vi.mock('@/assets/ai-tutor.png', () => ({ default: 'ai-tutor.png' }));

// Created once — a fresh object per render changes the identity of every
// `useCallback` depending on `t`, re-running the effects that own the
// subscription and reloading the transcript on every render.
// Interpolates, because the instructor label is `{{name}} · Instructor` and a
// `t` that ignored the variables would assert the raw template.
const translation = {
  t: (key: string, fallback?: string | Record<string, unknown>, options?: Record<string, unknown>) => {
    const [text, vars] = typeof fallback === 'string' ? [fallback, options] : [key, fallback];
    return Object.entries(vars ?? {}).reduce<string>(
      (acc, [name, value]) => acc.split(`{{${name}}}`).join(String(value)),
      text,
    );
  },
};
vi.mock('react-i18next', () => ({ useTranslation: () => translation }));

type SessionRow = {
  id: string;
  status: string;
  pause_reason?: string | null;
  last_instructor_message_at?: string | null;
};
type MessageRow = {
  id: string;
  role: string;
  content: string;
  sender_user_id: string | null;
  created_at: string;
};

let sessionRow: SessionRow = { id: 'sess-1', status: 'in_progress' };
let messageRows: MessageRow[] = [];
let profileRows: { user_id: string; full_name: string | null }[] = [];
/** Every `chat_messages` read the panel issued, as the role filter it used. */
let messageReads: string[] = [];
/** Fails the next N instructor reads, for the transient-failure cases. */
let failInstructorReads = 0;
/**
 * Held in front of the profile lookup, so a test can keep one merge in the
 * middle of that await while a second one starts — the window in which both
 * used to compute the same unrendered rows and append them twice.
 */
let profileReadGate: Promise<void> | null = null;
/** Throws the next N profile lookups, mid-merge, after rows are claimed. */
let failProfileReads = 0;

const channelHandlers: ((payload: { new: Record<string, unknown> }) => void)[] = [];
const emit = (row: Record<string, unknown>) => channelHandlers.forEach((h) => h({ new: row }));

vi.mock('@/integrations/supabase/client', () => {
  const makeQuery = (table: string) => {
    // Both filters are honoured: the transcript load selects roles with `.in`,
    // the live merge with `.eq`. A mock that ignored either would let the merge
    // appear to work while actually re-rendering the whole conversation.
    let roles: string[] | null = null;
    const result = () => {
      if (table === 'profiles') return { data: profileRows, error: null };
      if (table !== 'chat_messages') return { data: [], error: null };
      messageReads.push((roles ?? ['*']).join(','));
      if (roles?.join(',') === 'instructor' && failInstructorReads > 0) {
        failInstructorReads -= 1;
        return { data: null, error: { message: 'transient' } };
      }
      return {
        data: roles ? messageRows.filter((m) => roles!.includes(m.role)) : messageRows,
        error: null,
      };
    };
    const query = {
      select: () => query,
      insert: () => query,
      single: async () => ({ data: { id: 'msg-new' }, error: null }),
      eq: (column: string, value: string) => {
        if (table === 'chat_messages' && column === 'role') roles = [value];
        return query;
      },
      in: (column: string, values: string[]) => {
        if (column === 'role') roles = values;
        return query;
      },
      order: () => query,
      maybeSingle: async () =>
        table === 'chat_sessions' ? { data: sessionRow, error: null } : { data: null, error: null },
      // `reject` is threaded through deliberately. A thenable's `then` has its
      // return value discarded, so an `async then` that throws produces an
      // unhandled rejection and an `await` that never settles — the awaiting
      // code would hang rather than take its failure path, and a test written
      // against that would prove nothing.
      then: (
        resolve: (r: { data: unknown; error: unknown }) => unknown,
        reject?: (e: unknown) => unknown,
      ) => {
        const settle = async () => {
          if (table === 'profiles') {
            if (profileReadGate) await profileReadGate;
            if (failProfileReads > 0) {
              failProfileReads -= 1;
              // Rejects rather than returning an error row, which is the shape
              // the merge's release-the-claim path is written against.
              throw new Error('profile lookup failed');
            }
          }
          return result();
        };
        return settle().then(resolve, reject);
      },
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
          on: (
            _event: string,
            _opts: unknown,
            handler: (payload: { new: Record<string, unknown> }) => void,
          ) => {
            channelHandlers.push(handler);
            return ch;
          },
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

const TUTOR_TEXT = 'Ολοκληρώσαμε την επανάληψη.';
const INSTRUCTOR_TEXT = 'Congratulations!';
const REPLY_TEXT = 'Ωραία, συνεχίζουμε.';
const SIGNAL = '2026-09-06T14:21:00Z';

/** The teacher's row, and the signal the database would have stamped for it. */
const teacherWrites = (text = INSTRUCTOR_TEXT, at = SIGNAL) => {
  messageRows = [
    ...messageRows,
    {
      id: `instructor-${at}`,
      role: 'instructor',
      content: text,
      sender_user_id: 'teacher-1',
      created_at: at,
    },
  ];
  sessionRow = { ...sessionRow, last_instructor_message_at: at };
};

const renderPanel = (extra: Record<string, unknown> = {}) =>
  render(
    <StreamingChatPanel
      kind="study_session"
      subjectId="s1"
      courseId="c1"
      heading="Το ελληνικό κράτος 1830-1881"
      onBack={() => {}}
      {...extra}
    />,
  );

const sseBody = (text: string) =>
  [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
    'data: [DONE]\n\n',
  ].join('');

beforeEach(() => {
  channelHandlers.length = 0;
  messageReads = [];
  failInstructorReads = 0;
  failProfileReads = 0;
  profileReadGate = null;
  sessionRow = { id: 'sess-1', status: 'in_progress' };
  profileRows = [{ user_id: 'teacher-1', full_name: 'Μαρία Παπαδοπούλου' }];
  messageRows = [
    {
      id: 'm1',
      role: 'assistant',
      content: TUTOR_TEXT,
      sender_user_id: null,
      created_at: '2026-09-06T14:10:00Z',
    },
  ];
  vi.stubGlobal('fetch', () => Promise.reject(new Error('no turn expected')));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("StreamingChatPanel: a teacher's message arrives live", () => {
  it('appears without a reload, signed, when the session row signals it', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText(TUTOR_TEXT)).toBeInTheDocument());
    expect(screen.queryByText(INSTRUCTOR_TEXT)).not.toBeInTheDocument();

    teacherWrites();
    await act(async () => {
      emit({ id: 'sess-1', status: 'in_progress', last_instructor_message_at: SIGNAL });
    });

    await waitFor(() => expect(screen.getByText(INSTRUCTOR_TEXT)).toBeInTheDocument());
    // Attribution is the point of delivering it at all — see the sibling suite.
    expect(screen.getByText('Μαρία Παπαδοπούλου · Instructor')).toBeInTheDocument();
    // And the conversation it landed in is still there.
    expect(screen.getByText(TUTOR_TEXT)).toBeInTheDocument();
  });

  it('does not render it twice when the same signal is seen again', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText(TUTOR_TEXT)).toBeInTheDocument());

    teacherWrites();
    const payload = { id: 'sess-1', status: 'in_progress', last_instructor_message_at: SIGNAL };
    await act(async () => { emit(payload); });
    await waitFor(() => expect(screen.getByText(INSTRUCTOR_TEXT)).toBeInTheDocument());

    // A repeat of the same signal — a reconnect, a second UPDATE carrying an
    // unchanged column — must be inert.
    await act(async () => { emit(payload); });
    await act(async () => { emit(payload); });

    expect(screen.getAllByText(INSTRUCTOR_TEXT)).toHaveLength(1);
  });

  it('delivers a second message, and keeps the first', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText(TUTOR_TEXT)).toBeInTheDocument());

    teacherWrites();
    await act(async () => {
      emit({ id: 'sess-1', status: 'in_progress', last_instructor_message_at: SIGNAL });
    });
    await waitFor(() => expect(screen.getByText(INSTRUCTOR_TEXT)).toBeInTheDocument());

    const second = 'Μια ακόμη σημείωση.';
    teacherWrites(second, '2026-09-06T14:30:00Z');
    await act(async () => {
      emit({
        id: 'sess-1',
        status: 'in_progress',
        last_instructor_message_at: '2026-09-06T14:30:00Z',
      });
    });

    await waitFor(() => expect(screen.getByText(second)).toBeInTheDocument());
    expect(screen.getByText(INSTRUCTOR_TEXT)).toBeInTheDocument();
  });

  it('waits for a turn in flight rather than being overwritten by it', async () => {
    // The streaming path replaces the *last* message with the finished reply.
    // A message appended under the placeholder would be silently clobbered, so
    // the merge has to hold until the turn is done.
    let releaseStream: (() => void) | undefined;
    const streamed = new Promise<void>((resolve) => { releaseStream = resolve; });
    vi.stubGlobal('fetch', async () => {
      await streamed;
      return new Response(sseBody(REPLY_TEXT), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });

    renderPanel();
    await waitFor(() => expect(screen.getByText(TUTOR_TEXT)).toBeInTheDocument());

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'ναι' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(screen.getByText('ναι')).toBeInTheDocument());

    // The teacher writes while the tutor is still answering.
    teacherWrites();
    await act(async () => {
      emit({ id: 'sess-1', status: 'in_progress', last_instructor_message_at: SIGNAL });
    });

    await act(async () => {
      releaseStream!();
      await streamed;
    });

    // Both survive: the reply the pupil was waiting for, and the message that
    // arrived underneath it.
    await waitFor(() => expect(screen.getByText(REPLY_TEXT)).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText(INSTRUCTOR_TEXT)).toBeInTheDocument());
    expect(screen.getAllByText(INSTRUCTOR_TEXT)).toHaveLength(1);
  });

  it('reads only the instructor rows, leaving the rendered conversation alone', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText(TUTOR_TEXT)).toBeInTheDocument());
    messageReads = [];

    teacherWrites();
    await act(async () => {
      emit({ id: 'sess-1', status: 'in_progress', last_instructor_message_at: SIGNAL });
    });
    await waitFor(() => expect(screen.getByText(INSTRUCTOR_TEXT)).toBeInTheDocument());

    // Not a transcript reload: re-reading every row would throw away an
    // in-flight turn's optimistic bubbles along with it.
    expect(messageReads).toEqual(['instructor']);
  });

  it('retries after a failed read rather than treating the signal as spent', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText(TUTOR_TEXT)).toBeInTheDocument());

    teacherWrites();
    const payload = { id: 'sess-1', status: 'in_progress', last_instructor_message_at: SIGNAL };

    // The read fails once. Nothing is rendered, and — this is the part that
    // matters — the signal must not be recorded as handled, or the same
    // timestamp arriving again would be dismissed and the message lost until a
    // newer one superseded it.
    failInstructorReads = 1;
    await act(async () => { emit(payload); });
    expect(screen.queryByText(INSTRUCTOR_TEXT)).not.toBeInTheDocument();

    // A reconnect, or any later update to the row, carries the same timestamp.
    await act(async () => { emit(payload); });
    await waitFor(() => expect(screen.getByText(INSTRUCTOR_TEXT)).toBeInTheDocument());
  });

  it('does not append twice when two merges overlap', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText(TUTOR_TEXT)).toBeInTheDocument());

    teacherWrites();

    // Both merges get past the message read and into the profile lookup before
    // either can finish, which is where the second used to find the same rows
    // still unclaimed.
    let openGate: (() => void) | undefined;
    profileReadGate = new Promise<void>((resolve) => { openGate = resolve; });

    await act(async () => {
      emit({ id: 'sess-1', status: 'in_progress', last_instructor_message_at: SIGNAL });
      emit({ id: 'sess-1', status: 'in_progress', last_instructor_message_at: SIGNAL });
      emit({ id: 'sess-1', status: 'paused', last_instructor_message_at: SIGNAL });
    });

    await act(async () => {
      openGate!();
      await profileReadGate;
    });

    await waitFor(() => expect(screen.getByText(INSTRUCTOR_TEXT)).toBeInTheDocument());
    expect(screen.getAllByText(INSTRUCTOR_TEXT)).toHaveLength(1);
  });

  it('does not let a second merge report success for the first one\'s failure', async () => {
    // The interaction of the two guards above, and the reason merges are
    // serialised rather than merely deduplicated. Run concurrently: the first
    // claims the rows and stalls in the profile lookup; the second finds
    // nothing fresh — it cannot tell "claimed" from "rendered" — and answers
    // "done", which marks the signal handled; the first then fails and releases
    // the claim, leaving nothing on screen and no signal left to retry with.
    renderPanel();
    await waitFor(() => expect(screen.getByText(TUTOR_TEXT)).toBeInTheDocument());

    teacherWrites();
    failProfileReads = 1;

    const payload = { id: 'sess-1', status: 'in_progress', last_instructor_message_at: SIGNAL };
    await act(async () => {
      emit(payload);
      emit(payload);
    });

    // The failed run must not have been reported as done by its neighbour, so
    // the retry still has a signal to act on.
    await act(async () => { emit(payload); });
    await waitFor(() => expect(screen.getByText(INSTRUCTOR_TEXT)).toBeInTheDocument());
    expect(screen.getAllByText(INSTRUCTOR_TEXT)).toHaveLength(1);
  });

  it('ignores an update that carries no signal', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText(TUTOR_TEXT)).toBeInTheDocument());
    messageReads = [];

    // A moderation pause, say: same row, same channel, nothing to do with a
    // teacher having written.
    await act(async () => {
      emit({ id: 'sess-1', status: 'paused', pause_reason: 'assistant_moderation' });
    });

    expect(messageReads).toEqual([]);
  });
});
