import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getEffectiveLanguage, getLanguageInstruction } from "../_shared/language-utils.ts";
import {
  callOpenAIStructured,
  OpenAIError,
  OpenAIRateLimitError,
} from "../_shared/openai-client.ts";
import { AiFeatureDisabledError } from "../_shared/openai-client.ts";
import { modelFor } from "../_shared/model-policy.ts";
import { render } from "../_shared/render.ts";
import { logger } from "../_shared/logger.ts";
import { createUsageContext } from "../_shared/usage-tracker.ts";
import { ANALYZE_QUIZ_SYSTEM_PROMPT, ANALYZE_QUIZ_USER_PROMPT } from "../_shared/prompts/analyze-quiz.ts";
import { mcqOptionsFromPayload } from "../_shared/question-payload.ts";
import {
  AAL2_REQUIRED_CODE,
  AAL2_REQUIRED_MESSAGE,
  callerMfaSatisfied,
} from "../_shared/require-aal2.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Minimum submissions before we run an analysis at all.
const MIN_SUBMISSIONS = 3;
// Below this, results are flagged low_confidence so the UI can caveat them.
const LOW_CONFIDENCE_THRESHOLD = 5;
// Hard ceiling on clusters; the effective count is also capped to the data.
const MAX_CLUSTERS = 5;
// Keep open-ended answer samples compact in the prompt.
const OPEN_ANSWER_SAMPLE = 8;
const OPEN_ANSWER_MAXLEN = 500;

// Resolved once: the same object both makes the call and labels the stored
// analysis, so the two cannot disagree.
const QUIZ_ANALYSIS_POLICY = modelFor("analytics.quiz");

interface AnalyzeRequest {
  quiz_id?: string;
  offering_id?: string;
  /** Narrow the analysis to one offering group; null/absent = whole class. */
  group_id?: string | null;
}

interface Misconception {
  title: string;
  description: string;
  related_question_orders: number[];
}

interface KnowledgeGap {
  topic: string;
  description: string;
}

interface QuestionSignal {
  question_order: number;
  difficulty_signal: "easy" | "moderate" | "hard";
  note: string;
}

interface QuizReport {
  overall_understanding: string;
  common_misconceptions: Misconception[];
  knowledge_gaps: KnowledgeGap[];
  question_signals: QuestionSignal[];
  summary: string;
}

interface Cluster {
  label: string;
  rationale: string;
  summary: string;
  member_user_ids: string[];
}

interface AnalyzeResult {
  report: QuizReport;
  clusters: Cluster[];
}

const ANALYSIS_OUTPUT_SCHEMA = {
  name: "quiz_analysis",
  strict: true,
  schema: {
    type: "object",
    properties: {
      report: {
        type: "object",
        properties: {
          overall_understanding: {
            type: "string",
            description: "2-4 sentences on how well the class grasped the material overall.",
          },
          common_misconceptions: {
            type: "array",
            description: "Recurring wrong ideas, ranked most prevalent/important first.",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                description: { type: "string" },
                related_question_orders: {
                  type: "array",
                  description: "Question order numbers where this misconception appears.",
                  items: { type: "number" },
                },
              },
              required: ["title", "description", "related_question_orders"],
              additionalProperties: false,
            },
          },
          knowledge_gaps: {
            type: "array",
            description: "Topics or skills the class has not mastered.",
            items: {
              type: "object",
              properties: {
                topic: { type: "string" },
                description: { type: "string" },
              },
              required: ["topic", "description"],
              additionalProperties: false,
            },
          },
          question_signals: {
            type: "array",
            description: "One entry per question with a data-derived difficulty signal.",
            items: {
              type: "object",
              properties: {
                question_order: { type: "number" },
                difficulty_signal: { type: "string", enum: ["easy", "moderate", "hard"] },
                note: { type: "string" },
              },
              required: ["question_order", "difficulty_signal", "note"],
              additionalProperties: false,
            },
          },
          summary: {
            type: "string",
            description: "One short paragraph the teacher can read at a glance.",
          },
        },
        required: [
          "overall_understanding",
          "common_misconceptions",
          "knowledge_gaps",
          "question_signals",
          "summary",
        ],
        additionalProperties: false,
      },
      clusters: {
        type: "array",
        description: "Misconception-based student groups. May be empty when the data does not support grouping.",
        items: {
          type: "object",
          properties: {
            label: { type: "string" },
            rationale: { type: "string" },
            summary: { type: "string" },
            member_user_ids: {
              type: "array",
              description:
                'The short opaque student_id tokens (e.g. "S1", "S2") assigned to this cluster, copied exactly.',
              items: { type: "string" },
            },
          },
          required: ["label", "rationale", "summary", "member_user_ids"],
          additionalProperties: false,
        },
      },
    },
    required: ["report", "clusters"],
    additionalProperties: false,
  },
};

