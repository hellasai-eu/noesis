/**
 * The study-session tutor surface, as a `ChatSubject`.
 *
 * Everything here is prompt, context and state-merge policy. The turn itself
 * lives in `../chat-turn.ts` and is shared with the open-question surface.
 */

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { render } from "../render.ts";
import {
  STUDY_TUTOR_SYSTEM_PROMPT,
  STUDY_TUTOR_USER_PROMPT,
  STUDY_TUTOR_WELCOME_PROMPT,
} from "../prompts/study-tutor.ts";
import { TURNS_BEFORE_REVIEW } from "../chat-turn.ts";
import type { Authorization, ChatSubject, ModelRequest, TurnContext, TurnState } from "../chat-turn.ts";
import { buildStateSchema, promptStateFromStored } from "../chat-state.ts";
import type { PromptSessionState } from "../chat-state.ts";
import { resolveStudySessionOffering } from "../resolve-study-session-offering.ts";
import { unifiedOutputContract } from "../prompts/unified-state.ts";

/**
 * The learner state this surface speaks, under its original name.
 *
 * The shape moved to `chat-state.ts` as `PromptSessionState` when the
 * open-question surface adopted the same prompt — it is what the prompt
 * documents to the model, so both surfaces must render the same one. The alias
 * stays because this module's `mergeState` and effort ladder are written
 * against the name.
 *
 * `hint_level` and `judgement` ride this flat shape rather than only the
 * unified core because `adaptiveReasoningEffort` reads them. `USE_STREAMING_CHAT`
 * is documented as a one-line revert, and a ladder wired only to v2 fields would
 * go quietly dead the moment anyone took it — reading 0 and "PARTIAL" forever
 * from a row that never carried them.
 */
export type SessionState = PromptSessionState;

export interface TutorResponse {
  assistant_text_draft: string;
  response_class: "ON_TRACK" | "PARTIAL" | "IRRELEVANT" | "OFF_TASK";
  grounding_status: "GROUNDED" | "NEEDS_MORE_MATERIAL" | "OUT_OF_SCOPE";
  confidence: number;
  state_patch: SessionState;
}

interface StudySessionContext {
  courseTitle: string;
  courseDescription: string;
  institutionName: string;
  topic: string;
  competencyList: string[];
  studentNotes: string;
  instructions: string;
  contentChunks: Array<{ id: string; text: string }>;
}

// `DEFAULT_SESSION_STATE` used to live here, as the fallback when a session had
// no prior state. `sessionStateFromStored` covers that case now — it is the one
// way a stored row becomes a `SessionState`, and it defaults every field — so a
// second default would only be a way to bypass the accessor and reintroduce the
// shape bug it exists to prevent.

const PROGRESS_ORDER: Record<SessionState["progress_level"], number> = {
  intro: 0,
  developing: 1,
  solid: 2,
  mastered: 3,
};

const maxProgress = (
  a: SessionState["progress_level"],
  b: SessionState["progress_level"],
): SessionState["progress_level"] => (PROGRESS_ORDER[a] >= PROGRESS_ORDER[b] ? a : b);

const union = (a: string[], b: string[]): string[] => Array.from(new Set([...a, ...b]));

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

/** Merge the model's patch into the state that persists. */
export function mergeState(prev: SessionState, update: SessionState): SessionState {
  return {
    subject: update.subject || prev.subject,
    current_topic: update.current_topic || prev.current_topic,
    learning_goal: update.learning_goal || prev.learning_goal,

    // Mastery never regresses automatically.
    progress_level: maxProgress(prev.progress_level, update.progress_level),

    known: union(prev.known, update.known),

    // The tutor owns these outright, so they replace rather than merge.
    gaps: update.gaps,
    misconceptions: update.misconceptions,
    difficulty: update.difficulty,
    frustration: clamp(update.frustration, 0, 1),
    hint_level: clamp(update.hint_level, 0, 4),
    judgement: update.judgement,
  };
}

/**
 * How deep the hinting has to get before the turn is worth more thought.
 * At 3 the tutor is close to handing the answer over, which is the point past
 * which a better next question is worth paying for.
 */
const DEEP_HINTING = 3;

