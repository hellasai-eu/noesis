/**
 * HTML body builder for the test PDF export (#657).
 *
 * The PDF pipeline used to send raw markdown that included `\(...\)` /
 * `\[...\]` LaTeX delimiters straight through to ConvertAPI's
 * `md/to/pdf` endpoint — a plain markdown converter with no math
 * rendering, so LaTeX printed literally in the PDF while the on-screen
 * preview (which runs KaTeX via `processLatexContent`) rendered it
 * correctly.
 *
 * `buildTestExportHtml` renders the same shape the markdown helper
 * produces but as HTML, with question/option text fed through
 * `processLatexContent` (KaTeX). The KaTeX stylesheet is linked from a
 * pinned CDN so the PDF service renders math glyphs with the same
 * fonts the browser does.
 */
import { processLatexContent } from "./latex-utils";
import {
  mcqOptionsFromPayload,
  fillGapsStemFromPayload,
  fillGapsAcceptableAnswersFromAnswerKey,
  orderingPromptFromPayload,
  orderingItemsFromPayload,
  classificationPromptFromPayload,
  classificationCategoriesFromPayload,
  classificationItemsFromPayload,
} from "./question-payload";
import type { UnifiedQuestion } from "./unified-question";

const KATEX_VERSION = "0.16.27";
const KATEX_CSS_URL = `https://cdn.jsdelivr.net/npm/katex@${KATEX_VERSION}/dist/katex.min.css`;

export interface TestExportQuestionRef {
  id: string;
  points: number;
}

