import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  DEFAULT_TUTOR_STATE,
  TUTOR_STATE_SCHEMA_VERSION,
  buildStateSchema,
  mergeState,
  readStoredState,
  type TutorStateCore,
} from "../chat-state.ts";
import { reduceUnifiedState } from "../chat-turn.ts";

/**
 * The unified conversation state.
 *
 * Two things are being pinned: the merge rules, which decide what a tutor
 * believes about a student over time, and the reader, which has to make sense
 * of three shapes that exist in `chat_session_state.current_state` and are
 * deliberately never migrated.
 */

const base = (over: Partial<TutorStateCore> = {}): TutorStateCore => ({
  ...DEFAULT_TUTOR_STATE,
  ...over,
});

// ── Merge rules ────────────────────────────────────────────────────────

Deno.test("mergeState: mastery never regresses", () => {
  // A student does not become less expert because one answer went badly.
  const merged = mergeState(
    base({ progress_level: "solid" }),
    base({ progress_level: "intro" }),
  );
  assertEquals(merged.progress_level, "solid");
});

Deno.test("mergeState: mastery still advances", () => {
  const merged = mergeState(
    base({ progress_level: "developing" }),
    base({ progress_level: "mastered" }),
  );
  assertEquals(merged.progress_level, "mastered");
});

Deno.test("mergeState: known accumulates and de-duplicates", () => {
  const merged = mergeState(
    base({ known: ["a", "b"] }),
    base({ known: ["b", "c"] }),
  );
  assertEquals(merged.known.sort(), ["a", "b", "c"]);
});

Deno.test("mergeState: gaps and misconceptions replace rather than accumulate", () => {
  // These are the tutor's current reading, not a growing record — a gap the
  // student has closed must be able to disappear.
  const merged = mergeState(
    base({ gaps: ["old"], misconceptions: ["stale"] }),
    base({ gaps: ["new"], misconceptions: [] }),
  );
  assertEquals(merged.gaps, ["new"]);
  assertEquals(merged.misconceptions, []);
});

Deno.test("mergeState: frustration and hint level are clamped to their ranges", () => {
  const merged = mergeState(base(), base({ frustration: 5, hint_level: 99 }));
  assertEquals(merged.frustration, 1);
  assertEquals(merged.hint_level, 4);

  const low = mergeState(base(), base({ frustration: -2, hint_level: -1 }));
  assertEquals(low.frustration, 0);
  assertEquals(low.hint_level, 0);
});

Deno.test("mergeState: an empty patch string keeps what was already known", () => {
  const merged = mergeState(base({ subject: "physics" }), base({ subject: "" }));
  assertEquals(merged.subject, "physics");
});

// ── Reading the three shapes that exist ────────────────────────────────

Deno.test("readStoredState: a v2 row round-trips", () => {
  const stored = { decision: "ASK", state_update: base({ known: ["x"], progress_level: "solid" }) };
  const read = readStoredState(stored as unknown as Record<string, unknown>);
  assertEquals(read.known, ["x"]);
  assertEquals(read.progress_level, "solid");
});

Deno.test("readStoredState: a v1 study row keeps its learner model", () => {
  // The study tutor's flat shape, including `learning_goal` which the unified
  // core calls `goal`.
  const stored = {
    subject: "history",
    current_topic: "restoration",
    learning_goal: "explain the restoration",
    progress_level: "developing",
    known: ["dates"],
    gaps: ["causes"],
    misconceptions: ["it was bloodless"],
    difficulty: "same",
    frustration: 0.4,
    image_enabled: false,
  };
  const read = readStoredState(stored);

  assertEquals(read.subject, "history");
  assertEquals(read.goal, "explain the restoration");
  assertEquals(read.progress_level, "developing");
  assertEquals(read.known, ["dates"]);
  assertEquals(read.misconceptions, ["it was bloodless"]);
  assertEquals(read.frustration, 0.4);
});

Deno.test("readStoredState: a v1 socratic row carries only what it recorded", () => {
  // `{decision, evaluator}` held a verdict and no learner model. Anything more
  // would be invented history, so the rest stays at defaults.
  const stored = {
    decision: "ASK",
    evaluator: {
      judgement: "PARTIAL",
      stop: false,
      missing: ["the mechanism"],
      misconceptions: ["scattering is reflection"],
      answer_allowed: false,
    },
  };
  const read = readStoredState(stored);

  assertEquals(read.gaps, ["the mechanism"]);
  assertEquals(read.misconceptions, ["scattering is reflection"]);
  assertEquals(read.answer_allowed, false);
  // Never recorded, so never guessed.
  assertEquals(read.known, []);
  assertEquals(read.progress_level, "intro");
});

Deno.test("readStoredState: no state at all is the default", () => {
  assertEquals(readStoredState(null), { ...DEFAULT_TUTOR_STATE });
});

// ── Schema composition ─────────────────────────────────────────────────

Deno.test("buildStateSchema: the text field leads, so streaming starts early", () => {
  // `StreamingJsonTextExtractor` cannot emit until it is inside this field, so
  // anything ahead of it delays the first token a pupil sees.
  const schema = buildStateSchema({ reason: { type: "string" } });
  const props = Object.keys(schema.schema.properties as Record<string, unknown>);
  assertEquals(props[0], "assistant_text");
});

