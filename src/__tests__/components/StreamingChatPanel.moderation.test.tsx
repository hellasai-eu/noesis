import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * What a pupil is told about a paused session, and why it comes from one place.
 *
 * On the streaming surface the tutor's reply is screened *after* the stream
 * closes, so the verdict lands with no stream to announce it on. The pause on
 * `chat_sessions` is the announcement, and `pause_reason` says what it was for.
 *
 * The single source is the point. An earlier draft correlated a
 * `role='moderation'` message against `chat_sessions.status`; because those two
 * rows commit separately, every interleaving of the writes, the reads and the
 * Realtime events was its own defect. These tests pin the behaviour that
 * replaced them — including the two interleavings that used to break it.
 */

vi.mock('@/assets/ai-tutor.png', () => ({ default: 'ai-tutor.png' }));

// `t` and its wrapper are created ONCE. Returning a fresh object per render
// changes the identity of every `useCallback` that depends on `t`, which
// re-runs the effects that depend on those — so the transcript load fires on
// every render instead of on mount, and a test that sequences successive reads
// silently measures that loop rather than the code under test.
// The second argument is a fallback string or, as in the message counter, an
// i18next options object — which real i18next interpolates, never returns.
const translation = {
  t: (k: string, fallback?: string | Record<string, unknown>) =>
    typeof fallback === "string" ? fallback : k,
};
vi.mock('react-i18next', () => ({ useTranslation: () => translation }));

const WITHHELD_KEY = 'session.moderationReplyWithheld';
/** The generic paused banner, shown whenever a pause has no named cause. */
const PAUSED_TEXT = 'This session is paused for instructor review.';

type SessionRow = { id: string; status: string; pause_reason?: string | null };
let sessionRow: SessionRow | null = null;
/**
 * Successive answers to the session read, for tests that need the row to change
 * between the load and the post-subscribe reconcile — the window in which a
 * verdict used to be lost entirely. Empty means "always `sessionRow`".
 */
let sessionReads: (SessionRow | null)[] = [];
/**
 * Held in front of the session read, so a test can keep the reconcile's query
 * in flight while a live event lands — the window in which the reconcile's
 * older snapshot used to overwrite a newer verdict.
 */
let sessionReadGate: Promise<void> | null = null;
/** Session reads so far. The gate applies from the second — the reconcile's. */
let sessionReadCount = 0;
let messageRows: { id: string; role: string; content: string; created_at: string }[] = [];
/** Ids passed to a `chat_messages` delete, for the refused-turn withdrawal. */
let deletedIds: string[] = [];

/**
 * Every `postgres_changes` handler the panel registers.
 *
 * A test event is handed to all of them, which is what the real channel does
 * not do — but each handler already has to reject payloads that are not its
 * own, so broadcasting is a stricter test than routing would be.
 */
const channelHandlers: ((payload: { new: Record<string, unknown> }) => void)[] = [];
const emit = (row: Record<string, unknown>) => channelHandlers.forEach((h) => h({ new: row }));

