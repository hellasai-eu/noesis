import katex from "katex";
import DOMPurify from "dompurify";

// Common LaTeX → Unicode transliteration for graceful fallback on parse failure.
// Used only when KaTeX cannot parse the source (issue #742): students see clean
// plain text instead of red raw LaTeX with backslashes.
const LATEX_MACRO_MAP: Record<string, string> = {
  // Blackboard bold sets
  "\\mathbb{R}": "ℝ", "\\mathbb{N}": "ℕ", "\\mathbb{Z}": "ℤ",
  "\\mathbb{Q}": "ℚ", "\\mathbb{C}": "ℂ",
  // Relations
  "\\in": "∈", "\\notin": "∉", "\\ni": "∋",
  "\\subset": "⊂", "\\subseteq": "⊆", "\\supset": "⊃", "\\supseteq": "⊇",
  "\\leq": "≤", "\\geq": "≥", "\\neq": "≠", "\\approx": "≈", "\\equiv": "≡",
  // Operations
  "\\cup": "∪", "\\cap": "∩", "\\setminus": "∖",
  "\\cdot": "·", "\\times": "×", "\\div": "÷",
  "\\pm": "±", "\\mp": "∓",
  // Quantifiers / special
  "\\forall": "∀", "\\exists": "∃", "\\infty": "∞", "\\emptyset": "∅",
  // Arrows
  "\\to": "→", "\\rightarrow": "→", "\\leftarrow": "←",
  "\\Rightarrow": "⇒", "\\Leftarrow": "⇐", "\\Leftrightarrow": "⇔",
  // Operators
  "\\sum": "∑", "\\prod": "∏", "\\int": "∫", "\\sqrt": "√",
  // Greek lowercase
  "\\alpha": "α", "\\beta": "β", "\\gamma": "γ", "\\delta": "δ",
  "\\epsilon": "ε", "\\zeta": "ζ", "\\eta": "η", "\\theta": "θ",
  "\\iota": "ι", "\\kappa": "κ", "\\lambda": "λ", "\\mu": "μ",
  "\\nu": "ν", "\\xi": "ξ", "\\pi": "π", "\\rho": "ρ",
  "\\sigma": "σ", "\\tau": "τ", "\\phi": "φ", "\\chi": "χ",
  "\\psi": "ψ", "\\omega": "ω",
  // Greek uppercase
  "\\Gamma": "Γ", "\\Delta": "Δ", "\\Theta": "Θ", "\\Lambda": "Λ",
  "\\Xi": "Ξ", "\\Pi": "Π", "\\Sigma": "Σ", "\\Phi": "Φ",
  "\\Psi": "Ψ", "\\Omega": "Ω",
};

// Pre-sorted once at module load: longest key first so \mathbb{R} beats \mathbb.
const SORTED_MACROS = Object.entries(LATEX_MACRO_MAP).sort(
  (a, b) => b[0].length - a[0].length,
);

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Converts a LaTeX source string to a plain-text fallback used when KaTeX
 * cannot parse it. Applies the macro map, then strips any remaining commands
 * and braces so students never see raw backslashes.
 */
export function latexToPlainText(latex: string): string {
  let text = latex;
  // Apply known macros longest-first so \mathbb{R} beats \mathbb.
  for (const [macro, replacement] of SORTED_MACROS) {
    text = text.split(macro).join(replacement);
  }
  // \cmd{arg} → arg (one level only — [^{}]* rejects inner braces, so nested
  // commands like \frac{\sqrt{2}}{2} are handled by the later cleanup passes).
  text = text.replace(/\\[a-zA-Z]+\s*\{([^{}]*)\}/g, "$1");
  // \cmd → ''
  text = text.replace(/\\[a-zA-Z]+/g, "");
  // Lone backslashes
  text = text.replace(/\\/g, "");
  // Drop braces, keep their content
  text = text.replace(/[{}]/g, "");
  // Drop $ delimiters that may have leaked in
  text = text.replace(/\$/g, "");
  return text.replace(/\s+/g, " ").trim();
}

