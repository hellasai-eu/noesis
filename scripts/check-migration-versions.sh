#!/usr/bin/env bash
# Fails if any two migration files in supabase/migrations/ share the same
# version prefix (the timestamp before the first underscore). Supabase records
# only the version, so a collision means the second file is silently skipped
# on every push — see PR #527 for the incident that motivated this check.

set -euo pipefail

MIGRATIONS_DIR="${1:-supabase/migrations}"

if [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "::error::migrations directory not found: $MIGRATIONS_DIR" >&2
  exit 1
fi

dupes=$(
  find "$MIGRATIONS_DIR" -maxdepth 1 -name '*.sql' -type f -print0 \
    | xargs -0 -n1 basename \
    | sed 's/_.*$//' \
    | sort \
    | uniq -d
)

if [ -n "$dupes" ]; then
  echo "::error::Duplicate migration version prefix(es) in $MIGRATIONS_DIR:" >&2
  while IFS= read -r v; do
    [ -z "$v" ] && continue
    echo "  version $v:" >&2
    for f in "$MIGRATIONS_DIR"/${v}_*.sql; do
      echo "    - $f" >&2
    done
  done <<< "$dupes"
  echo >&2
  echo "Each migration must have a unique timestamp prefix. Bump the offending file(s) to a later timestamp." >&2
  exit 1
fi

count=$(find "$MIGRATIONS_DIR" -maxdepth 1 -name '*.sql' -type f | wc -l | tr -d ' ')
echo "OK: all ${count} migrations have unique version prefixes."
