import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

/**
 * The end-of-turn stall.
 *
 * After the last visible word, the server still generates the state tail,
 * awaits the moderation verdict and persists the turn before `[DONE]` — and the
 * client used to keep the typing cursor blinking through all of it. The
 * `text_done` frame is the server saying "the text is finished"; these tests
 * pin what the panel does with it: settle the bubble immediately, keep Send
 * gated until `[DONE]`, and still honour every frame that follows.
 */

vi.mock('@/assets/ai-tutor.png', () => ({ default: 'ai-tutor.png' }));

// Created once — see StreamingChatPanel.opening.test.tsx for why identity
// matters here.
const translation = {
  t: (k: string, fallback?: string | Record<string, unknown>) =>
    typeof fallback === "string" ? fallback : k,
};
vi.mock('react-i18next', () => ({ useTranslation: () => translation }));

vi.mock('@/integrations/supabase/client', () => {
  const makeQuery = (table: string) => {
    const query = {
      select: () => query,
      insert: () => query,
      single: async () => ({ data: { id: 'msg-new' }, error: null }),
      eq: () => query,
      in: () => query,
      order: () => query,
      maybeSingle: async () => ({ data: null, error: null }),
      then: (resolve: (r: { data: unknown; error: null }) => unknown) =>
        resolve({ data: table === 'chat_messages' ? [] : null, error: null }),
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
    },
  };
});

import { StreamingChatPanel } from '@/components/chat/StreamingChatPanel';

const WELCOME = 'Καλώς ήρθες! Τι θυμάσαι για την περίοδο αυτή;';

const frame = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

/** A stream the test feeds by hand, so it can assert between frames. */
function controlledStream() {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }),
    push: (chunk: string) => controller.enqueue(encoder.encode(chunk)),
    close: () => controller.close(),
    fail: (err: Error) => controller.error(err),
  };
}

let stream: ReturnType<typeof controlledStream>;

const renderPanel = () =>
  render(
    <StreamingChatPanel
      kind="study_session"
      subjectId="s1"
      courseId="c1"
      heading="Το ελληνικό κράτος 1830-1881"
      openWithTutorTurn
      onBack={() => {}}
    />,
  );

/** The panel mid-turn, with the whole reply streamed and text_done delivered. */
async function renderSettledMidTurn() {
  renderPanel();
  await waitFor(() => expect(stream).toBeTruthy());

  stream.push(frame({ choices: [{ delta: { content: WELCOME } }] }));
  stream.push(frame({ type: 'text_done' }));

  await waitFor(() => expect(screen.getByText(WELCOME)).toBeInTheDocument());
  // Settled: no typing cursor, no pulsing avatar — nothing claiming the tutor
  // is still writing a reply that is already on screen in full.
  await waitFor(() => expect(document.querySelector('.animate-pulse')).toBeNull());
}

beforeEach(() => {
  stream = undefined as unknown as ReturnType<typeof controlledStream>;
  vi.stubGlobal('fetch', () => {
    stream = controlledStream();
    return Promise.resolve(stream.response);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('StreamingChatPanel: text_done settles the bubble before [DONE]', () => {
  it('settles the reply while the stream is still open, and gates Send until [DONE]', async () => {
    await renderSettledMidTurn();

    // The student can already draft their next message...
    const box = screen.getByRole('textbox');
    expect(box).toBeEnabled();
    // jsdom fires no real key events here; setting the value through the
    // change event is what the composer's controlled input listens to.
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.change(box, { target: { value: 'η απάντησή μου' } });

    // ...but not send it: the turn is not persisted until [DONE].
    const send = document.querySelector('button[type="submit"]')!;
    expect(send).toBeDisabled();

    stream.push(frame({ type: 'metadata', state: {}, meta: {} }));
    stream.push('data: [DONE]\n\n');
    stream.close();

    await waitFor(() => expect(send).toBeEnabled());
    // The settled text survived the finalisation swap.
    expect(screen.getByText(WELCOME)).toBeInTheDocument();
  });

  it('lets a turn_not_recorded notice pop a bubble that was already settled', async () => {
    // text_done says the text is finished, not that it was saved. When the
    // persist then fails, the notice must still bring the settled bubble down
    // — an unsaved reply left standing would vanish on reload.
    await renderSettledMidTurn();

    stream.push(frame({ type: 'notice', code: 'turn_not_recorded', message: 'not saved' }));
    stream.push('data: [DONE]\n\n');
    stream.close();

    await waitFor(() => expect(screen.queryByText(WELCOME)).not.toBeInTheDocument());
    expect(screen.getByText('not saved')).toBeInTheDocument();
  });

  it('brings a settled bubble down when the stream dies before [DONE]', async () => {
    // The failure window between text_done and [DONE] is the persist itself,
    // so whether the reply was recorded is unknown. The bubble comes down for
    // the same reason the empty placeholder always has: Retry re-reads the
    // transcript and re-renders the reply if it was saved, and a bubble left
    // standing would sit beside that re-render as a duplicate.
    await renderSettledMidTurn();

    stream.fail(new Error('connection reset'));

    await waitFor(() => expect(screen.queryByText(WELCOME)).not.toBeInTheDocument());
  });
});
