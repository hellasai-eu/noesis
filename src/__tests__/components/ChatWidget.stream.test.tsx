import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, render } from '@testing-library/react';

vi.mock('@/assets/ai-tutor.png', () => ({ default: 'ai-tutor.png' }));

import { ChatWidget, parseSSEStream, SSEStallError, SSEStreamError } from '@/components/chat/ChatWidget';

/** Builds a Response whose body emits `chunks`, then stays open forever. */
function stallingResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      // Deliberately never close — this is the failure being guarded against.
    },
  });
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
}

function completeResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('parseSSEStream — stall guard (issue #1039)', () => {
  it('rejects with SSEStallError when the stream goes silent', async () => {
    const seen: string[] = [];
    // Comfortably above the microtask in which the queued chunk is read, so a
    // loaded CI box cannot let the timer win the race and flake the assertion
    // below; still far below the suite's per-test budget.
    const promise = parseSSEStream(
      stallingResponse(['data: {"choices":[{"delta":{"content":"Το "}}]}\n\n']),
      { onContent: (c) => seen.push(c), stallTimeoutMs: 500 },
    );

    await expect(promise).rejects.toBeInstanceOf(SSEStallError);
    // The chunk that did arrive was still delivered before the stall was detected.
    expect(seen).toEqual(['Το ']);
  });

  it('surfaces an in-stream {type:"error"} instead of returning empty content', async () => {
    // The tutoring turn emits this then `[DONE]` when the model produced no output
    // text. Ignoring it made the turn look like a normal empty completion, so
    // the reason never reached the student (#1039).
    await expect(
      parseSSEStream(
        completeResponse([
          'data: {"type":"error","code":"tutor_empty_response","message":"The tutor did not produce a reply. Please try again."}\n\n',
          'data: [DONE]\n\n',
        ]),
        {},
      ),
    ).rejects.toMatchObject({
      name: 'SSEStreamError',
      code: 'tutor_empty_response',
      message: 'The tutor did not produce a reply. Please try again.',
    });
  });

  it('does not fire when the stream completes within the window', async () => {
    const result = await parseSSEStream(
      completeResponse([
        'data: {"choices":[{"delta":{"content":"Γεια"}}]}\n\n',
        'data: [DONE]\n\n',
      ]),
      { stallTimeoutMs: 5_000 },
    );

    expect(result.content).toBe('Γεια');
  });
});

describe('parseSSEStream — text_done (the end-of-turn stall)', () => {
  it('fires onTextDone mid-stream and keeps reading the frames after it', async () => {
    // The streaming surface sends text_done between the last delta and the
    // paperwork (metadata, notices, [DONE]). The callback must fire while the
    // stream is still open, and must not stop the reader: a turn_not_recorded
    // notice can still follow it.
    const events: string[] = [];
    const result = await parseSSEStream(
      completeResponse([
        'data: {"choices":[{"delta":{"content":"Η απά"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"ντηση."}}]}\n\n',
        'data: {"type":"text_done"}\n\n',
        'data: {"type":"notice","code":"turn_not_recorded","message":"not saved"}\n\n',
        'data: [DONE]\n\n',
      ]),
      {
        onContent: (c) => events.push(`content:${c}`),
        onTextDone: () => events.push('text_done'),
        onNotice: (n) => events.push(`notice:${n.code}`),
      },
    );

    expect(events).toEqual(['content:Η απά', 'content:ντηση.', 'text_done', 'notice:turn_not_recorded']);
    expect(result.content).toBe('Η απάντηση.');
  });

  it('is harmless to a consumer that does not listen for it', async () => {
    // The buffered surface's consumers pass no onTextDone; the frame must fall
    // through without breaking content accumulation or completion.
    const result = await parseSSEStream(
      completeResponse([
        'data: {"choices":[{"delta":{"content":"Γεια"}}]}\n\n',
        'data: {"type":"text_done"}\n\n',
        'data: [DONE]\n\n',
      ]),
      {},
    );

    expect(result.content).toBe('Γεια');
  });
});

describe('ChatWidget — composing while a turn is in flight', () => {
  const noop = async () => {};

  it('keeps the box typable while isLoading, but not the Send button', () => {
    // The student can draft their next message while the tutor replies; only
    // *send* waits, because the server builds the next turn from the persisted
    // transcript and a racing send would answer against a conversation missing
    // its last reply.
    const { container } = render(
      <ChatWidget
        messages={[{ role: 'user', content: 'ερώτηση' }]}
        onSendMessage={noop}
        isLoading
        inputType="textarea"
      />,
    );

    const box = container.querySelector('textarea')!;
    expect(box).toBeEnabled();

    fireEvent.change(box, { target: { value: 'η επόμενη σκέψη μου' } });
    expect(box).toHaveValue('η επόμενη σκέψη μου');
    // Text present, turn in flight: still not sendable.
    expect(container.querySelector('button[type="submit"]')).toBeDisabled();
  });

  it('enables Send once the turn is over', () => {
    const { container } = render(
      <ChatWidget
        messages={[{ role: 'user', content: 'ερώτηση' }]}
        onSendMessage={noop}
        isLoading={false}
        inputType="textarea"
      />,
    );

    fireEvent.change(container.querySelector('textarea')!, { target: { value: 'έτοιμο' } });
    expect(container.querySelector('button[type="submit"]')).toBeEnabled();
  });

  it('still hard-disables the box when the conversation is closed', () => {
    // `disabled` is the pause/completion gate and must keep winning: a paused
    // session takes no drafts either.
    const { container } = render(
      <ChatWidget
        messages={[{ role: 'user', content: 'ερώτηση' }]}
        onSendMessage={noop}
        disabled
        inputType="textarea"
      />,
    );

    expect(container.querySelector('textarea')).toBeDisabled();
  });
});

describe('ChatWidget — orphaned assistant placeholder (issue #1039)', () => {
  const noop = async () => {};

  it('renders nothing for an empty assistant message that is not the typing target', () => {
    // A placeholder whose reply never arrived, superseded by a newer exchange.
    // `isLastAssistant` only tracks the final assistant message, so this one
    // used to fall through and paint an empty bubble that never resolved.
    const rendered: string[] = [];

    const { container } = render(
      <ChatWidget
        messages={[
          { role: 'user', content: 'πρώτη ερώτηση' },
          { role: 'assistant', content: '' },
          { role: 'user', content: 'δεύτερη ερώτηση' },
          { role: 'assistant', content: 'Η απάντηση.' },
        ]}
        onSendMessage={noop}
        renderAssistantMessage={(msg, index, _isTyping, displayContent) => {
          rendered.push(displayContent);
          return <div key={index} data-testid="assistant">{displayContent}</div>;
        }}
      />,
    );

    const text = container.textContent ?? '';
    expect(text).toContain('πρώτη ερώτηση');
    expect(text).toContain('Η απάντηση.');
    // The empty placeholder must not reach the renderer at all.
    expect(rendered).toEqual(['Η απάντηση.']);
    expect(container.querySelectorAll('[data-testid="assistant"]').length).toBe(1);
  });
});
