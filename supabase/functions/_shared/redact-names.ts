/**
 * Name redaction for text bound for an OpenAI prompt. Student names are
 * deliberately kept out of LLM prompts (issue #557), so any free text that
 * may mention them — instructor clustering instructions, the per-student
 * audience hint — must be redacted before it leaves the institution's data
 * boundary.
 */

/**
 * Decompose to NFD and drop combining marks, keeping a map from each kept
 * code unit back to its code-unit index in the original string.
 * Needed because Greek all-caps drops accents (Μαρία → ΜΑΡΙΑ), so matching
 * must ignore diacritics while replacement happens in the original text.
 *
 * The map is per UTF-16 code unit, not per code point: regex match offsets
 * on `stripped` are code-unit indices, so an astral character (two units,
 * e.g. an emoji) before a name would otherwise shift every later map lookup
 * and leave part of the name unredacted.
 */
function stripMarks(s: string): { stripped: string; map: number[] } {
  const strippedChars: string[] = [];
  const map: number[] = [];
  let origIdx = 0;
  for (const ch of s) {
    for (const d of ch.normalize("NFD")) {
      if (/\p{M}/u.test(d)) continue;
      strippedChars.push(d);
      for (let unit = 0; unit < d.length; unit++) map.push(origIdx);
    }
    origIdx += ch.length;
  }
  return { stripped: strippedChars.join(""), map };
}

/**
 * Replace every roster-name token with "[student]". Matching is
 * diacritic-insensitive so Greek names fold correctly in any casing, and:
 *
 * - tokens of 3+ characters match case-insensitively;
 * - two-character tokens ("Bo", "Li") match exact-case only — a real short
 *   name is still redacted, while common lowercase words survive;
 * - single characters (initials, particles) are skipped;
 * - compound parts are also split on hyphens/apostrophes/dots, so
 *   "Jean-Pierre" protects the bare "Jean" and "Pierre" forms too.
 */
export function redactRosterNames(
  text: string,
  fullNames: Array<string | null>,
): string {
  if (!text) return text;
  const ciTokens = new Set<string>();
  const csTokens = new Set<string>();
  for (const name of fullNames) {
    if (!name) continue;
    for (const part of name.split(/\s+/)) {
      for (const candidate of [part, ...part.split(/[-‐'’.]/)]) {
        if (candidate.length >= 3) ciTokens.add(candidate);
        else if (candidate.length === 2) csTokens.add(candidate);
      }
    }
  }
  if (ciTokens.size === 0 && csTokens.size === 0) return text;

  const { stripped, map } = stripMarks(text);
  // Match ranges in original code-unit index space
  const ranges: Array<[number, number]> = [];
  const entries: Array<[string, boolean]> = [
    ...Array.from(ciTokens, (t): [string, boolean] => [t, true]),
    ...Array.from(csTokens, (t): [string, boolean] => [t, false]),
  ];
  for (const [token, caseInsensitive] of entries) {
    const strippedToken = stripMarks(token).stripped;
    if (!strippedToken) continue;
    const escaped = strippedToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Whole-token matches only, so "Ann" doesn't corrupt "annual". \b is
    // ASCII-only in JS, so use Unicode letter/digit lookarounds instead.
    const re = new RegExp(
      `(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`,
      caseInsensitive ? "giu" : "gu",
    );
    let m: RegExpExecArray | null;
    while ((m = re.exec(stripped)) !== null) {
      const endStripped = m.index + m[0].length;
      const startOrig = map[m.index];
      // map[endStripped] is the next kept char's original index, which sits
      // past any combining marks trailing the match — exactly the cut point.
      const endOrig = endStripped < map.length ? map[endStripped] : text.length;
      ranges.push([startOrig, endOrig]);
    }
  }
  if (ranges.length === 0) return text;

  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }

  let out = "";
  let pos = 0;
  for (const [start, end] of merged) {
    out += text.slice(pos, start) + "[student]";
    pos = end;
  }
  return out + text.slice(pos);
}
