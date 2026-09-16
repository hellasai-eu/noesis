import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getEffectiveLanguage, getLanguageInstruction } from "../_shared/language-utils.ts";
import { callOpenAIStructured, OpenAIError, OpenAIRateLimitError } from "../_shared/openai-client.ts";
import { AiFeatureDisabledError } from "../_shared/openai-client.ts";
import { modelFor } from "../_shared/model-policy.ts";
import { render } from "../_shared/render.ts";
import { logger } from "../_shared/logger.ts";
import {
  authorizeStudentRecord,
  callerFromRequest,
} from "../_shared/course-authz.ts";
import { createUsageContext } from "../_shared/usage-tracker.ts";
import { STUDENT_EVALUATION_SYSTEM_PROMPT, STUDENT_EVALUATION_USER_PROMPT } from "../_shared/prompts/generate-student-evaluation.ts";
import { openModelAnswerFromAnswerKey } from "../_shared/question-payload.ts";
import {
  extractClassification,
  extractOpenText,
  extractStringArray,
} from "../_shared/study-guide-submission.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/** Most recent answers fed to the model. Newest-first, so the cap trims history, not recency. */
const MAX_QUIZ_ANSWERS = 200;
const MAX_STUDY_GUIDE_ANSWERS = 100;
const MAX_INTERACTION_GRADES = 50;

/**
 * Below this total of graded evidence (quiz answers + study guide answers +
 * interaction grades) there is nothing to evaluate; the caller gets
 * `hasEnoughData: false`.
 */
const MIN_EVIDENCE = 3;

/**
 * Engagement counts are taken as the length of a slim bounded query rather
 * than an exact count, so a hyperactive student cannot make this handler pull
 * an unbounded id list. A count at the cap is reported to the model as
 * "at least this many".
 */
const ENGAGEMENT_COUNT_CAP = 500;

// Nothing a student submits is length-bounded at the source, so every field
// that carries their words — or the question's — is capped here. Without this
// a handful of long answers out of the 200 can crowd out the rest of the
// evidence, or overrun the model's input budget outright.
const MAX_OPEN_TEXT = 800;
const MAX_MODEL_ANSWER = 500;
/** fill_gaps inputs, an ordering sequence, a classification map. */
const MAX_STRUCTURED_ANSWER = 400;
/** AI-authored feedback text (study guide + interaction grades), unbounded at the source. */
const MAX_FEEDBACK = 300;

