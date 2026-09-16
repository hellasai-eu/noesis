#!/usr/bin/env python3
"""CI gate over `npm audit`: fail on high/critical advisories, except an
explicit, documented allowlist.

Runs from the lockfile alone (no node_modules needed). The allowlist exists
because "fail on high" is only a usable gate if a known-accepted finding can
be waived in one reviewed place instead of by weakening the gate itself; every
entry must carry a reason and should name the upgrade that retires it.

Exit codes: 0 clean (or only allowlisted/low/moderate), 1 blocking advisories,
2 npm audit itself failed.
"""
from __future__ import annotations

import json
import subprocess
import sys

# GHSA id -> reason. Keep entries short-lived; each names the change that
# removes it.
ALLOWLIST: dict[str, str] = {
    # Vite dev-server-only issue: `server.fs.deny` bypass via Windows
    # alternate paths. The dev server never runs in production (Vercel serves
    # the static dist/), and no Windows dev machines are in use. The fix is
    # the Vite 8 major upgrade — remove this entry when that lands.
    "GHSA-fx2h-pf6j-xcff": "vite dev-server-only, Windows-only; retired by the Vite 8 upgrade",
}

BLOCKING = {"high", "critical"}


def main() -> int:
    proc = subprocess.run(
        ["npm", "audit", "--json"], capture_output=True, text=True
    )
    # npm audit exits 1 when vulnerabilities exist — only treat missing/broken
    # JSON as an infrastructure failure.
    try:
        report = json.loads(proc.stdout)
    except json.JSONDecodeError:
        print("npm audit produced no JSON report:", file=sys.stderr)
        sys.stderr.write(proc.stderr)
        return 2

    blocking: list[str] = []
    waived: list[str] = []
    for name, vuln in sorted(report.get("vulnerabilities", {}).items()):
        if vuln.get("severity") not in BLOCKING:
            continue
        # `via` mixes advisory dicts (this package's own advisories) with
        # strings (names of vulnerable dependencies it inherits from). The
        # inherited ones are gated at their own package's entry, and a
        # package flagged high can still carry moderate advisories of its
        # own — gate each advisory on its own severity.
        for via in vuln.get("via", []):
            if not isinstance(via, dict) or via.get("severity") not in BLOCKING:
                continue
            ghsa = (via.get("url") or "").rsplit("/", 1)[-1]
            line = f"{via.get('severity')}: {name} — {via.get('title')} ({via.get('url')})"
            if ghsa in ALLOWLIST:
                waived.append(f"{line}\n    waived: {ALLOWLIST[ghsa]}")
            else:
                blocking.append(line)

    for entry in waived:
        print(f"ALLOWLISTED {entry}")
    if blocking:
        print(f"\n{len(blocking)} blocking advisor{'y' if len(blocking) == 1 else 'ies'}:")
        for entry in blocking:
            print(f"  {entry}")
        print(
            "\nFix with `npm audit fix` (or a scoped `npm update`), or — for a "
            "reviewed, temporary exception — add the GHSA id to ALLOWLIST in "
            "scripts/npm_audit_gate.py with a reason.",
        )
        return 1

    totals = report.get("metadata", {}).get("vulnerabilities", {})
    print(f"npm audit gate clean (severity totals: {json.dumps(totals)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