function renderMathWithFallback(latex: string, displayMode: boolean): string {
  // Generators sometimes put an HTML line break INSIDE the delimiters
  // ("$<br/> u(3) = -2$"). It is never valid LaTeX, but KaTeX parses it
  // anyway — `<`, `br`, `/`, `>` are all legal math tokens — so students see
  // a literal "< br/ >" typeset mid-formula.
  const trimmed = latex.replace(/<\/?br\s*\/?>/gi, " ").trim();
  try {
    return katex.renderToString(trimmed, { displayMode, throwOnError: true });
  } catch {
    const plain = latexToPlainText(trimmed);
    const tag = displayMode ? "div" : "span";
    return `<${tag} class="latex-fallback" style="color:inherit">${escapeHtml(plain)}</${tag}>`;
  }
}

/**
 * Renders LaTeX math expressions in a string to HTML using KaTeX.
 * Supports both inline ($...$, \(...\)) and display ($$...$$, \[...\]) math.
 * Falls back to a clean Unicode/plain-text rendering when KaTeX cannot parse
 * the source (issue #742) so students never see raw red LaTeX.
 */
export function renderLatexInHtml(html: string): string {
  // Display math: $$...$$ and \[...\]
  let result = html.replace(/\$\$([\s\S]*?)\$\$/g, (_, latex) =>
    renderMathWithFallback(latex, true),
  );
  result = result.replace(/\\\[([\s\S]*?)\\\]/g, (_, latex) =>
    renderMathWithFallback(latex, true),
  );

  // Inline math: $...$ (but not $$) and \(...\)
  result = result.replace(/\$([^$\n]+?)\$/g, (_, latex) =>
    renderMathWithFallback(latex, false),
  );
  result = result.replace(/\\\(([\s\S]+?)\\\)/g, (_, latex) =>
    renderMathWithFallback(latex, false),
  );

  return result;
}

/**
 * Sanitizes HTML content while preserving MathML and KaTeX elements
 */