function truncate(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

interface QuizAnswerContext {
  question: string;
  type: string;
  difficulty: string;
  competencyId: string | null;
  answeredAt: string;
  /** null for ungraded types — see `graded` below. */
  isCorrect: boolean | null;
  graded: boolean;
  studentAnswer?: string;
  modelAnswer?: string;
}

/**
 * One quiz answer as evidence for the evaluator, shaped per question type.
 *
 * Two things this has to get right:
 *
 * - **Open answers are never auto-scored.** `submit-quiz-answers` records
 *   `is_correct = false` for every `open` row because a quiz does not grade
 *   prose. Passing that through as a verdict would tell the model the student
 *   failed every open question. They are marked `graded: false` with the text
 *   and the model answer attached, so the model judges the answer itself.
 * - **MCQ stays slim** (#356): the selected and correct option *text* is not
 *   sent — correctness is the whole signal, and 200 answers' worth of option
 *   arrays is not. The other types do carry the literal submission, because
 *   *how* a student mis-ordered or mis-filled is the diagnostic part.
 */
function quizAnswerContext(row: any): QuizAnswerContext {
  const q = row.questions ?? {};
  const type: string = q.type ?? "mcq";
  const isOpen = type === "open";

  const ctx: QuizAnswerContext = {
    question: q.question ?? "",
    type,
    difficulty: q.difficulty ?? "unknown",
    competencyId: q.competency_id ?? null,
    answeredAt: row.answered_at,
    isCorrect: isOpen ? null : !!row.is_correct,
    graded: !isOpen,
  };

  switch (type) {
    case "open": {
      const text = extractOpenText(row.submission) ?? "";
      if (text) ctx.studentAnswer = truncate(text, MAX_OPEN_TEXT);
      const modelAnswer = openModelAnswerFromAnswerKey(q.answer_key);
      if (modelAnswer) ctx.modelAnswer = truncate(modelAnswer, MAX_MODEL_ANSWER);
      break;
    }
    case "fill_gaps": {
      const inputs = extractStringArray(row.submission, "fill_gaps");
      if (inputs?.length) {
        ctx.studentAnswer = truncate(inputs.join(" | "), MAX_STRUCTURED_ANSWER);
      }
      break;
    }
    case "ordering": {
      const order = extractStringArray(row.submission, "ordering");
      if (order?.length) {
        ctx.studentAnswer = truncate(order.join(" → "), MAX_STRUCTURED_ANSWER);
      }
      break;
    }
    case "classification": {
      const placements = extractClassification(row.submission);
      if (placements && Object.keys(placements).length > 0) {
        ctx.studentAnswer = truncate(JSON.stringify(placements), MAX_STRUCTURED_ANSWER);
      }
      break;
    }
    // mcq (and anything unrecognised): correctness only.
  }

  return ctx;
}

interface StudyGuideAnswerContext extends QuizAnswerContext {
  /** 0-100 from the AI grader, when the answer was graded. */
  grade?: number;
  aiFeedback?: string;
}

/**
 * One study guide answer as evidence, shaped like a quiz answer (same
 * question types, same submission format) plus the grader's verdict where
 * one exists: deterministic grades from `submit-study-guide-piece`, open
 * answers graded by the instructor (NULL while still pending review).
 */
function studyGuideAnswerContext(row: any): StudyGuideAnswerContext {
  const ctx: StudyGuideAnswerContext = quizAnswerContext({
    ...row,
    answered_at: row.submitted_at,
  });
  const hasGrade = typeof row.grade === "number";
  // A study-guide open answer IS graded once the instructor scored it —
  // unlike a quiz open answer, which never carries a verdict.
  if (hasGrade) {
    ctx.grade = row.grade;
    ctx.graded = true;
  }
  if (row.is_correct !== null && row.is_correct !== undefined) {
    ctx.isCorrect = !!row.is_correct;
    ctx.graded = true;
  }
  if (typeof row.feedback === "string" && row.feedback.trim()) {
    ctx.aiFeedback = truncate(row.feedback, MAX_FEEDBACK);
  }
  return ctx;
}

interface InteractionGradeContext {
  grade: number | null;
  gradedAt: string;
  feedback?: string;
  strengths?: string[];
  areasForImprovement?: string[];
}

/** One graded AI interactive session (open_question_grades row). */
function interactionGradeContext(row: any): InteractionGradeContext {
  const ctx: InteractionGradeContext = {
    grade: typeof row.grade === "number" ? row.grade : null,
    gradedAt: row.graded_at,
  };
  if (typeof row.feedback === "string" && row.feedback.trim()) {
    ctx.feedback = truncate(row.feedback, MAX_FEEDBACK);
  }
  const strengths = (row.strengths || []).filter((s: unknown) => typeof s === "string");
  if (strengths.length) ctx.strengths = strengths.map((s: string) => truncate(s, MAX_FEEDBACK));
  const areas = (row.areas_for_improvement || []).filter((s: unknown) => typeof s === "string");
  if (areas.length) ctx.areasForImprovement = areas.map((s: string) => truncate(s, MAX_FEEDBACK));
  return ctx;
}

/** A bounded count rendered for the model: exact below the cap, "N+" at it. */
function countLabel(n: number, cap: number = ENGAGEMENT_COUNT_CAP): string {
  return n >= cap ? `${cap}+` : String(n);
}

interface AICompetencyScore {
  competencyId: string;
  score: number | null;
  rationale: string;
}

interface ResolvedCompetencyScore {
  competencyId: string;
  competencyTitle: string;
  score: number | null;
  rationale: string;
}

interface EvaluationResult {
  engagementSummary: string;
  engagementLevel: "high" | "moderate" | "low";
  progressSummary: string;
  overallTrend: "improving" | "stable" | "declining";
  keyImprovements: string[];
  resolvedIssues: string[];
  persistentChallenges: string[];
  newStrengths: string[];
  recommendations: string[];
  insightfulObservation: string;
  competencyScores: AICompetencyScore[];
}

// Note: EvaluationResult uses AICompetencyScore which now has competencyId (UUID) instead of competencyTitle

const EVALUATION_OUTPUT_SCHEMA = {
  name: "progress_analysis",
  strict: true,
  schema: {
    type: "object",
    properties: {
      engagementSummary: {
        type: "string",
        description: "2-3 sentence summary of how engaged the student is with the platform, grounded in the activity counts",
        minLength: 10,
      },
      engagementLevel: {
        type: "string",
        description: "Overall engagement with the platform, judged from the activity counts alone",
        enum: ["high", "moderate", "low"],
      },
      progressSummary: {
        type: "string",
        description: "2-3 sentence overall summary of progress",
        minLength: 10,
      },
      overallTrend: {
        type: "string",
        description: "Overall trend observed across evaluations",
        enum: ["improving", "stable", "declining"],
      },
      keyImprovements: {
        type: "array",
        description: "Specific improvements noted between evaluations",
        items: { type: "string", minLength: 1 },
      },
      resolvedIssues: {
        type: "array",
        description: "Weaknesses that were resolved over time",
        items: { type: "string", minLength: 1 },
      },
      persistentChallenges: {
        type: "array",
        description: "Ongoing areas of concern",
        items: { type: "string", minLength: 1 },
      },
      newStrengths: {
        type: "array",
        description: "Strengths that emerged in later evaluations",
        items: { type: "string", minLength: 1 },
      },
      recommendations: {
        type: "array",
        description: "Actionable next steps",
        items: { type: "string", minLength: 1 },
      },
      insightfulObservation: {
        type: "string",
        description: "One notable pattern or insight from the progression",
        minLength: 5,
      },
      competencyScores: {
        type: "array",
        description: "One entry per course competency with a score (0-100) or null if insufficient data. Use the competency ID exactly as provided in the competency list.",
        items: {
          type: "object",
          properties: {
            competencyId: {
              type: "string",
              description: "The competency UUID exactly as provided in the [ID] prefix of the competency list",
            },
            score: {
              anyOf: [
                { type: "number" },
                { type: "null" },
              ],
              description: "Score 0-100, or null when there is not enough data",
            },
            rationale: {
              type: "string",
              description: "Brief explanation for the score or why data is insufficient",
            },
          },
          required: ["competencyId", "score", "rationale"],
          additionalProperties: false,
        },
      },
    },
    required: [
      "engagementSummary",
      "engagementLevel",
      "progressSummary",
      "overallTrend",
      "keyImprovements",
      "resolvedIssues",
      "persistentChallenges",
      "newStrengths",
      "recommendations",
      "insightfulObservation",
      "competencyScores",
    ],
    additionalProperties: false,
  },
};

export const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { courseId, userId, offeringId, stats } = await req.json();

    if (!courseId || !userId) {
      return new Response(JSON.stringify({ error: "Missing courseId or userId" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }


    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey, {
      // No session to refresh on a service-role client, and leaving the
      // refresh timer on leaks an interval in the handler tests.
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // ── Caller gate (#1135) ───────────────────────────────────────────────
    // This wrote onto a student named in the request body, with no caller
    // identity at all — an anonymous request could put an AI verdict on any
    // student's record in any institution.
    //
    // Two conditions now: the caller manages the course, AND the subject is
    // actually a student on it. The second matters on its own — without it an
    // instructor of a course they legitimately manage could name any user id
    // and have this written onto that person.
    const caller = await callerFromRequest(req, supabase);
    if (!caller.ok) {
      return new Response(JSON.stringify({ error: caller.error, code: caller.code }), {
        status: caller.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const authorized = await authorizeStudentRecord(
      supabase,
      caller.userId,
      userId,
      courseId,
    );
    if (!authorized.ok) {
      logger.warn("Refused a student-record write", {
        callerId: caller.userId,
        subjectUserId: userId,
        courseId: courseId,
      });
      return new Response(JSON.stringify({ error: authorized.error }), {
        status: authorized.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    logger.info("Generating student evaluation", { courseId, userId });

    // Set logger context
    logger.setContext({ courseId });


    // Get effective language for the course
    const effectiveLanguage = await getEffectiveLanguage(supabase, courseId);
    const langInfo = getLanguageInstruction(effectiveLanguage);

    // ── Performance evidence ─────────────────────────────────────────────
    // The evaluation is built from GRADED work only — raw chat transcripts
    // and study-tutor session state stay out so a grade reflects graded work,
    // not conversation volume. Three sources qualify: quiz answers, study
    // guide answers (AI-graded), and the tutor's grades for completed
    // interactive sessions. Every list is newest-first, so the caps keep the
    // most recent work rather than a student's first ever attempts.
    const { data: quizAnswers } = await supabase
      .from("quiz_answers")
      .select(
        `
        is_correct,
        answered_at,
        submission,
        questions!inner(question, type, difficulty, competency_id, answer_key)
      `,
      )
      .eq("course_id", courseId)
      .eq("user_id", userId)
      .order("answered_at", { ascending: false })
      .limit(MAX_QUIZ_ANSWERS);

    const answerRows = (quizAnswers as any[]) || [];

    // Study guide answers hang off the offering, not the course. When the
    // caller is looking at one section, scope to that offering so the saved
    // evaluation matches what the section view shows — and never let a
    // section-restricted instructor's evaluation absorb another section's
    // work. Filtering the course's own offerings by the requested id also
    // rejects an offering id from a different course.
    let offeringsQuery = supabase
      .from("offerings")
      .select("id")
      .eq("course_id", courseId);
    if (offeringId) offeringsQuery = offeringsQuery.eq("id", offeringId);
    const { data: courseOfferings } = await offeringsQuery;
    const offeringIds = (courseOfferings || []).map((o: any) => o.id).filter(Boolean);

    let studyGuideRows: any[] = [];
    let studyGuidesStarted = 0;
    if (offeringIds.length > 0) {
      const { data: sgAnswers } = await supabase
        .from("study_guide_answers")
        .select(
          `
          is_correct,
          grade,
          feedback,
          submitted_at,
          submission,
          questions!inner(question, type, difficulty, competency_id, answer_key)
        `,
        )
        .in("offering_id", offeringIds)
        .eq("user_id", userId)
        .order("submitted_at", { ascending: false })
        .limit(MAX_STUDY_GUIDE_ANSWERS);
      studyGuideRows = (sgAnswers as any[]) || [];

      const { data: sgProgress } = await supabase
        .from("study_guide_progress")
        .select("id")
        .in("offering_id", offeringIds)
        .eq("user_id", userId)
        .limit(ENGAGEMENT_COUNT_CAP);
      studyGuidesStarted = (sgProgress || []).length;
    }

    const { data: interactionGrades } = await supabase
      .from("open_question_grades")
      .select("grade, feedback, strengths, areas_for_improvement, graded_at")
      .eq("course_id", courseId)
      .eq("user_id", userId)
      // Ungraded rows are submissions still awaiting instructor review —
      // they carry no verdict and no feedback, so they are not evidence.
      .not("grade", "is", null)
      .order("graded_at", { ascending: false })
      .limit(MAX_INTERACTION_GRADES);
    const gradeRows = (interactionGrades as any[]) || [];

    // ── Engagement counts ────────────────────────────────────────────────
    // Deterministic activity volume for the engagement axis. Slim bounded
    // queries — the model gets "N" or "cap+", never unbounded id lists.
    //
    // Practice is `quiz_id IS NULL` — formal quiz submissions stay out of the
    // engagement count (they remain performance evidence above).
    const { data: practiceRows } = await supabase
      .from("quiz_answers")
      .select("id")
      .eq("course_id", courseId)
      .eq("user_id", userId)
      .is("quiz_id", null)
      .limit(ENGAGEMENT_COUNT_CAP);
    const practiceQuestionsAnswered = (practiceRows || []).length;

    const { data: flashcardRows } = await supabase
      .from("flashcard_reviews")
      .select("id")
      .eq("course_id", courseId)
      .eq("user_id", userId)
      .limit(ENGAGEMENT_COUNT_CAP);
    const flashcardsReviewed = (flashcardRows || []).length;

    // Joined through the owning session so the cap applies to messages
    // directly — an intermediate session-id list would silently undercount
    // past its own cap while still reading as an exact number.
    const { data: chatMessageRows } = await supabase
      .from("chat_messages")
      .select("id, chat_sessions!inner(id)")
      .eq("chat_sessions.course_id", courseId)
      .eq("chat_sessions.user_id", userId)
      .eq("role", "user")
      .limit(ENGAGEMENT_COUNT_CAP);
    const chatMessagesSent = (chatMessageRows || []).length;

    const engagementCounts = {
      practiceQuestionsAnswered,
      flashcardsReviewed,
      chatMessagesSent,
      studyGuidesStarted,
      studyGuideAnswersSubmitted: studyGuideRows.length,
    };

    const evidenceCount = answerRows.length + studyGuideRows.length + gradeRows.length;

    logger.info("Fetched student evidence", {
      quizAnswers: answerRows.length,
      studyGuideAnswers: studyGuideRows.length,
      interactionGrades: gradeRows.length,
      ...engagementCounts,
    });

    if (evidenceCount < MIN_EVIDENCE) {
      return new Response(
        JSON.stringify({
          evaluation: {
            hasEnoughData: false,
            strengths: [],
            weaknesses: [],
            recommendations: [],
            overallAssessment:
              `This student has only ${evidenceCount} piece(s) of graded work recorded (quiz answers, study guide answers, or graded AI interactions). More activity is needed to provide a meaningful evaluation.`,
          },
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Fetch competencies for the course (id kept for later title→id resolution)
    const { data: competencies } = await supabase
      .from("course_competencies")
      .select("id, title, description")
      .eq("course_id", courseId);

    const competencyList = competencies?.map((c: any) =>
      c.description ? `[${c.id}] ${c.title} - ${c.description}` : `[${c.id}] ${c.title}`
    ).join("\n") || "No competencies defined";

    const quizAnswersJson = JSON.stringify(answerRows.map(quizAnswerContext), null, 2);
    const studyGuideAnswersJson = studyGuideRows.length
      ? JSON.stringify(studyGuideRows.map(studyGuideAnswerContext), null, 2)
      : "None";
    const interactionGradesJson = gradeRows.length
      ? JSON.stringify(gradeRows.map(interactionGradeContext), null, 2)
      : "None";

    // Each count is exact below its cap and rendered "cap+" at it.
    const engagementJson = JSON.stringify(
      {
        practiceQuestionsAnswered: countLabel(engagementCounts.practiceQuestionsAnswered),
        flashcardsReviewed: countLabel(engagementCounts.flashcardsReviewed),
        chatMessagesSent: countLabel(engagementCounts.chatMessagesSent),
        studyGuidesStarted: countLabel(engagementCounts.studyGuidesStarted),
        studyGuideAnswersSubmitted: countLabel(engagementCounts.studyGuideAnswersSubmitted, MAX_STUDY_GUIDE_ANSWERS),
      },
      null,
      2,
    );

    logger.info("Calling OpenAI for evaluation", { language: langInfo.name });
    const llmTimer = logger.startTimer("openai_call");

    const userMessage = render(STUDENT_EVALUATION_USER_PROMPT, {
      lang: langInfo.name,
      competencies: competencyList,
      engagement: engagementJson,
      quiz_answers: quizAnswersJson,
      study_guide_answers: studyGuideAnswersJson,
      interaction_grades: interactionGradesJson,
    });

    let aiResult: EvaluationResult | null = null;
    try {
      aiResult = await callOpenAIStructured<EvaluationResult>({
        ...modelFor("analytics.student-evaluation"),
        promptText: STUDENT_EVALUATION_SYSTEM_PROMPT,
        variables: {},
        input: [{ role: "user", content: userMessage }],
        structuredOutput: EVALUATION_OUTPUT_SCHEMA,
        usageContext: createUsageContext("generate-student-evaluation", {
          promptKey: "student_evaluation",
          courseId,
          userId,
        }),
      });
      const llmDuration = llmTimer();
      logger.info("Evaluation generated successfully", { durationMs: llmDuration });
    } catch (error) {
      llmTimer();
      // The school switched this AI family off (ai-feature-gate) — a policy
      // refusal, not a failure. Must precede the OpenAIError mapping below
      // (it is a subclass) so it cannot surface as a 5xx.
      if (error instanceof AiFeatureDisabledError) {
        return new Response(JSON.stringify({ error: error.message, code: "ai_feature_disabled" }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (error instanceof OpenAIRateLimitError) {
        return new Response(JSON.stringify({ error: "Rate limit exceeded. Please try again later." }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (error instanceof OpenAIError) {
        logger.error("OpenAI error", { message: error.message });
        return new Response(JSON.stringify({ error: "Failed to generate evaluation. Please try again." }), {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      throw error;
    }

    // Build a set of valid competency IDs and a title lookup for the response.
    const validCompetencyIds = new Map<string, string>();
    for (const c of competencies || []) {
      if (c?.id && c?.title) validCompetencyIds.set(c.id, c.title);
    }

    // Deduplicate by competency_id — prefer entries with a non-null score.
    const seenCompetencies = new Map<string, ResolvedCompetencyScore>();
    for (const raw of aiResult?.competencyScores || []) {
      if (!raw?.competencyId) continue;
      const title = validCompetencyIds.get(raw.competencyId);
      if (!title) {
        logger.warn("Unknown competency ID from AI", { id: raw.competencyId });
        continue;
      }
      const existing = seenCompetencies.get(raw.competencyId);
      if (!existing || (existing.score === null && raw.score !== null)) {
        seenCompetencies.set(raw.competencyId, {
          competencyId: raw.competencyId,
          competencyTitle: title,
          score: raw.score ?? null,
          rationale: raw.rationale || "",
        });
      }
    }
    const resolvedScores = Array.from(seenCompetencies.values());

    const evaluation = aiResult
      ? {
          hasEnoughData: true,
          overallAssessment: aiResult.progressSummary,
          strengths: [...(aiResult.keyImprovements || []), ...(aiResult.newStrengths || []), ...(aiResult.resolvedIssues || [])],
          weaknesses: aiResult.persistentChallenges || [],
          recommendations: aiResult.recommendations || [],
          competencyScores: resolvedScores,
          engagement: {
            level: aiResult.engagementLevel,
            summary: aiResult.engagementSummary,
            counts: engagementCounts,
          },
        }
      : {
          hasEnoughData: false,
          overallAssessment: "Unable to generate detailed evaluation at this time.",
          strengths: [],
          weaknesses: [],
          recommendations: [],
          competencyScores: [],
        };

    return new Response(JSON.stringify({ evaluation }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: any) {
    logger.exception("Error generating evaluation", error);
    return new Response(JSON.stringify({ error: error.message || "Failed to generate evaluation" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
};
