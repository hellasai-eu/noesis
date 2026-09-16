import { describe, it, expect } from "vitest";
import { createRef } from "react";
import { render, screen } from "@testing-library/react";

import { ScrollableDialogBody } from "@/components/ui/scrollable-dialog-body";

// jsdom can't assert real layout, so we can't test that the body actually
// scrolls. Instead we lock in the three classes that form the reliable scroll
// container inside a flex-column dialog — the fix for the recurring
// dialog-scroll regression (#843, #849, #850, #862). If any of these is
// dropped, the bug comes back.
describe("ScrollableDialogBody", () => {
  it("renders the flex-1 min-h-0 overflow-y-auto scroll classes", () => {
    render(<ScrollableDialogBody data-testid="body">content</ScrollableDialogBody>);
    const el = screen.getByTestId("body");
    expect(el).toHaveClass("flex-1");
    expect(el).toHaveClass("min-h-0");
    expect(el).toHaveClass("overflow-y-auto");
  });

  it("merges caller className while keeping the scroll classes", () => {
    render(
      <ScrollableDialogBody data-testid="body" className="border rounded-lg -mx-6 px-6">
        content
      </ScrollableDialogBody>,
    );
    const el = screen.getByTestId("body");
    expect(el).toHaveClass("flex-1", "min-h-0", "overflow-y-auto");
    expect(el).toHaveClass("border", "rounded-lg", "-mx-6", "px-6");
  });

  it("forwards its ref to the underlying div", () => {
    const ref = createRef<HTMLDivElement>();
    render(<ScrollableDialogBody ref={ref}>content</ScrollableDialogBody>);
    expect(ref.current).toBeInstanceOf(HTMLDivElement);
  });
});
