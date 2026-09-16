/**
 * The Socratic open-question surface, as a `ChatSubject`.
 *
 * Everything here is prompt and context. The turn itself — authorisation,
 * transcript, both moderation gates, persistence, SSE — lives in
 * `../chat-turn.ts` and is shared with the study-session surface.
 */

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getLanguageInstruction } from "../language-utils.ts";
import { render, renderEach } from "../render.ts";
import {
  SOCRATIC_CHAT_SYSTEM_PROMPT,
  SOCRATIC_CHAT_USER_PROMPT,
  SOCRATIC_CHAT_WELCOME_PROMPT,
} from "../prompts/socratic-chat.ts";
import {
  STUDY_TUTOR_SYSTEM_PROMPT,
  STUDY_TUTOR_USER_PROMPT,
  STUDY_TUTOR_WELCOME_PROMPT,
} from "../prompts/study-tutor.ts";
import { openModelAnswerFromAnswerKey } from "../question-payload.ts";
import { verifyQuestionEnrollment } from "../verify-question-enrollment.ts";
import { TURNS_BEFORE_REVIEW } from "../chat-turn.ts";
import type { Authorization, ChatSubject, ModelRequest, TurnContext, TurnState } from "../chat-turn.ts";
import { buildStateSchema, promptStateFromStored } from "../chat-state.ts";
import { unifiedOutputContract } from "../prompts/unified-state.ts";

export interface SocraticResponse {
  assistant_text: string;
  judgement: "CORRECT" | "PARTIAL" | "INCORRECT" | "IRRELEVANT" | "OFF_TASK";
  stop: boolean;
  confidence: number;
  reason: string;
  missing: string[];
  misconceptions: string[];
}

interface OpenQuestionContext {
  question: string;
  modelAnswer: string;
  explanation: string;
  competencies: string;
  courseTitle: string;
  courseDescription: string;
  institutionName: string;
}

// `assistant_text` is first on purpose: it is the field a streaming extractor
// would need to reach earliest, and the ordering costs nothing to keep.
const SOCRATIC_OUTPUT_SCHEMA = {
  name: "socratic_response",
  strict: true,
  schema: {
    type: "object",
    properties: {
      assistant_text: {
        type: "string",
        description: "Markdown-formatted pedagogical response to the student.",
      },
      judgement: {
        type: "string",
        enum: ["CORRECT", "PARTIAL", "INCORRECT", "IRRELEVANT", "OFF_TASK"],
        description: "Classification of the student's answer against the reference.",
      },
      stop: {
        type: "boolean",
        description: "True only if judgement is CORRECT — signals the question is complete.",
      },
      confidence: {
        type: "number",
        description: "Confidence in the judgement, 0 to 1.",
        minimum: 0,
        maximum: 1,
      },
      reason: { type: "string", description: "Brief justification for the judgement." },
      missing: {
        type: "array",
        description: "Missing concepts or steps.",
        items: { type: "string" },
      },
      misconceptions: {
        type: "array",
        description: "Identified misconceptions.",
        items: { type: "string" },
      },
    },
    required: [
      "assistant_text",
      "judgement",
      "stop",
      "confidence",
      "reason",
      "missing",
      "misconceptions",
    ],
    additionalProperties: false,
  },
};

// A blank competencies section has historically made the model claim it has no
// course material, so the absence is stated rather than left empty.
const NO_COMPETENCIES_FALLBACK =
  "No specific competencies are defined for this question. Use the question text itself to guide the student Socratically.";

/**
 * What this surface puts in the shared prompt's `{{objective}}` slot.
 *
 * The prompt is written for a session with a stated learning objective; an open
 * question has a question instead. This says so, and "the following" is
 * literal — the question itself arrives in the GROUNDING SOURCES section
 * immediately below the objective in the rendered prompt.
 */
const OPEN_QUESTION_OBJECTIVE =
  "The student needs to find the solution to the following question/exercise. " +
  "Your job is to help them get there.";

/**
 * What this surface puts in `{{special_instructions_for_tutor}}`.
 *
 * The reference answer is handed to the tutor as authoritative content — it has
 * to be, or the tutor cannot tell a correct answer from a plausible one — which
 * makes withholding it a prompt-level rule rather than a matter of what the
 * model happens to know. The prompt ranks instructor instructions below the
 * grounding, formatting and one-question rules, which is the right order here:
 * this constrains what may be said, not the shape of the reply.
 */
