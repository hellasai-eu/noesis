import { describe, it, expect, vi } from 'vitest';
import { render, renderHook, act } from '@testing-library/react';

vi.mock('@/assets/ai-tutor.png', () => ({ default: 'ai-tutor.png' }));

import { ChatWidget, RichContent, useChatMessages, formatMessageTime } from '@/components/chat/ChatWidget';
import type { ChatMessage } from '@/components/chat/ChatWidget';
import { AI_DISCLAIMER_EL, AI_DISCLAIMER_EN } from '@/components/AiDisclaimer';

describe('RichContent — fenced code block sanitization', () => {
  it('strips <p>/</p> tags and converts <br> to newlines inside fenced code blocks', () => {
    const message = [
      'Here is the algorithm:',
      '',
      '```',
      '<p>Αλγόριθμος Άθροισμα100</p>',
      '<p>άθροισμα ← 0</p>',
      '<p>Επανάλαβε</p>',
      '<p>  Διάβασε x</p>',
      '<p>  άθροισμα ← άθροισμα + x</p>',
      '<p>Μέχρις_ότου άθροισμα = 100</p>',
      '<p>Γράψε άθροισμα</p>',
      '<p>Τέλος Άθροισμα100</p>',
      '```',
    ].join('\n');

    const { container } = render(<RichContent content={message} />);

    const codeEl = container.querySelector('pre code');
    expect(codeEl).not.toBeNull();
    const codeText = codeEl!.textContent ?? '';

    expect(codeText).toContain('άθροισμα ← 0');
    expect(codeText).toContain('Τέλος Άθροισμα100');
    expect(codeText).not.toContain('<p>');
    expect(codeText).not.toContain('</p>');
  });

  it('converts <br> tags inside a fenced code block to newlines', () => {
    const message = '```\nline1<br>line2<br/>line3<br />line4\n```';

    const { container } = render(<RichContent content={message} />);
    const codeEl = container.querySelector('pre code');
    expect(codeEl).not.toBeNull();
    const codeText = codeEl!.textContent ?? '';

    expect(codeText).not.toContain('<br');
    expect(codeText.split('\n').map(s => s.trim()).filter(Boolean)).toEqual([
      'line1',
      'line2',
      'line3',
      'line4',
    ]);
  });

  it('does not strip <p> tags from non-code prose text', () => {
    const message = 'Use the `<p>` tag to wrap a paragraph in HTML.';

    const { container } = render(<RichContent content={message} />);
    expect(container.textContent).toContain('<p>');
    expect(container.querySelector('pre code')).toBeNull();
  });
});

describe('RichContent — maths must not span markup (issue #1039)', () => {
  it('does not swallow paragraph tags between $$ delimiters', () => {
    // Observed in production: the tutor put each `$$` on its own line, so
    // markdownToHtml made three paragraphs and the delimiters ended up in
    // separate ones. A `[\s\S]*?` regex over the serialized HTML then matched
    // `</p><p>f'(\xi)=0.</p><p>` as the formula body and handed the markup to
    // KaTeX, which typeset `</p><p>` on screen for the student.
    const message = ['τέτοιο ώστε', '', '$$', "f'(\\xi)=0.", '$$', '', 'Με απλά λόγια…'].join('\n');

    const { container } = render(<RichContent content={message} />);
    const text = container.textContent ?? '';

    expect(text).not.toContain('</p>');
    expect(text).not.toContain('<p>');
    // Asserting the tags are gone is not enough — leaving the delimiters on
    // screen as literal `$$` also passes that, and is what actually shipped.
    // The maths has to be typeset.
    // (textContent still holds the LaTeX source via KaTeX's MathML annotation,
    // which is intended — it is what copy-paste and screen readers read.)
    expect(container.querySelector('.katex')).not.toBeNull();
    expect(text).not.toContain('$$');
    expect(text).toContain('τέτοιο ώστε');
    expect(text).toContain('Με απλά λόγια…');
  });

  it('leaves an unterminated $ alone instead of consuming the rest of the message', () => {
    // Mid-stream the typewriter renders partial text, so a lone `$` is common.
    const message = 'Το κόστος είναι $5 και μετά συνεχίζουμε κανονικά.';

    const { container } = render(<RichContent content={message} />);
    const text = container.textContent ?? '';

    expect(text).toContain('συνεχίζουμε κανονικά');
  });

  it('still renders well-formed inline maths', () => {
    const { container } = render(<RichContent content={'Έστω $f(x)=x^2$ συνεχής.'} />);

    expect(container.querySelector('.katex')).not.toBeNull();
    expect(container.textContent ?? '').not.toContain('$');
  });
});