/**
 * A struggling student gets more careful reasoning; everyone else gets the
 * fast path, which is enough for an ordinary tutoring turn.
 *
 * ## Why not `frustration`
 *
 * It was the sole trigger, at `> 0.7`, and it is the model's read of a mood.
 * Nothing in the conversation has to have gone wrong for it to rise, and
 * nothing has to have gone right for it to fall — so the ladder fired on the
 * tutor's guess about how a pupil felt rather than on evidence of them being
 * stuck. These three are records of what actually happened in the lesson:
 * `judgement` is the verdict on the last answer, `hint_level` is how much has
 * already been given away, and `misconceptions` is a wrong belief the tutor has
 * named and is working to unpick.
 *
 * ## The clauses
 *
 * Each is a distinct way of being stuck, and any one is enough:
 *
 * 1. Deep hinting on its own. At `hint_level >= 3` the next question is nearly
 *    the answer, and getting it wrong wastes the whole exchange.
 * 2. A wrong answer *after* a hint. One wrong answer is ordinary teaching; a
 *    wrong answer that a hint failed to fix means the approach is not landing.
 * 3. A wrong answer with a named misconception. Correcting a specific wrong
 *    belief is the case where care pays most, and it is the hardest thing the
 *    tutor does.
 *
 * Note what deliberately does *not* escalate: a standing misconception alone.
 * The tutor lists them routinely, often for a pupil who is answering perfectly
 * well, so firing on that would pin most sessions to medium — which is the
 * latency and cost this tier exists to avoid.
 *
 * ## One turn behind, necessarily
 *
 * `state` is the *previous* turn's reading. The message being answered has not
 * been judged yet and cannot be: judging it is the model call this effort
 * setting is being chosen for. So the ladder is predictive, and a pupil who was
 * stuck last turn but has just answered perfectly gets one medium turn they did
 * not need.
 *
 * That is the intended reading rather than a defect to route around. The reply
 * being generated is the one that either confirms a recovery or hints deeper
 * after a failed hint, which is exactly where the extra care earns its keep.
 * The lag is bounded and self-correcting — `judgement` is replaced every turn
 * and `hint_level` is free to fall — so a recovered pupil drops back to the
 * fast path on the turn after. The frustration trigger this replaced had the
 * identical property, for the identical reason.
 */
function adaptiveReasoningEffort(state: SessionState): "low" | "medium" {
  const answeredWrong = state.judgement === "INCORRECT";

  const deepHinting = state.hint_level >= DEEP_HINTING;
  const hintDidNotLand = answeredWrong && state.hint_level > 0;
  const namedMisconception = answeredWrong && state.misconceptions.length > 0;

  return deepHinting || hintDidNotLand || namedMisconception ? "medium" : "low";
}

/**
 * Read a persisted row back into the flat state this surface speaks, whichever
 * shape it was written in.
 *
 * Both surfaces share one session, so a student can move between them
 * mid-session in either direction — by the `USE_STREAMING_CHAT` switch now
 * rather than the "Try new chat" button this originally described, which is the
 * same movement from the stored row's point of view. Neither direction survived
 * a raw cast:
 *
 * - /chat → streaming: the v2 wrapper read as flat state handed the model the
 *   wrapper, and read `frustration` off an object with no such field, silently
 *   pinning reasoning effort to "low" for the rest of the session.
 * - streaming → /chat: worse. `mergeState` spreads `prev.known`, which on a
 *   wrapper is `undefined`, so the buffered turn threw `TypeError: a is not
 *   iterable` and failed outright.
 *
 * So this is not a v2 concern to branch on — it is how a stored row is read,
 * full stop. `readStoredState` sniffs the shape, which is why it can be applied
 * unconditionally without changing what /chat reads back from its own rows.
 *
 * It moved to `chat-state.ts` as `promptStateFromStored` when the open-question
 * surface adopted this prompt: two surfaces rendering the same
 * `{{session_state}}` must read a row the same way, and a second copy here
 * would be the thing that eventually drifted.
 */
const sessionStateFromStored = promptStateFromStored;

