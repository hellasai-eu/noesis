/**
 * Unified TutorState Types
 *
 * Single source of truth for tutor state types used across frontend and backend.
 * Schema versioning enables safe migrations of state structure.
 */

// =============================================================================
// Schema Version
// =============================================================================

/**
 * Current schema version for tutor state. Increment when state structure changes.
 *
 * v2 is the unified contract that both tutoring surfaces emit. Kept in step with
 * `supabase/functions/_shared/chat-state.ts`, which is the producing end.
 */
export const TUTOR_STATE_SCHEMA_VERSION = 2;

// =============================================================================
// Type Unions
// =============================================================================

/** Tutor decision type - determines what action the tutor takes */
export type TutorDecision = "STOP" | "ASK" | "HINT" | "WORKED_STEP";

/** Every valid decision, for validating what the model sends back. */
export const TUTOR_DECISIONS: readonly TutorDecision[] = [
  "STOP",
  "ASK",
  "HINT",
  "WORKED_STEP",
];

/**
 * Narrow a model-supplied decision, falling back to `ASK`.
 *
 * The value arrives in the tutor response's metadata, so it is whatever the
 * model wrote. Call sites used to cast it straight into the union — a claim the
 * compiler happened not to be checking, so an unrecognised decision would flow
 * into the UI as though it were valid. `ASK` is the safe default: it keeps the
 * tutor asking rather than silently ending the exchange.
 */
export function toTutorDecision(value: unknown): TutorDecision {
  return TUTOR_DECISIONS.includes(value as TutorDecision)
    ? (value as TutorDecision)
    : "ASK";
}

/** Judgement of student's response correctness */
export type TutorJudgement = "CORRECT" | "PARTIAL" | "INCORRECT";

/** Tutor response mode */
export type TutorMode = "closure" | "question" | "nudge" | "strong_hint" | "worked_step";

/** Response classification */
export type TutorResponseClass = "ON_TRACK" | "PARTIAL" | "IRRELEVANT" | "OFF_TASK";

/** How far the student has got with the current topic. Never lowered. */
export type TutorProgressLevel = "intro" | "developing" | "solid" | "mastered";

/** Where the next turn should sit relative to this one. */
export type TutorDifficulty = "easier" | "same" | "harder";

// =============================================================================
// Competency Assessment
// =============================================================================

/** Evidence for a competency score */
export interface CompetencyScoreEvidence {
  /** Score from 0-4 */
  score: number;
  /** Evidence items supporting the score (max 3) */
  evidence: string[];
}

/** Competency assessment map */
export type CompetencyAssessment = Record<string, CompetencyScoreEvidence>;

// =============================================================================
// Core State Types
// =============================================================================

/**
 * Core tutor state data — the student's learning state.
 *
 * This mirrors `TutorStateCore` in `supabase/functions/_shared/chat-state.ts`,
 * which is what actually writes it. Fields are optional here because a stored
 * row may predate the unified schema; the backend fills every one.
 *
 * Four fields were removed when the two surfaces unified: `plan`, `step_index`,
 * `competencies` and `stop_reason`. No producer ever wrote them and the panel
 * rendered them as "Step: 0/0" on every session. `domain` is gone too — the
 * backend calls the same thing `subject`.
 */
export interface TutorStateCore {
  /** Subject area being studied. */
  subject?: string;
  /** The specific topic within the subject. */
  current_topic?: string;
  /** Current learning goal */
  goal?: string;
  /** How far the student has got. Never lowered. */
  progress_level?: TutorProgressLevel;
  /** What the student knows. Accumulates over the session. */
  known?: string[];
  /** Knowledge gaps identified. Replaced each turn. */
  gaps?: string[];
  /** Misconceptions identified. Replaced each turn. */
  misconceptions?: string[];
  /** Where to pitch the next turn. */
  difficulty?: TutorDifficulty;
  /** Frustration level, 0..1. */
  frustration?: number;
  /** Current hint level (0-4, higher = more direct) */
  hint_level?: 0 | 1 | 2 | 3 | 4;
  /** Judgement of student's latest response */
  judgement?: TutorJudgement;
  /** Whether student is allowed to submit final answer */
  answer_allowed?: boolean;
}

/** Metadata about the tutor's decision process */
export interface TutorStateMeta {
  /** Response mode used */
  mode?: TutorMode;
  /** Classification of student's response */
  response_class?: TutorResponseClass;
  /** Confidence in the response (0-1) */
  confidence?: number;
  /** Competency assessment scores */
  competency_assessment?: CompetencyAssessment;
}

// =============================================================================
// Complete Tutor State
// =============================================================================

/** Complete tutor state including decision, state update, and metadata */
export interface TutorState {
  /** The decision/action taken by the tutor */
  decision?: TutorDecision;
  /** Updates to the student's learning state */
  state_update?: TutorStateCore;
  /** Metadata about the decision */
  meta?: TutorStateMeta;
}

// =============================================================================
// Session State (from database)
// =============================================================================

/** Session state record from the chat_session_state table */
export interface SocraticSessionState {
  id: string;
  user_id: string;
  open_question_id: string;
  course_id: string;
  schema_version: number;
  current_state: TutorState;
  created_at: string;
  updated_at: string;
}

/** State history record from the chat_state_history table */
export interface SocraticStateHistory {
  id: string;
  session_state_id: string;
  state_before: TutorState | null;
  state_after: TutorState;
  trigger_message_id: string | null;
  transition_type: string;
  llm_decision: TutorDecision | null;
  llm_judgement: TutorJudgement | null;
  llm_confidence: number | null;
  created_at: string;
}

// =============================================================================
// Factory Functions
// =============================================================================

/** Create an initial empty tutor state */
export function createInitialTutorState(): TutorState {
  return {
    decision: undefined,
    state_update: {
      subject: undefined,
      current_topic: undefined,
      goal: undefined,
      progress_level: "intro",
      known: [],
      gaps: [],
      misconceptions: [],
      difficulty: "same",
      frustration: 0,
      hint_level: 0,
      judgement: undefined,
      answer_allowed: false,
    },
    meta: {
      mode: undefined,
      response_class: undefined,
      confidence: undefined,
      competency_assessment: undefined,
    },
  };
}

/** Create a state update payload for API calls */
export function createStateUpdate(
  currentState: TutorState | null,
  updates: Partial<TutorStateCore>
): TutorStateCore {
  const current = currentState?.state_update || {};
  return {
    ...current,
    ...updates,
  };
}
