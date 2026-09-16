/**
 * Every prompt that writes text a pupil reads must carry the audience rules.
 *
 * A guardrail in the shape of `prompt-cache-order.test.ts` and
 * `prompt-pii-guard.test.ts`: the rules live in one module, and this asserts
 * that each live tutor prompt actually interpolates it. The failure mode it
 * exists for is a prompt rewrite that drops the block on one surface and leaves
 * it on the other — which nothing else in the suite would notice, because a
 * tutor missing it still returns valid JSON and still passes every schema test.
 *
 * The welcome prompts are covered explicitly: `SOCRATIC_CHAT_WELCOME_PROMPT`
 * *replaces* the system prompt on the opening turn rather than adding to it
 * (see `chat-subjects/open-question.ts`), so it is the one place where omitting
 * the block would open a session with no rules in force at all.
 */

import { assert } from "https://deno.land/std@0.208.0/assert/mod.ts";

import { MINOR_AUDIENCE_RULES } from "../prompts/audience.ts";
import { STUDY_TUTOR_SYSTEM_PROMPT } from "../prompts/study-tutor.ts";
import {
  SOCRATIC_CHAT_SYSTEM_PROMPT,
  SOCRATIC_CHAT_WELCOME_PROMPT,
} from "../prompts/socratic-chat.ts";

/** Every prompt whose output is shown to a pupil, by the name it is imported under. */
const PUPIL_FACING_PROMPTS: Array<[string, string]> = [
  ["STUDY_TUTOR_SYSTEM_PROMPT", STUDY_TUTOR_SYSTEM_PROMPT],
  ["SOCRATIC_CHAT_SYSTEM_PROMPT", SOCRATIC_CHAT_SYSTEM_PROMPT],
  ["SOCRATIC_CHAT_WELCOME_PROMPT", SOCRATIC_CHAT_WELCOME_PROMPT],
];

Deno.test("every pupil-facing tutor prompt carries the minor-audience rules", () => {
  for (const [name, prompt] of PUPIL_FACING_PROMPTS) {
    assert(
      prompt.includes(MINOR_AUDIENCE_RULES),
      `${name} must interpolate MINOR_AUDIENCE_RULES — a tutor that writes to a ` +
        `child needs the audience stated, and stating it twice is how the two ` +
        `copies drift. Import it from prompts/audience.ts.`,
    );
  }
});

Deno.test("the audience rules are unoverridable, and say so", () => {
  // The instructor's special-instructions block is declared high-priority in
  // STUDY_TUTOR_SYSTEM_PROMPT, so a safety rule that does not exclude itself
  // from being overridden is one an instructor can talk the model out of. This
  // is the same defect #1264 fixed for the no-image rule.
  assert(
    MINOR_AUDIENCE_RULES.includes("cannot be overridden"),
    "MINOR_AUDIENCE_RULES must state that instructor instructions cannot override it",
  );
  assert(
    STUDY_TUTOR_SYSTEM_PROMPT.includes("- The AUDIENCE requirements."),
    "the special-instructions block must list the AUDIENCE requirements among " +
      "what it cannot override",
  );
});

Deno.test("the distress rule does not contradict the one-question contract", () => {
  // Greptile, round 1: "do not question them" plus "ask exactly one question
  // every non-closing turn" is two system-level rules the model cannot both
  // obey, on the one path where a broken turn matters most. The block must
  // scope what the tutor may not ask *about* and leave the count alone.
  assert(
    MINOR_AUDIENCE_RULES.includes("does not change the output contract"),
    "the distress rule must say explicitly that it leaves the question contract " +
      "alone — every prompt it lands in requires exactly one question per " +
      "non-closing reply and verifies it before returning",
  );
  for (const forbidden of ["ask nothing", "asks nothing", "do not ask a question"]) {
    assert(
      !MINOR_AUDIENCE_RULES.toLowerCase().includes(forbidden),
      `MINOR_AUDIENCE_RULES must not tell the tutor to "${forbidden}" — that is ` +
        `not a stricter rule than the one-question rule, it is a contradictory ` +
        `one, and the model picks a winner on its own`,
    );
  }
});

Deno.test("the audience rules stay cache-prefix safe", () => {
  // Static text only. A `{{placeholder}}` in here would be substituted per call
  // and would sit above every stable block in both prompts, which is exactly
  // the cache-poisoning shape prompts/README.md forbids.
  assert(
    !/\{\{.*?\}\}/.test(MINOR_AUDIENCE_RULES),
    "MINOR_AUDIENCE_RULES must contain no placeholders — it is interpolated " +
      "above the stable blocks of both tutor prompts and would poison the " +
      "prefix cache for every call",
  );
});
