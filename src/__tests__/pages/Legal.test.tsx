import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import Legal, { LegalMarkdown } from "@/pages/Legal";
import { LEGAL_DOCUMENTS, legalPath } from "@/deployment";

/**
 * These pages are public by construction: nothing here mocks a Supabase client
 * or an auth context, because the page reads neither. If a future change makes
 * it need one, this file fails first — which is the point.
 *
 * The documents themselves come from the deployment overlay, so this file
 * asserts the *viewer's* behaviour against whatever that overlay publishes —
 * never against particular prose. A deployment pointing DEPLOYMENT_DIR at its
 * own set runs these same tests over its own documents.
 */
const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/legal/:slug" element={<Legal />} />
        <Route path="/legal" element={<Legal />} />
        <Route path="*" element={<div>elsewhere</div>} />
      </Routes>
    </MemoryRouter>,
  );

describe("Legal pages (#937)", () => {
  it("renders every document at its own route, with no session", () => {
    for (const doc of LEGAL_DOCUMENTS) {
      const { unmount } = renderAt(legalPath(doc.slug));
      const body = screen.getByTestId("legal-body");
      // The document's own H1 comes from the markdown, so a wired-up route
      // that rendered the wrong file would still pass a length check.
      expect(within(body).getAllByRole("heading", { level: 1 })).not.toHaveLength(0);
      expect(body.textContent!.length).toBeGreaterThan(500);
      unmount();
    }
  });

  it("leads in Greek and switches to English on request", async () => {
    renderAt("/legal/privacy");

    const body = screen.getByTestId("legal-body");
    expect(body).toHaveAttribute("lang", "el");
    expect(body).toHaveTextContent("Πολιτική Απορρήτου");

    await userEvent.click(screen.getByRole("button", { name: "English" }));

    const english = screen.getByTestId("legal-body");
    expect(english).toHaveAttribute("lang", "en");
    expect(english).toHaveTextContent("Privacy Policy");
    // The English page must say it is not the binding text.
    expect(screen.getByText(/binding text/i)).toBeInTheDocument();
  });

  it("shows the DRAFT banner on every document, in both languages", async () => {
    for (const doc of LEGAL_DOCUMENTS) {
      const { unmount } = renderAt(legalPath(doc.slug));
      expect(screen.getByTestId("legal-body")).toHaveTextContent(/ΠΡΟΣΧΕΔΙΟ/);

      await userEvent.click(screen.getByRole("button", { name: "English" }));
      expect(screen.getByTestId("legal-body")).toHaveTextContent(/DRAFT/);
      unmount();
    }
  });

  it("marks the operator placeholders instead of leaving them as raw brackets", () => {
    renderAt("/legal/privacy");

    const body = screen.getByTestId("legal-body");
    // `[OPERATOR: …]` in running prose reads like a typo. It is real content in
    // a draft, but it has to be visibly unfinished. The shipped skeletons are
    // made of these markers, so the default overlay exercises this for real.
    expect(body.textContent).not.toMatch(/\[OPERATOR:/);
    expect(body).toHaveTextContent(/TO BE COMPLETED/);
  });

  it("sets a per-document title and description for indexing", () => {
    const { unmount } = renderAt("/legal/subprocessors");
    expect(document.title).toContain("Υπεργολάβοι");
    expect(
      document.querySelector('meta[name="description"]')?.getAttribute("content"),
    ).toBe(LEGAL_DOCUMENTS.find((d) => d.slug === "subprocessors")!.description.el);
    unmount();
  });

  it("sends an unknown slug to the privacy policy rather than a blank page", () => {
    renderAt("/legal/not-a-document");
    expect(screen.getByTestId("legal-body")).toHaveTextContent("Πολιτική Απορρήτου");
  });

  it("links every other document from each page, and carries a footer", () => {
    renderAt("/legal/terms");

    for (const doc of LEGAL_DOCUMENTS) {
      expect(screen.getAllByRole("link", { name: doc.label.el }).length).toBeGreaterThan(0);
    }
    expect(screen.getByTestId("site-footer")).toBeInTheDocument();
  });

});

describe("LegalMarkdown (#937)", () => {
  // Tested directly rather than through a page: none of the four published
  // documents happens to contain a table today, so asserting over the real
  // pages would pass vacuously and stop meaning anything the day one does.
  const TABLE = [
    "| Subprocessor | Purpose | Where |",
    "|---|---|---|",
    "| Supabase | Database, auth, storage | EU |",
  ].join("\n");

  it("wraps a table so a wide one scrolls inside itself, not the page", () => {
    render(<LegalMarkdown markdown={TABLE} language="en" />);

    const table = screen.getByRole("table");
    expect(table.parentElement?.className).toContain("overflow-x-auto");
  });

  it("marks an operator placeholder wherever it appears", () => {
    render(<LegalMarkdown markdown="Contact: [OPERATOR: privacy address]" language="en" />);

    const body = screen.getByTestId("legal-body");
    expect(body.textContent).not.toMatch(/\[OPERATOR:/);
    expect(body).toHaveTextContent("TO BE COMPLETED — privacy address");
  });

  it("emits exactly one code span for a marker the source already wrapped", () => {
    // This is the form that actually ships — nearly every marker in the
    // compliance files is written as inline code. Matching only the brackets
    // would leave the source pair in place and add a second, which renders
    // correctly only because CommonMark reads the doubled pair as one
    // delimiter run. Correct by coincidence breaks the first time a marker's
    // text contains a backtick.
    const { container } = render(
      <LegalMarkdown
        markdown={"**Operator:** `[OPERATOR: registered legal entity]`"}
        language="en"
      />,
    );

    const codes = container.querySelectorAll("code");
    expect(codes).toHaveLength(1);
    expect(codes[0].textContent).toBe("⚠ TO BE COMPLETED — registered legal entity");
    // No stray delimiters anywhere on the page.
    expect(container.textContent).not.toContain("`");
  });

  it("handles a wrapped marker whose text contains a backtick", () => {
    render(
      <LegalMarkdown
        markdown={"`[OPERATOR: read it from the `region` field]`"}
        language="en"
      />,
    );

    expect(screen.getByTestId("legal-body")).toHaveTextContent(/TO BE COMPLETED/);
  });

  it("collapses a placeholder the source wrapped across lines", () => {
    // The compliance files wrap at 80 columns, so a long marker spans two or
    // three lines. Left alone it renders as separate code fragments with hard
    // breaks through the middle of a sentence.
    render(
      <LegalMarkdown
        markdown={"See [OPERATOR: confirm the executed\nDPA and the\nregion]."}
        language="en"
      />,
    );

    expect(screen.getByTestId("legal-body")).toHaveTextContent(
      "TO BE COMPLETED — confirm the executed DPA and the region",
    );
  });

  it("opens external links in a new tab, and internal ones in place", () => {
    render(
      <MemoryRouter>
        <LegalMarkdown
          markdown={"[out](https://www.dpa.gr) and [in](/legal/terms)"}
          language="en"
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole("link", { name: "out" })).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByRole("link", { name: "in" })).not.toHaveAttribute("target");
  });
});
