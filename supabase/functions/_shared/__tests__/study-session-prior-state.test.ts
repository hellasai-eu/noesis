import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { studySessionSubject } from "../chat-subjects/study-session.ts";
import type { TurnContext } from "../chat-turn.ts";

/**
 * What the study tutor is told about the student on the *second* turn.
 *
 * The first streamed turn persists the unified `{decision, state_update, meta}`
 * wrapper. Every turn after it reads that back, and the v1 code path cast it
 * straight to the flat `SessionState` — so the model was handed the wrapper
 * instead of the learner state, and `frustration` was read off an object with
 * no such field, silently pinning reasoning effort to "low" for the rest of
 * every session.
 *
 * Nothing caught it because the existing streaming tests only ever exercise a
 * first turn, where `priorState` is null and the shapes coincide.
 */

const subjectContext = {
  courseTitle: "Physics",
  courseDescription: "",
  institutionName: "",
  topic: "why the sky is blue",
  competencyList: [],
  studentNotes: "",
  instructions: "",
  contentChunks: [{ id: "c1", text: "Rayleigh scattering." }],
};

const ctx = (
  priorState: Record<string, unknown> | null,
  stateVersion: 1 | 2,
) =>
  ({
    priorState,
    stateVersion,
    language: "en",
    history: [],
    isStart: false,
    subjectContext,
  }) as unknown as TurnContext<typeof subjectContext>;

/** What the prompt actually sends as `session_state`. */
const sentState = (req: { inputMessages: Array<{ content: string }> }) =>
  JSON.parse(
    req.inputMessages[0].content.slice(
      req.inputMessages[0].content.indexOf("{"),
      req.inputMessages[0].content.lastIndexOf("}") + 1,
    ),
  );

const V2_ROW = {
  decision: "ASK",
  schema_version: 2,
  meta: { confidence: 0.8 },
  state_update: {
    subject: "physics",
    current_topic: "scattering",
    goal: "explain why the sky is blue",
    progress_level: "solid",
    known: ["light has a spectrum"],
    gaps: ["wavelength dependence"],
    misconceptions: [],
    difficulty: "same",
    frustration: 0.9,
    hint_level: 1,
    judgement: "PARTIAL",
    answer_allowed: false,
  },
};

Deno.test("study v2: the learner state reaches the model, not the wrapper", () => {
  const req = studySessionSubject.buildModelRequest(ctx(V2_ROW, 2));
  const state = sentState(req);

  assertEquals(state.subject, "physics");
  assertEquals(state.known, ["light has a spectrum"]);
  assertEquals(state.progress_level, "solid");
  // The unified core's `goal` under the name this prompt uses.
  assertEquals(state.learning_goal, "explain why the sky is blue");
  // The wrapper's own keys must not leak into what the model is shown.
  assertEquals(state.state_update, undefined);
  assertEquals(state.decision, undefined);
});

/** `V2_ROW` with the ladder's inputs overridden. */
const stuck = (over: Record<string, unknown>) => ({
  ...V2_ROW,
  state_update: { ...V2_ROW.state_update, ...over },
});

Deno.test("study v2: a stuck student still escalates reasoning effort", () => {
  // The regression this has always guarded: state read off the *wrapper* rather
  // than out of it is undefined, every comparison against undefined is false,
  // and the ladder silently stays "low" for the rest of the session. The
  // signals changed; the way that bug hides has not.
  const req = studySessionSubject.buildModelRequest(
    ctx(stuck({ judgement: "INCORRECT", hint_level: 2 }), 2),
  );
  assertEquals(req.reasoningEffort, "medium");
});

Deno.test("study v2: an untroubled student stays on the fast path", () => {
  const req = studySessionSubject.buildModelRequest(
    ctx(stuck({ judgement: "CORRECT", hint_level: 0, misconceptions: [] }), 2),
  );
  assertEquals(req.reasoningEffort, "low");
});

// ── The ladder's three clauses, one test each ──────────────────────────────

Deno.test("ladder: deep hinting escalates on its own", () => {
  // At 3 the next question is nearly the answer; getting it wrong wastes the
  // exchange. No wrong answer is needed for this one.
  const req = studySessionSubject.buildModelRequest(
    ctx(stuck({ hint_level: 3, judgement: "PARTIAL" }), 2),
  );
  assertEquals(req.reasoningEffort, "medium");
});

Deno.test("ladder: a wrong answer after a hint escalates", () => {
  const req = studySessionSubject.buildModelRequest(
    ctx(stuck({ hint_level: 1, judgement: "INCORRECT", misconceptions: [] }), 2),
  );
  assertEquals(req.reasoningEffort, "medium");
});

Deno.test("ladder: a wrong answer against a named misconception escalates", () => {
  const req = studySessionSubject.buildModelRequest(
    ctx(
      stuck({
        hint_level: 0,
        judgement: "INCORRECT",
        misconceptions: ["thinks the sky reflects the sea"],
      }),
      2,
    ),
  );
  assertEquals(req.reasoningEffort, "medium");
});

// ── And what deliberately does not ─────────────────────────────────────────

Deno.test("ladder: one wrong answer with no hint given is ordinary teaching", () => {
  const req = studySessionSubject.buildModelRequest(
    ctx(stuck({ hint_level: 0, judgement: "INCORRECT", misconceptions: [] }), 2),
  );
  assertEquals(req.reasoningEffort, "low");
});

