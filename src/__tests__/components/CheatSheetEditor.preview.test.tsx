/**
 * The visual editor is TipTap with no math extension, so a formula is literal
 * `$...$` text while you type. For a calculus guide that is most of the
 * content, which made the editor unusable for its actual purpose: you could
 * not tell whether a formula was right until a student saw it.
 *
 * The preview pane renders alongside using `renderAuthoredHtml` — the SAME
 * function the student view uses. That identity is the point: a preview that
 * rendered differently would just be a second thing to distrust. These tests
 * pin the rendering and the toggle; the shared-renderer guarantee is pinned in
 * src/__tests__/lib/latex-utils.test.ts.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

beforeAll(() => {
  for (const fn of [
    "hasPointerCapture",
    "setPointerCapture",
    "releasePointerCapture",
    "scrollIntoView",
  ] as const) {
    if (!(Element.prototype as unknown as Record<string, unknown>)[fn]) {
      (Element.prototype as unknown as Record<string, unknown>)[fn] = () => {};
    }
  }
  if (typeof globalThis.ResizeObserver === "undefined") {
    class RO {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    (globalThis as unknown as { ResizeObserver: typeof RO }).ResizeObserver = RO;
  }
  if (!globalThis.matchMedia) {
    globalThis.matchMedia = ((q: string) => ({
      matches: false,
      media: q,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof globalThis.matchMedia;
  }
});

// The editor's image-attach path imports the supabase client, which throws at
// module load without VITE_SUPABASE_* — unset for unit tests in CI.
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { getUser: vi.fn() }, storage: { from: vi.fn() } },
}));

import { CheatSheetEditor } from "@/components/CheatSheetEditor";

const THEORY = "<p>Έστω ότι η $f$ είναι συνεχής στο $[\\alpha,\\beta]$.</p>";

describe("CheatSheetEditor preview pane", () => {
  it("renders the maths the editor itself can only show as $ delimiters", async () => {
    render(<CheatSheetEditor content={THEORY} onChange={() => {}} />);

    const preview = await screen.findByTestId("editor-preview");
    await waitFor(() => expect(preview.querySelector(".katex")).not.toBeNull());

    // The delimited forms are consumed — that is the whole point.
    expect(preview.innerHTML).not.toContain("$f$");
    expect(preview.innerHTML).not.toContain("$[\\alpha,\\beta]$");

    // NOTE: do not assert the absence of `\alpha` itself. KaTeX embeds the
    // original TeX in a MathML <annotation> for screen readers and copy-paste,
    // so the source string is legitimately still in the markup — just not
    // rendered as text. Asserting on it fails against perfectly good output.
    const annotations = [...preview.querySelectorAll("annotation")].map(
      (a) => a.textContent ?? "",
    );
    expect(annotations.some((t) => t.includes("\\alpha"))).toBe(true);
  });

  it("keeps rendering both formulae, not just the first", async () => {
    render(<CheatSheetEditor content={THEORY} onChange={() => {}} />);
    const preview = await screen.findByTestId("editor-preview");
    await waitFor(() =>
      expect(preview.querySelectorAll(".katex").length).toBe(2),
    );
  });

  it("is on by default, because otherwise there is nowhere to check a formula", async () => {
    render(<CheatSheetEditor content={THEORY} onChange={() => {}} />);
    expect(await screen.findByTestId("editor-preview")).toBeInTheDocument();
    expect(screen.getByTestId("editor-toggle-preview")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("can be collapsed for authors who want the full width", async () => {
    render(<CheatSheetEditor content={THEORY} onChange={() => {}} />);
    await screen.findByTestId("editor-preview");

    await userEvent.click(screen.getByTestId("editor-toggle-preview"));

    await waitFor(() =>
      expect(screen.queryByTestId("editor-preview")).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId("editor-toggle-preview")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });
});