const NO_REVEAL_INSTRUCTIONS =
  "Your job is to help them without revealing the answer even if the student " +
  "asks. They must get there independently.";

/**
 * The prompt renders a "Student notes" section unconditionally, and this
 * surface has none.
 *
 * Stated rather than left blank for the same reason as
 * `NO_COMPETENCIES_FALLBACK` above: an empty section under a heading has
 * historically made the model announce that it has no course material.
 */
const NO_STUDENT_NOTES =
  "No student notes exist for this surface. Work from the authoritative content alone.";

function competencyText(links: Array<{ course_competencies: unknown }> | null): string {
  if (!links || links.length === 0) return NO_COMPETENCIES_FALLBACK;

  const described = links
    .map((link) => {
      const comp = link.course_competencies;
      if (!comp) return null;

      // PostgREST returns an embedded row as an object or a single-element
      // array depending on the relationship it infers; both shapes occur here.
      const row = Array.isArray(comp) ? comp[0] : comp;
      if (!row || typeof row !== "object" || !("title" in row)) return null;

      const { title, description } = row as { title: string; description: string | null };
      return description ? `${title}: ${description}` : title;
    })
    .filter(Boolean);

  return described.length > 0 ? described.join("; ") : NO_COMPETENCIES_FALLBACK;
}

/**
 * What the open-question surface adds to the shared state schema.
 *
 * Just the justification for its judgement. Everything else it used to return
 * — `missing`, `misconceptions`, `stop` — is in the shared core now, as `gaps`,
 * `misconceptions` and `answer_allowed`.
 */
const SOCRATIC_EXTRA_PROPERTIES: Record<string, unknown> = {
  reason: {
    type: "string",
    description: "Brief justification for the judgement.",
  },
};

/**
 * What this surface puts in the shared prompt's `{{session_end_rules}}` slot.
 *
 * An open question ends on a correct answer and on nothing else — the appended
 * output contract (`endsOnStop: true`) owns that rule, including the
 * no-question STOP reply. So this slot's job is to declare that the closing
 * turns the shared prompt describes do not exist here: a student asking to
 * stop has still not answered, and closing on their behalf would take away the
 * attempt they never got to make. Without this text, the slot the study
 * surface uses to honour "let's finish here" would invite the same farewell on
 * a surface where it ends the exchange for real.
 */
const NO_SESSION_END_RULES =
  "There are no closing turns on this surface. The exchange ends only as the " +
  "output contract below describes — when the student's answer is correct — " +
  "never because they ask to stop or say they are done. A student who asks to " +
  "stop has still not answered: acknowledge it briefly, and keep exactly one " +
  "focused question in every reply. Ending the session is the student's " +
  "decision and they have their own way to make it; it is not yours.";

/**
 * `STOP` ends this surface's session.
 *
 * One constant feeds both `completeOnStop` — what the server acts on — and the
 * STOP paragraph in the shared output contract, which is what the model is
 * told. They must agree: a prompt promising the exchange closes, on a surface
 * that then leaves it open, teaches the model to lie to the student.
 */
const ENDS_ON_STOP = true;

/**
 * Build the v2 turn from the shared tutor prompt.
 *
 * Byte-identical to what the study surface sends, bar the nine substitutions —
 * which is the point. One prompt taught two ways drifts; one prompt fed
 * different variables does not.
 *
 * The mapping onto the prompt's slots:
 *
 * - `{{objective}}` — this surface has a question, not a stated objective, so
 *   `OPEN_QUESTION_OBJECTIVE` says exactly that.
 * - `{{content}}` — the question, the reference answer and the explanation, as
 *   labelled chunks. The prompt calls this the only source of factual truth,
 *   which for a question with a marked answer is precisely right.
 * - `{{special_instructions_for_tutor}}` — `NO_REVEAL_INSTRUCTIONS`, the rule
 *   that makes holding the reference answer safe.
 *
 * The session state travels as a user message, after the system prompt, so the
 * cached prefix is the same on every turn of a session (see prompts/README.md).
 */
