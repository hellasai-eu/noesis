import { describe, it, expect, vi } from 'vitest';
import type { UnifiedQuestion } from '@/lib/unified-question';

// Replicate the lightweight katex/dompurify stubs from latex-utils.test.ts so
// processLatexContent runs without a real DOM (this is the helper that pulls
// in the KaTeX renderer indirectly via latex-utils).
vi.mock('katex', () => ({
  default: {
    renderToString: vi.fn((latex: string, opts?: { displayMode?: boolean }) => {
      const tag = opts?.displayMode ? 'div' : 'span';
      return `<${tag} class="katex">${latex}</${tag}>`;
    }),
  },
}));
vi.mock('dompurify', () => ({
  default: {
    sanitize: vi.fn((html: string) => html),
  },
}));

import { buildTestExportHtml } from '@/lib/test-html-export';

function mcqQuestion(id: string, prompt: string, options: string[]): UnifiedQuestion {
  return {
    id,
    type: 'mcq',
    raw: {
      question: prompt,
      payload: { options },
      answer_key: null,
      explanation: null,
      generation_rationale: null,
    },
  } as unknown as UnifiedQuestion;
}

describe('buildTestExportHtml (issue #657)', () => {
  it('renders inline LaTeX `\\(...\\)` via KaTeX rather than emitting raw source', () => {
    const html = buildTestExportHtml({
      institutionName: 'School',
      courseName: 'Physics',
      testTitle: 'Midterm',
      customHeader: '',
      questions: [{ id: 'q1', points: 2 }],
      questionsById: new Map([
        ['q1', mcqQuestion('q1', 'What is \\(54\\,km/h\\) in m/s?', ['A', 'B'])],
      ]),
    });

    // The raw LaTeX delimiters must NOT appear in the rendered body — that's
    // the regression we're guarding against (PDF previously printed `\(...\)`
    // literally because the markdown converter has no math support).
    expect(html).not.toContain('\\(54');
    // KaTeX output (mocked to a span.katex wrapper) should be present.
    expect(html).toContain('<span class="katex">');
    expect(html).toContain('54\\,km/h');
  });

  it('renders display LaTeX `\\[...\\]` via KaTeX', () => {
    const html = buildTestExportHtml({
      testTitle: 'T',
      questions: [{ id: 'q1', points: 1 }],
      questionsById: new Map([
        ['q1', mcqQuestion('q1', 'Solve: \\[x^2 + 1\\]', [])],
      ]),
    });

    expect(html).not.toContain('\\[x^2');
    expect(html).toContain('<div class="katex">');
  });

  it('includes KaTeX stylesheet link', () => {
    const html = buildTestExportHtml({
      testTitle: 'T',
      questions: [],
      questionsById: new Map(),
    });
    expect(html).toMatch(/cdn\.jsdelivr\.net\/npm\/katex/);
  });

  it('sets a ~12pt base font-size on body so the PDF is comfortably readable (#738)', () => {
    // Without an explicit `font-size`, the PDF renderer falls back to its
    // default, which prints body text very small. Match the edited-HTML PDF
    // path (`convert-html-to-pdf`) which already sets `font-size: 12pt`.
    const html = buildTestExportHtml({
      testTitle: 'T',
      questions: [],
      questionsById: new Map(),
    });
    expect(html).toMatch(/body\s*\{[^}]*font-size:\s*12pt/);
  });

  it('escapes plain text in headers/title to prevent HTML injection', () => {
    const html = buildTestExportHtml({
      institutionName: '<script>alert(1)</script>',
      testTitle: 'T & U',
      questions: [],
      questionsById: new Map(),
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('T &amp; U');
  });

  it('numbers questions and includes total points', () => {
    const html = buildTestExportHtml({
      testTitle: 'Quiz',
      questions: [
        { id: 'q1', points: 2 },
        { id: 'q2', points: 3 },
      ],
      questionsById: new Map([
        ['q1', mcqQuestion('q1', 'First?', ['a'])],
        ['q2', mcqQuestion('q2', 'Second?', ['b'])],
      ]),
    });
    expect(html).toContain('Total Points: 5');
    expect(html).toContain('1. (2 points)');
    expect(html).toContain('2. (3 points)');
  });
});
