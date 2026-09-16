/**
 * Normalization + PII redaction for the instructor's free-text clustering
 * instructions. Student names are deliberately kept out of the LLM prompt
 * (issue #557), so free text that mentions roster names must be redacted
 * before it is appended to the OpenAI user message.
 *
 * The redaction itself lives in `_shared/redact-names.ts` so the targeted-
 * student audience hint can apply the same guard; re-exported here to keep
 * this module the single import point for this function's sanitization.
 */

export { redactRosterNames } from "../_shared/redact-names.ts";

export const MAX_SPECIAL_INSTRUCTIONS_LENGTH = 2000;

/** Trim and cap the raw instructor text; anything non-string becomes "". */
export function normalizeSpecialInstructions(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.trim().slice(0, MAX_SPECIAL_INSTRUCTIONS_LENGTH);
}
