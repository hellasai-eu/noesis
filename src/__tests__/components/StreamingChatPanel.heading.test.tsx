import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

/**
 * The question above a streamed conversation.
 *
 * Open questions are authored in LaTeX and markdown, so printing the heading as
 * plain text showed a student `$$ f(x)=x^3 \quad \text{και} \quad g(x)=2x-x^2 $$`
 * verbatim — directly above replies that rendered the same maths correctly,
 * because those go through ChatWidget's renderer and the heading did not.
 */

vi.mock('@/assets/ai-tutor.png', () => ({ default: 'ai-tutor.png' }));

// The panel loads a transcript on mount. These resolve to nothing so it renders
// its empty state; the heading does not depend on any of it.
vi.mock('@/integrations/supabase/client', () => {
  const query = {
    select: () => query,
    eq: () => query,
    in: () => query,
    order: () => Promise.resolve({ data: [], error: null }),
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
  };
  return {
    supabase: {
      auth: { getUser: () => Promise.resolve({ data: { user: null }, error: null }) },
      from: () => query,
      functions: { invoke: () => Promise.resolve({ data: null, error: null }) },
    },
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, fallback?: string) => fallback ?? _k }),
}));

import { StreamingChatPanel } from '@/components/chat/StreamingChatPanel';

/**
 * The text a student actually sees.
 *
 * KaTeX emits its rendered HTML *and* a MathML `<annotation>` holding the
 * original TeX, so raw `textContent` contains `\quad` even on a correct render.
 * Dropping the annotations is what separates "the maths rendered" from "the
 * source was printed at the student".
 */
const visibleText = (el: HTMLElement): string => {
  const clone = el.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('annotation, .katex-mathml').forEach((n) => n.remove());
  return clone.textContent ?? '';
};

const renderPanel = (heading: string) =>
  render(
    <StreamingChatPanel
      kind="open_question"
      subjectId="q1"
      courseId="c1"
      heading={heading}
      onBack={() => {}}
    />,
  );

describe('StreamingChatPanel heading', () => {
  it('renders the maths in a question rather than its source', () => {
    const { container } = renderPanel(
      'Να υπολογίσετε το εμβαδόν των συναρτήσεων $$ f(x)=x^3 \\quad \\text{και} \\quad g(x)=2x-x^2. $$',
    );

    const heading = screen.getByRole('heading', { level: 2 });
    const seen = visibleText(heading);

    // KaTeX ran, and none of the source leaked through to the student.
    expect(container.querySelector('.katex')).not.toBeNull();
    expect(seen).not.toContain('$$');
    expect(seen).not.toContain('\\quad');
    expect(seen).not.toContain('\\text');

    // The prose around the maths still reads normally, and the maths itself is
    // laid out rather than echoed.
    expect(seen).toContain('Να υπολογίσετε το εμβαδόν');
    expect(seen).toContain('και');
  });

  it('prints a study session title literally, formatting and all', () => {
    // A title is not authored content — every other surface shows it verbatim,
    // so formatting it here alone would make this screen disagree with them.
    // The characters below are exactly the ones `formatQuestionText` acts on.
    const title = 'Κεφάλαιο 3: **ισότητες** και x^2';
    const { container } = render(
      <StreamingChatPanel
        kind="study_session"
        subjectId="s1"
        courseId="c1"
        heading={title}
        onBack={() => {}}
      />,
    );

    const seen = screen.getByRole('heading', { level: 2 });
    expect(seen.textContent).toBe(title);
    // Not turned into emphasis, a superscript, or maths.
    expect(container.querySelector('strong')).toBeNull();
    expect(container.querySelector('sup')).toBeNull();
    expect(container.querySelector('.katex')).toBeNull();
  });

  it("shows the instructor's notes under the heading, above the attachments", () => {
    // The notes are what the instructor wrote *for the student*. The session's
    // topic is not — it is the objective the tutor is given, written about the
    // student rather than to them, and no student surface shows it. Which is
    // why this panel takes a node it renders as given rather than a string it
    // decides how to display.
    const notes = 'Διάβασε πρώτα τη σελίδα 42 και κράτησε σημειώσεις.';
    render(
      <StreamingChatPanel
        kind="study_session"
        subjectId="s1"
        courseId="c1"
        heading="Το ελληνικό κράτος 1830-1881"
        notes={<p>{notes}</p>}
        attachments={<div data-testid="attachments" />}
        onBack={() => {}}
      />,
    );

    const shown = screen.getByText(notes);

    // Under the title, above the attachments.
    const FOLLOWS = Node.DOCUMENT_POSITION_FOLLOWING;
    const title = screen.getByRole('heading', { level: 2 });
    const attachments = screen.getByTestId('attachments');
    expect(title.compareDocumentPosition(shown) & FOLLOWS).toBeTruthy();
    expect(shown.compareDocumentPosition(attachments) & FOLLOWS).toBeTruthy();
  });

  it('renders no heading when none is given', () => {
    render(
      <StreamingChatPanel kind="study_session" subjectId="s1" courseId="c1" onBack={() => {}} />,
    );

    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
  });
});
