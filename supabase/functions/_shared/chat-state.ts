/**
 * The conversation state both tutoring surfaces share.
 *
 * Until now each surface returned its own shape. Six concepts carried two names
 * — `assistant_text_draft`/`assistant_text`, `gaps`/`missing`,
 * `response_class`/`judgement` — and only the study tutor kept a cumulative
 * model of the learner; the Socratic side stored a per-turn verdict that was
 * overwritten every turn. Sharing the state core means sharing `mergeState`, so
 * the open-question surface gains a learner model it never had.
 *
 * The shape is `TutorState` from `src/types/tutor-state.ts`, which the frontend
 * has described and `ChatWidget`'s `TutorStatePanel` has rendered all along —
 * while nothing wrote it. This module is what makes that type true.
 *
 * ## Field names are load-bearing
 *
 * `subject`, `current_topic`, `progress_level`, `known`, `gaps` and
 * `misconceptions` keep their exact names because persisted session state
 * already carries them. Renaming for tidiness would break stored rows for
 * nothing.
 */

/** Bump when the persisted shape changes. v1 = the two legacy shapes. */
export const TUTOR_STATE_SCHEMA_VERSION = 2;

export type TutorDecision = "STOP" | "ASK" | "HINT" | "WORKED_STEP";
export type TutorJudgement = "CORRECT" | "PARTIAL" | "INCORRECT";
export type ProgressLevel = "intro" | "developing" | "solid" | "mastered";
export type Difficulty = "easier" | "same" | "harder";

export interface TutorStateCore {
  subject: string;
  current_topic: string;
  goal: string;
  progress_level: ProgressLevel;
  known: string[];
  gaps: string[];
  misconceptions: string[];
  difficulty: Difficulty;
  /** 0–1. Above 0.7 the study tutor raises its reasoning effort. */
  frustration: number;
  /** 0–4, higher being more direct. */
  hint_level: number;
  judgement: TutorJudgement;
  /** The Socratic surface's `stop`: the student may now give a final answer. */
  answer_allowed: boolean;
}

export interface TutorStateMeta {
  response_class?: string;
  confidence?: number;
  grounding_status?: string;
  mode?: string;
}

export interface TutorState {
  decision?: TutorDecision;
  state_update?: TutorStateCore;
  meta?: TutorStateMeta;
}

export const DEFAULT_TUTOR_STATE: TutorStateCore = {
  subject: "",
  current_topic: "",
  goal: "",
  progress_level: "intro",
  known: [],
  gaps: [],
  misconceptions: [],
  difficulty: "same",
  frustration: 0,
  hint_level: 0,
  judgement: "PARTIAL",
  answer_allowed: false,
};

// ── The schema the model is held to ──────────────────────────────────────

const PROGRESS_ORDER: Record<ProgressLevel, number> = {
  intro: 0,
  developing: 1,
  solid: 2,
  mastered: 3,
};

const maxProgress = (a: ProgressLevel, b: ProgressLevel): ProgressLevel =>
  PROGRESS_ORDER[a] >= PROGRESS_ORDER[b] ? a : b;

const union = (a: string[], b: string[]): string[] => Array.from(new Set([...a, ...b]));

const clamp = (v: number, min: number, max: number): number => Math.min(Math.max(v, min), max);

/**
 * Fold a turn's state patch into what persists.
 *
 * Written for the study tutor and correct for both: a student does not become
 * less expert because one answer went badly, so mastery never regresses and
 * `known` only grows. Gaps and misconceptions are the tutor's current reading
 * and replace wholesale.
 */
export function mergeState(prev: TutorStateCore, update: TutorStateCore): TutorStateCore {
  return {
    subject: update.subject || prev.subject,
    current_topic: update.current_topic || prev.current_topic,
    goal: update.goal || prev.goal,

    progress_level: maxProgress(prev.progress_level, update.progress_level),
    known: union(prev.known, update.known),

    gaps: update.gaps,
    misconceptions: update.misconceptions,
    difficulty: update.difficulty,
    frustration: clamp(update.frustration, 0, 1),
    hint_level: clamp(update.hint_level, 0, 4),
    judgement: update.judgement,
    answer_allowed: update.answer_allowed,
  };
}