export function sanitizeMathContent(html: string): string {
  return DOMPurify.sanitize(html, {
    ADD_TAGS: ['math', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub', 'mfrac', 'msqrt', 'mroot', 'mtext', 'mspace', 'mtable', 'mtr', 'mtd', 'munder', 'mover', 'munderover', 'menclose', 'mpadded', 'mphantom', 'mstyle', 'merror', 'maction', 'semantics', 'annotation', 'span', 'svg', 'line', 'path', 'sup', 'sub'],
    ADD_ATTR: ['mathvariant', 'mathsize', 'mathcolor', 'mathbackground', 'displaystyle', 'scriptlevel', 'xmlns', 'class', 'aria-hidden', 'style', 'focusable', 'role', 'viewBox', 'preserveAspectRatio', 'd', 'x1', 'x2', 'y1', 'y2', 'stroke', 'stroke-width', 'fill'],
  });
}

/**
 * Placeholder standing in for a rendered display-maths block while the markdown
 * pass runs. Deliberately inert: no markdown construct treats `%` specially, so
 * it survives the conversion as plain text and can be swapped back afterwards.
 */
const DISPLAY_MATH_TOKEN = (index: number) => `%%%KATEXBLOCK${index}%%%`;
const DISPLAY_MATH_TOKEN_RE = /%%%KATEXBLOCK(\d+)%%%/g;

/**
 * One pass over the markdown matching either a region where maths must stay
 * literal, or a display-maths block.
 *
 * Order matters: the protected alternative comes first, so `$$` inside a fenced
 * block or an inline code span is swallowed as part of that region and never
 * reaches the maths branches. A message explaining the syntax — "write
 * `$$x$$` for display" — therefore shows the delimiters instead of typesetting
 * the example it is describing. The backreference keeps inline spans balanced,
 * so ``a `b` c`` closes on its matching run rather than the first stray tick.
 *
 * Groups: 1 = protected region, 2 = its backtick run, 3 = `$$…$$` body,
 * 4 = `\[…\]` body.
 */
const PROTECTED_OR_DISPLAY_MATH =
  /(```[\s\S]*?```|~~~[\s\S]*?~~~|(`+)[\s\S]*?\2)|\$\$([\s\S]*?)\$\$|\\\[([\s\S]*?)\\\]/g;

export interface DisplayMathExtraction {
  text: string;
  blocks: string[];
}

/**
 * Renders display maths out of RAW markdown, before the markdown pass runs.
 *
 * Authors write display maths with the delimiters on their own lines:
 *
 *     τέτοιο ώστε
 *
 *     $$
 *     f'(\xi)=0.
 *     $$
 *
 * That is the ordinary convention, not malformed input. But markdown turns the
 * blank lines into paragraph breaks, so by the time the HTML exists the opening
 * and closing `$$` sit in different elements — and `renderLatexInTextNodes`
 * refuses to match across elements, by design, so it leaves them on screen as
 * literal `$$`. Regexing the HTML instead is what used to typeset `</p><p>` as
 * maths (#1039). Neither pass can win once markdown has run.
 *
 * So take the block out first, while `$$…$$` is still one contiguous string,
 * and leave an inert token in its place. Code — fenced or inline — is skipped,
 * so a `$$` shown as an example of the syntax stays literal.
 */
export function extractDisplayMath(markdown: string): DisplayMathExtraction {
  const blocks: string[] = [];
  if (!markdown) return { text: markdown, blocks };

  const text = markdown.replace(
    PROTECTED_OR_DISPLAY_MATH,
    (match, protectedRegion, _ticks, dollarMath, bracketMath) => {
      // Code wins — see PROTECTED_OR_DISPLAY_MATH. Extraction runs before the
      // markdown pass turns a span into <code>, so the protection cannot be
      // left to the `code, pre` exemption downstream; it has to happen here.
      if (protectedRegion !== undefined) return match;

      const latex = dollarMath !== undefined ? dollarMath : bracketMath;
      blocks.push(renderMathWithFallback(latex, true));
      return DISPLAY_MATH_TOKEN(blocks.length - 1);
    },
  );

  return { text, blocks };
}

/** Puts rendered display-maths blocks back. Call before sanitizing. */
export function restoreDisplayMath(html: string, blocks: string[]): string {
  if (blocks.length === 0) return html;
  return html.replace(DISPLAY_MATH_TOKEN_RE, (match, index) => blocks[Number(index)] ?? match);
}

/** Elements whose text is never maths, however many `$` it contains. */
const MATH_EXEMPT_SELECTOR = 'code, pre, kbd, samp, script, style, math, .katex';

/**
 * Cheap test for "could this string contain maths at all?".
 *
 * Both delimiter families must be covered: chat content uses `$`/`$$`, but the
 * generators also emit `\(…\)` and `\[…\]`, and a text node carrying only the
 * backslash forms has no `$` in it.
 */
function mayContainMath(text: string): boolean {
  return text.includes('$') || text.includes('\\(') || text.includes('\\[');
}

/**
 * Renders LaTeX inside TEXT NODES only, leaving markup untouched.
 *
 * `renderLatexInHtml` runs its delimiter regex over the serialized HTML, which
 * is fine for a short plain-text question stem but not for authored documents:
 * two literal `$` either side of a tag or an attribute make everything between
 * them "a formula", and the markup in the middle is swallowed. A `<code>$var</code>
 * … `<code>$other</code>` pair, or a link whose href contains `$`, is enough.
 *
 * Walking text nodes removes that whole class of corruption — attributes are
 * never seen, tag structure cannot be spanned, and `<code>`/`<pre>` are skipped
 * outright, which is where literal `$` most often lives.
 *
 * Two limits, both deliberate:
 *  - Maths cannot span elements (`<p>$$a</p><p>b$$</p>`). That is malformed
 *    authoring, and refusing to reach across tags is the point of this
 *    function.
 *  - `$` used as currency in ordinary prose ("costs $5 and $10") is still
 *    ambiguous — inherent to the delimiter, not something node-walking fixes,
 *    and unchanged from the behaviour every other surface already has.
 */
function renderLatexInTextNodes(root: HTMLElement): void {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if (!text.data || !mayContainMath(text.data)) continue;
    if (text.parentElement?.closest(MATH_EXEMPT_SELECTOR)) continue;
    targets.push(text);
  }

  for (const text of targets) {
    // Display first, so `$$…$$` is not eaten by the inline pattern. All four
    // delimiter families are handled here: the generators emit `\(…\)` and
    // `\[…\]` as readily as `$`, and callers rely on this being the single
    // place maths is rendered.
    const rendered = text.data
      .replace(/\$\$([\s\S]*?)\$\$/g, (_, latex) => renderMathWithFallback(latex, true))
      .replace(/\\\[([\s\S]*?)\\\]/g, (_, latex) => renderMathWithFallback(latex, true))
      .replace(/\$([^$\n]+?)\$/g, (_, latex) => renderMathWithFallback(latex, false))
      .replace(/\\\(([\s\S]+?)\\\)/g, (_, latex) => renderMathWithFallback(latex, false));

    if (rendered === text.data) continue;

    const holder = doc.createElement('span');
    holder.innerHTML = rendered;
    text.replaceWith(...Array.from(holder.childNodes));
  }
}

/**
 * Renders instructor/AI-authored HTML that may embed LaTeX.
 *
 * The generators are told to write maths as LaTeX with `$` / `$$` delimiters
 * (`MATHML_FORMATTING_INSTRUCTIONS`, despite the name), so authored HTML
 * routinely carries `$f'(\xi)=0$` as literal text. `sanitizeMathContent` alone
 * leaves those delimiters on screen — which is how study guide theory came to
 * show raw LaTeX to students and to the instructor editing it.
 *
 * Deliberately NOT `processLatexContent`: that runs a markdown pass as well,
 * which is right for plain-text question stems but wrong here. The input is
 * already HTML, so a stray `*` or `_` in prose would be reinterpreted as
 * emphasis and the surrounding tags disturbed.
 */
export function renderAuthoredHtml(html: string): string {
  if (!html) return '';

  // Parsed rather than regexed — see renderLatexInTextNodes. Sanitizing the
  // result still matters: the input is model-authored, and KaTeX's own output
  // needs the MathML allowlist to survive.
  return sanitizeMathContent(renderLatexInHtmlNodes(html));
}

/**
 * Text-node LaTeX rendering over an HTML string, WITHOUT sanitizing.
 *
 * Same engine as `renderAuthoredHtml` — see `renderLatexInTextNodes` for why
 * walking nodes beats regexing the serialized HTML. Split out for callers that
 * must sanitize with their own allowlist afterwards (chat's `RichContent` keeps
 * `data-code-block` placeholder divs that `sanitizeMathContent` would strip).
 *
 * The caller is responsible for sanitizing the result. Do not render the return
 * value directly.
 */
export function renderLatexInHtmlNodes(html: string): string {
  if (!html) return '';

  // Fast path. Chat re-renders this on every typewriter tick, and parsing a
  // whole message into a DOM to find nothing is pure cost — most prose carries
  // no delimiter at all.
  if (!mayContainMath(html)) return html;

  const doc = new DOMParser().parseFromString(
    `<div id="__authored">${html}</div>`,
    'text/html',
  );
  const root = doc.getElementById('__authored');
  if (!root) return html;

  renderLatexInTextNodes(root);
  return root.innerHTML;
}

/**
 * Sanitizes raw SVG markup for diagram rendering (#627).
 *
 * Uses DOMPurify's built-in SVG profile (which strips `<script>`,
 * `<foreignObject>`, event handlers like `onclick`/`onload`, and `javascript:`
 * URLs by default) and widens the tag/attribute allowlist to cover the
 * full set needed for math/geometry diagrams (markers, defs, tspan, use,
 * stroke-dasharray, text anchoring, etc.).
 *
 * Returns the sanitized SVG string. If sanitization strips everything to an
 * empty result, returns `""` — callers render nothing.
 */
export function sanitizeDiagram(svg: string): string {
  if (!svg || typeof svg !== "string") return "";
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: false },
    ADD_TAGS: ["marker", "defs", "tspan", "use", "title", "desc"],
    ADD_ATTR: [
      "viewBox",
      "preserveAspectRatio",
      "width",
      "height",
      "x",
      "y",
      "x1",
      "x2",
      "y1",
      "y2",
      "cx",
      "cy",
      "r",
      "rx",
      "ry",
      "d",
      "points",
      "transform",
      "fill",
      "stroke",
      "stroke-width",
      "stroke-dasharray",
      "stroke-linecap",
      "stroke-linejoin",
      "font-family",
      "font-size",
      "font-weight",
      "text-anchor",
      "dominant-baseline",
      "opacity",
      "class",
      "aria-label",
      "role",
      "marker-end",
      "marker-start",
      "marker-mid",
      "refX",
      "refY",
      "markerUnits",
      "markerWidth",
      "markerHeight",
      "orient",
    ],
  });
}

