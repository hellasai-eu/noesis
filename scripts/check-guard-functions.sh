#!/usr/bin/env bash
# Guards the two invariants every "refuse the write when students have already
# submitted" SQL function must hold (#1000).
#
# Both were violated in review after being written down, which is why this
# exists rather than a comment:
#
#   1. SECURITY DEFINER. A guard that counts rows the caller may not be allowed
#      to SEE must define away RLS, or its count is RLS-scoped while the write
#      it guards is not. A section-restricted instructor would get zero for a
#      question answered only in another section, and the delete would cascade
#      those answers away anyway. (#997 rounds 1 and 3.)
#
#   2. FOR UPDATE before the count. `SELECT count(*)` then `DELETE` is not
#      atomic under READ COMMITTED — the two take different snapshots, so an
#      answer committing between them is invisible to the count and cascaded
#      away. Locking the row the answer INSERT must take FOR KEY SHARE on (via
#      its FK) serializes the two. (#991 round 6, #997 round 2.)
#
# Neither is solvable with ON DELETE RESTRICT: `questions.course_id` is itself
# ON DELETE CASCADE, so RESTRICT would make deleting a course — and the GDPR
# erasure paths built on it — fail whenever any answer existed. That reasoning
# is recorded in 20260727190000 and pinned by a test.
#
# Scope: functions that count `public.study_guide_answers`. A function that
# neither counts answers nor cascades them is not a guard and is ignored —
# `move_study_guide_piece` is deliberately SECURITY INVOKER for that reason.
#
# Comments are stripped before analysis. Without that, a function whose comment
# merely mentions "FOR UPDATE" or "SECURITY DEFINER" would pass while the code
# did neither — the guard would assert its own documentation.

set -euo pipefail

MIG_DIR="${1:-supabase/migrations}"

if [ ! -d "$MIG_DIR" ]; then
  echo "::error::migrations directory not found: $MIG_DIR" >&2
  exit 1
fi

report=$(
  find "$MIG_DIR" -name '*.sql' -print0 \
    | xargs -0 awk '
    function reset() { n = 0; fname = ""; delete body }

    # Block-comment state must not bleed between files.
    FNR == 1 { inblock = 0 }

    # Strip BOTH comment forms before anything else: the invariants must be
    # proven by code, never by prose that happens to contain the same words.
    # Stripping only `--` left the hole open for `/* SECURITY DEFINER */`,
    # which is the same vacuity in a different syntax.
    #
    # Order matters. Block comments are resolved first (they can span lines and
    # can contain `--`), then the line comment, and only then is a trailing
    # unterminated `/*` treated as opening a block — so `-- /*` inside a line
    # comment does not swallow the rest of the file.
    {
      line = $0

      if (inblock) {
        idx = index(line, "*/")
        if (idx == 0) { line = "" }
        else { line = substr(line, idx + 2); inblock = 0 }
      }

      while (match(line, /\/\*.*\*\//)) {
        line = substr(line, 1, RSTART - 1) substr(line, RSTART + RLENGTH)
      }

      sub(/--.*/, "", line)

      open = index(line, "/*")
      if (open > 0) { line = substr(line, 1, open - 1); inblock = 1 }
    }

    line ~ /^[[:space:]]*CREATE OR REPLACE FUNCTION/ {
      reset()
      infunc = 1
      fname = line
      sub(/^[[:space:]]*CREATE OR REPLACE FUNCTION[[:space:]]+/, "", fname)
      sub(/\(.*$/, "", fname)
      file = FILENAME
    }

    infunc { body[++n] = line }

    # plpgsql bodies in this repo all terminate with a bare `$$;`.
    infunc && line ~ /^\$\$;/ {
      infunc = 0

      countline = 0
      for (i = 1; i <= n; i++) {
        if (body[i] ~ /count\(\*\)/) {
          # The FROM may sit on a following line.
          for (j = i; j <= n && j <= i + 5; j++) {
            if (body[j] ~ /study_guide_answers/) { countline = i; break }
          }
        }
        if (countline) break
      }

      if (countline) {
        inspected++
        definer = 0
        for (i = 1; i <= n; i++) if (body[i] ~ /SECURITY[[:space:]]+DEFINER/) definer = 1

        lock = 0
        for (i = 1; i < countline; i++) if (body[i] ~ /FOR[[:space:]]+UPDATE/) lock = 1

        if (!definer)
          printf "V:%s: %s counts study_guide_answers but is not SECURITY DEFINER\n", file, fname
        if (!lock)
          printf "V:%s: %s counts study_guide_answers without FOR UPDATE before the count\n", file, fname
      }
      reset()
    }

    # Report how many guards were actually inspected, not just how many files
    # were scanned. A function silently skipped — which is exactly what a
    # mis-anchored start rule caused — is invisible in a file count.
    END { printf "N:%d\n", inspected + 0 }
  '
)

violations=$(printf '%s\n' "$report" | sed -n 's/^V://p')
inspected=$(printf '%s\n' "$report" | sed -n 's/^N://p' | tail -1)

if [ -n "$violations" ]; then
  echo "Submissions-guard invariants violated:" >&2
  printf '%s\n' "$violations" | while IFS= read -r line; do
    echo "::error::$line" >&2
  done
  echo >&2
  echo "A guard that counts study_guide_answers must be SECURITY DEFINER (so the" >&2
  echo "count is not RLS-scoped while the write it guards is not) and must take" >&2
  echo "FOR UPDATE on the row the answer INSERT locks via its FK BEFORE counting" >&2
  echo "(so a concurrent submission cannot slip between the count and the delete)." >&2
  echo "See the header of scripts/check-guard-functions.sh." >&2
  exit 1
fi

# Zero inspected is a FAILURE, not a pass. Reporting the count was not enough on
# its own: a parser regression that skips every function would still exit 0 and
# print a cheerful "0 guard function(s)", which is precisely the silent-pass this
# script exists to prevent — and precisely how its first three bugs presented.
#
# This repo has guard functions. If that ever stops being true, delete the CI
# step rather than letting it pass vacuously.
if [ "${inspected:-0}" -eq 0 ]; then
  echo "::error::inspected 0 guard functions in ${MIG_DIR} — the parser is broken or the path is wrong." >&2
  echo >&2
  echo "This is a failure, not a pass: a check that examines nothing must not report" >&2
  echo "success. If this project genuinely has no submissions-guard functions any" >&2
  echo "more, remove this step from CI instead." >&2
  exit 1
fi

echo "OK: submissions-guard invariants hold across ${inspected} guard function(s)."
