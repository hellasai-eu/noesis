import { describe, it, expect, vi } from 'vitest';
import type { UnifiedQuestion } from '@/lib/unified-question';

// Same lightweight katex/dompurify stubs as test-html-export.test.ts so
// processLatexContent runs without pulling in the real KaTeX renderer.
vi.mock('katex', () => ({
  default: {
    renderToString: vi.fn((latex: string, opts?: { displayMode?: boolean }) => {
      const tag = opts?.displayMode ? 'div' : 'span';
      return `<${tag} class="katex">${latex}</${tag}>`;
    }),
  },
}));
vi.mock('dompurify', () => ({
  default: { sanitize: vi.fn((html: string) => html) },
}));

import { buildTestDocumentSeedHtml } from '@/lib/test-document-seed';

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

function openQuestion(id: string, prompt: string): UnifiedQuestion {
  return {
    id,
    type: 'open',
    raw: {
      question: prompt,
      payload: {},
      answer_key: null,
      explanation: null,
      generation_rationale: null,
    },
  } as unknown as UnifiedQuestion;
}

describe('buildTestDocumentSeedHtml (issue #728)', () => {
  it('numbers questions, includes per-question points, and totals points in the header', () => {
    const html = buildTestDocumentSeedHtml({
      institutionName: 'School',
      courseName: 'Physics',
      testTitle: 'Midterm',
      customHeader: '',
      questions: [
        { id: 'q1', points: 2 },
        { id: 'q2', points: 3 },
      ],
      questionsById: new Map([
        ['q1', mcqQuestion('q1', 'Question one?', ['A', 'B'])],
        ['q2', openQuestion('q2', 'Question two?')],
      ]),
    });

    expect(html).toContain('Total Points: 5');
    expect(html).toContain('<h2>1. (2 points)</h2>');
    expect(html).toContain('<h2>2. (3 points)</h2>');
  });

  it('preserves LaTeX by routing prose through KaTeX', () => {
    const html = buildTestDocumentSeedHtml({
      testTitle: 'T',
      questions: [{ id: 'q1', points: 1 }],
      questionsById: new Map([
        ['q1', mcqQuestion('q1', 'What is \\(54\\,km/h\\)?', ['A'])],
      ]),
    });
    expect(html).not.toContain('\\(54');
    expect(html).toContain('<span class="katex">');
  });

  it('renders MCQ options as <ol> with letter labels', () => {
    const html = buildTestDocumentSeedHtml({
      testTitle: 'T',
      questions: [{ id: 'q1', points: 1 }],
      questionsById: new Map([
        ['q1', mcqQuestion('q1', 'Pick one', ['First', 'Second', 'Third'])],
      ]),
    });
    expect(html).toContain('<ol>');
    expect(html).toContain('<strong>A.</strong>');
    expect(html).toContain('<strong>B.</strong>');
    expect(html).toContain('<strong>C.</strong>');
  });

  it('escapes plain text in the institution / course / title fields', () => {
    const html = buildTestDocumentSeedHtml({
      institutionName: '<script>alert(1)</script>',
      courseName: 'C & C',
      testTitle: 'T & U',
      questions: [],
      questionsById: new Map(),
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('T &amp; U');
  });

  it('returns an HTML fragment (no <!doctype>, <html>, or <head> wrapper)', () => {
    // Distinct from `buildTestExportHtml` which builds a *full* document;
    // the editor's `setContent` consumes a body fragment.
    const html = buildTestDocumentSeedHtml({
      testTitle: 'Fragment',
      questions: [],
      questionsById: new Map(),
    });
    expect(html.toLowerCase()).not.toContain('<!doctype');
    expect(html.toLowerCase()).not.toContain('<html');
    expect(html.toLowerCase()).not.toContain('<head');
    expect(html.toLowerCase()).not.toContain('<body');
  });
});