function sharedTutorRequest(
  ctx: TurnContext<OpenQuestionContext>,
  language: string,
): ModelRequest {
  const { question, modelAnswer, explanation } = ctx.subjectContext;

  // Labelled by id rather than concatenated: the tutor has to be able to tell
  // the question from the answer it must not give away, and an unlabelled blob
  // makes that a matter of inference.
  const contentChunks = [
    { id: "question", text: question },
    ...(modelAnswer ? [{ id: "reference_answer", text: modelAnswer }] : []),
    ...(explanation ? [{ id: "explanation", text: explanation }] : []),
  ];

  const basePrompt = render(STUDY_TUTOR_SYSTEM_PROMPT, {
    course: ctx.subjectContext.courseTitle,
    description: ctx.subjectContext.courseDescription,
    institution: ctx.subjectContext.institutionName,
    objective: OPEN_QUESTION_OBJECTIVE,
    competency_list: ctx.subjectContext.competencies,
    lang: language,
    student_notes: NO_STUDENT_NOTES,
    special_instructions_for_tutor: NO_REVEAL_INSTRUCTIONS,
    content: JSON.stringify(contentChunks),
    session_end_rules: NO_SESSION_END_RULES,
  });

  const contract = unifiedOutputContract(Object.keys(SOCRATIC_EXTRA_PROPERTIES), {
    endsOnStop: ENDS_ON_STOP,
  });

  const prior = promptStateFromStored(ctx.priorState);
  const userMessage = render(
    ctx.isStart ? STUDY_TUTOR_WELCOME_PROMPT : STUDY_TUTOR_USER_PROMPT,
    { session_state: JSON.stringify(prior) },
  );

  return {
    systemPrompt: `${basePrompt}\n\n${contract}`,
    inputMessages: [
      { role: "user", content: userMessage },
      ...ctx.history.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
    ],
    structuredOutput: buildStateSchema(SOCRATIC_EXTRA_PROPERTIES),
  };
}

