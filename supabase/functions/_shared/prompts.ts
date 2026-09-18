/**
 * Centralized AI Prompts for the education platform
 *
 * This file contains shared formatting instructions used across the platform.
 * Most prompts are now managed via OpenAI Saved Prompts.
 */

// ============================================================================
// SHARED FORMATTING INSTRUCTIONS
// ============================================================================

export const MATHML_FORMATTING_INSTRUCTIONS = `MATHEMATICAL CONTENT FORMATTING:
- For ALL mathematical expressions, use LaTeX notation with $ for inline math and $$ for display math.
- Example inline: The formula is $a^2 + b^2 = c^2$
- Example display: $$c = \\sqrt{a^2 + b^2}$$
- For fractions use \\frac{a}{b}, for square roots use \\sqrt{x}, for powers use x^2, for subscripts use x_i
- For Greek letters use LaTeX commands: \\alpha, \\beta, \\gamma, \\delta, \\theta, \\lambda, \\pi, \\Sigma, \\Delta, etc.
- For integrals use \\int, for sums use \\sum, for limits use \\lim`;

/**
 * The `{{N}}` placeholder contract every fill-the-gaps stem must obey, shared
 * by every generator that can produce one (#1035).
 *
 * It lives here rather than in one generator's prompt because the renderer
 * splits stems on `/\{\{(\d+)\}\}/` and nothing else: a stem that marks its
 * blanks any other way renders as prose with no inputs at all, and — since
 * `___` is markdown for bold-italic — the orphaned markers are styled away
 * instead of showing up as stray characters. The study guide generator asked
 * for `___` and shipped exactly that failure.
 *
 * Deliberately excludes the per-generator gap cap (4 for the Question Bank, 8
 * for study guides); each prompt states its own.
 */
export const FILL_GAPS_PLACEHOLDER_CONTRACT =
  `FILL-THE-GAPS PLACEHOLDER SYNTAX (CRITICAL - THE STEM IS UNUSABLE WITHOUT IT):
- Each blank is marked by a numbered placeholder written EXACTLY as {{1}}, {{2}}, {{3}}, … — two braces on each side, a plain digit inside.
- Placeholders are 1-indexed and CONTIGUOUS (1, 2, 3, …). Never skip or repeat a number.
- The stem MUST contain one placeholder per gap, and the placeholder count MUST equal the number of gaps you supply. A stem with no placeholders is rejected.
- NEVER mark a blank any other way. Not ___, not ____, not [gap], not (1), not "…". Only {{N}} renders as an input box.
- A composite or multi-word answer is ONE gap, never split across placeholders. "Great Britain", "New York", "Μέγας Αλέξανδρος", "Second World War" each fill a SINGLE {{N}}.
  - WRONG: "The capital of {{1}} {{2}} is London." (Great + Britain split)
  - RIGHT: "The capital of {{1}} is London."  with gap 1 acceptable: ["Great Britain", "United Kingdom", "the UK"].`;

// A gap is graded by exact string match against its accepted list (after
// lowercasing / whitespace normalization). Every generator that writes a
// fill-gaps answer key therefore decides, at generation time, which defensible
// answers count as wrong — and study-guide answers are one-shot and immutable.
// #1042 case 2: the source coordinated two nouns, the key listed one, and the
// student who wrote the other was permanently marked incorrect.
export const FILL_GAPS_ACCEPTABLE_ANSWERS_CONTRACT =
  `FILL-THE-GAPS ACCEPTED ANSWERS (AN INCOMPLETE LIST IS A WRONG GRADE):
- A gap is marked correct ONLY by an exact match against its accepted list, after lowercasing and whitespace normalization. There is no other leniency. A defensible answer you leave out of the list is a student permanently marked wrong.
- Therefore enumerate EVERY answer the source text supports for that gap — not only the first one that came to mind.
- Before emitting each gap, re-read the exact clause you took it from and ask: "reading ONLY this text, could a careful student have written something else in this blank that is just as correct?" If yes, that answer belongs in the list.
- Watch coordinated alternatives above all: "X and Y", "X or Y", a list, an apposition. When the blank stands where the source offered two or more equally valid fillers, ALL of them are accepted answers.
  - Source: "the citizens who have a role within a state and a constitution."
  - Stem: "... is a political community that acquires a role within a {{1}}."
  - WRONG: accepted ["constitution"] — a student who read the same sentence and wrote "state" is marked incorrect.
  - RIGHT: accepted ["constitution", "state"].
- Also list close inflections and genuine synonyms of each answer (singular/plural, gender/case forms), in the language of the material.
- Do NOT pad the list with answers the source does not support. An accepted answer the text never licenses makes the gap test nothing.
- If a gap honestly admits more than a handful of different correct fillers, it is too loose to be a question at all: blank a different, more determinate word instead.`;

export const HTML_RESPONSE_FORMAT = `RESPONSE FORMAT (CRITICAL - FOLLOW EXACTLY):
- Output ALL responses as pure HTML - NEVER use markdown syntax
- NEVER use asterisks for bold (**text**) - use <strong>text</strong> instead
- NEVER use underscores for italics (_text_) - use <em>text</em> instead
- NEVER use markdown headers (## or ###) - use <h4>text</h4> instead
- NEVER use markdown lists (* or -) - use <ul><li>text</li></ul> instead
- Use <br><br> for paragraph breaks within flowing text
- For code examples, wrap code in <pre><code class="language-X"> tags where X is the language (python, javascript, html, css, sql, typescript, java, etc.): <pre><code class="language-python">your code here</code></pre>
- For mathematical expressions, use LaTeX notation with $ for inline and $$ for display:
  - Inline: $a^2 + b^2 = c^2$
  - Display: $$c = \\sqrt{a^2 + b^2}$$
  - Fractions: $\\frac{a}{b}$
  - Square roots: $\\sqrt{x}$
  - Integrals: $\\int x^2 dx$`;