const STATE_PATCH_SCHEMA = {
  type: "object",
  properties: {
    subject: { type: "string", maxLength: 200 },
    current_topic: { type: "string", maxLength: 200 },
    learning_goal: { type: "string", maxLength: 400 },
    progress_level: { type: "string", enum: ["intro", "developing", "solid", "mastered"] },
    known: { type: "array", items: { type: "string", maxLength: 240 }, maxItems: 50 },
    gaps: { type: "array", items: { type: "string", maxLength: 240 }, maxItems: 50 },
    misconceptions: { type: "array", items: { type: "string", maxLength: 240 }, maxItems: 30 },
    difficulty: { type: "string", enum: ["easier", "same", "harder"] },
    frustration: { type: "number", minimum: 0, maximum: 1 },
    hint_level: {
      type: "integer",
      minimum: 0,
      maximum: 4,
      description:
        "How much has been given away so far, 0 (none) to 4 (all but the answer).",
    },
    judgement: {
      type: "string",
      enum: ["CORRECT", "PARTIAL", "INCORRECT"],
      description: "Verdict on the student's most recent answer.",
    },
  },
  required: [
    "subject",
    "current_topic",
    "learning_goal",
    "progress_level",
    "known",
    "gaps",
    "misconceptions",
    "difficulty",
    "frustration",
    "hint_level",
    "judgement",
  ],
  additionalProperties: false,
};

const TUTOR_OUTPUT_SCHEMA = {
  name: "assistant_evaluation",
  strict: true,
  schema: {
    type: "object",
    properties: {
      assistant_text_draft: {
        type: "string",
        description:
          "Markdown-formatted text generated by the assistant. Must include exactly one question — except a closing message after the student asked to finish, which asks none.",
      },
      response_class: {
        type: "string",
        enum: ["ON_TRACK", "PARTIAL", "IRRELEVANT", "OFF_TASK"],
        description: "Classification of the assistant response in relation to the user's need.",
      },
      grounding_status: {
        type: "string",
        enum: ["GROUNDED", "NEEDS_MORE_MATERIAL", "OUT_OF_SCOPE"],
        description: "Indicates how well the response is supported by reference material.",
      },
      confidence: {
        type: "number",
        description: "Confidence score of the assistant answer, between 0 and 1.",
        minimum: 0,
        maximum: 1,
      },
      state_patch: { $ref: "#/$defs/state_patch" },
    },
    required: [
      "assistant_text_draft",
      "response_class",
      "grounding_status",
      "confidence",
      "state_patch",
    ],
    additionalProperties: false,
    $defs: { state_patch: STATE_PATCH_SCHEMA },
  },
};

/**
 * What the study surface adds to the shared state schema.
 *
 * Grounding is genuinely its own: it is the only surface with course material
 * to be grounded in.
 */
const STUDY_EXTRA_PROPERTIES: Record<string, unknown> = {
  grounding_status: {
    type: "string",
    enum: ["GROUNDED", "NEEDS_MORE_MATERIAL", "OUT_OF_SCOPE"],
    description: "How well the reply is supported by the session's material.",
  },
};

/**
 * What this surface puts in the shared prompt's `{{session_end_rules}}` slot.
 *
 * A study session has no right answer to stop at: the student decides when it
 * is over, and nothing server-side closes it (see `completeOnStop`). Before
 * this slot existed the prompt required exactly one question mark in every
 * reply with no exception, so even "no, let's finish here" was answered with
 * another question — the tutor could not stop offering recaps and
 * confirmations. The v2 contract's farewell STOP (`unifiedOutputContract`,
 * `endsOnStop: false`) describes the same closing turn; the two must agree or
 * the model holds two instructions it cannot both obey.
 */
const STUDY_SESSION_END_RULES =
  `The student decides when this session is over, and their first word on it is final.

This turn is a closing turn when the latest learner message says they want to stop, finish, or wrap up ("let's finish here", "that's enough for today"), or gives ANY assent — a bare "yes", "ok", "sure" — to a wrap-up or session-completion suggestion in your previous message. Write the closing message on THAT turn; never ask them to confirm ending first.

You may suggest wrapping up at most ONCE per session, and only when the material is covered. After that suggestion, the student's next message either continues the work or closes the session — there is no second offer and no confirmation step.

On a closing turn, classify the learner message as ON_TRACK, and carry the academic state fields over unchanged except where the message itself is evidence; a request to stop is not evidence of frustration.`;

