# Scrollable dialog bodies

**TL;DR — if a dialog's content needs to scroll, wrap the scrolling section in
`<ScrollableDialogBody>`, not a Radix `<ScrollArea>`.**

## The bug this prevents

A dialog that constrains its height and lays its children out as a flex column:

```tsx
<DialogContent className="max-w-3xl max-h-[90vh] flex flex-col">
  <DialogHeader>…</DialogHeader>
  {/* body that should scroll */}
  <DialogFooter>…</DialogFooter>
</DialogContent>
```

needs its body to be the part that scrolls, so the header and footer stay
pinned. The intuitive choice — a Radix `<ScrollArea className="flex-1">` — does
**not** work here. Radix wraps its content in an internal `display:table`
viewport that ignores the flex constraint, so the `flex-1` child never bounds
its height, no scroll boundary forms, and the body clips above the footer.

This exact regression has shipped four times: #843, #849, #850, #862.

## The fix

Use `ScrollableDialogBody` from `src/components/ui/scrollable-dialog-body.tsx`.
It's a native `<div>` hard-coded to `flex-1 min-h-0 overflow-y-auto` — the
reliable scroll container inside a flex column (`min-h-0` lets the flex child
shrink below its content; `overflow-y-auto` forms the scroll boundary).

```tsx
import { ScrollableDialogBody } from "@/components/ui/scrollable-dialog-body";

<DialogContent className="max-w-3xl max-h-[90vh] flex flex-col">
  <DialogHeader>…</DialogHeader>
  <ScrollableDialogBody className="-mx-6 px-6">
    {/* long content */}
  </ScrollableDialogBody>
  <DialogFooter>…</DialogFooter>
</DialogContent>
```

Pass extra classes (borders, negative-margin bleed, etc.) via `className`; they
merge with the scroll classes.

## When `ScrollArea` is still fine

A Radix `<ScrollArea>` with an **explicit height** (`h-[60vh]`, `h-40`,
`max-h-[400px]`) self-bounds and works fine — inside a dialog or anywhere else.
The anti-pattern is specifically a `flex-1` ScrollArea (sized only by flex) as
the body of a `max-h-[..vh] flex flex-col` DialogContent.

## The guard

`scripts/check-dialog-scroll.sh` runs in CI (the `lint-and-typecheck` job) and
fails the build if it finds a `flex-1` `ScrollArea` inside a constrained
flex-column dialog. Run it locally with `npm run check:dialog-scroll`.

If you have a genuine exception (a `flex-1` ScrollArea that isn't the dialog
body), add a `dialog-scroll-ok` comment on that line to suppress the check.
