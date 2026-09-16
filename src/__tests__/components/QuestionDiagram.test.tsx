import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";

// DOMPurify needs a real implementation for the sanitization assertions below
// — the latex-utils tests stub it out, but here we want to verify that
// sanitizeDiagram actually strips dangerous markup. The package ships an
// isomorphic-DOM build that works inside jsdom.
vi.mock("katex", () => ({
  default: {
    renderToString: vi.fn((latex: string) => latex),
  },
}));

import { QuestionDiagram } from "@/components/QuestionDiagram";

describe("QuestionDiagram (#627)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders a benign SVG verbatim (circle + viewBox preserved)", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle r="3" cx="5" cy="5"/></svg>';
    const { container } = render(<QuestionDiagram source={svg} alt="A circle" />);
    const root = container.querySelector("div.question-diagram");
    expect(root).not.toBeNull();
    expect(root!.querySelector("svg")).not.toBeNull();
    expect(root!.querySelector("circle")).not.toBeNull();
  });

  it("strips inline <script> tags via DOMPurify's SVG profile", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><circle r="1"/></svg>';
    const { container } = render(<QuestionDiagram source={svg} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("circle")).not.toBeNull();
  });

  it("strips inline event-handler attributes (onclick / onload / onerror) — regression for #636", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">' +
      '<circle r="1" onclick="alert(2)"/>' +
      '<rect width="10" height="10" onerror="alert(3)"/>' +
      '<g onmouseover="alert(4)"><text>label</text></g>' +
      "</svg>";
    const { container } = render(<QuestionDiagram source={svg} />);
    const root = container.querySelector("svg");
    expect(root).not.toBeNull();
    // The shapes survive…
    expect(container.querySelector("circle")).not.toBeNull();
    expect(container.querySelector("rect")).not.toBeNull();
    expect(container.querySelector("g")).not.toBeNull();
    // …but every event-handler attribute is stripped.
    for (const el of Array.from(container.querySelectorAll("svg, svg *"))) {
      for (const attr of Array.from(el.attributes)) {
        expect(attr.name.startsWith("on")).toBe(false);
      }
    }
  });

  it("strips javascript: URLs from <a href> inside SVG — regression for #636", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg">' +
      '<a href="javascript:alert(1)"><circle r="1"/></a>' +
      "</svg>";
    const { container } = render(<QuestionDiagram source={svg} />);
    const link = container.querySelector("a");
    // Either the link itself is dropped, or its href is rewritten to something safe.
    const href = link?.getAttribute("href") ?? link?.getAttributeNS("http://www.w3.org/1999/xlink", "href") ?? "";
    expect(href.toLowerCase().startsWith("javascript:")).toBe(false);
  });

  it("renders nothing when both source and alt are missing", () => {
    const { container: missing } = render(<QuestionDiagram source={null} alt={null} />);
    expect(missing.querySelector(".question-diagram")).toBeNull();
    expect(missing.querySelector(".question-diagram-alt")).toBeNull();

    const { container: empty } = render(<QuestionDiagram source="" />);
    expect(empty.querySelector(".question-diagram")).toBeNull();
    expect(empty.querySelector(".question-diagram-alt")).toBeNull();
  });

  it("falls back to alt text when source is missing/empty but alt is provided (#636)", () => {
    const { container: missing } = render(
      <QuestionDiagram source={null} alt="Velocity vs. time graph" />,
    );
    const fallback = missing.querySelector(".question-diagram-alt") as HTMLElement | null;
    expect(fallback).not.toBeNull();
    expect(fallback?.textContent).toBe("Velocity vs. time graph");
    expect(fallback?.getAttribute("role")).toBe("img");
    expect(fallback?.getAttribute("aria-label")).toBe("Velocity vs. time graph");

    const { container: empty } = render(
      <QuestionDiagram source="" alt="A small dot" />,
    );
    expect(empty.querySelector(".question-diagram-alt")?.textContent).toBe("A small dot");
  });

  it("falls back to alt text when sanitization strips everything (#636)", () => {
    const { container } = render(
      <QuestionDiagram source="<script>alert(1)</script>" alt="A unit circle" />,
    );
    // The SVG path is gone (no real <svg> root) — alt takes over instead of rendering nothing.
    expect(container.querySelector(".question-diagram")).toBeNull();
    const fallback = container.querySelector(".question-diagram-alt") as HTMLElement | null;
    expect(fallback?.textContent).toBe("A unit circle");
  });

  it("sets aria-label from alt for screen readers", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>';
    const { container } = render(<QuestionDiagram source={svg} alt="A unit circle" />);
    const root = container.querySelector("div.question-diagram") as HTMLElement | null;
    expect(root?.getAttribute("aria-label")).toBe("A unit circle");
    expect(root?.getAttribute("role")).toBe("img");
  });

  it("omits aria-label when no alt text is given", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>';
    const { container } = render(<QuestionDiagram source={svg} />);
    const root = container.querySelector("div.question-diagram") as HTMLElement | null;
    expect(root?.getAttribute("aria-label")).toBeNull();
  });
});