/**
 * Deterministic score-band grouping used when the model returns no usable
 * clusters. Guarantees a non-empty, sensible grouping whenever there are
 * submitters, so the panel never shows an empty groups section with data.
 */
function buildFallbackClusters(
  profileByUser: Map<string, { total: number; correct: number }>,
  targetClusterCount: number,
): Cluster[] {
  const bands = [
    {
      label: "Needs support",
      max: 50,
      rationale: "Scored below 50% on this quiz.",
      summary: "These students missed most of the quiz and need foundational review.",
    },
    {
      label: "Approaching mastery",
      max: 80,
      rationale: "Scored between 50% and 80% on this quiz.",
      summary: "These students grasped the basics but still have gaps to close.",
    },
    {
      label: "On track",
      max: Infinity,
      rationale: "Scored 80% or higher on this quiz.",
      summary: "These students demonstrated strong understanding of the material.",
    },
  ];
  const buckets: string[][] = bands.map(() => []);
  for (const [uid, p] of profileByUser) {
    const percent = p.total > 0 ? (p.correct / p.total) * 100 : 0;
    const idx = bands.findIndex((b) => percent < b.max);
    buckets[idx].push(uid);
  }
  const clusters: Cluster[] = [];
  bands.forEach((b, i) => {
    if (buckets[i].length === 0) return;
    clusters.push({
      label: b.label,
      rationale: b.rationale,
      summary: b.summary,
      member_user_ids: buckets[i],
    });
  });
  return clusters.slice(0, Math.max(1, targetClusterCount));
}

/** Read the option indices a student selected from an MCQ answer row. */
function selectedIndicesFromAnswer(row: { submission: any; selected_answer: number | null }): number[] {
  const s = row.submission;
  if (s && typeof s === "object" && Array.isArray(s.selected_indices)) {
    return (s.selected_indices as unknown[]).filter((v): v is number => typeof v === "number");
  }
  return typeof row.selected_answer === "number" ? [row.selected_answer] : [];
}