/**
 * Renders basic markdown (bold, italic) to HTML
 */
function renderMarkdown(text: string): string {
  // Bold: **text** or __text__
  let result = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  result = result.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  
  // Italic: *text* or _text_ (but not inside bold)
  result = result.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
  result = result.replace(/(?<!_)_([^_]+)_(?!_)/g, '<em>$1</em>');
  
  return result;
}

/**
 * Extracts LaTeX expressions and replaces them with placeholders to protect
 * them from markdown processing, then restores them afterward.
 */
function protectLatex(content: string): { text: string; blocks: string[] } {
  const blocks: string[] = [];
  // Extract display math ($$...$$, \[...\]) first, then inline math ($...$, \(...\))
  let text = content.replace(/\$\$([\s\S]*?)\$\$/g, (match) => {
    blocks.push(match);
    return `%%LATEX:${blocks.length - 1}%%`;
  });
  text = text.replace(/\\\[([\s\S]*?)\\\]/g, (match) => {
    blocks.push(match);
    return `%%LATEX:${blocks.length - 1}%%`;
  });
  text = text.replace(/\$([^$\n]+?)\$/g, (match) => {
    blocks.push(match);
    return `%%LATEX:${blocks.length - 1}%%`;
  });
  text = text.replace(/\\\(([\s\S]+?)\\\)/g, (match) => {
    blocks.push(match);
    return `%%LATEX:${blocks.length - 1}%%`;
  });
  return { text, blocks };
}

