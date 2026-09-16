import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * The sanctioned scrolling body for a constrained (`max-h-[..vh] flex flex-col`)
 * `DialogContent`.
 *
 * Why this exists: a Radix `ScrollArea` with `flex-1` (and no explicit height)
 * placed as the body of a flex-column dialog will NOT bound its own height —
 * Radix wraps the viewport in an internal `display:table` element that ignores
 * the flex constraint, so no scroll boundary forms and the content clips above
 * the footer. This exact bug has shipped four times (#843, #849, #850, #862).
 *
 * A native `flex-1 min-h-0 overflow-y-auto` div is the reliable scroll
 * container inside a flex column. `min-h-0` lets the flex child shrink below
 * its content height; `overflow-y-auto` forms the scroll boundary.
 *
 * Trades the custom thin Radix scrollbar for the native one — worth it for a
 * body that must always scroll to reach the footer.
 *
 * See `docs/scrollable-dialog-body.md` and `scripts/check-dialog-scroll.sh`
 * (the CI guard that flags the anti-pattern).
 */
const ScrollableDialogBody = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("flex-1 min-h-0 overflow-y-auto", className)} {...props} />
));
ScrollableDialogBody.displayName = "ScrollableDialogBody";

export { ScrollableDialogBody };