export interface TestExportArgs {
  institutionName?: string | null;
  courseName?: string | null;
  testTitle: string;
  customHeader?: string | null;
  questions: TestExportQuestionRef[];
  questionsById: Map<string, UnifiedQuestion>;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Run user-supplied prose through the same KaTeX + markdown pipeline the
 * on-screen preview uses, so the PDF mirrors what the instructor sees.
 */
function renderInline(text: string | null | undefined): string {
  if (!text) return "";
  return processLatexContent(text);
}

/**
 * Deterministic Fisher-Yates with a fixed seed so each regeneration of a
 * given ordering question produces the same printed order — matches the
 * shuffle used by the on-screen preview (`TestBuilder.renderPrintPreviewBody`).
 */
function deterministicShuffle<T>(items: T[]): T[] {
  const out = [...items];
  let seed = 0x9e3779b9;
  for (let i = out.length - 1; i > 0; i--) {
    seed = Math.imul(seed ^ (seed >>> 16), 0x45d9f3b);
    seed = Math.imul(seed ^ (seed >>> 16), 0x45d9f3b);
    seed ^= seed >>> 16;
    const j = Math.abs(seed) % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function questionBodyHtml(question: UnifiedQuestion): string {
  const { type, raw } = question;

  switch (type) {
    case "mcq": {
      const options = mcqOptionsFromPayload(raw.payload);
      const optionItems = options
        .map((opt, i) => {
          const letter = String.fromCharCode(65 + i);
          return `<li><span class="opt-letter">${letter}.</span> ${renderInline(opt)}</li>`;
        })
        .join("");
      return `
        <div class="q-prompt">${renderInline(raw.question ?? "")}</div>
        <ol class="q-options">${optionItems}</ol>
      `;
    }
    case "open": {
      return `
        <div class="q-prompt">${renderInline(raw.question ?? "")}</div>
        <div class="q-answer-label"><em>Answer:</em></div>
        <div class="q-answer-space"></div>
      `;
    }
    case "fill_gaps": {
      const stem = fillGapsStemFromPayload(raw.payload).replace(
        /\{\{(\d+)\}\}/g,
        (_m, n) => `**(${n})** ____`,
      );
      const gaps = fillGapsAcceptableAnswersFromAnswerKey(raw.answer_key);
      const hint =
        gaps.length > 0
          ? `<p class="q-hint"><em>Fill in ${gaps.length} blank${
              gaps.length === 1 ? "" : "s"
            }.</em></p>`
          : "";
      return `
        <div class="q-prompt">${renderInline(stem)}</div>
        ${hint}
      `;
    }
    case "ordering": {
      const prompt = orderingPromptFromPayload(raw.payload);
      const items = deterministicShuffle(orderingItemsFromPayload(raw.payload));
      const lis = items
        .map(
          (item) =>
            `<li><span class="blank">____</span> ${renderInline(item)}</li>`,
        )
        .join("");
      return `
        <div class="q-prompt">${renderInline(prompt)}</div>
        <p class="q-hint"><em>Number each item in the correct order (1 = first):</em></p>
        <ul class="q-list">${lis}</ul>
      `;
    }
    case "classification": {
      const prompt = classificationPromptFromPayload(raw.payload);
      const categories = classificationCategoriesFromPayload(raw.payload);
      const items = classificationItemsFromPayload(raw.payload);
      const catLine = categories.map((c) => escapeHtml(c.label)).join(" • ");
      const lis = items
        .map(
          (it) =>
            `<li>${renderInline(it.text)} <span class="arrow">→</span> <span class="blank">____</span></li>`,
        )
        .join("");
      return `
        <div class="q-prompt">${renderInline(prompt)}</div>
        <p class="q-hint"><em>Categories:</em> ${catLine}</p>
        <p class="q-hint"><em>Write the correct category next to each item:</em></p>
        <ul class="q-list">${lis}</ul>
      `;
    }
  }

  return "";
}

const DOCUMENT_STYLES = `
  body {
    font-family: 'Helvetica', 'Arial', sans-serif;
    color: #111;
    margin: 24px;
    line-height: 1.5;
    font-size: 12pt;
  }
  h1 { font-size: 24px; text-align: center; margin: 16px 0 8px; }
  h2 { font-size: 18px; margin: 24px 0 8px; }
  hr { border: 0; border-top: 1px solid #999; margin: 16px 0; }
  .institution { font-weight: 600; margin-bottom: 4px; }
  .course { font-style: italic; margin-bottom: 16px; }
  .total-points { margin-bottom: 12px; }
  .custom-header { margin: 12px 0 16px; }
  .q-prompt { margin: 8px 0; }
  .q-options { list-style: none; padding-left: 16px; margin: 8px 0; }
  .q-options li { margin: 4px 0; }
  .q-options .opt-letter { font-weight: 600; margin-right: 6px; }
  .q-list { padding-left: 16px; }
  .q-list li { margin: 4px 0; }
  .q-hint { color: #555; margin: 6px 0; font-size: 13px; }
  .q-answer-label { margin-top: 12px; font-size: 13px; color: #555; }
  .q-answer-space { height: 80px; border: 1px solid #ccc; background: #fafafa; margin-top: 4px; }
  .blank { font-weight: 600; letter-spacing: 1px; }
  .arrow { color: #888; }
  /* KaTeX produces both visually-rendered HTML and a hidden MathML copy.
     Hide the MathML copy in print so glyphs don't double up. */
  .katex .katex-mathml { display: none; }
`;

export function buildTestExportHtml(args: TestExportArgs): string {
  const {
    institutionName,
    courseName,
    testTitle,
    customHeader,
    questions,
    questionsById,
  } = args;

  const totalPoints = questions.reduce((sum, q) => sum + q.points, 0);

  const headerHtml = [
    institutionName
      ? `<div class="institution">${escapeHtml(institutionName)}</div>`
      : "",
    courseName ? `<div class="course">${escapeHtml(courseName)}</div>` : "",
    `<h1>${escapeHtml(testTitle)}</h1>`,
    `<div class="total-points">Total Points: ${totalPoints}</div>`,
    customHeader && customHeader.trim()
      ? `<div class="custom-header">${renderInline(customHeader)}</div>`
      : "",
    `<hr />`,
  ].join("\n");

  const questionsHtml = questions
    .map((q, index) => {
      const full = questionsById.get(q.id);
      const body = full ? questionBodyHtml(full) : "";
      const pointsLabel = `${q.points} point${q.points !== 1 ? "s" : ""}`;
      return `
        <section class="question">
          <h2>${index + 1}. (${pointsLabel})</h2>
          ${body}
        </section>
        <hr />
      `;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(testTitle)}</title>
    <link rel="stylesheet" href="${KATEX_CSS_URL}" crossorigin="anonymous" integrity="sha384-Pu5+C18nP5dwykLJOhd2U4Xen7rjScHN/qusop27hdd2drI+lL5KvX7YntvT8yew" />
    <style>${DOCUMENT_STYLES}</style>
  </head>
  <body>
    ${headerHtml}
    ${questionsHtml}
  </body>
</html>`;
}