export const openQuestionSubject: ChatSubject<OpenQuestionContext, SocraticResponse> = {
  kind: "open_question",
  functionName: "socratic-chat",
  promptKey: "socratic_chat",
  modelPolicyKey: "tutoring.socratic-chat",
  pauseEveryNMessages: TURNS_BEFORE_REVIEW,

  // Enrollment rather than course management: this is a student surface, and
  // `verifyQuestionEnrollment` already states what entitlement means — a
  // published `offering_questions` row whose offering belongs to a class the
  // caller is enrolled in.
  async authorize(supabase, { subjectId, userId }): Promise<Authorization> {
    const enrollment = await verifyQuestionEnrollment(supabase, {
      questionId: subjectId,
      userId,
    });
    if (!enrollment.ok) {
      return { ok: false, status: enrollment.status, error: enrollment.error };
    }

    // The offering the question was published through is the authoritative
    // scope for the session. The legacy `open_question_progress` row usually
    // left `offering_id` NULL, which is why its RLS could only ever be
    // course-wide; carrying it here is what lets the unified policies be
    // section-scoped.
    const { data: offering, error } = await supabase
      .from("offerings")
      .select("id, course_id")
      .eq("id", enrollment.offeringId)
      .maybeSingle();

    if (error || !offering) {
      return { ok: false, status: 500, error: "Failed to resolve the question's offering" };
    }

    return { ok: true, courseId: offering.course_id, offeringId: offering.id };
  },

  async loadContext(
    supabase: SupabaseClient,
    { subjectId, session },
  ): Promise<OpenQuestionContext> {
    const { data: question, error } = await supabase
      .from("questions")
      .select("question, answer_key, explanation")
      .eq("id", subjectId)
      .eq("type", "open")
      .single();

    if (error || !question) throw new Error("Question not found");

    const { data: links } = await supabase
      .from("question_competencies")
      .select("competency_id, course_competencies(title, description)")
      .eq("question_id", subjectId);

    // The course and its institution are new here: the shared tutor prompt
    // opens by naming them, and the Socratic prompt this surface used before
    // never did. `session.course_id` is the scope `authorize` resolved from the
    // offering the question was published through, so no second trust decision
    // is being made by reading it.
    const { data: course, error: courseError } = await supabase
      .from("courses")
      .select("id, title, description, institutions ( id, name )")
      .eq("id", session.course_id)
      .single();

    if (courseError || !course) throw new Error("Course not found");

    const institution = course.institutions as { name?: string } | null;

    return {
      question: question.question,
      modelAnswer: openModelAnswerFromAnswerKey(question.answer_key) || "",
      explanation: question.explanation || "",
      competencies: competencyText(links as Array<{ course_competencies: unknown }> | null),
      courseTitle: course.title || "Open Question",
      courseDescription: course.description || "",
      institutionName: institution?.name || "Educational Institution",
    };
  },

  buildModelRequest(ctx: TurnContext<OpenQuestionContext>): ModelRequest {
    const langInfo = getLanguageInstruction(ctx.language);

    // v2 — the surface students actually reach — teaches from the shared tutor
    // prompt. v1 keeps the Socratic prompt below, because that path is held to
    // `SOCRATIC_OUTPUT_SCHEMA`, whose keys the shared prompt does not describe;
    // pointing it at the same text would leave the model reading rules for a
    // schema it is not being held to. See the note above `sharedTutorRequest`.
    if (ctx.stateVersion === 2) return sharedTutorRequest(ctx, langInfo.name);

    const chatHistoryJson = JSON.stringify(
      ctx.history.map((m) => ({
        role: m.role === "assistant" ? "tutor" : "user",
        content: m.content,
      })),
    );

    // One variable bag, two templates, each using a subset — rendered together
    // so a misspelled key is still caught.
    const rendered = renderEach(
      {
        system: ctx.isStart ? SOCRATIC_CHAT_WELCOME_PROMPT : SOCRATIC_CHAT_SYSTEM_PROMPT,
        user: SOCRATIC_CHAT_USER_PROMPT,
      },
      {
        question: ctx.subjectContext.question,
        model_answer: ctx.subjectContext.modelAnswer,
        explanation: ctx.subjectContext.explanation,
        competencies: ctx.subjectContext.competencies,
        chat_history: chatHistoryJson,
        lang: langInfo.name,
      },
    );

    const inputMessages: Array<{ role: "user" | "assistant"; content: string }> = [
      {
        role: "user",
        content: ctx.isStart ? "Please welcome the student." : rendered.user,
      },
    ];

    if (!ctx.isStart) {
      // `runChatTurn` already loaded the transcript including this turn's
      // student message, so replaying `history` verbatim is the whole
      // conversation — no separate append of `userMessage`.
      for (const m of ctx.history) {
        inputMessages.push({ role: m.role as "user" | "assistant", content: m.content });
      }
    }

    return {
      systemPrompt: rendered.system,
      inputMessages,
      structuredOutput: SOCRATIC_OUTPUT_SCHEMA,
    };
  },

  extractText: (r) => r?.assistant_text ?? "",
  streamTextField: "assistant_text",

  reduceState(_ctx, r): TurnState {
    const decision: "STOP" | "ASK" = r.stop ? "STOP" : "ASK";
    const evaluator = {
      judgement: r.judgement,
      stop: r.stop,
      confidence: r.confidence,
      reason: r.reason,
      missing: r.missing,
      misconceptions: r.misconceptions,
      answer_allowed: r.stop,
    };

    const next = { decision, evaluator };

    return {
      next,
      // Shape matches `parseSSEStream`'s `{ state, meta }` contract so the
      // client can still read metadata.state.evaluator / .decision.
      metadata: { state: next },
      llmDecision: decision,
      llmJudgement: r.judgement,
      llmConfidence: r.confidence,
    };
  },

  notification: {
    inputFlaggedTitle: "Open question session flagged",
    inputFlaggedMessage: (categories) =>
      `A student's message was flagged by content moderation in an open question session. Categories: ${categories.join(", ")}.`,
    outputFlaggedTitle: "AI tutor reply flagged",
    outputFlaggedMessage: (categories) =>
      `The AI tutor's reply was flagged by content moderation in an open question session and was withheld from the student. Categories: ${categories.join(", ")}.`,
  },

  pausedCopy: {
    alreadyPaused:
      "This session has been paused. Please wait for your instructor to review and unpause your session before continuing.",
    historyLimit:
      "Your session has been paused because the conversation has become very long. Your instructor will review your progress and may start a new session.",
    messageInterval: (count) =>
      `Your session has been paused after ${count} messages for instructor review. Please wait for your instructor to unpause your session before continuing.`,
    alreadyCompleted:
      "You have marked this question complete. Reopen it if you would like to keep working on it.",
  },

  // A question the student marked complete is finished. The composer has been
  // disabled in that state for as long as this surface has existed; this is the
  // same rule where it cannot be bypassed by a stale tab.
  refuseWhenCompleted: true,

  // `STOP` is the evaluator saying the student has answered the question, so
  // the session ends there without waiting for them to press anything. The
  // buffered page did this from the client off `evaluator.stop`; that field is
  // gone from the unified reply, and streaming is what students actually get,
  // so the rule lives on the server now.
  completeOnStop: ENDS_ON_STOP,
};