/**
 * Read whatever a session's stored state happens to be.
 *
 * Three shapes exist in `chat_session_state.current_state`, and none are
 * migrated: the study tutor's flat `SessionState`, the Socratic
 * `{decision, evaluator}` verdict, and this unified one. Rows are read where
 * they are — inferring a learner model from a verdict that never recorded one
 * would invent history.
 */
export function readStoredState(stored: Record<string, unknown> | null): TutorStateCore {
  if (!stored) return { ...DEFAULT_TUTOR_STATE };

  // v2: already unified.
  if (stored.state_update && typeof stored.state_update === "object") {
    return { ...DEFAULT_TUTOR_STATE, ...(stored.state_update as Partial<TutorStateCore>) };
  }

  // v1 study tutor: flat, and its `learning_goal` is this `goal`.
  if ("progress_level" in stored || "learning_goal" in stored) {
    const s = stored as Record<string, unknown>;
    return {
      ...DEFAULT_TUTOR_STATE,
      subject: (s.subject as string) ?? "",
      current_topic: (s.current_topic as string) ?? "",
      goal: (s.learning_goal as string) ?? "",
      progress_level: (s.progress_level as ProgressLevel) ?? "intro",
      known: (s.known as string[]) ?? [],
      gaps: (s.gaps as string[]) ?? [],
      misconceptions: (s.misconceptions as string[]) ?? [],
      difficulty: (s.difficulty as Difficulty) ?? "same",
      frustration: (s.frustration as number) ?? 0,
      // The study tutor's flat shape carries these too. Omitting them here
      // silently reset the effort ladder's inputs on every buffered turn — the
      // row was written with them and read back without, so `hint_level` could
      // never be seen above 0 no matter how deep the hinting had gone.
      //
      // A row written before they existed has neither key, so the `??` falls
      // through to the defaults and the migration behaviour is unchanged: no
      // hinting history reads as untroubled.
      hint_level: (s.hint_level as number) ?? DEFAULT_TUTOR_STATE.hint_level,
      judgement: (s.judgement as TutorJudgement) ?? DEFAULT_TUTOR_STATE.judgement,
    };
  }

  // v1 socratic: `{decision, evaluator}` — a verdict, with no learner model
  // behind it. Only what it actually recorded is carried across.
  const evaluator = (stored.evaluator ?? {}) as Record<string, unknown>;
  return {
    ...DEFAULT_TUTOR_STATE,
    gaps: (evaluator.missing as string[]) ?? [],
    misconceptions: (evaluator.misconceptions as string[]) ?? [],
    answer_allowed: Boolean(evaluator.answer_allowed ?? evaluator.stop),
  };
}

/**
 * The learner state as the tutor prompt states it.
 *
 * Flat, and one field short of `TutorStateCore`: `goal` is `learning_goal`, and
 * `answer_allowed` is absent. That is not tidiness — it is the shape the prompt
 * documents to the model under SESSION STATE SCHEMA, so it is what must be
 * rendered into `{{session_state}}`. Handing the model a state whose field
 * names differ from the schema it was just shown is how a model starts
 * inventing keys.
 *
 * Shared by both tutoring surfaces since they share the prompt.
 */
export interface PromptSessionState {
  subject: string;
  current_topic: string;
  learning_goal: string;
  progress_level: ProgressLevel;
  known: string[];
  gaps: string[];
  misconceptions: string[];
  difficulty: Difficulty;
  frustration: number;
  /** 0–4, higher being more direct. Read by the study tutor's effort ladder. */
  hint_level: number;
  judgement: TutorJudgement;
}

/**
 * Read a persisted row into the flat shape the prompt speaks, whatever shape it
 * was written in.
 *
 * Built on `readStoredState`, so it sniffs all three stored shapes rather than
 * casting. Both surfaces share one session and a student can cross between the
 * buffered and streaming paths mid-session in either direction; a raw cast
 * failed in both directions, which is why this goes through the accessor.
 */
