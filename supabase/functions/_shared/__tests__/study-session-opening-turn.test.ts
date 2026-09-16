import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { studySessionSubject } from "../chat-subjects/study-session.ts";
import type { TurnContext } from "../chat-turn.ts";

/**
 * The turn that opens a study session.
 *
 * The student is shown the instructor's objective and then an empty chat, which
 * asked them to start a conversation about a topic they had only just read.
 * The tutor opens it instead — from that objective, which is already in the
 * system prompt, so the opening turn differs only in its user message.
 *
 * That last part is the reason these assertions are about *where* the text is:
 * a welcome instruction placed in the system prompt would change the cached
 * prefix, so every session would pay full price for its second turn too (see
 * prompts/README.md).
 */

const subjectContext = {
  courseTitle: "History",
  courseDescription: "",
  institutionName: "",
  topic: "how the new Greek state took shape between 1830 and 1881",
  competencyList: [],
  studentNotes: "",
  instructions: "",
  contentChunks: [{ id: "c1", text: "The Kingdom of Greece, 1830-1881." }],
};

const ctx = (isStart: boolean) =>
  ({
    priorState: null,
    stateVersion: 2,
    language: "el",
    history: [],
    isStart,
    subjectContext,
  }) as unknown as TurnContext<typeof subjectContext>;

Deno.test("opening turn: the tutor is asked to speak first", () => {
  const req = studySessionSubject.buildModelRequest(ctx(true));
  const opening = req.inputMessages[0].content;

  assertEquals(req.inputMessages[0].role, "user");
  assertStringIncludes(opening, "opening turn");
  // Nothing to answer, so nothing to judge about the student.
  assertStringIncludes(opening, "no learner message");
});

Deno.test("opening turn: it is built from the objective the instructor wrote", () => {
  const req = studySessionSubject.buildModelRequest(ctx(true));

  // The objective itself stays in the system prompt — sent on every turn, and
  // the reason the opening can be written without repeating it below.
  assertStringIncludes(req.systemPrompt, subjectContext.topic);
  assertStringIncludes(req.inputMessages[0].content, "objective");
});

Deno.test("opening turn: the cached prefix is the one every later turn hits", () => {
  // The whole difference between an opening turn and an ordinary one is the
  // user message. If it were not, the prefix cache would miss on turn two.
  const start = studySessionSubject.buildModelRequest(ctx(true));
  const ordinary = studySessionSubject.buildModelRequest(ctx(false));

  assertEquals(start.systemPrompt, ordinary.systemPrompt);
  assert(
    start.inputMessages[0].content !== ordinary.inputMessages[0].content,
    "the opening turn must ask for something different than an ordinary turn",
  );
});

Deno.test("ordinary turn: no welcome instruction reaches the model", () => {
  // A student mid-session must not be greeted again.
  const req = studySessionSubject.buildModelRequest(ctx(false));
  const sent = req.systemPrompt + req.inputMessages.map((m) => m.content).join("");

  assertEquals(sent.includes("opening turn"), false);
  assertEquals(sent.includes("Greet the student"), false);
});
