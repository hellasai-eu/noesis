#!/usr/bin/env bash
# Guards against the recurring "flex-column dialog whose body doesn't scroll"
# regression (#843, #849, #850, #862 — all the same root cause).
#
# The anti-pattern: a Radix `ScrollArea` with `flex-1` (and no explicit height)
# used as the scrolling body of a `max-h-[..vh] flex flex-col` DialogContent.
# Radix's internal display:table viewport won't bound its height as a flex-1
# child, so no scroll boundary forms and the content clips above the footer.
#
# The fix: use the native `<ScrollableDialogBody>` (flex-1 min-h-0
# overflow-y-auto) from src/components/ui/scrollable-dialog-body.tsx, or a plain
# `<div className="flex-1 min-h-0 overflow-y-auto">`.
#
# A `ScrollArea` with an explicit height (h-[..], h-40, max-h-[..]) self-bounds
# and is NOT flagged — only `flex-1` bodies are.
#
# Escape hatch: add a `dialog-scroll-ok` comment on the offending line if a
# ScrollArea is genuinely fine there (e.g. it isn't the dialog body).

set -euo pipefail

SRC_DIR="${1:-src}"

if [ ! -d "$SRC_DIR" ]; then
  echo "::error::source directory not found: $SRC_DIR" >&2
  exit 1
fi

offenders=""

while IFS= read -r file; do
  [ -z "$file" ] && continue

  # Candidate: file has a DialogContent whose className carries both a viewport
  # height constraint and a flex column (flex flex-col). The opening tag is
  # flattened across lines first (same approach as the ScrollArea scan below)
  # so a multiline `className={cn(...)}` layout is still caught, not just
  # single-line tags.
  #
  # The height may be a MAX (max-h-[88vh]) or FIXED (h-[88vh]) — both bound the
  # dialog, so both produce the clipping bug. Matching only `max-h-` was a hole
  # that let the regression through a fifth time in #997, where the dialog used
  # `h-[88vh]`: the file was skipped before the ScrollArea scan ever ran, so
  # the guard reported OK on code that had exactly the defect it exists to
  # catch. `\b` before `h-` keeps `max-h-` matching here too rather than
  # requiring an alternation that could drift.
  has_constrained_dialog=$(perl -0777 -ne '
    while (/<DialogContent\b.*?>/gs) {
      (my $flat = $&) =~ s/\s+/ /g;
      if ($flat =~ /(?<![\w-])(?:max-)?h-\[[0-9]+vh\]/ && $flat =~ /flex flex-col/) {
        print "yes";
        last;
      }
    }
  ' "$file")
  if [ "$has_constrained_dialog" != "yes" ]; then
    continue
  fi

  # Anti-pattern body: a ScrollArea sized only by flex-1 (no explicit height),
  # ignoring lines the author explicitly marked safe. className is matched
  # loosely (up to the tag close) so string literals, template literals, and
  # cn(...)/clsx(...) expressions are all caught, not just className="...".
  # The opening tag is flattened across lines first so JSX that wraps
  # className onto its own line (e.g. `<ScrollArea className={cn(\n "flex-1"\n)}>`)
  # is still caught, not just single-line tags.
  hits=$(perl -0777 -ne '
    while (/<ScrollArea\b.*?>/gs) {
      my $tag = $&;
      my $before = substr($_, 0, $-[0]);
      my $line = ($before =~ tr/\n//) + 1;
      (my $flat = $tag) =~ s/\s+/ /g;
      if ($flat =~ /className\s*=.*\bflex-1\b/ && $flat !~ /dialog-scroll-ok/) {
        print "$line:$flat\n";
      }
    }
  ' "$file" || true)
  if [ -n "$hits" ]; then
    offenders+="$file"$'\n'"$hits"$'\n'
  fi
done < <(grep -rlE 'DialogContent' "$SRC_DIR" --include='*.tsx')

if [ -n "$offenders" ]; then
  echo "::error::Unbounded ScrollArea body inside a constrained flex-column dialog:" >&2
  echo "$offenders" >&2
  cat >&2 <<'MSG'
A Radix <ScrollArea className="flex-1 ..."> won't scroll inside a
`max-h-[..vh] flex flex-col` DialogContent — it clips above the footer.

Replace it with <ScrollableDialogBody> from
src/components/ui/scrollable-dialog-body.tsx (or a native
`<div className="flex-1 min-h-0 overflow-y-auto">`).

See docs/scrollable-dialog-body.md. If the ScrollArea is genuinely not the
dialog body, add a `dialog-scroll-ok` comment on its line to suppress.
MSG
  exit 1
fi

count=$(grep -rlE 'DialogContent' "$SRC_DIR" --include='*.tsx' | wc -l | tr -d ' ')
echo "OK: no unbounded dialog-scroll bodies across ${count} dialog file(s)."