export function promptStateFromStored(
  stored: Record<string, unknown> | null,
): PromptSessionState {
  const core = readStoredState(stored);
  return {
    subject: core.subject,
    current_topic: core.current_topic,
    // `learning_goal` is what the unified core calls `goal`. Every other name
    // matches, which is why they were kept verbatim.
    learning_goal: core.goal,
    progress_level: core.progress_level,
    known: core.known,
    gaps: core.gaps,
    misconceptions: core.misconceptions,
    difficulty: core.difficulty,
    frustration: core.frustration,
    hint_level: core.hint_level,
    judgement: core.judgement,
  };
}

/**
 * The shared half of every subject's output schema.
 *
 * `assistant_text` is first deliberately and must stay first:
 * `StreamingJsonTextExtractor` cannot emit until it is inside that field, so
 * anything ahead of it delays the first token a pupil sees.
 */
export const STATE_CORE_PROPERTIES: Record<string, unknown> = {
  assistant_text: {
    type: "string",
    description: "Markdown-formatted reply to the student.",
  },
  decision: {
    type: "string",
    enum: ["STOP", "ASK", "HINT", "WORKED_STEP"],
    description: "The pedagogical move this reply makes.",
  },
  confidence: {
    type: "number",
    minimum: 0,
    maximum: 1,
    description: "Confidence in the judgement, 0 to 1.",
  },
  state_update: {
    type: "object",
    properties: {
      subject: { type: "string", maxLength: 200 },
      current_topic: { type: "string", maxLength: 200 },
      goal: { type: "string", maxLength: 400 },
      progress_level: { type: "string", enum: ["intro", "developing", "solid", "mastered"] },
      known: { type: "array", items: { type: "string", maxLength: 240 }, maxItems: 50 },
      gaps: { type: "array", items: { type: "string", maxLength: 240 }, maxItems: 50 },
      misconceptions: { type: "array", items: { type: "string", maxLength: 240 }, maxItems: 30 },
      difficulty: { type: "string", enum: ["easier", "same", "harder"] },
      frustration: { type: "number", minimum: 0, maximum: 1 },
      hint_level: { type: "integer", minimum: 0, maximum: 4 },
      judgement: { type: "string", enum: ["CORRECT", "PARTIAL", "INCORRECT"] },
      answer_allowed: { type: "boolean" },
    },
    required: [
      "subject",
      "current_topic",
      "goal",
      "progress_level",
      "known",
      "gaps",
      "misconceptions",
      "difficulty",
      "frustration",
      "hint_level",
      "judgement",
      "answer_allowed",
    ],
    additionalProperties: false,
  },
};

const CORE_REQUIRED = ["assistant_text", "decision", "confidence", "state_update"];

/**
 * Compose a subject's schema from the shared core and its own extension.
 *
 * Extensions rather than one flat schema with optional fields, because
 * `strict: true` requires every property to appear in `required` — "optional"
 * would mean nullable-and-always-emitted, forcing the Socratic model to return
 * `image_prompt: null` every turn and inviting hallucinated values.
 */
export function buildStateSchema(
  extra: Record<string, unknown> = {},
): { name: string; strict: boolean; schema: Record<string, unknown> } {
  return {
    // One name for both surfaces: under the unified contract they emit the same
    // turn, differing only by the extension each adds.
    name: "tutor_turn",
    strict: true,
    schema: {
      type: "object",
      // Core first, so `assistant_text` leads and streaming starts early.
      properties: { ...STATE_CORE_PROPERTIES, ...extra },
      required: [...CORE_REQUIRED, ...Object.keys(extra)],
      additionalProperties: false,
    },
  };
}

/** The model's raw reply, before merging. */
export interface UnifiedResponse {
  assistant_text: string;
  decision: TutorDecision;
  confidence: number;
  state_update: TutorStateCore;
  [extra: string]: unknown;
}