export const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const { quiz_id, offering_id, group_id } = (await req.json()) as AnalyzeRequest;

    if (!quiz_id || !offering_id) {
      return json({ error: "quiz_id and offering_id are required" }, 400);
    }

    logger.info("Analyze-quiz request received", {
      quiz_id,
      offering_id,
      group_id: group_id ?? null,
    });

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Authenticate caller
    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return json({ error: "Authorization required" }, 401);
    }
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return json({ error: "Invalid authentication" }, 401);
    }

    // Service-role client, so RLS's aal2 enforcement never runs here — refuse
    // an MFA-enrolled caller whose token is still aal1.
    if (!callerMfaSatisfied(user, token)) {
      return json({ error: AAL2_REQUIRED_MESSAGE, code: AAL2_REQUIRED_CODE }, 403);
    }

    // Authorize via the offering RLS helper, evaluated as the caller so
    // can_manage_offering sees auth.uid(). Only instructors / institution
    // admins / super-admins pass.
    const authedClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: canManage, error: authzError } = await authedClient.rpc("can_manage_offering", {
      _offering_id: offering_id,
    });
    if (authzError || canManage !== true) {
      logger.warn("Authorization failed for analyze-quiz", {
        user_id: user.id,
        offering_id,
        error: authzError?.message,
      });
      return json({ error: "Forbidden" }, 403);
    }

    // The quiz must actually be published to this offering. One quiz can carry
    // several rows here — whole-class plus group-scoped assignments — so this
    // reads them all (a `.maybeSingle()` would error on the second row).
    // Analysis no longer requires closure: like a study guide, an open quiz can
    // be analyzed mid-flight — generation is an explicit act in the UI, and the
    // MIN_SUBMISSIONS floor still applies.
    const { data: assignments, error: oqError } = await supabase
      .from("offering_quizzes")
      .select("id, group_id, published_at")
      .eq("quiz_id", quiz_id)
      .eq("offering_id", offering_id)
      .not("published_at", "is", null);
    if (oqError) throw oqError;
    if (!assignments || assignments.length === 0) {
      return json({ error: "Quiz is not assigned to this offering" }, 404);
    }

    // WHO the quiz was published to, which is not the same as who is enrolled.
    // A quiz assigned only to a group is still "published to this offering",
    // but the population it was assigned to is that group, not the class.
    const publishedGroupIds: string[] = [];
    let publishedToWholeClass = false;
    for (const a of assignments as Array<{ group_id: string | null }>) {
      if (a.group_id === null) publishedToWholeClass = true;
      else publishedGroupIds.push(a.group_id);
    }

    // Resolve course + class for the offering.
    const { data: offering, error: offError } = await supabase
      .from("offerings")
      .select("course_id, class_id")
      .eq("id", offering_id)
      .single();
    if (offError) throw offError;
    const courseId = offering.course_id as string;
    const classId = offering.class_id as string;

    logger.setContext({ courseId });

    const effectiveLanguage = await getEffectiveLanguage(supabase, courseId);
    const langInfo = getLanguageInstruction(effectiveLanguage);

    // Roster: enrolled students for this class.
    const { data: enrollments, error: enrollError } = await supabase
      .from("class_enrollments")
      .select("user_id")
      .eq("class_id", classId)
      .eq("role", "student");
    if (enrollError) throw enrollError;
    let rosterIds = ((enrollments as any[]) || []).map((r) => r.user_id);

    // Cut the roster down to the students the quiz was actually published to.
    // A whole-class row covers everyone; without one, the assigned population
    // is the union of the targeted groups' members.
    if (!publishedToWholeClass && rosterIds.length > 0) {
      const { data: assignedMembers, error: assignedError } = await supabase
        .from("offering_group_members")
        .select("user_id")
        .in("group_id", publishedGroupIds);
      if (assignedError) throw assignedError;
      const assignedIds = new Set(
        ((assignedMembers as Array<{ user_id: string }>) || []).map((m) => m.user_id),
      );
      rosterIds = rosterIds.filter((id) => assignedIds.has(id));
    }

    // Narrow further to a sub-group when asked. The group must belong to this
    // offering, otherwise a caller could name a group from a class they do not
    // manage and read its membership back through the analysis. Same rules as
    // analyze-study-guide: a whole-class assignment reaches every group of the
    // class, so slicing by any of them is legitimate; without one, only the
    // targeted groups qualify.
    if (group_id) {
      const { data: group, error: groupError } = await supabase
        .from("offering_groups")
        .select("id")
        .eq("id", group_id)
        .eq("offering_id", offering_id)
        .maybeSingle();
      if (groupError) throw groupError;
      if (!group) {
        return json({ error: "That group does not belong to this class" }, 404);
      }
      if (!publishedToWholeClass && !publishedGroupIds.includes(group_id)) {
        return json({ error: "This quiz is not assigned to that group" }, 404);
      }

      const { data: members, error: memberError } = await supabase
        .from("offering_group_members")
        .select("user_id")
        .eq("group_id", group_id);
      if (memberError) throw memberError;
      const memberIds = new Set(
        ((members as Array<{ user_id: string }>) || []).map((m) => m.user_id),
      );
      rosterIds = rosterIds.filter((id) => memberIds.has(id));
    }

    if (rosterIds.length === 0) {
      return json({
        analysis: null,
        insufficientData: true,
        submission_count: 0,
        message: group_id
          ? "This group has no enrolled students yet."
          : publishedToWholeClass
            ? "This class has no enrolled students yet."
            : "Nobody in this class has been assigned this quiz yet.",
      });
    }

    // Quiz questions in order.
    const { data: quizQs, error: qqError } = await supabase
      .from("quiz_questions")
      .select("order_num, question_id, questions(id, question, type, difficulty, payload, answer_key)")
      .eq("quiz_id", quiz_id)
      .order("order_num", { ascending: true });
    if (qqError) throw qqError;

    interface QInfo {
      id: string;
      order: number;
      type: string;
      difficulty: string | null;
      text: string;
      options: string[];
    }
    const questions: QInfo[] = ((quizQs as any[]) || []).map((row, idx) => {
      const q = row.questions;
      return {
        id: row.question_id,
        order: row.order_num ?? idx + 1,
        type: q?.type ?? "mcq",
        difficulty: q?.difficulty ?? null,
        text: q?.question ?? "",
        options: mcqOptionsFromPayload(q?.payload ?? null),
      };
    });
    const questionById = new Map(questions.map((q) => [q.id, q]));
    const openQuestionIds = questions.filter((q) => q.type === "open").map((q) => q.id);

    // Offering-scoped answers, incl. legacy rows where offering_id was never set.
    const offeringOrNull = `offering_id.eq.${offering_id},offering_id.is.null`;

    const { data: answerRows, error: ansError } = await supabase
      .from("quiz_answers")
      .select("user_id, question_id, is_correct, selected_answer, submission, offering_id, answered_at")
      .eq("quiz_id", quiz_id)
      .or(offeringOrNull)
      .in("user_id", rosterIds);
    if (ansError) throw ansError;

    // Dedupe per (user, question): prefer the row tagged with this offering over
    // a legacy NULL row, then the latest answered_at. This keeps a student who
    // is enrolled in multiple classes sharing the quiz from being double-counted
    // via their offering_id-less submission.
    interface AnswerAgg {
      user_id: string;
      question_id: string;
      is_correct: boolean;
      selected: number[];
      offeringMatch: boolean;
      answeredAt: string;
    }
    const answerByKey = new Map<string, AnswerAgg>();
    for (const r of (answerRows as any[]) || []) {
      const key = `${r.user_id}::${r.question_id}`;
      const offeringMatch = r.offering_id === offering_id;
      const existing = answerByKey.get(key);
      const isBetter = !existing ||
        (offeringMatch && !existing.offeringMatch) ||
        (offeringMatch === existing.offeringMatch && r.answered_at > existing.answeredAt);
      if (isBetter) {
        answerByKey.set(key, {
          user_id: r.user_id,
          question_id: r.question_id,
          is_correct: !!r.is_correct,
          selected: selectedIndicesFromAnswer(r),
          offeringMatch,
          answeredAt: r.answered_at ?? "",
        });
      }
    }
    const answers = Array.from(answerByKey.values());

    // Open-ended answers via open_question_grades (same offering/legacy dedupe).
    interface OpenAgg {
      user_id: string;
      question_id: string;
      grade: number | null;
      answer: string;
      offeringMatch: boolean;
      gradedAt: string;
    }
    const openByKey = new Map<string, OpenAgg>();
    if (openQuestionIds.length > 0) {
      const { data: gradeRows, error: gradeError } = await supabase
        .from("open_question_grades")
        .select("user_id, open_question_id, grade, submitted_answer, offering_id, graded_at")
        .in("open_question_id", openQuestionIds)
        .or(offeringOrNull)
        .in("user_id", rosterIds);
      if (gradeError) throw gradeError;
      for (const r of (gradeRows as any[]) || []) {
        const key = `${r.user_id}::${r.open_question_id}`;
        const offeringMatch = r.offering_id === offering_id;
        const existing = openByKey.get(key);
        const isBetter = !existing ||
          (offeringMatch && !existing.offeringMatch) ||
          (offeringMatch === existing.offeringMatch && (r.graded_at ?? "") > existing.gradedAt);
        if (isBetter) {
          openByKey.set(key, {
            user_id: r.user_id,
            question_id: r.open_question_id,
            grade: typeof r.grade === "number" ? r.grade : null,
            answer: (r.submitted_answer ?? "").slice(0, OPEN_ANSWER_MAXLEN),
            offeringMatch,
            gradedAt: r.graded_at ?? "",
          });
        }
      }
    }
    // `open_question_grades` has no `quiz_id` column (UNIQUE is on
    // (open_question_id, user_id)), so a grade row from the same open
    // question reused in a different quiz for this offering would otherwise
    // leak in here. When the quiz also has MCQ/objective questions, cross-check
    // against `quiz_answers` (which IS quiz_id-scoped) and only keep open
    // answers from students who also submitted this quiz's objective answers.
    // Quizzes made up entirely of open questions have no such signal to
    // cross-check against, so they're left as-is.
    const hasObjectiveQuestions = openQuestionIds.length < questions.length;
    const quizSubmitterIds = new Set(answers.map((a) => a.user_id));
    const openAnswers = hasObjectiveQuestions
      ? Array.from(openByKey.values()).filter((o) => quizSubmitterIds.has(o.user_id))
      : Array.from(openByKey.values());

    // Distinct students who submitted anything (objective or open).
    const submittedUserIds = new Set<string>();
    for (const a of answers) submittedUserIds.add(a.user_id);
    for (const o of openAnswers) submittedUserIds.add(o.user_id);
    const submissionCount = submittedUserIds.size;

    logger.info("Aggregated quiz responses", {
      questions: questions.length,
      objective_answers: answers.length,
      open_answers: openAnswers.length,
      submission_count: submissionCount,
    });

    if (submissionCount < MIN_SUBMISSIONS) {
      return json({
        analysis: null,
        insufficientData: true,
        submission_count: submissionCount,
        message:
          `Only ${submissionCount} student${submissionCount === 1 ? " has" : "s have"} submitted this quiz. ` +
          `At least ${MIN_SUBMISSIONS} submissions are needed for a meaningful analysis.`,
      });
    }

    // ── Build the per-question aggregate for the prompt ──────────────────
    const questionSummaries = questions.map((q) => {
      if (q.type === "open") {
        const grades = openAnswers.filter((o) => o.question_id === q.id);
        return {
          order: q.order,
          type: q.type,
          difficulty: q.difficulty,
          question: q.text,
          answered: grades.length,
          sample_answers: grades.slice(0, OPEN_ANSWER_SAMPLE).map((g) => ({
            grade: g.grade,
            answer: g.answer,
          })),
        };
      }
      const qAnswers = answers.filter((a) => a.question_id === q.id);
      const correct = qAnswers.filter((a) => a.is_correct).length;
      // Option distribution only carries meaning for MCQ (has option text).
      let optionCounts: Array<{ option: string; count: number }> | undefined;
      if (q.type === "mcq" && q.options.length > 0) {
        const counts = new Array(q.options.length).fill(0);
        for (const a of qAnswers) {
          for (const idx of a.selected) {
            if (idx >= 0 && idx < counts.length) counts[idx]++;
          }
        }
        optionCounts = q.options.map((option, i) => ({ option, count: counts[i] }));
      }
      return {
        order: q.order,
        type: q.type,
        difficulty: q.difficulty,
        question: q.text,
        answered: qAnswers.length,
        correct,
        incorrect: qAnswers.length - correct,
        ...(optionCounts ? { option_distribution: optionCounts } : {}),
      };
    });

    // ── Alias students behind short opaque tokens (S1, S2, …) ─────────────
    // LLMs cannot reliably reproduce long random UUIDs verbatim, so we never
    // send raw user_ids. Each submitter gets a short token; the model clusters
    // by token and we map the returned tokens back to real user_ids below.
    const aliasByUser = new Map<string, string>();
    const userByAlias = new Map<string, string>();
    let aliasSeq = 0;
    for (const uid of submittedUserIds) {
      const alias = `S${++aliasSeq}`;
      aliasByUser.set(uid, alias);
      userByAlias.set(alias, uid);
    }

    // ── Build per-student profiles (opaque ids; no names sent to the LLM) ──
    const profileByUser = new Map<string, {
      student_id: string;
      total: number;
      correct: number;
      missed: Array<{ question_order: number; chosen_option?: string }>;
    }>();
    for (const uid of submittedUserIds) {
      profileByUser.set(uid, { student_id: aliasByUser.get(uid)!, total: 0, correct: 0, missed: [] });
    }
    for (const a of answers) {
      const p = profileByUser.get(a.user_id);
      const q = questionById.get(a.question_id);
      if (!p || !q) continue;
      p.total++;
      if (a.is_correct) {
        p.correct++;
      } else {
        const chosen = q.type === "mcq"
          ? a.selected.map((i) => q.options[i]).filter((o): o is string => typeof o === "string")
          : [];
        p.missed.push({
          question_order: q.order,
          ...(chosen.length > 0 ? { chosen_option: chosen.join(" | ") } : {}),
        });
      }
    }
    for (const o of openAnswers) {
      const p = profileByUser.get(o.user_id);
      const q = questionById.get(o.question_id);
      if (!p || !q) continue;
      // An ungraded open answer is pending instructor review — counting it
      // would silently deflate percent_correct for every pending row.
      if (o.grade === null) continue;
      p.total++;
      // Treat a passing open grade (>= 50) as correct for the objective tally.
      if (o.grade >= 50) p.correct++;
      else p.missed.push({ question_order: q.order });
    }
    const studentProfiles = Array.from(profileByUser.values()).map((p) => ({
      student_id: p.student_id,
      correct: p.correct,
      total: p.total,
      percent_correct: p.total > 0 ? Math.round((p.correct / p.total) * 100) : null,
      missed: p.missed,
    }));

    // Cap clusters to the data: never more than we have students to group.
    const targetClusterCount = Math.max(1, Math.min(MAX_CLUSTERS, submissionCount));

    const userMessage = render(ANALYZE_QUIZ_USER_PROMPT, {
      lang: langInfo.name,
      submission_count: String(submissionCount),
      target_cluster_count: String(targetClusterCount),
      questions: JSON.stringify(questionSummaries, null, 2),
      student_profiles: JSON.stringify(studentProfiles, null, 2),
    });

    let aiResult: AnalyzeResult;
    try {
      aiResult = await callOpenAIStructured<AnalyzeResult>({
        ...QUIZ_ANALYSIS_POLICY,
        promptText: ANALYZE_QUIZ_SYSTEM_PROMPT,
        variables: {},
        input: [{ role: "user", content: userMessage }],
        structuredOutput: ANALYSIS_OUTPUT_SCHEMA,
        usageContext: createUsageContext("analyze-quiz", {
          promptKey: "analyze_quiz",
          courseId,
          userId: user.id,
        }),
      });
    } catch (error) {
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
        return json({ error: "Rate limit exceeded. Please try again later." }, 429);
      }
      if (error instanceof OpenAIError) {
        logger.error("OpenAI error", { message: error.message });
        return json({ error: "Failed to analyze quiz. Please try again." }, 502);
      }
      throw error;
    }

    // ── Validate + sanitize AI output ────────────────────────────────────
    const knownOrders = new Set(questions.map((q) => q.order));

    const report: QuizReport = {
      overall_understanding: (aiResult.report?.overall_understanding ?? "").trim(),
      common_misconceptions: (aiResult.report?.common_misconceptions ?? [])
        .map((m) => ({
          title: (m.title ?? "").trim(),
          description: (m.description ?? "").trim(),
          related_question_orders: (m.related_question_orders ?? []).filter((o) => knownOrders.has(o)),
        }))
        .filter((m) => m.title.length > 0 && m.description.length > 0),
      knowledge_gaps: (aiResult.report?.knowledge_gaps ?? [])
        .map((g) => ({
          topic: (g.topic ?? "").trim(),
          description: (g.description ?? "").trim(),
        }))
        .filter((g) => g.topic.length > 0 && g.description.length > 0),
      question_signals: (aiResult.report?.question_signals ?? []).filter((s) =>
        knownOrders.has(s.question_order)
      ),
      summary: (aiResult.report?.summary ?? "").trim(),
    };

    // Map the AI-returned aliases (S1, S2, …) back to real user_ids. Keep only
    // known submitters; a student lands in at most one cluster.
    const usedUserIds = new Set<string>();
    const clusters: Cluster[] = [];
    for (const c of aiResult.clusters ?? []) {
      const members: string[] = [];
      for (const alias of c.member_user_ids ?? []) {
        const uid = userByAlias.get(alias);
        if (uid && !usedUserIds.has(uid)) {
          members.push(uid);
          usedUserIds.add(uid);
        }
      }
      if (members.length === 0) continue;
      clusters.push({
        label: (c.label || "Group").slice(0, 120).trim() || "Group",
        rationale: (c.rationale || "").slice(0, 400).trim(),
        summary: (c.summary || "").slice(0, 800).trim(),
        member_user_ids: members,
      });
      if (clusters.length >= targetClusterCount) break;
    }

    // Deterministic fallback: if the model returned no usable clusters but we
    // do have submitters, group students into score bands so the section is
    // never empty when data exists.
    if (clusters.length === 0 && submissionCount > 0) {
      clusters.push(...buildFallbackClusters(profileByUser, targetClusterCount));
    }

    const lowConfidence = submissionCount < LOW_CONFIDENCE_THRESHOLD;
    // Stamped onto the saved analysis, and taken from the same policy object
    // that made the call — a second literal here would drift the moment the
    // policy changed, mislabelling stored reports as the old model's work.
    const model = QUIZ_ANALYSIS_POLICY.model;
    const generatedAt = new Date().toISOString();

    // Persist via upsert so Regenerate overwrites the stored analysis. Scoped
    // by group: one cached row per (quiz, offering, cohort) — the unique index
    // is NULLS NOT DISTINCT, so the whole-class scope has exactly one slot.
    const { data: saved, error: saveError } = await supabase
      .from("quiz_analyses")
      .upsert(
        {
          quiz_id,
          offering_id,
          group_id: group_id ?? null,
          report,
          clusters,
          model,
          submission_count: submissionCount,
          low_confidence: lowConfidence,
          generated_at: generatedAt,
          updated_at: generatedAt,
        },
        { onConflict: "quiz_id,offering_id,group_id" },
      )
      .select()
      .single();
    if (saveError) throw saveError;

    logger.info("Quiz analysis generated", {
      quiz_id,
      offering_id,
      group_id: group_id ?? null,
      submission_count: submissionCount,
      clusters: clusters.length,
      low_confidence: lowConfidence,
    });

    return json({ analysis: saved ?? {
      quiz_id,
      offering_id,
      group_id: group_id ?? null,
      report,
      clusters,
      model,
      submission_count: submissionCount,
      low_confidence: lowConfidence,
      generated_at: generatedAt,
    } });
  } catch (error: any) {
    logger.exception("Error analyzing quiz", error);
    return json({ error: error.message || "Failed to analyze quiz" }, 500);
  }
};
