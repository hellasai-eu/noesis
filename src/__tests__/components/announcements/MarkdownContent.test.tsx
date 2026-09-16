import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MarkdownContent } from "@/components/announcements/MarkdownContent";

describe("MarkdownContent", () => {
  it("renders paragraphs and bold text", () => {
    render(<MarkdownContent>{"Hello **world**"}</MarkdownContent>);
    expect(screen.getByText("world")).toBeInTheDocument();
    expect(screen.getByText("world").tagName.toLowerCase()).toBe("strong");
  });

  it("renders unordered lists", () => {
    render(<MarkdownContent>{"- one\n- two"}</MarkdownContent>);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("one");
    expect(items[1]).toHaveTextContent("two");
  });

  it("renders links with target=_blank and safe rel", () => {
    render(<MarkdownContent>{"[site](https://example.com)"}</MarkdownContent>);
    const link = screen.getByRole("link", { name: "site" });
    expect(link).toHaveAttribute("href", "https://example.com");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("does not render raw HTML script tags", () => {
    const malicious = 'Hi<script>alert("xss")</script> there';
    const { container } = render(<MarkdownContent>{malicious}</MarkdownContent>);
    expect(container.querySelector("script")).toBeNull();
  });
});
