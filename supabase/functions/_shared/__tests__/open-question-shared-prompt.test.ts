import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { openQuestionSubject } from "../chat-subjects/open-question.ts";
import { STUDY_TUTOR_SYSTEM_PROMPT } from "../prompts/study-tutor.ts";
import { placeholdersIn } from "../render.ts";
import type { TurnContext } from "../chat-turn.ts";

/**
 * The open-question surface teaches from the shared tutor prompt on v2.
 *
 * The interesting failures are not "does it render" but "does it render the
 * same prompt": a substitution silently dropped, a section left blank, or the
 * reference answer arriving unlabelled next to the question. Each is invisible
 * in a diff and only shows up as a tutor that behaves subtly differently from
 * the study one — which is the whole thing sharing a prompt was meant to
 * prevent.
 */

const subjectContext = {
  question: "Why does a heavier object not fall faster in a vacuum?",
  modelAnswer: "Gravitational and inertial mass cancel in a = F/m.",
  explanation: "Both scale with m, so acceleration is mass-independent.",
  competencies: "Newtonian mechanics: apply F = ma",
  courseTitle: "Mechanics",
  courseDescription: "Introductory classical mechanics",
  institutionName: "Test School",
};

const ctx = (
  overrides: Partial<{
    stateVersion: 1 | 2;
    isStart: boolean;
    priorState: Record<string, unknown> | null;
    subjectContext: typeof subjectContext;
  }> = {},
) =>
  ({
    priorState: null,
    stateVersion: 2,
    language: "en",
    history: [],
    isStart: false,
    subjectContext,
    ...overrides,
  }) as unknown as TurnContext<typeof subjectContext>;

Deno.test("v2 open questions render the shared tutor prompt, fully substituted", () => {
  const req = openQuestionSubject.buildModelRequest(ctx());

  // Every placeholder resolved. `render` throws on a missing one, so this is
  // really guarding the opposite: a section that rendered to nothing at all.
  assertEquals(placeholdersIn(req.systemPrompt).length, 0);
  assert(!req.systemPrompt.includes("{{"));

  // The prompt's own landmarks, so a future edit that swaps it back to the
  // Socratic text fails here rather than in production.
  assertStringIncludes(req.systemPrompt, "ROLE AND PURPOSE");
  assertStringIncludes(req.systemPrompt, "IMMUTABLE RULES");
  assertStringIncludes(req.systemPrompt, "SESSION STATE SCHEMA");
});

Deno.test("the objective states that the goal is solving the question", () => {
  const req = openQuestionSubject.buildModelRequest(ctx());

  assertStringIncludes(
    req.systemPrompt,
    "The student needs to find the solution to the following question/exercise.",
  );
  assertStringIncludes(req.systemPrompt, "Your job is to help them get there.");
});

Deno.test("the reference answer is supplied, labelled, and fenced by the no-reveal rule", () => {
  const req = openQuestionSubject.buildModelRequest(ctx());

  // Supplied — the tutor cannot grade an answer it has never seen.
  assertStringIncludes(req.systemPrompt, subjectContext.modelAnswer);
  // Labelled, so the answer is distinguishable from the question.
  assertStringIncludes(req.systemPrompt, '"id":"reference_answer"');
  assertStringIncludes(req.systemPrompt, '"id":"question"');
  // And withheld.
  assertStringIncludes(
    req.systemPrompt,
    "without revealing the answer even if the student asks",
  );
  assertStringIncludes(req.systemPrompt, "They must get there independently.");
});

Deno.test("a question with no reference answer omits the chunk rather than sending an empty one", () => {
  const req = openQuestionSubject.buildModelRequest(
    ctx({ subjectContext: { ...subjectContext, modelAnswer: "", explanation: "" } }),
  );

  assert(!req.systemPrompt.includes('"id":"reference_answer"'));
  assert(!req.systemPrompt.includes('"id":"explanation"'));
  assertStringIncludes(req.systemPrompt, '"id":"question"');
});

Deno.test("the absent student-notes section says so instead of being blank", () => {
  const req = openQuestionSubject.buildModelRequest(ctx());

  // A bare heading with nothing under it has historically made the model
  // announce that it has no course material at all.
  assertStringIncludes(req.systemPrompt, "No student notes exist for this surface");
});

Deno.test("the unified contract is appended, with the STOP rule this surface needs", () => {
  const req = openQuestionSubject.buildModelRequest(ctx());

  assertStringIncludes(req.systemPrompt, "## Output contract");
  // `completeOnStop` is true here, so STOP genuinely ends the exchange — and
  // the contract must lift the prompt's one-question rule for that turn, or the
  // model is handed two instructions it cannot both obey.
  assertStringIncludes(req.systemPrompt, "STOP means you are done asking");
  assertStringIncludes(
    req.systemPrompt,
    'this overrides the rule above requiring exactly one question',
  );
});

Deno.test("the session state travels as a user message, after the cached prefix", () => {
  const req = openQuestionSubject.buildModelRequest(ctx());

  // Nothing session-varying in the system prompt is what lets the prefix cache
  // hit from the second turn on.
  assertStringIncludes(req.inputMessages[0].content, "The session state:");
  assertStringIncludes(req.inputMessages[0].content, '"learning_goal"');
  // `answer_allowed` is not part of the shape the prompt documents.
  assert(!req.inputMessages[0].content.includes("answer_allowed"));
});

Deno.test("the opening turn asks the tutor to write first", () => {
  const req = openQuestionSubject.buildModelRequest(ctx({ isStart: true }));

  assertStringIncludes(req.inputMessages[0].content, "This is the opening turn");
  // Same system prompt as every later turn — that identity is the cache.
  assertEquals(
    req.systemPrompt,
    openQuestionSubject.buildModelRequest(ctx({ isStart: false })).systemPrompt,
  );
});

Deno.test("a prior v2 row reaches the model as flat prompt state", () => {
  const req = openQuestionSubject.buildModelRequest(
    ctx({
      priorState: {
        decision: "ASK",
        schema_version: 2,
        state_update: {
          subject: "mechanics",
          current_topic: "free fall",
          goal: "explain mass-independent acceleration",
          progress_level: "developing",
          known: ["F = ma"],
          gaps: ["why m cancels"],
          misconceptions: ["heavier means faster"],
          difficulty: "same",
          frustration: 0.3,
          hint_level: 2,
          judgement: "PARTIAL",
          answer_allowed: false,
        },
      },
    }),
  );

  const state = JSON.parse(
    req.inputMessages[0].content.slice(
      req.inputMessages[0].content.indexOf("{"),
      req.inputMessages[0].content.lastIndexOf("}") + 1,
    ),
  );

  // `goal` arrives under the name the prompt documents, and the learner model
  // survives — the Socratic surface never had one before the unified state.
  assertEquals(state.learning_goal, "explain mass-independent acceleration");
  assertEquals(state.hint_level, 2);
  assertEquals(state.misconceptions, ["heavier means faster"]);
  assertEquals(state.answer_allowed, undefined);
});

Deno.test("v1 keeps the Socratic prompt, whose schema it is actually held to", () => {
  const req = openQuestionSubject.buildModelRequest(ctx({ stateVersion: 1 }));

  assert(!req.systemPrompt.includes("ROLE AND PURPOSE"));
  assert(!req.systemPrompt.includes(STUDY_TUTOR_SYSTEM_PROMPT.slice(0, 40)));
  assertEquals(
    (req.structuredOutput as { name: string }).name,
    "socratic_response",
  );
});
