/**
 * Issue #728: HTML seed for the rich-text test document editor.
 *
 * Distinct from `buildTestExportHtml` (which produces a *full* HTML
 * document for the read-only PDF pipeline): this helper returns an
 * editable HTML *fragment* — just the body content — that the TipTap
 * editor loads as its initial document. The instructor then tweaks
 * page breaks / font sizes / wording before exporting.
 *
 * Question text and options run through `processLatexContent` so KaTeX
 * markup is baked into the snapshot; the PDF renderer just pulls in
 * the same KaTeX stylesheet, no client-side math rendering needed.
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

export interface TestDocumentSeedQuestionRef {
  id: string;
  points: number;
}

export interface TestDocumentSeedArgs {
  institutionName?: string | null;
  courseName?: string | null;
  testTitle: string;
  customHeader?: string | null;
  questions: TestDocumentSeedQuestionRef[];
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

function renderInline(text: string | null | undefined): string {
  if (!text) return "";
  return processLatexContent(text);
}

/**
 * Deterministic Fisher-Yates with the same seed `buildTestExportHtml`
 * uses, so the editable seed matches the read-only export.
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
          return `<li><strong>${letter}.</strong> ${renderInline(opt)}</li>`;
        })
        .join("");
      return `<p>${renderInline(raw.question ?? "")}</p><ol>${optionItems}</ol>`;
    }
    case "open": {
      return `<p>${renderInline(raw.question ?? "")}</p><p><em>Answer:</em></p><p>&nbsp;</p><p>&nbsp;</p>`;
    }
    case "fill_gaps": {
      const stem = fillGapsStemFromPayload(raw.payload).replace(
        /\{\{(\d+)\}\}/g,
        (_m, n) => `**(${n})** ____`,
      );
      const gaps = fillGapsAcceptableAnswersFromAnswerKey(raw.answer_key);
      const hint =
        gaps.length > 0
          ? `<p><em>Fill in ${gaps.length} blank${gaps.length === 1 ? "" : "s"}.</em></p>`
          : "";
      return `<p>${renderInline(stem)}</p>${hint}`;
    }
    case "ordering": {
      const prompt = orderingPromptFromPayload(raw.payload);
      const items = deterministicShuffle(orderingItemsFromPayload(raw.payload));
      const lis = items
        .map((item) => `<li><strong>____</strong> ${renderInline(item)}</li>`)
        .join("");
      return `<p>${renderInline(prompt)}</p><p><em>Number each item in the correct order (1 = first):</em></p><ul>${lis}</ul>`;
    }
    case "classification": {
      const prompt = classificationPromptFromPayload(raw.payload);
      const categories = classificationCategoriesFromPayload(raw.payload);
      const items = classificationItemsFromPayload(raw.payload);
      const catLine = categories.map((c) => escapeHtml(c.label)).join(" • ");
      const lis = items
        .map(
          (it) =>
            `<li>${renderInline(it.text)} → <strong>____</strong></li>`,
        )
        .join("");
      return `<p>${renderInline(prompt)}</p><p><em>Categories:</em> ${catLine}</p><p><em>Write the correct category next to each item:</em></p><ul>${lis}</ul>`;
    }
  }

  return "";
}

/**
 * Render a TipTap-loadable HTML body fragment for the assembled test.
 * Headings use `<h1>`/`<h2>` so the editor's heading toolbar picks them
 * up; `processLatexContent` is applied to user prose so KaTeX glyphs
 * live in the snapshot.
 */
export function buildTestDocumentSeedHtml(args: TestDocumentSeedArgs): string {
  const {
    institutionName,
    courseName,
    testTitle,
    customHeader,
    questions,
    questionsById,
  } = args;

  const totalPoints = questions.reduce((sum, q) => sum + q.points, 0);

  const headerParts: string[] = [];
  if (institutionName) {
    headerParts.push(`<p><strong>${escapeHtml(institutionName)}</strong></p>`);
  }
  if (courseName) {
    headerParts.push(`<p><em>${escapeHtml(courseName)}</em></p>`);
  }
  headerParts.push(`<h1>${escapeHtml(testTitle)}</h1>`);
  headerParts.push(`<p>Total Points: ${totalPoints}</p>`);
  if (customHeader && customHeader.trim()) {
    headerParts.push(`<p>${renderInline(customHeader)}</p>`);
  }
  headerParts.push("<hr />");

  const questionsHtml = questions
    .map((q, index) => {
      const full = questionsById.get(q.id);
      const body = full ? questionBodyHtml(full) : "";
      const pointsLabel = `${q.points} point${q.points !== 1 ? "s" : ""}`;
      return `<h2>${index + 1}. (${pointsLabel})</h2>${body}`;
    })
    .join("\n");

  return `${headerParts.join("\n")}\n${questionsHtml}`;
}
