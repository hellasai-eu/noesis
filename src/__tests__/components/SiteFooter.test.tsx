import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { SiteFooter } from "@/components/SiteFooter";
import { GlobalFooter } from "@/components/GlobalFooter";
import { LEGAL_DOCUMENTS, legalPath } from "@/deployment";

const at = (path: string, element: React.ReactNode) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="*" element={<>{element}</>} />
      </Routes>
    </MemoryRouter>,
  );

describe("SiteFooter (#937)", () => {
  it("links every legal document, at its own route", () => {
    at("/dashboard", <SiteFooter />);

    for (const doc of LEGAL_DOCUMENTS) {
      const link = screen.getByRole("link", { name: doc.label.en });
      expect(link).toHaveAttribute("href", legalPath(doc.slug));
    }
    expect(screen.getByRole("link", { name: "Contact" })).toHaveAttribute("href", "/contact");
  });

  it("takes its links from the compliance set rather than a second list", () => {
    at("/dashboard", <SiteFooter />);

    // A document the deployment overlay adds must appear here without anyone
    // editing the footer — which is only true if the count matches.
    const nav = screen.getByRole("navigation", { name: "Legal" });
    expect(nav.querySelectorAll("a")).toHaveLength(LEGAL_DOCUMENTS.length + 1);
  });

  it("shows Greek labels when the reader has chosen Greek", () => {
    at("/legal/privacy", <SiteFooter language="el" />);
    expect(screen.getByRole("link", { name: "Απόρρητο" })).toBeInTheDocument();
  });
});

describe("GlobalFooter (#937)", () => {
  it("renders on an app route that has no footer of its own", () => {
    at("/classes", <GlobalFooter />);
    expect(screen.getByTestId("site-footer")).toBeInTheDocument();
  });

  it("stays out of the way of routes that render their own", () => {
    // Each would otherwise show two footers: the landing page keeps its
    // brand-dark band, and the legal pages and the two dashboards place theirs
    // inside their own flex column, so it lands at the bottom of the content
    // rather than below a forced 100vh.
    for (const path of [
      "/",
      "/legal",
      "/legal/privacy",
      "/student",
      "/student/course/abc",
      "/dashboard",
    ]) {
      const { unmount } = at(path, <GlobalFooter />);
      expect(screen.queryByTestId("site-footer")).toBeNull();
      unmount();
    }
  });

  it("still covers the routes nested under an excluded dashboard", () => {
    // `/student` and `/student/course/:id` render their own — both wear the
    // same shell. The pages *under* a course do not, and are different pages:
    // excluding the prefix rather than the exact paths would quietly drop the
    // legal links from quiz history and community questions.
    for (const path of [
      "/student/course/abc/quiz-history",
      "/student/course/abc/community-questions",
      "/dashboard/anything",
      "/legalese",
    ]) {
      const { unmount } = at(path, <GlobalFooter />);
      expect(screen.getByTestId("site-footer")).toBeInTheDocument();
      unmount();
    }
  });
});