function restoreLatex(text: string, blocks: string[]): string {
  return text.replace(/%%LATEX:(\d+)%%/g, (_, index) => blocks[Number(index)]);
}

/**
 * Processes content with markdown, LaTeX and sanitizes it for safe rendering
 */
export function processLatexContent(content: string): string {
  const { text, blocks } = protectLatex(content);
  const withMarkdown = renderMarkdown(text);
  const restored = restoreLatex(withMarkdown, blocks);
  const withMath = renderLatexInHtml(restored);
  return sanitizeMathContent(withMath);
}

/**
 * Formats question text with paragraph splitting, superscript conversion,
 * and full LaTeX/markdown rendering. Use for question text that may contain
 * ^superscript notation, MathML, or LaTeX math expressions.
 */
export function formatQuestionText(text: string): string {
  if (!text) return '';

  const hasMathML = text.includes('<math>') || text.includes('<math ');

  const { text: safeText, blocks } = protectLatex(text);

  const paragraphs = safeText.split(/\n\n+/);

  const processedParagraphs = paragraphs.map(para => {
    let result = para.trim();
    if (!result) return '';

    if (hasMathML) {
      result = result
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\n(?![^<]*<\/math>)/g, '<br />');
    } else {
      result = result
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\^(\([^)]+\))/g, '<sup>$1</sup>')
        .replace(/\^([a-zA-Z0-9\-+]+)/g, '<sup>$1</sup>')
        .replace(/<sup>\(([^)]+)\)<\/sup>/g, '<sup>$1</sup>')
        .replace(/\n/g, '<br />');
    }

    return result;
  }).filter(p => p);

  const htmlContent = processedParagraphs.length > 1
    ? processedParagraphs.map(p => `<p class="mb-3 last:mb-0">${p}</p>`).join('')
    : processedParagraphs[0] || '';

  const restored = restoreLatex(htmlContent, blocks);
  return processLatexContent(restored);
}
