import { describe, it, expect, vi } from 'vitest';

vi.mock('@/assets/ai-tutor.png', () => ({ default: 'ai-tutor.png' }));

import { parseSSEStream } from '@/components/chat/ChatWidget';

/**
 * The streaming surface screens a reply *after* delivering it, so a flag
 * arrives once the pupil has already read the text. `moderation_flag` is the
 * frame that carries it, and the banner it drives is the only signal they get.
 *
 * A parser that quietly ignored an unrecognised frame would turn that into
 * silence — which is exactly what a moderation flag must never be.
 */

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

describe('parseSSEStream — post-delivery moderation', () => {
  it('surfaces a moderation_flag frame that arrives after the reply', async () => {
    const flags: Array<{ categories?: string[]; message?: string }> = [];

    const result = await parseSSEStream(
      completeResponse([
        'data: {"choices":[{"delta":{"content":"Light scatters."}}]}\n\n',
        'data: {"type":"metadata","state":{"decision":"ASK"}}\n\n',
        'data: {"type":"moderation_flag","categories":["violence"],"message":"withdrawn for review"}\n\n',
        'data: [DONE]\n\n',
      ]),
      { onModerationFlag: (f) => flags.push(f) },
    );

    expect(flags).toHaveLength(1);
    expect(flags[0].categories).toEqual(['violence']);
    expect(flags[0].message).toBe('withdrawn for review');

    // The reply itself still came through — on this surface the pupil has read
    // it, and pretending otherwise would lose the transcript.
    expect(result.content).toBe('Light scatters.');
  });

  it('does not let a moderation_flag overwrite the tutor state metadata', async () => {
    // The flag arrives after the metadata frame. Folding it into `metadata`
    // would clobber the state the client was already given, which is why it is
    // its own frame type.
    const result = await parseSSEStream(
      completeResponse([
        'data: {"type":"metadata","state":{"decision":"HINT"},"meta":{"confidence":0.9}}\n\n',
        'data: {"type":"moderation_flag","categories":["self-harm"],"message":"withdrawn"}\n\n',
        'data: [DONE]\n\n',
      ]),
      { onModerationFlag: () => {} },
    );

    expect(result.metadata?.state).toEqual({ decision: 'HINT' });
    expect(result.metadata?.meta).toEqual({ confidence: 0.9 });
  });

  it('ignores the frame without throwing when a consumer does not handle it', async () => {
    // The buffered endpoint never sends this frame, so its callers omit the
    // callback. That must stay harmless rather than becoming a parse error.
    const result = await parseSSEStream(
      completeResponse([
        'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
        'data: {"type":"moderation_flag","categories":["violence"]}\n\n',
        'data: [DONE]\n\n',
      ]),
      {},
    );

    expect(result.content).toBe('hello');
  });
});

describe('parseSSEStream — non-fatal notices', () => {
  it('does not terminate the stream, so a later moderation flag still arrives', async () => {
    // The regression this fixes: `turn_not_recorded` was sent as
    // {type:"error"}, which rejects the stream and cancels the reader — so the
    // moderation verdict that follows never reached the pupil, and the panel
    // stayed unpaused while the server paused the session.
    const notices: Array<{ code?: string; message?: string }> = [];
    const flags: Array<{ message?: string }> = [];

    const result = await parseSSEStream(
      completeResponse([
        'data: {"choices":[{"delta":{"content":"Light scatters."}}]}\n\n',
        'data: {"type":"notice","code":"turn_not_recorded","message":"could not be saved"}\n\n',
        'data: {"type":"moderation_flag","categories":["violence"],"message":"withdrawn"}\n\n',
        'data: [DONE]\n\n',
      ]),
      {
        onNotice: (n) => notices.push(n),
        onModerationFlag: (f) => flags.push(f),
      },
    );

    expect(notices).toHaveLength(1);
    expect(notices[0].code).toBe('turn_not_recorded');

    // The frame after the notice still landed — the whole point of the fix.
    expect(flags).toHaveLength(1);
    expect(flags[0].message).toBe('withdrawn');
    expect(result.content).toBe('Light scatters.');
  });

  it('still treats {type:"error"} as terminal', async () => {
    // A notice is not a softening of `error`. A turn that produced no reply is
    // genuinely fatal and must keep rejecting.
    await expect(
      parseSSEStream(
        completeResponse([
          'data: {"type":"error","code":"tutor_empty_response","message":"no reply"}\n\n',
          'data: [DONE]\n\n',
        ]),
        {},
      ),
    ).rejects.toThrow();
  });

  it('ignores a notice when the consumer does not handle it', async () => {
    const result = await parseSSEStream(
      completeResponse([
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
        'data: {"type":"notice","code":"turn_already_answered"}\n\n',
        'data: [DONE]\n\n',
      ]),
      {},
    );
    expect(result.content).toBe('hi');
  });
});
