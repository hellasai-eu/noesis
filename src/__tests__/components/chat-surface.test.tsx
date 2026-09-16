import { describe, it, expect } from 'vitest';
import { USE_STREAMING_CHAT } from '@/lib/chat-surface';

/**
 * Which surface students are served.
 *
 * One assertion, and it earns its place: the buffered path is still in the tree
 * and still tested (`StudentStudySession.test.tsx` pins the flag to `false` to
 * reach it), so nothing else in the suite would notice this flipping back. A
 * silent revert would mean every student quietly returning to the old renderer
 * — and to a different moderation contract, since the buffered path withholds a
 * flagged reply rather than annotating it after the fact.
 *
 * If this is ever deliberately flipped, change the assertion and say why in the
 * commit. That is the point: it should take a decision, not a stray edit.
 */

describe('the tutoring surface students get', () => {
  it('is the streaming one', () => {
    expect(USE_STREAMING_CHAT).toBe(true);
  });
});