vi.mock('@/integrations/supabase/client', () => {
  const makeQuery = (table: string) => {
    // `.in('role', ...)` is honoured because the panel relies on it to keep
    // moderation records out of the transcript — a mock that ignored it would
    // let a test claiming they are never rendered pass without checking.
    let roles: string[] | null = null;
    let deleting = false;
    const rows = () => {
      if (table !== 'chat_messages') return [];
      return roles ? messageRows.filter((m) => roles!.includes(m.role)) : messageRows;
    };
    const query = {
      select: () => query,
      insert: () => query,
      delete: () => {
        deleting = true;
        return query;
      },
      single: async () => ({ data: { id: 'msg-new' }, error: null }),
      eq: (_column: string, value: string) => {
        if (deleting && table === 'chat_messages') deletedIds.push(value);
        return query;
      },
      in: (_column: string, values: string[]) => {
        roles = values;
        return query;
      },
      order: () => query,
      limit: () => query,
      maybeSingle: async () => {
        if (table !== 'chat_sessions') return { data: null, error: null };
        const data = sessionReads.shift() ?? sessionRow;
        sessionReadCount += 1;
        // Captured before awaiting, so the answer is the one that was true when
        // the query was issued — which is the whole point of a stale snapshot.
        // The first read is the transcript load, which must complete for the
        // subscription to exist at all; only the reconcile's read is held.
        if (sessionReadGate && sessionReadCount > 1) await sessionReadGate;
        return { data, error: null };
      },
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
        const ch = {
          on: (
            _event: string,
            _config: unknown,
            handler: (payload: { new: Record<string, unknown> }) => void,
          ) => {
            channelHandlers.push(handler);
            return ch;
          },
          subscribe: (cb?: (status: string) => void) => {
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

const renderPanel = (extra: Record<string, unknown> = {}) =>
  render(
    <StreamingChatPanel
      kind="open_question"
      subjectId="q1"
      courseId="c1"
      onBack={() => {}}
      {...extra}
    />,
  );

const reply = {
  id: 'm1',
  role: 'assistant',
  content: 'Light scatters in the atmosphere.',
  created_at: '2026-09-03T10:00:00Z',
};

/** The audit record. Written for reviewers; never shown to the pupil. */
const moderationRecord = {
  id: 'm2',
  role: 'moderation',
  content: JSON.stringify({
    type: 'moderation',
    side: 'assistant',
    decision: 'blocked',
    withheld_text: 'Light scatters in the atmosphere.',
    flaggedCategories: ['violence'],
  }),
  created_at: '2026-09-03T10:00:05Z',
};

const flaggedSession: SessionRow = {
  id: 's1',
  status: 'paused',
  pause_reason: 'assistant_moderation',
};

beforeEach(() => {
  sessionRow = null;
  messageRows = [];
  sessionReads = [];
  sessionReadGate = null;
  sessionReadCount = 0;
  deletedIds = [];
  channelHandlers.length = 0;
});

describe('StreamingChatPanel: what a paused session says on load', () => {
  it('warns about a reply withheld while the panel was unmounted', async () => {
    sessionRow = flaggedSession;
    messageRows = [reply, moderationRecord];

    renderPanel();

    // Told, without having been present when the verdict landed.
    await waitFor(() => expect(screen.getByText(WITHHELD_KEY)).toBeInTheDocument());
  });

  it('never renders the moderation record as conversation', async () => {
    sessionRow = flaggedSession;
    messageRows = [reply, moderationRecord];

    const { container } = renderPanel();

    await waitFor(() => expect(screen.getByText(WITHHELD_KEY)).toBeInTheDocument());

    // The envelope and its withheld-text field must not reach the transcript.
    expect(container.textContent).not.toContain('withheld_text');
    expect(container.textContent).not.toContain('"decision"');
  });

  it('does not blame the tutor for a pause with another cause', async () => {
    // The record of an older, released flag is still in the transcript. The
    // reason on the session says this pause is not about it.
    sessionRow = { id: 's1', status: 'paused', pause_reason: 'message_interval' };
    messageRows = [reply, moderationRecord];

    renderPanel();

    await waitFor(() => expect(screen.getByText(PAUSED_TEXT)).toBeInTheDocument());
    expect(screen.queryByText(WITHHELD_KEY)).not.toBeInTheDocument();
  });

  it('does not blame the tutor for the pupil\'s own flagged message', async () => {
    sessionRow = { id: 's1', status: 'paused', pause_reason: 'input_moderation' };
    messageRows = [reply];

    renderPanel();

    await waitFor(() => expect(screen.getByText(PAUSED_TEXT)).toBeInTheDocument());
    expect(screen.queryByText(WITHHELD_KEY)).not.toBeInTheDocument();
  });

  it('stays quiet once the session is no longer paused', async () => {
    sessionRow = { id: 's1', status: 'in_progress', pause_reason: null };
    messageRows = [reply, moderationRecord];

    renderPanel();

    await waitFor(() => expect(screen.getByText(reply.content)).toBeInTheDocument());
    expect(screen.queryByText(WITHHELD_KEY)).not.toBeInTheDocument();
    expect(screen.queryByText(PAUSED_TEXT)).not.toBeInTheDocument();
  });
});

describe('StreamingChatPanel: live moderation state', () => {
  it('raises the banner when the verdict lands while mounted', async () => {
    sessionRow = { id: 's1', status: 'in_progress' };
    messageRows = [reply];

    renderPanel();
    await waitFor(() => expect(channelHandlers.length).toBeGreaterThan(0));
    expect(screen.queryByText(WITHHELD_KEY)).not.toBeInTheDocument();

    act(() => emit(flaggedSession));

    expect(screen.getByText(WITHHELD_KEY)).toBeInTheDocument();
  });

  it('clears the banner when an instructor releases the session', async () => {
    sessionRow = flaggedSession;
    messageRows = [reply, moderationRecord];

    renderPanel();
    await waitFor(() => expect(screen.getByText(WITHHELD_KEY)).toBeInTheDocument());

    act(() => emit({ id: 's1', status: 'in_progress', pause_reason: null }));

    expect(screen.queryByText(WITHHELD_KEY)).not.toBeInTheDocument();
    // Clearing the banner is not enough on its own: `paused` also gates the
    // composer, so leaving it set would swap the moderation warning for the
    // generic paused one and keep refusing to send.
    expect(screen.queryByText(PAUSED_TEXT)).not.toBeInTheDocument();
  });

  it('leaves a pause with another cause on the generic copy', async () => {
    sessionRow = { id: 's1', status: 'in_progress' };
    messageRows = [reply];

    renderPanel();
    await waitFor(() => expect(channelHandlers.length).toBeGreaterThan(0));

    act(() => emit({ id: 's1', status: 'paused', pause_reason: 'history_limit' }));

    expect(screen.getByText(PAUSED_TEXT)).toBeInTheDocument();
    expect(screen.queryByText(WITHHELD_KEY)).not.toBeInTheDocument();
  });

  it('catches a verdict that landed while the panel was starting up', async () => {
    // The seam between the two mechanisms. The load reads the session as still
    // running; the pause then commits; the subscription attaches afterwards and
    // Realtime does not replay. Without the post-subscribe reconcile this pupil
    // kept the flagged reply with no banner and an enabled composer.
    sessionReads = [
      { id: 's1', status: 'in_progress' }, // the load, too early to see it
      flaggedSession, // the reconcile, once listening
    ];
    sessionRow = flaggedSession;
    messageRows = [reply];

    renderPanel();

    await waitFor(() => expect(screen.getByText(WITHHELD_KEY)).toBeInTheDocument());
  });

  it('does not let a stale reconcile overwrite a verdict that arrived first', async () => {
    // The reconcile's read is issued before the pause commits, so its snapshot
    // says "running". The verdict then arrives on the channel while that read
    // is still in flight. Applying the snapshot afterwards would clear the
    // banner and re-enable the composer for a session that is in fact paused.
    let release: () => void = () => {};
    sessionReadGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    sessionRow = { id: 's1', status: 'in_progress' };
    messageRows = [reply];

    renderPanel();
    await waitFor(() => expect(channelHandlers.length).toBeGreaterThan(0));

    act(() => emit(flaggedSession));
    expect(screen.getByText(WITHHELD_KEY)).toBeInTheDocument();

    await act(async () => {
      release();
      await Promise.resolve();
    });

    expect(screen.getByText(WITHHELD_KEY)).toBeInTheDocument();
    expect(screen.queryByText(PAUSED_TEXT)).not.toBeInTheDocument();
  });
});

describe('StreamingChatPanel: the caller owns the header and the facts', () => {
  /*
    Not decoration. Students lost "mark as complete", and the created / started /
    message-count line with it, the moment this panel became the surface they
    are served — it had been built as a separate screen with neither. It takes
    both from its caller so the two renderers cannot disagree about what a
    student is allowed to do.
  */
  it('renders the actions and the facts it is given', async () => {
    sessionRow = { id: 's1', status: 'in_progress' };
    messageRows = [reply];

    renderPanel({
      title: 'Open question',
      subtitle: 'Socratic learning',
      headerActions: <button type="button">Mark as complete</button>,
      meta: <span>Created 10 Jul 2026</span>,
    });

    await waitFor(() => expect(screen.getByText('Open question')).toBeInTheDocument());
    expect(screen.getByText('Socratic learning')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark as complete' })).toBeInTheDocument();
    expect(screen.getByText('Created 10 Jul 2026')).toBeInTheDocument();
  });

  it('refuses new turns when the caller says the subject is finished', async () => {
    // A completed open question. The buffered view gated its composer on
    // `isFlagged || isCompleted`; this renderer knows only about pauses, so the
    // second half has to be handed to it or a student can keep tutoring a
    // question they have already finished.
    sessionRow = { id: 's1', status: 'in_progress' };
    messageRows = [reply];

    renderPanel({ title: 'Open question', disabled: true });

    await waitFor(() => expect(screen.getByText('Open question')).toBeInTheDocument());
    const input = screen.getByRole('textbox');
    expect(input).toBeDisabled();
  });

  it('shows a paused session as paused in its own header', async () => {
    // Derived from the session row this panel already reads, not passed in: a
    // caller-supplied copy fed by separate state is the two-sources-of-truth
    // mistake that cost this component five review rounds.
    sessionRow = { id: 's1', status: 'paused', pause_reason: 'message_interval' };
    messageRows = [reply];

    renderPanel({ title: 'Open question' });

    await waitFor(() =>
      expect(screen.getByText('session.sessionPausedBadge')).toBeInTheDocument(),
    );
  });
});

describe('StreamingChatPanel: a refused turn is not left behind', () => {
  /*
    The student's turn is written before the request — that is what makes a
    retry idempotent — so a server refusal leaves it in the transcript with no
    reply after it, and replays it to the model if the subject is reopened.

    Reachable despite the composer being disabled on a completed question: the
    question can be completed in another tab, leaving this client's `disabled`
    prop stale.
  */
  const typeAndSend = async (text: string) => {
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: text } });
    fireEvent.submit(input.closest('form')!);
  };

  const refuseWith = (body: Record<string, unknown>) =>
    vi.stubGlobal('fetch', () =>
      Promise.resolve({
        ok: false,
        headers: { get: () => null },
        json: () => Promise.resolve(body),
      }),
    );

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the refused turn on screen, because the row is still there', async () => {
    // The server refuses the turn and leaves it in the transcript, so showing
    // it is the honest thing. Nothing here deletes, and the reply already on
    // screen has to survive the refusal too.
    sessionRow = { id: 's1', status: 'in_progress' };
    messageRows = [reply];
    refuseWith({ error: 'session_completed', message: 'Already complete.' });

    renderPanel({ title: 'Open question' });
    await waitFor(() => expect(screen.getByText(reply.content)).toBeInTheDocument());

    await typeAndSend('a turn that survived');

    await waitFor(() => expect(screen.getByRole('textbox')).toBeDisabled());
    expect(screen.getByText('a turn that survived')).toBeInTheDocument();
    expect(screen.getByText(reply.content)).toBeInTheDocument();
    expect(deletedIds).toEqual([]);
  });

  it('re-enables the composer when the question is reopened', async () => {
    /*
      Reopening has to reach this panel without a remount, and it does — as an
      UPDATE on the session row it already subscribes to.

      The first attempt at this latched a `refusedComplete` flag and cleared it
      when the `disabled` prop went false. That never fired in the case it was
      written for: the tab whose state is stale has `disabled === false`
      already, so there was no transition, and the composer stayed dead until a
      reload. Deriving from the row is what makes reopening — from any tab —
      simply arrive.
    */
    sessionRow = { id: 's1', status: 'in_progress' };
    messageRows = [reply];
    refuseWith({ error: 'session_completed', message: 'Already complete.', withdrewTurn: true });

    renderPanel({ title: 'Open question' });
    await waitFor(() => expect(screen.getByText(reply.content)).toBeInTheDocument());

    await typeAndSend('one more thought');
    await waitFor(() => expect(screen.getByRole('textbox')).toBeDisabled());

    act(() => emit({ id: 's1', status: 'in_progress', pause_reason: null }));

    expect(screen.getByRole('textbox')).not.toBeDisabled();
  });

  it('disables the composer when the session row says complete', async () => {
    sessionRow = { id: 's1', status: 'completed' };
    messageRows = [reply];

    renderPanel({ title: 'Open question' });

    await waitFor(() => expect(screen.getByRole('textbox')).toBeDisabled());
  });

  it('keeps the turn when the session is merely paused', async () => {
    // A paused session is on its way to an instructor, and what they review is
    // what the student actually wrote. Deleting it would destroy the thing
    // being reviewed — so this must NOT behave like the completed case.
    sessionRow = { id: 's1', status: 'in_progress' };
    messageRows = [reply];
    refuseWith({ error: 'session_paused', message: 'Paused.' });

    renderPanel({ title: 'Open question' });
    await waitFor(() => expect(screen.getByText(reply.content)).toBeInTheDocument());

    await typeAndSend('something a teacher should see');

    await waitFor(() => expect(screen.getByText(PAUSED_TEXT)).toBeInTheDocument());
    expect(deletedIds).toEqual([]);
    expect(screen.getByText('something a teacher should see')).toBeInTheDocument();
    // Same guard as the completed case: a refusal must not swallow the reply
    // already on screen by leaving the typing state set behind it.
    expect(screen.getByText(reply.content)).toBeInTheDocument();
  });
});