/**
 * `STOP` does not end this surface's session — see `completeOnStop`, and the
 * note on `unifiedOutputContract`. The same constant drives both, so the model
 * is never told the exchange closes on a surface where nothing closes it.
 */
const ENDS_ON_STOP = false;

export const studySessionSubject: ChatSubject<StudySessionContext, TutorResponse> = {
  kind: "study_session",
  functionName: "study-tutor",
  promptKey: "study_tutor",
  modelPolicyKey: "tutoring.study-tutor",
  pauseEveryNMessages: TURNS_BEFORE_REVIEW,

  // Ownership is structural here: `resolveSession` keys the session on the
  // caller, so a student can only ever reach their own. What this establishes
  // is that the study session exists and which course it belongs to — the
  // scope the session is then created under.
  //
  // A failed lookup is not a denial. Reporting a database fault as 403 would
  // name a legitimate owner as an intruder, so it surfaces as a retryable 500.
  //
  // The offering is part of that scope and used to be missing, which is not a
  // cosmetic omission: an unattributed session is one no section-restricted
  // instructor may write to, so unpausing, deleting and messaging all failed on
  // this surface while working on the open-question one. See
  // `resolveStudySessionOffering` — it answers `null` where the section is
  // genuinely undetermined, which is the pre-existing behaviour.
  async authorize(supabase, { subjectId, userId }): Promise<Authorization> {
    const { data, error } = await supabase
      .from("study_sessions")
      .select("id, course_id")
      .eq("id", subjectId)
      .maybeSingle();

    if (error) {
      return { ok: false, status: 500, error: "Failed to check authorization" };
    }
    if (!data) {
      return { ok: false, status: 404, error: "Study session not found" };
    }

    const offeringId = await resolveStudySessionOffering(supabase, {
      studySessionId: subjectId,
      courseId: data.course_id,
      userId,
    });

    return { ok: true, courseId: data.course_id, offeringId };
  },

  async loadContext(supabase: SupabaseClient, { subjectId, session }): Promise<StudySessionContext> {
    const { data: studySession, error: sessionError } = await supabase
      .from("study_sessions")
      .select(
        "id, title, topic, extracted_content, instructions, student_notes, chapter_id",
      )
      .eq("id", subjectId)
      .single();

    if (sessionError || !studySession) throw new Error("Study session not found");

    const { data: course, error: courseError } = await supabase
      .from("courses")
      .select("id, title, description, institutions ( id, name )")
      .eq("id", session.course_id)
      .single();

    if (courseError || !course) throw new Error("Course not found");

    const { data: competencyLinks } = await supabase
      .from("study_session_competencies")
      .select("competency_id, course_competencies(id, title, description)")
      .eq("study_session_id", subjectId);

    const competencyList = (competencyLinks ?? [])
      .map((link) => link.course_competencies as { title?: string; description?: string } | null)
      .filter((c): c is { title: string; description?: string } => !!c?.title)
      .map((c) => (c.description ? `${c.title}: ${c.description}` : c.title));

    const content = studySession.extracted_content || "";
    const institution = course.institutions as { name?: string } | null;

    return {
      courseTitle: course.title || "Study Session",
      courseDescription: course.description || "",
      institutionName: institution?.name || "Educational Institution",
      topic: studySession.topic || "",
      competencyList,
      studentNotes: studySession.student_notes || "",
      instructions: studySession.instructions || "",
      // A single pre-generated summary, not the raw material.
      contentChunks: content ? [{ id: "c1", text: content }] : [],
    };
  },

  buildModelRequest(ctx: TurnContext<StudySessionContext>): ModelRequest {
    // What the model is told about the student, and what decides how hard it
    // thinks. Read through the accessor on both versions — either surface can
    // meet a row the other wrote.
    const prior = sessionStateFromStored(ctx.priorState);

    const baseSystemPrompt = render(STUDY_TUTOR_SYSTEM_PROMPT, {
      course: ctx.subjectContext.courseTitle,
      description: ctx.subjectContext.courseDescription,
      institution: ctx.subjectContext.institutionName,
      objective: ctx.subjectContext.topic,
      competency_list: JSON.stringify(ctx.subjectContext.competencyList),
      lang: ctx.language || "en",
      student_notes: ctx.subjectContext.studentNotes,
      special_instructions_for_tutor: ctx.subjectContext.instructions,
      content: JSON.stringify(ctx.subjectContext.contentChunks),
      session_end_rules: STUDY_SESSION_END_RULES,
    });

    // Under v2 the prompt above still names the v1 keys, so the shared contract
    // is appended to rename them. Leaving the base prompt alone is what keeps
    // /chat's behaviour untouched while this is watched on the streaming
    // surface.
    const systemPrompt = ctx.stateVersion === 2
      ? `${baseSystemPrompt}\n\n${
        unifiedOutputContract(Object.keys(STUDY_EXTRA_PROPERTIES), {
          endsOnStop: ENDS_ON_STOP,
        })
      }`
      : baseSystemPrompt;

    // The opening turn has no student message to answer, so the tutor is asked
    // to open the conversation itself — from the objective, which the system
    // prompt above already carries. Only the user message differs, so the
    // cached prefix is the same one every later turn hits.
    const userMessage = render(
      ctx.isStart ? STUDY_TUTOR_WELCOME_PROMPT : STUDY_TUTOR_USER_PROMPT,
      { session_state: JSON.stringify(prior) },
    );

    // The transcript carries the conversation; the rendered user prompt frames
    // it with the current state.
    const inputMessages: Array<{ role: "user" | "assistant"; content: string }> = [
      { role: "user", content: userMessage },
      ...ctx.history.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
    ];

    return {
      systemPrompt,
      inputMessages,
      structuredOutput:
        ctx.stateVersion === 2
          ? buildStateSchema(STUDY_EXTRA_PROPERTIES)
          : TUTOR_OUTPUT_SCHEMA,
      reasoningEffort: adaptiveReasoningEffort(prior),
    };
  },

  // Under v2 the shared core names the field `assistant_text`; the v1 schema
  // still calls it `assistant_text_draft`, so both are read.
  extractText: (r) =>
    r?.assistant_text_draft ?? (r as unknown as { assistant_text?: string })?.assistant_text ?? "",
  streamTextField: "assistant_text",

  reduceState(ctx, r): TurnState {
    // Same accessor as `buildModelRequest`: a student who tried the streaming
    // surface and came back leaves a v2 row here, and `mergeState` spreads
    // `prev.known` — undefined on a wrapper, which threw rather than degraded.
    const prior = sessionStateFromStored(ctx.priorState);
    const merged = mergeState(prior, r.state_patch);

    return {
      next: merged as unknown as Record<string, unknown>,
      metadata: {
        state: merged,
        meta: {
          response_class: r.response_class,
          grounding_status: r.grounding_status,
          confidence: r.confidence,
        },
      },
      llmDecision: r.response_class,
      llmJudgement: r.grounding_status,
      llmConfidence: r.confidence,
    };
  },

  notification: {
    inputFlaggedTitle: "Study session flagged",
    inputFlaggedMessage: (categories) =>
      `A student's message was flagged by content moderation in a study session. Categories: ${categories.join(", ")}.`,
    outputFlaggedTitle: "AI tutor reply flagged",
    outputFlaggedMessage: (categories) =>
      `The AI tutor's reply was flagged by content moderation in a study session and was withheld from the student. Categories: ${categories.join(", ")}.`,
  },

  pausedCopy: {
    alreadyPaused:
      "This study session has been paused. Please wait for your instructor to review and unpause your session before continuing.",
    historyLimit:
      "This study session has been paused because the conversation has become very long. Your instructor will review your progress and may start a new session.",
    messageInterval: (count) =>
      `This study session has been paused after ${count} messages for instructor review. Your instructor will review your progress and unpause the session when ready.`,
  },

  // Deliberately false. Reviewing a completed study session and carrying on is
  // an ordinary thing for a student to do — the list offers "Review" for
  // exactly that — so refusing here would break a working flow rather than
  // close a gap.
  refuseWhenCompleted: false,

  // Also false, and for a related reason: a study session has no right answer
  // to stop at. The student decides when it is finished, and reopens it to
  // review — auto-completing it would take that away and, since this surface
  // does not refuse a completed session, would say nothing true about it.
  completeOnStop: ENDS_ON_STOP,
};