describe('RichContent — every delimiter family renders', () => {
  // Routing chat maths through the text-node walker (#1044) silently dropped
  // `\(…\)` and `\[…\]`, which the previous regex had handled: the walker only
  // looked for `$`. Pin all four so the next consolidation cannot lose a family.
  const cases: [string, string][] = [
    ['$…$', 'Έστω $f(x)=x^2$ συνεχής.'],
    ['$$…$$', 'Άρα:\n\n$$f(x)=x^2$$\n'],
    ['\\(…\\)', 'Έστω \\(f(x)=x^2\\) συνεχής.'],
    ['\\[…\\]', 'Άρα:\n\n\\[f(x)=x^2\\]\n'],
  ];

  for (const [name, source] of cases) {
    it(`renders ${name}`, () => {
      const { container } = render(<RichContent content={source} />);
      expect(container.querySelector('.katex')).not.toBeNull();
      expect(container.textContent ?? '').not.toContain('\\');
    });
  }
});

describe('RichContent — display maths with delimiters on their own lines', () => {
  // The shape the tutor actually produces, and the convention every author
  // uses. Markdown splits the blank lines into paragraphs, so by the time the
  // HTML exists the opening and closing `$$` are in different elements — the
  // text-node walker then (correctly) refuses to match across them and used to
  // leave `$$` on screen. Display maths is now taken out before markdown runs.
  const message = [
    'τότε υπάρχει τουλάχιστον ένα σημείο τέτοιο ώστε',
    '',
    '$$',
    "f'(\\xi)=0.",
    '$$',
    '',
    'Με απλά λόγια: οριζόντια εφαπτομένη.',
  ].join('\n');

  it('typesets the block instead of showing the delimiters', () => {
    const { container } = render(<RichContent content={message} />);
    const text = container.textContent ?? '';

    expect(container.querySelector('.katex')).not.toBeNull();
    expect(text).not.toContain('$$');
    expect(text).toContain('τότε υπάρχει');
    expect(text).toContain('Με απλά λόγια');
  });

  it('handles the \\[ … \\] form written the same way', () => {
    const withBrackets = message.replace('$$\n', '\\[\n').replace('\n$$', '\n\\]');
    const { container } = render(<RichContent content={withBrackets} />);

    expect(container.querySelector('.katex')).not.toBeNull();
    expect(container.textContent ?? '').not.toContain('\\[');
  });

  it('leaves $$ inside an inline code span literal', () => {
    // A message teaching the syntax must show it, not typeset it. Extraction
    // runs before markdown makes the span a <code> element, so the protection
    // has to happen inside extractDisplayMath itself.
    const { container } = render(<RichContent content={'Γράψε `$$x$$` για display.'} />);

    expect(container.querySelector('code')?.textContent ?? '').toContain('$$x$$');
    expect(container.querySelector('.katex')).toBeNull();
  });

  it('leaves \\[ … \\] inside an inline code span literal', () => {
    const { container } = render(<RichContent content={'Γράψε `\\[x\\]` για display.'} />);

    expect(container.querySelector('code')?.textContent ?? '').toContain('\\[');
    expect(container.querySelector('.katex')).toBeNull();
  });

  it('closes an inline span on its matching backtick run', () => {
    // ``a `b` c`` is one span containing a backtick — the delimiter run must be
    // matched by length, not by the first stray backtick encountered.
    const { container } = render(
      <RichContent content={'Δες ``$$a$$ `b` c`` και μετά $$z$$.'} />,
    );

    expect(container.querySelector('code')?.textContent ?? '').toContain('$$a$$');
    // The maths outside the span still renders.
    expect(container.querySelector('.katex')).not.toBeNull();
  });

  it('leaves $$ inside a fenced code block literal', () => {
    const { container } = render(
      <RichContent content={'Παράδειγμα:\n\n```\n$$\nx=1\n$$\n```'} />,
    );

    const code = container.querySelector('pre code')?.textContent ?? '';
    expect(code).toContain('$$');
    expect(container.querySelector('.katex')).toBeNull();
  });
});

describe('useChatMessages — every message carries a timestamp', () => {
  it('stamps a locally-created message that arrives without one', () => {
    const { result } = renderHook(() => useChatMessages());

    act(() => {
      result.current[1]([{ role: 'user', content: 'hello' }]);
    });

    expect(result.current[0][0].timestamp).toBeInstanceOf(Date);
  });

  it('leaves a message loaded from the database on its server time', () => {
    const created = '2026-06-27T09:15:00.000Z';
    const { result } = renderHook(() => useChatMessages());

    act(() => {
      result.current[1]([{ role: 'assistant', content: 'hi', timestamp: created }]);
    });

    expect(result.current[0][0].timestamp).toBe(created);
  });

  it('does not re-stamp an existing message when a later turn is added', () => {
    const { result } = renderHook(() => useChatMessages());

    act(() => {
      result.current[1]([{ role: 'user', content: 'first' }]);
    });
    const firstStamp = result.current[0][0].timestamp;

    act(() => {
      result.current[1]((prev: ChatMessage[]) => [...prev, { role: 'assistant', content: 'second' }]);
    });

    expect(result.current[0][0].timestamp).toBe(firstStamp);
    expect(result.current[0][1].timestamp).toBeInstanceOf(Date);
  });
});