Deno.test("ladder: a standing misconception alone does not escalate", () => {
  // The tutor lists these routinely, often for a pupil answering perfectly
  // well. Firing on it would pin most sessions to medium, which is the cost
  // and latency the fast tier exists to avoid.
  const req = studySessionSubject.buildModelRequest(
    ctx(
      stuck({
        hint_level: 0,
        judgement: "CORRECT",
        misconceptions: ["thinks the sky reflects the sea"],
      }),
      2,
    ),
  );
  assertEquals(req.reasoningEffort, "low");
});

Deno.test("v1 round-trip: the ladder's signals survive being written and read", () => {
  // The whole point of carrying `hint_level` and `judgement` on the flat shape.
  // They were persisted but not read back, so every buffered turn started from
  // 0/PARTIAL and the ladder could never see hinting it had itself recorded —
  // escalation was unreachable on that surface no matter how stuck the pupil.
  const writtenByV1 = {
    subject: "physics",
    current_topic: "scattering",
    learning_goal: "explain why the sky is blue",
    progress_level: "developing",
    known: [],
    gaps: ["wavelength"],
    misconceptions: [],
    difficulty: "same",
    frustration: 0.2,
    hint_level: 2,
    judgement: "INCORRECT",
  };

  for (const version of [1, 2] as const) {
    const req = studySessionSubject.buildModelRequest(ctx(writtenByV1, version));
    const state = sentState(req);
    assertEquals(state.hint_level, 2, `hint_level lost on v${version}`);
    assertEquals(state.judgement, "INCORRECT", `judgement lost on v${version}`);
    assertEquals(req.reasoningEffort, "medium", `ladder did not fire on v${version}`);
  }
});

Deno.test("ladder: frustration no longer escalates on its own", () => {
  // The trigger this replaced. It is the model's read of a mood, and nothing in
  // the lesson has to have gone wrong for it to reach 1.0.
  const req = studySessionSubject.buildModelRequest(
    ctx(stuck({ frustration: 1, hint_level: 0, judgement: "CORRECT", misconceptions: [] }), 2),
  );
  assertEquals(req.reasoningEffort, "low");
});

Deno.test("study v2: a session that started on /chat keeps its learner model", () => {
  // A v1 row, read on a streaming turn. This is the migration story: rows are
  // never rewritten, so the flat shape must still be understood here.
  const v1Row = {
    subject: "history",
    current_topic: "restoration",
    learning_goal: "explain the restoration",
    progress_level: "developing",
    known: ["dates"],
    gaps: ["causes"],
    misconceptions: [],
    difficulty: "same",
    frustration: 0.8,
    image_enabled: false,
  };
  const req = studySessionSubject.buildModelRequest(ctx(v1Row, 2));
  const state = sentState(req);

  assertEquals(state.subject, "history");
  assertEquals(state.known, ["dates"]);
  assertEquals(state.learning_goal, "explain the restoration");

  // A row written before the ladder changed carries no `hint_level` or
  // `judgement`, so it defaults to 0/PARTIAL and reads as untroubled — even at
  // frustration 0.8, which used to be the whole trigger. That is the intended
  // migration: no evidence of being stuck is not evidence of being stuck, and
  // the first turn to produce any corrects it.
  assertEquals(req.reasoningEffort, "low");
});

Deno.test("study v1: /chat survives a row the streaming surface wrote", () => {
  // The other direction, and the worse one. Both surfaces share a session and
  // the panel offers "Try new chat", so a student can come back. `mergeState`
  // spreads `prev.known`, which on a wrapper is undefined — this threw
  // `TypeError: a is not iterable` and failed the turn outright, rather than
  // merely losing state.
  const req = studySessionSubject.buildModelRequest(ctx(V2_ROW, 1));
  const state = sentState(req);

  assertEquals(state.subject, "physics");
  assertEquals(state.known, ["light has a spectrum"]);
  assertEquals(state.state_update, undefined);
});

Deno.test("study v1: reducing against a v2 row keeps the learner model", () => {
  const patch = {
    subject: "physics",
    current_topic: "scattering",
    learning_goal: "explain why the sky is blue",
    progress_level: "intro" as const,
    known: ["shorter wavelengths scatter more"],
    gaps: [],
    misconceptions: [],
    difficulty: "same" as const,
    frustration: 0.2,
  };
  const out = studySessionSubject.reduceState(
    ctx(V2_ROW, 1),
    { state_patch: patch } as never,
  );
  const next = out.next as unknown as { known: string[]; progress_level: string };

  // What the streaming surface learned is still there, unioned with this turn.
  assertEquals(next.known.sort(), ["light has a spectrum", "shorter wavelengths scatter more"]);
  // And mastery from the v2 row is not undone by this turn's lower reading.
  assertEquals(next.progress_level, "solid");
});

Deno.test("study v1: reading back its own rows is unchanged", () => {
  const v1Row = {
    subject: "biology",
    current_topic: "mitosis",
    learning_goal: "name the phases",
    progress_level: "intro",
    known: [],
    gaps: ["anaphase"],
    misconceptions: [],
    difficulty: "same",
    frustration: 0.9,
    image_enabled: false,
  };
  const req = studySessionSubject.buildModelRequest(ctx(v1Row, 1));
  const state = sentState(req);

  assertEquals(state.subject, "biology");
  assertEquals(state.gaps, ["anaphase"]);
  // Same migration rule as above: a legacy row has no hinting history.
  assertEquals(req.reasoningEffort, "low");
});

Deno.test("study: a first turn has no prior state on either version", () => {
  for (const version of [1, 2] as const) {
    const req = studySessionSubject.buildModelRequest(ctx(null, version));
    const state = sentState(req);

    assertEquals(state.progress_level, "intro", `version ${version}`);
    assertEquals(state.known, [], `version ${version}`);
    assertEquals(req.reasoningEffort, "low", `version ${version}`);
  }
});