Deno.test("buildStateSchema: every property is required, as strict mode demands", () => {
  const extra = { grounding_status: { type: "string" }, evidence: { type: "string" } };
  const schema = buildStateSchema(extra);
  const props = Object.keys(schema.schema.properties as Record<string, unknown>).sort();
  const required = (schema.schema.required as string[]).sort();

  assertEquals(schema.strict, true);
  // `strict: true` rejects a schema whose properties and required disagree,
  // which is why extensions exist instead of optional fields.
  assertEquals(required, props);
  assertEquals(schema.schema.additionalProperties, false);
});

Deno.test("buildStateSchema: a subject's extension does not disturb the core", () => {
  const plain = buildStateSchema();
  const extended = buildStateSchema({ reason: { type: "string" } });

  const coreKeys = Object.keys(plain.schema.properties as Record<string, unknown>);
  const extendedKeys = Object.keys(extended.schema.properties as Record<string, unknown>);

  assertEquals(extendedKeys.slice(0, coreKeys.length), coreKeys);
  assertEquals(extendedKeys.includes("reason"), true);
});

// ── The reducer both surfaces now share ────────────────────────────────

const ctxWith = (priorState: unknown) =>
  ({ priorState } as unknown as Parameters<typeof reduceUnifiedState>[0]);

const reply = (state: Partial<TutorStateCore>) => ({
  assistant_text: "…",
  decision: "ASK" as const,
  confidence: 0.7,
  state_update: state as TutorStateCore,
});

Deno.test("reduceUnifiedState: writes v2 and merges against the prior state", () => {
  const prior = { state_update: base({ known: ["a"], progress_level: "solid" }) };
  const out = reduceUnifiedState(ctxWith(prior), reply({ known: ["b"], progress_level: "intro" }));

  const next = out.next as unknown as { state_update: TutorStateCore; schema_version: number };
  assertEquals(next.schema_version, TUTOR_STATE_SCHEMA_VERSION);
  assertEquals(next.state_update.known.sort(), ["a", "b"]);
  // The merge rules apply, so a bad turn does not undo demonstrated mastery.
  assertEquals(next.state_update.progress_level, "solid");
});

Deno.test("reduceUnifiedState: a v1 study row is merged, not discarded", () => {
  // The whole point of reading legacy shapes: a session that started on /chat
  // and continued on the streaming surface must keep its learner model.
  const prior = {
    subject: "history",
    learning_goal: "explain the restoration",
    progress_level: "solid",
    known: ["dates"],
    gaps: ["causes"],
    misconceptions: [],
    frustration: 0.2,
  };
  const out = reduceUnifiedState(
    ctxWith(prior),
    reply({ known: ["actors"], progress_level: "developing" }),
  );

  const next = out.next as unknown as { state_update: TutorStateCore };
  assertEquals(next.state_update.known.sort(), ["actors", "dates"]);
  assertEquals(next.state_update.subject, "history");
  assertEquals(next.state_update.goal, "explain the restoration");
  assertEquals(next.state_update.progress_level, "solid");
});

Deno.test("reduceUnifiedState: a v1 socratic row gains a learner model", () => {
  // Socratic stored only the last verdict, so this is the first turn where its
  // `known` can carry forward at all.
  const prior = {
    decision: "ASK",
    evaluator: {
      judgement: "INCORRECT",
      missing: ["the mechanism"],
      misconceptions: ["it reflects"],
    },
  };
  const out = reduceUnifiedState(
    ctxWith(prior),
    reply({
      known: ["scattering depends on wavelength"],
      gaps: [],
      misconceptions: [],
      judgement: "CORRECT",
    }),
  );

  const next = out.next as unknown as { state_update: TutorStateCore };
  assertEquals(next.state_update.known, ["scattering depends on wavelength"]);
  // Corrected, so both are dropped — these fields replace rather than accumulate.
  assertEquals(next.state_update.gaps, []);
  assertEquals(next.state_update.misconceptions, []);
  assertEquals(next.state_update.judgement, "CORRECT");
});

Deno.test("reduceUnifiedState: both surfaces produce the same shape", () => {
  // Same prior, same reply, one reducer — the unification, asserted.
  const studyLike = reduceUnifiedState(
    ctxWith(null),
    { ...reply({ known: ["x"] }), grounding_status: "GROUNDED" } as never,
  );
  const socraticLike = reduceUnifiedState(
    ctxWith(null),
    { ...reply({ known: ["x"] }), reason: "partial" } as never,
  );

  const keys = (r: typeof studyLike) => Object.keys(r.next as Record<string, unknown>).sort();
  assertEquals(keys(studyLike), keys(socraticLike));
  assertEquals(
    (studyLike.next as unknown as { state_update: TutorStateCore }).state_update,
    (socraticLike.next as unknown as { state_update: TutorStateCore }).state_update,
  );
  // A surface's own field rides in `meta`, not in the state the tutor reasons from.
  assertEquals(
    (studyLike.metadata.meta as { grounding_status?: string }).grounding_status,
    "GROUNDED",
  );
});

Deno.test("reduceUnifiedState: the metadata is the shape the panel renders", () => {
  // `TutorStatePanel` reads {decision, state_update, meta}. It has rendered that
  // shape since #1241 against a producer that did not exist; this is it.
  const out = reduceUnifiedState(ctxWith(null), reply({ hint_level: 2, judgement: "PARTIAL" }));
  const state = out.metadata.state as {
    decision: string;
    state_update: TutorStateCore;
    meta: unknown;
  };

  assertEquals(state.decision, "ASK");
  assertEquals(state.state_update.hint_level, 2);
  assertEquals(out.llmDecision, "ASK");
  assertEquals(out.llmJudgement, "PARTIAL");
  assertEquals(out.llmConfidence, 0.7);
});
