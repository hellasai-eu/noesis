/**
 * Tests for the special-instructions sanitization used by
 * `cluster-students-by-performance` (#1331 review follow-up).
 *
 * The instructor's free text is the only user-controlled string appended to
 * the clustering LLM prompt, so the server boundary must (a) normalize it
 * (trim + 2000-char cap, non-strings dropped) and (b) redact roster names so
 * the text cannot leak the PII deliberately kept out of the student summaries
 * (issue #557).
 */
import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  MAX_SPECIAL_INSTRUCTIONS_LENGTH,
  normalizeSpecialInstructions,
  redactRosterNames,
} from "../../cluster-students-by-performance/special-instructions.ts";

Deno.test("normalize: non-string inputs become empty", () => {
  assertEquals(normalizeSpecialInstructions(undefined), "");
  assertEquals(normalizeSpecialInstructions(null), "");
  assertEquals(normalizeSpecialInstructions(42), "");
  assertEquals(normalizeSpecialInstructions({ text: "hi" }), "");
});

Deno.test("normalize: trims surrounding whitespace", () => {
  assertEquals(
    normalizeSpecialInstructions("  focus on essays \n"),
    "focus on essays",
  );
});

Deno.test("normalize: caps at the max length", () => {
  const long = "a".repeat(MAX_SPECIAL_INSTRUCTIONS_LENGTH + 500);
  assertEquals(
    normalizeSpecialInstructions(long).length,
    MAX_SPECIAL_INSTRUCTIONS_LENGTH,
  );
});

Deno.test("redact: replaces roster name tokens case-insensitively", () => {
  const out = redactRosterNames(
    "Keep alice PAPADOPOULOS away from Bob",
    ["Alice Papadopoulos", "Bob Smith"],
  );
  assertEquals(out, "Keep [student] [student] away from [student]");
});

Deno.test("redact: folds Greek names case- and accent-insensitively", () => {
  // Greek all-caps drops the tonos (Μαρία → ΜΑΡΙΑ), so matching must ignore
  // diacritics, not just case.
  const out = redactRosterNames(
    "Η ΜΑΡΙΑ χρειάζεται βοήθεια, όπως και η μαρία",
    ["Μαρία Οικονόμου"],
  );
  assertEquals(out, "Η [student] χρειάζεται βοήθεια, όπως και η [student]");
});

Deno.test("redact: accented text matches an unaccented roster token", () => {
  const out = redactRosterNames("pair María with someone strong", ["Maria Lopez"]);
  assertEquals(out, "pair [student] with someone strong");
});

Deno.test("redact: ignores null names; 2-char tokens match exact case only", () => {
  const out = redactRosterNames(
    "An A+ plan for the li group",
    [null, "Al Li"],
  );
  // Lowercase "li" is a common word, not the name "Li" — left alone.
  assertEquals(out, "An A+ plan for the li group");
});

Deno.test("redact: short names like Bo and Li are redacted when cased as names", () => {
  const out = redactRosterNames("pair Li with Bo tomorrow", ["Li Chen", "Bo Xu"]);
  assertEquals(out, "pair [student] with [student] tomorrow");
});

Deno.test("redact: hyphenated names protect their bare components", () => {
  const out = redactRosterNames(
    "ask Jean about the essay, then Jean-Pierre",
    ["Jean-Pierre Dupont"],
  );
  assertEquals(out, "ask [student] about the essay, then [student]");
});

Deno.test("redact: name tokens with regex metacharacters are escaped", () => {
  const out = redactRosterNames("pair with O'Brien(2)", ["O'Brien(2) Kelly"]);
  assertEquals(out, "pair with [student]");
});

Deno.test("redact: matches whole tokens only, not substrings", () => {
  const out = redactRosterNames(
    "annual planning for Ann and Annika",
    ["Ann Smith", "Annika Jones"],
  );
  assertEquals(out, "annual planning for [student] and [student]");
});

Deno.test("redact: empty text passes through", () => {
  assertEquals(redactRosterNames("", ["Alice Papadopoulos"]), "");
});

Deno.test("redact: astral characters before a name do not shift the boundary", () => {
  // An emoji is one code point but two UTF-16 units; the offset map must be
  // per code unit or every later replacement starts one unit late
  // ("😀M[student]" instead of "😀[student]").
  assertEquals(redactRosterNames("😀Maria", ["Maria Lopez"]), "😀[student]");
  assertEquals(
    redactRosterNames("great work 🎉🎉 by Μαρία today", ["Μαρία Παπαδοπούλου"]),
    "great work 🎉🎉 by [student] today",
  );
});