// `formatMessageTime` formats in the host's locale, which decides the field
// separators, the numerals and the order. Asking Intl for the same fields under
// the same locale keeps these assertions about *which fields are present and
// which hour cycle they use* — the things the formatter decides — instead of
// pinning them to the ASCII, en-US-shaped output the CI box happens to produce.
const partsIn = (date: Date, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat([], options).format(date);

describe('formatMessageTime — date as well as time', () => {
  it('carries the day and month, not just the clock', () => {
    const afternoon = new Date(2026, 5, 27, 13, 24);

    expect(formatMessageTime(afternoon)).toContain(
      partsIn(afternoon, { day: 'numeric', month: 'short' })
    );
  });

  it('reads the clock in 24 hours, as the instructor-side viewer does', () => {
    const in24h = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } as const;

    // 13:24, never 01:24 PM — a 12-hour formatter cannot contain this.
    const afternoon = new Date(2026, 5, 27, 13, 24);
    expect(formatMessageTime(afternoon)).toContain(partsIn(afternoon, in24h));

    // Midnight is 00:xx, not 24:xx — h23, not h24.
    const midnight = new Date(2026, 5, 27, 0, 5);
    expect(formatMessageTime(midnight)).toContain(partsIn(midnight, in24h));
  });

  it('spells out the year only for a message from another one', () => {
    const thisYear = new Date();
    thisYear.setMonth(0, 15);
    const otherYear = new Date(2019, 0, 15, 9, 5);

    expect(formatMessageTime(thisYear)).not.toContain(partsIn(thisYear, { year: 'numeric' }));
    expect(formatMessageTime(otherYear)).toContain(partsIn(otherYear, { year: 'numeric' }));
  });

  it('returns null for a missing or unparseable timestamp', () => {
    expect(formatMessageTime(undefined)).toBeNull();
    expect(formatMessageTime('not a date')).toBeNull();
  });
});

describe('ChatWidget — AI transparency notice (#936)', () => {
  const messages: ChatMessage[] = [
    { id: 'm1', role: 'user', content: 'Γιατί ο ουρανός είναι γαλάζιος;' },
    { id: 'm2', role: 'assistant', content: 'Σκέψου τι κάνει το φως στην ατμόσφαιρα.' },
  ];

  it('shows the bilingual notice below the input, on an empty conversation and a busy one', () => {
    // Persistent means persistent: a notice that only appears once the model
    // has replied has already missed the first thing the student read.
    for (const msgs of [[] as ChatMessage[], messages]) {
      const { container, unmount } = render(
        <ChatWidget messages={msgs} onSendMessage={async () => {}} />,
      );

      const note = container.querySelector('[data-testid="ai-disclaimer"]');
      expect(note).not.toBeNull();
      expect(note!.textContent).toContain(AI_DISCLAIMER_EL);
      expect(note!.textContent).toContain(AI_DISCLAIMER_EN);

      // Below the input, at the foot of the widget — DOCUMENT_POSITION_PRECEDING
      // means the textbox comes before the note in document order.
      const input = container.querySelector('input, textarea');
      expect(input).not.toBeNull();
      expect(note!.compareDocumentPosition(input!) & Node.DOCUMENT_POSITION_PRECEDING)
        .toBeTruthy();

      unmount();
    }
  });

  it('offers no way to dismiss it', () => {
    const { container } = render(
      <ChatWidget messages={messages} onSendMessage={async () => {}} />,
    );

    const note = container.querySelector('[data-testid="ai-disclaimer"]');
    expect(note!.querySelector('button')).toBeNull();
  });
});

describe('ChatWidget — the transcript scrolls instead of overflowing its container', () => {
  const messages: ChatMessage[] = [
    { id: 'm1', role: 'user', content: 'to emvado einai ena trigono' },
    { id: 'm2', role: 'assistant', content: 'Καλή αρχή, αλλά εδώ το χωρίο δεν είναι τρίγωνο.' },
  ];

  // jsdom lays nothing out, so this asserts the class rather than the pixels.
  // It is still the real guard: the widget is always a flex item in a
  // height-capped column, and dropping `min-h-0` lets `min-height: auto` size
  // it to the whole transcript, which then paints over the global footer on
  // /student/course/:id.
  it('keeps min-h-0 on the root and the scroll region', () => {
    const { container } = render(
      <ChatWidget messages={messages} onSendMessage={async () => {}} className="flex-1" />,
    );

    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain('min-h-0');
    expect(root.className).toContain('flex-1');

    const scrollRegion = root.firstElementChild as HTMLElement;
    expect(scrollRegion.className).toContain('min-h-0');
    expect(scrollRegion.className).toContain('flex-1');
  });
});
