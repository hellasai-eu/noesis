import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

vi.mock('@/assets/ai-tutor.png', () => ({ default: 'ai-tutor.png' }));

import { useChatStreaming } from '@/components/chat/ChatWidget';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * `finishTyping` waits for the character queue to drain by polling. Both the
 * poll and the state update that follows it used to outlive unmount: the poll
 * was a bare `setInterval` nobody held a handle to, and the `await` resumed
 * into `setIsTyping` on a hook that was gone. In CI that surfaced as an
 * unhandled `ReferenceError: window is not defined` — React reaching for a
 * `window` Vitest had already torn down — failing the Frontend Unit job with
 * every test green.
 */
describe('useChatStreaming — unmount teardown', () => {
  it('leaves no timer running after unmount mid-drain', () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useChatStreaming());

    act(() => {
      result.current.beginTyping(8);
      result.current.addToQueue('a stretch of text still waiting to be typed out');
    });
    // The drain poll is only armed while the queue is non-empty.
    void result.current.finishTyping();

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not update state when the drain finishes after unmount', async () => {
    // Armed before the teardown it is watching: React reports an update against
    // an unmounted tree through `console.error`, so a spy installed afterwards
    // would record nothing no matter how broken the mount guard was.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result, unmount } = renderHook(() => useChatStreaming());

    act(() => {
      result.current.beginTyping(8);
      result.current.addToQueue('x'.repeat(200));
    });

    const finished = result.current.finishTyping();
    unmount();

    // Resolves rather than hanging: unmount releases the drain wait.
    await expect(finished).resolves.toBeUndefined();

    expect(consoleError).not.toHaveBeenCalled();
  });

  it('keeps overlapping drains on one poll so neither is released early', async () => {
    const { result } = renderHook(() => useChatStreaming());

    act(() => {
      result.current.beginTyping(1);
      result.current.addToQueue('a second send can overlap a retry still typing');
    });

    // The second call must not cancel the first one's drain: doing so resolves
    // the first awaiter early, and its continuation stops the typing interval
    // the second is still waiting on — a queue that can no longer drain.
    let both: Promise<void>;
    act(() => {
      both = Promise.all([result.current.finishTyping(), result.current.finishTyping()]).then(() => undefined);
    });

    await act(async () => {
      await both;
    });

    expect(result.current.isTyping).toBe(false);
    expect(result.current.displayedContent).toBe('a second send can overlap a retry still typing');
  });

  it('still settles normally while mounted', async () => {
    const { result } = renderHook(() => useChatStreaming());

    act(() => {
      result.current.beginTyping(1);
      result.current.addToQueue('hello');
    });
    expect(result.current.isTyping).toBe(true);

    await act(async () => {
      await result.current.finishTyping();
    });

    expect(result.current.isTyping).toBe(false);
    expect(result.current.displayedContent).toBe('hello');
  });
});
