import { describe, it, expect, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import Landing from "@deployment/Landing";
// The in-repo default, imported by path rather than through the alias: its
// behaviour is worth asserting even in a deployment whose own overlay has
// replaced it.
import DefaultLanding from "../../../deployment/Landing";
import { BrandLogo, BrandMark } from "@/components/BrandMark";
import {
  LEGAL_DOCUMENTS,
  brand,
  copyrightLine,
  hasLegalDocuments,
  legal,
  legalDocumentBySlug,
  legalPath,
  primaryLegalLanguage,
} from "@/deployment";
import { defineBrand, defineLegal, BRAND_META_DEFAULTS } from "@/deployment/contract";

/**
 * The deployment overlay is what makes this repository deployable by somebody
 * other than its author: `/`, `/legal/*` and the logo all come from a
 * directory outside `src/`, resolved through the `@deployment` alias.
 *
 * These tests are written against the *contract*, not against the default
 * overlay's content — a deployment that points DEPLOYMENT_DIR at its own
 * directory runs them over its own brand and must still pass.
 */

const at = (path: string, element: React.ReactNode) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/auth" element={<div>sign-in screen</div>} />
        <Route path="*" element={<>{element}</>} />
      </Routes>
    </MemoryRouter>,
  );

describe("the resolved overlay", () => {
  it("always has a name and a description to render", () => {
    // Every consumer treats these as present. An overlay that omits both gets
    // the defaults rather than `undefined` in the page chrome.
    expect(brand.name).toBeTruthy();
    expect(brand.description).toBeTruthy();
    expect(brand.title).toBeTruthy();
  });

  it("carries no product identity of this repository's", () => {
    // The whole point of the overlay. A name reintroduced as a literal under
    // `src/` would not fail a type-check, so it has to fail here.
    const chrome = [brand.name, brand.title, brand.description].join(" ");
    expect(chrome).not.toMatch(/noesis|dianoisis/i);
  });

  it("keeps the published legal set and the route helper in step", () => {
    expect(hasLegalDocuments).toBe(LEGAL_DOCUMENTS.length > 0);

    for (const doc of LEGAL_DOCUMENTS) {
      expect(legalPath(doc.slug)).toBe(`/legal/${doc.slug}`);
      expect(legalDocumentBySlug(doc.slug)).toBe(doc);
    }
    expect(legalDocumentBySlug("not-a-document")).toBeUndefined();
  });

  it("publishes every document in every language it declares", () => {
    // A document missing a body in a declared language would render an empty
    // legal page — the one failure mode nobody notices until a school does.
    for (const doc of LEGAL_DOCUMENTS) {
      for (const language of legal.languages) {
        expect(doc.body[language], `${doc.slug}.${language}`).toBeTruthy();
        expect(doc.label[language], `${doc.slug}.${language} label`).toBeTruthy();
        expect(
          doc.description[language],
          `${doc.slug}.${language} description`,
        ).toBeTruthy();
      }
    }
  });

  it("opens its legal pages in the language it treats as binding", () => {
    expect(primaryLegalLanguage).toBe(legal.languages[0] ?? null);
  });
});

describe("the landing page at /", () => {
  it("comes from the overlay and renders", () => {
    // `/` used to be a 600-line marketing page for one particular product,
    // which made this repository unusable by anyone else without deleting it
    // first. All this asserts is that whatever the overlay puts there mounts —
    // its content is the deployment's business, not this suite's.
    expect(() => at("/", <Landing />)).not.toThrow();
  });

  it("defaults to the sign-in screen rather than a pitch or a blank page", () => {
    // The default overlay has nothing to market. A redirect is the only thing
    // an unbranded clone can honestly offer at `/`.
    at("/", <DefaultLanding />);
    expect(screen.getByText("sign-in screen")).toBeInTheDocument();
  });
});

describe("BrandMark", () => {
  it("renders the configured name", () => {
    at("/dashboard", <BrandMark />);
    expect(screen.getByText(brand.name)).toBeInTheDocument();
  });

  it("renders a mark even when the overlay configures no logo and no icon", () => {
    // The fallback is why a clone is not shipped with an empty square where
    // the logo goes.
    const { container } = render(<BrandLogo />);
    expect(container.querySelector("svg, img")).not.toBeNull();
  });

  it("lets a page name itself while keeping the product's mark", () => {
    // An institution portal shows the school's name, not the product's.
    at("/i/some-school", <BrandMark name="Some School" subtitle="Powered by X" />);
    expect(screen.getByText("Some School")).toBeInTheDocument();
    expect(screen.getByText("Powered by X")).toBeInTheDocument();
    expect(screen.queryByText(brand.name)).toBeNull();
  });

  it("links to a path when asked, and not otherwise", () => {
    const { unmount } = at("/auth-page", <BrandMark to="/" />);
    expect(screen.getByRole("link")).toHaveAttribute("href", "/");
    unmount();

    at("/dashboard", <BrandMark />);
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("defineBrand", () => {
  it("fills in every field an overlay leaves out", () => {
    const result = defineBrand({ name: "Acme Learn" });

    expect(result.name).toBe("Acme Learn");
    // The field an overlay is most likely to forget, and the one a stale
    // default is most visible in.
    expect(result.title).toBe("Acme Learn");
    expect(result.description).toBe(BRAND_META_DEFAULTS.description);
    expect(result.logo).toBeNull();
    expect(result.icon).toBeNull();
  });

  it("keeps an explicit title rather than deriving one from the name", () => {
    expect(defineBrand({ name: "Acme", title: "Acme — sign in" }).title).toBe(
      "Acme — sign in",
    );
  });

  it("does not let an explicit undefined erase a default", () => {
    // Easy to produce from a conditional in an overlay's object literal, and
    // it would otherwise win the spread and put `undefined` in the UI.
    expect(defineBrand({ name: undefined }).name).toBe(BRAND_META_DEFAULTS.name);
    expect(defineBrand({ copyright: undefined }).copyright).toBe(
      BRAND_META_DEFAULTS.copyright,
    );
    // Whereas an explicit null is a choice, and is kept.
    expect(defineBrand({ copyright: null }).copyright).toBeNull();
  });
});

describe("defineLegal", () => {
  it("publishes nothing unless an overlay declares its languages", () => {
    // Publishing a document in a language nobody declared is worse than
    // publishing none: the page would render with a toggle that does nothing.
    const result = defineLegal();
    expect(result.languages).toEqual([]);
    expect(result.documents).toEqual([]);
  });

  it("merges per-language maps rather than replacing them wholesale", () => {
    const result = defineLegal({
      languages: ["el"],
      translationNote: { en: "note" },
    });

    expect(result.translationNote.en).toBe("note");
    // The language the overlay did not mention keeps its default.
    expect(result.translationNote.el).toBeNull();
    expect(result.languageLabels.el).toBe("Ελληνικά");
  });
});

describe("copyrightLine", () => {
  const original = brand.copyright;
  afterEach(() => {
    brand.copyright = original;
  });

  it("substitutes the current year and the brand name", () => {
    brand.copyright = "© {year} {name}. All rights reserved.";
    expect(copyrightLine()).toBe(
      `© ${new Date().getFullYear()} ${brand.name}. All rights reserved.`,
    );
  });

  it("returns null when the overlay wants no line", () => {
    brand.copyright = null;
    expect(copyrightLine()).toBeNull();
  });
});
