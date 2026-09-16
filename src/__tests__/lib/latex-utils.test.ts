import { describe, it, expect, vi } from 'vitest';

// Mock katex before importing the module.
// The mock throws on inputs containing the malformed marker `__BAD_LATEX__`
// so tests can exercise the graceful fallback path (#742) without needing
// the real KaTeX parser. Valid inputs render as before.
vi.mock('katex', () => ({
  default: {
    renderToString: vi.fn((latex: string, opts?: { displayMode?: boolean; throwOnError?: boolean }) => {
      if (latex.includes('__BAD_LATEX__')) {
        throw new Error('KaTeX parse error: simulated malformed input');
      }
      const tag = opts?.displayMode ? 'div' : 'span';
      return `<${tag} class="katex">${latex}</${tag}>`;
    }),
  },
}));

// Mock DOMPurify
vi.mock('dompurify', () => ({
  default: {
    sanitize: vi.fn((html: string) => html),
  },
}));

import { renderLatexInHtml, sanitizeMathContent, processLatexContent, formatQuestionText, latexToPlainText, renderAuthoredHtml } from '@/lib/latex-utils';

describe('latex-utils', () => {
  describe('renderLatexInHtml', () => {
    it('should render inline math $...$', () => {
      const result = renderLatexInHtml('The formula $x^2$ is simple');
      expect(result).toContain('<span class="katex">x^2</span>');
    });

    it('should render display math $$...$$', () => {
      const result = renderLatexInHtml('Display: $$\\frac{a}{b}$$');
      expect(result).toContain('<div class="katex">\\frac{a}{b}</div>');
    });

    it('should handle multiple inline expressions', () => {
      const result = renderLatexInHtml('$a$ and $b$');
      expect(result).toContain('<span class="katex">a</span>');
      expect(result).toContain('<span class="katex">b</span>');
    });

    it('should leave text without math unchanged', () => {
      const text = 'No math here';
      expect(renderLatexInHtml(text)).toBe(text);
    });

    it('should not treat $$ as inline math', () => {
      const result = renderLatexInHtml('$$x$$');
      // Should be display mode, not inline
      expect(result).toContain('<div class="katex">');
    });

    it('should render inline math \\(...\\)', () => {
      const result = renderLatexInHtml('The formula \\(x^2\\) is simple');
      expect(result).toContain('<span class="katex">x^2</span>');
    });

    it('should render inline \\(...\\) containing inner parentheses', () => {
      const result = renderLatexInHtml('Given \\(f(x)=\\sqrt{1-\\ln x}\\) find the domain');
      expect(result).toContain('<span class="katex">f(x)=\\sqrt{1-\\ln x}</span>');
      expect(result).not.toContain('\\(');
    });

    it('should render display math \\[...\\]', () => {
      const result = renderLatexInHtml('Display: \\[\\frac{a}{b}\\]');
      expect(result).toContain('<div class="katex">\\frac{a}{b}</div>');
    });

    it('should gracefully fall back when inline LaTeX fails to parse (#742)', () => {
      const result = renderLatexInHtml('Choose: $__BAD_LATEX__ \\in \\mathbb{R}$');
      // No red error rendering, no raw backslashes, no $ delimiters left behind
      expect(result).not.toContain('\\');
      expect(result).not.toContain('$');
      expect(result).not.toContain('color:#cc0000');
      expect(result).not.toContain('katex-error');
      // Recognised macros are transliterated to Unicode
      expect(result).toContain('∈');
      expect(result).toContain('ℝ');
      // Fallback uses a span (inline) with neutral color
      expect(result).toContain('latex-fallback');
      expect(result).toContain('color:inherit');
    });

    it('should gracefully fall back when display LaTeX fails to parse', () => {
      const result = renderLatexInHtml('$$__BAD_LATEX__ \\sum x$$');
      expect(result).not.toContain('\\');
      expect(result).toContain('∑');
      // Display fallback uses a div
      expect(result).toMatch(/<div[^>]*class="latex-fallback"/);
    });

    it('should escape HTML in malformed LaTeX fallback', () => {
      const result = renderLatexInHtml('$__BAD_LATEX__ <script>x</script>$');
      expect(result).not.toContain('<script>');
      expect(result).toContain('&lt;script&gt;');
    });
  });

  describe('latexToPlainText', () => {
    it('maps \\mathbb{R} to ℝ', () => {
      expect(latexToPlainText('\\mathbb{R}')).toBe('ℝ');
    });

    it('maps the reported bug sample to readable text', () => {
      // The exact malformed string from issue #742 — stray "bb" with valid macros
      expect(latexToPlainText('bb\\in\\mathbb{R}')).toBe('bb∈ℝ');
    });

    it('strips unknown commands and their braces', () => {
      expect(latexToPlainText('\\unknown{abc}xyz')).toBe('abcxyz');
    });

    it('strips lone non-alphabetic backslash escapes', () => {
      // \, is a LaTeX spacing command (non-alphabetic) not in the macro map
      expect(latexToPlainText('5\\,000')).toBe('5,000');
    });

    it('maps common relations and Greek letters', () => {
      expect(latexToPlainText('\\alpha \\leq \\beta')).toBe('α ≤ β');
    });
  });

  describe('sanitizeMathContent', () => {
    it('should call DOMPurify.sanitize', () => {
      const html = '<span class="katex">x</span>';
      const result = sanitizeMathContent(html);
      expect(result).toBe(html);
    });
  });

  describe('processLatexContent', () => {
    it('should process markdown bold', () => {
      const result = processLatexContent('This is **bold** text');
      expect(result).toContain('<strong>bold</strong>');
    });

    it('should process markdown italic', () => {
      const result = processLatexContent('This is *italic* text');
      expect(result).toContain('<em>italic</em>');
    });

    it('should process both markdown and LaTeX', () => {
      const result = processLatexContent('**Bold** and $x^2$');
      expect(result).toContain('<strong>Bold</strong>');
      expect(result).toContain('<span class="katex">x^2</span>');
    });

    it('should handle empty string', () => {
      expect(processLatexContent('')).toBe('');
    });

    it('should process underscore bold', () => {
      const result = processLatexContent('This is __bold__ text');
      expect(result).toContain('<strong>bold</strong>');
    });

    it('should not corrupt LaTeX underscores with markdown italic processing', () => {
      const result = processLatexContent('The limit is $\\lim_{x \\to 1^-}f(x)$');
      expect(result).not.toContain('<em>');
      expect(result).toContain('<span class="katex">');
      expect(result).toContain('\\lim_{x \\to 1^-}f(x)');
    });

    it('should protect display math from markdown processing', () => {
      const result = processLatexContent('$$\\sum_{i=0}^{n} x_i$$');
      expect(result).not.toContain('<em>');
      expect(result).toContain('<div class="katex">');
      expect(result).toContain('\\sum_{i=0}^{n} x_i');
    });

    it('should still apply markdown outside LaTeX blocks', () => {
      const result = processLatexContent('**Bold** text with $x_{n}$ math');
      expect(result).toContain('<strong>Bold</strong>');
      expect(result).toContain('<span class="katex">x_{n}</span>');
      expect(result).not.toContain('<em>');
    });

    it('should protect \\(...\\) with inner parentheses from markdown processing', () => {
      const result = processLatexContent('\\(f(x)=x^2\\)');
      expect(result).toContain('<span class="katex">f(x)=x^2</span>');
      expect(result).not.toContain('\\(');
    });
  });

  describe('formatQuestionText', () => {
    it('should return empty string for empty input', () => {
      expect(formatQuestionText('')).toBe('');
    });

    // Generators sometimes emit an HTML line break INSIDE the delimiters
    // ("$<br/> u(3) = -2$"); KaTeX would typeset it as a literal "< br/ >".
    it('strips a stray <br/> inside math delimiters instead of typesetting it', () => {
      const result = formatQuestionText('ισχύει $<br/> u(3) = -2$.');
      expect(result).toContain('<span class="katex">u(3) = -2</span>');
      expect(result).not.toContain('br');
    });

    it('should convert ^word to superscript', () => {
      const result = formatQuestionText('x^2 + y^3');
      expect(result).toContain('<sup>2</sup>');
      expect(result).toContain('<sup>3</sup>');
    });

    it('should convert ^(group) to superscript', () => {
      const result = formatQuestionText('x^(2+)');
      expect(result).toContain('<sup>2+</sup>');
    });

    it('should render inline LaTeX $...$', () => {
      const result = formatQuestionText('The formula $x^2$');
      expect(result).toContain('<span class="katex">x^2</span>');
    });

    it('should render display LaTeX $$...$$', () => {
      const result = formatQuestionText('$$\\frac{a}{b}$$');
      expect(result).toContain('<div class="katex">\\frac{a}{b}</div>');
    });

    it('should render bold markdown', () => {
      const result = formatQuestionText('This is **bold**');
      expect(result).toContain('<strong>bold</strong>');
    });

    it('should create paragraph tags for double newlines', () => {
      const result = formatQuestionText('First paragraph\n\nSecond paragraph');
      expect(result).toContain('<p class="mb-3 last:mb-0">First paragraph</p>');
      expect(result).toContain('<p class="mb-3 last:mb-0">Second paragraph</p>');
    });

    it('should not wrap single paragraphs in <p> tags', () => {
      const result = formatQuestionText('Single paragraph');
      expect(result).not.toContain('<p');
    });

    it('should preserve MathML content', () => {
      const result = formatQuestionText('Text with <math><mi>x</mi></math>');
      expect(result).toContain('<math>');
    });

    it('should convert line breaks to <br /> in non-MathML content', () => {
      const result = formatQuestionText('line1\nline2');
      expect(result).toContain('<br />');
    });
  });

  /**
   * The gap this closes: study guide theory was rendered with
   * `sanitizeMathContent` alone, on the assumption the maths arrived as
   * MathML. The theory prompt asks for LaTeX with `$` delimiters, so students
   * were reading raw `$f'(\xi)=0$`.
   */
  describe('renderAuthoredHtml', () => {
    it('renders inline LaTeX that sanitizing alone would leave as text', () => {
      const authored = "<p>Έστω ότι η $f$ είναι συνεχής.</p>";

      // The old behaviour, kept here so the difference is visible.
      expect(sanitizeMathContent(authored)).toContain('$f$');

      const result = renderAuthoredHtml(authored);
      expect(result).toContain('class="katex"');
      expect(result).not.toContain('$f$');
    });

    it('renders display LaTeX', () => {
      const result = renderAuthoredHtml("<p>άρα</p>$$f'(\\xi)=0$$");
      expect(result).toContain('<div class="katex"');
      expect(result).not.toContain('$$');
    });

    it('leaves the surrounding HTML structure intact', () => {
      const result = renderAuthoredHtml('<h2>Rolle</h2><p><strong>bold</strong> and $x$</p>');
      expect(result).toContain('<h2>Rolle</h2>');
      expect(result).toContain('<strong>bold</strong>');
    });

    it('does not run a markdown pass over already-HTML content', () => {
      // processLatexContent would turn these into <em>; authored HTML must not
      // have prose reinterpreted underneath it.
      const result = renderAuthoredHtml('<p>a_b_c and 2*3*4</p>');
      expect(result).not.toContain('<em>');
      expect(result).toContain('a_b_c');
    });

    it('returns empty string for empty input rather than throwing', () => {
      expect(renderAuthoredHtml('')).toBe('');
    });

    /**
     * The string-regex approach treats any two `$` in the serialized HTML as a
     * formula, so markup sitting between them is swallowed. Harmless for a
     * short question stem; not for authored documents, which carry code
     * samples, links and tables.
     */
    describe('does not corrupt markup between literal dollar signs', () => {
      it('leaves code samples alone', () => {
        const result = renderAuthoredHtml(
          '<p><code>$HOME</code> and <code>$PATH</code> are shell vars</p>',
        );
        expect(result).toContain('<code>$HOME</code>');
        expect(result).toContain('<code>$PATH</code>');
        expect(result).not.toContain('class="katex"');
      });

      it('does not swallow the markup between two code blocks', () => {
        const result = renderAuthoredHtml(
          '<p><code>$a</code> <strong>important</strong> <code>$b</code></p>',
        );
        // Asserting the <strong> survives is NOT enough on its own: the old
        // implementation swept it INTO the formula, and the rendered output
        // still contained the substring. The discriminating facts are that the
        // code elements are intact and that nothing was treated as maths.
        expect(result).toContain('<code>$a</code>');
        expect(result).toContain('<code>$b</code>');
        expect(result).toContain('<strong>important</strong>');
        expect(result).not.toContain('class="katex"');
      });

      it('never reads attributes as maths', () => {
        const result = renderAuthoredHtml(
          '<p><a href="/pay?amt=$5">one</a> then <a href="/pay?amt=$9">two</a></p>',
        );
        expect(result).toContain('href="/pay?amt=$5"');
        expect(result).toContain('href="/pay?amt=$9"');
        expect(result).toContain('>one</a>');
        expect(result).toContain('>two</a>');
      });

      it('keeps <pre> blocks verbatim', () => {
        // Single line on purpose: the inline pattern refuses to cross a
        // newline, so a multi-line sample would survive the old code too and
        // the test would prove nothing.
        const result = renderAuthoredHtml('<pre>cost=$5 total=$9</pre>');
        expect(result).toContain('cost=$5 total=$9');
        expect(result).not.toContain('class="katex"');
      });

      it('still renders real maths sitting beside exempt elements', () => {
        const result = renderAuthoredHtml(
          '<p><code>$HOME</code> but $x^2$ is maths</p>',
        );
        expect(result).toContain('<code>$HOME</code>');
        expect(result).toContain('class="katex"');
      });
    });
  });
});
