// AI class assessment for an assigned study guide (#981, epic #976).
//
// Direct sibling of `analyze-quiz`: same authorization path, same submission
// floor, same anonymization convention. What differs is the shape of the data —
// a study guide is an ordered, gated sequence, so students sit at different
// positions and later pieces are thin by construction rather than by
// difficulty. The prompt is told this explicitly and every per-piece and
// per-competency finding carries a deterministically-computed confidence flag.
//
// The result is CACHED in `study_guide_analyses` and only recomputed when the
// instructor asks. The raw statistics in the results view are computed
// client-side straight from the tables and are always live; nothing here is on
// the path of a student submitting.
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
import {
  ANALYZE_STUDY_GUIDE_SYSTEM_PROMPT,
  ANALYZE_STUDY_GUIDE_USER_PROMPT,
} from "../_shared/prompts/analyze-study-guide.ts";
import { mcqOptionsFromPayload } from "../_shared/question-payload.ts";
import { extractMcqSelection, extractOpenText } from "../_shared/study-guide-submission.ts";
import {
  AAL2_REQUIRED_CODE,
  AAL2_REQUIRED_MESSAGE,
  callerMfaSatisfied,
} from "../_shared/require-aal2.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Minimum submitters before we run an analysis at all. Matches analyze-quiz.
const MIN_SUBMISSIONS = 3;
// Below this, the WHOLE report is flagged low_confidence.
const LOW_CONFIDENCE_THRESHOLD = 5;
// Below this many responses, an individual piece or competency is marked as a
// thin signal so the model (and the UI) present it as tentative rather than as
// a conclusion. A gated sequence guarantees the tail is thin, so without this
// every late piece would read as a finding.
const LOW_CONFIDENCE_RESPONSES = 3;
// Keep open-ended answer samples compact in the prompt.
const OPEN_ANSWER_SAMPLE = 8;
const OPEN_ANSWER_MAXLEN = 500;
// A passing open-answer grade counts as "got it" in the objective tally.
const OPEN_PASS_GRADE = 50;
// Hard ceiling on clusters; the effective count is also capped to the data.
// Matches analyze-quiz so the two panels never offer wildly different shapes.
const MAX_CLUSTERS = 5;

// Resolved once, so the model stamped onto the saved `study_guide_analyses`
// row and the model actually called can never disagree.
const ANALYSIS_POLICY = modelFor("study-guide.analyze");
const MODEL = ANALYSIS_POLICY.model;

interface AnalyzeRequest {
  study_guide_id?: string;
  offering_id?: string;
  /** Optional sub-group filter; must belong to the offering. */
  group_id?: string | null;
}

interface RankedFinding {
  topic: string;
  description: string;
  piece_positions: number[];
  competency_ids: string[];
}

interface Misconception {
  title: string;
  description: string;
  evidence: string;
  piece_positions: number[];
}

interface SuggestedAction {
  action: string;
  rationale: string;
  piece_positions: number[];
}

/**
 * A group of students who share one conceptual struggle. Same shape as
 * `quiz_analyses.clusters` — the instructor panel renders both through the
 * same component, and both persist into `offering_groups` the same way.
 */
interface Cluster {
  label: string;
  rationale: string;
  summary: string;
  /** Real user_ids by the time this is stored; aliases while in model output. */
  member_user_ids: string[];
}

interface StudyGuideReport {
  overall_narrative: string;
  strengths: RankedFinding[];
  weaknesses: RankedFinding[];
  misconceptions: Misconception[];
  suggested_actions: SuggestedAction[];
  summary: string;
  /** Deterministic, not model-authored: piece positions backed by thin data. */
  low_confidence_piece_positions: number[];
  /** Deterministic, not model-authored: competency ids backed by thin data. */
  low_confidence_competency_ids: string[];
}

type AnalyzeReport = Pick<
  StudyGuideReport,
  "overall_narrative" | "strengths" | "weaknesses" | "misconceptions" | "suggested_actions" | "summary"
>;

interface AnalyzeResult extends AnalyzeReport {
  clusters: Cluster[];
}

const RANKED_FINDING_SCHEMA = {
  type: "object",
  properties: {
    topic: { type: "string", description: "The subject-matter topic, never a question format." },
    description: { type: "string" },
    piece_positions: {
      type: "array",
      description: "Positions of the pieces this rests on, copied from the data.",
      items: { type: "number" },
    },
    competency_ids: {
      type: "array",
      description:
        'The short opaque competency tokens (e.g. "C1", "C2") this rests on, copied exactly. Empty when none apply.',
      items: { type: "string" },
    },
  },
  required: ["topic", "description", "piece_positions", "competency_ids"],
  additionalProperties: false,
};

const ANALYSIS_OUTPUT_SCHEMA = {
  name: "study_guide_analysis",
  strict: true,
  schema: {
    type: "object",
    properties: {
      overall_narrative: {
        type: "string",
        description: "3-5 sentences on how the class is doing so far, in terms of concepts.",
      },
      strengths: {
        type: "array",
        description: "What the class has grasped, most-established first.",
        items: RANKED_FINDING_SCHEMA,
      },
      weaknesses: {
        type: "array",
        description: "What the class has not grasped, most urgent first.",
        items: RANKED_FINDING_SCHEMA,
      },
      misconceptions: {
        type: "array",
        description: "Recurring wrong ideas, most prevalent first, each with its evidence.",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            description: { type: "string" },
            evidence: {
              type: "string",
              description: "The concrete answer pattern this is read from.",
            },
            piece_positions: {
              type: "array",
              description: "Positions of the pieces where this shows up.",
              items: { type: "number" },
            },
          },
          required: ["title", "description", "evidence", "piece_positions"],
          additionalProperties: false,
        },
      },
      suggested_actions: {
        type: "array",
        description: "Concrete follow-up moves for the teacher, highest impact first.",
        items: {
          type: "object",
          properties: {
            action: { type: "string" },
            rationale: { type: "string" },
            piece_positions: {
              type: "array",
              description: "Positions of the pieces this addresses.",
              items: { type: "number" },
            },
          },
          required: ["action", "rationale", "piece_positions"],
          additionalProperties: false,
        },
      },
      summary: {
        type: "string",
        description: "One short paragraph the teacher can read at a glance.",
      },
      clusters: {
        type: "array",
        description:
          "Students grouped by the conceptual struggle they share. May be empty when the data does not support grouping.",
        items: {
          type: "object",
          properties: {
            label: {
              type: "string",
              description: "Short instructor-facing name for the shared struggle, never a question format.",
            },
            rationale: { type: "string" },
            summary: { type: "string" },
            member_user_ids: {
              type: "array",
              description:
                'The short opaque student_id tokens (e.g. "S1", "S2") in this cluster, copied exactly.',
              items: { type: "string" },
            },
          },
          required: ["label", "rationale", "summary", "member_user_ids"],
          additionalProperties: false,
        },
      },
    },
    required: [
      "overall_narrative",
      "strengths",
      "weaknesses",
      "misconceptions",
      "suggested_actions",
      "summary",
      "clusters",
    ],
    additionalProperties: false,
  },
};

/**
 * Deterministic score-band grouping used when the model returns no usable
 * clusters. Mirrors `buildFallbackClusters` in analyze-quiz, with one
 * difference that matters: a study guide is a GATED sequence, so a student's
 * percentage is over the questions they have actually reached. Two students in
 * the same band may be nowhere near each other in the guide — which is why the
 * band summaries talk about what to do next rather than claiming a shared
 * misunderstanding the data does not evidence.
 */
function buildFallbackClusters(
  profileByUser: Map<string, { total: number; correct: number }>,
  targetClusterCount: number,
): Cluster[] {
  const bands = [
    {
      label: "Needs support",
      max: 50,
      rationale: "Under 50% correct on the pieces they have reached so far.",
      summary:
        "These students are missing most of what they have attempted. Reteach the earliest weak piece before letting them go further.",
    },
    {
      label: "Approaching mastery",
      max: 80,
      rationale: "Between 50% and 80% correct on the pieces they have reached so far.",
      summary:
        "These students have the basics but still slip on the harder checks. Targeted practice on the weak pieces should close the gap.",
    },
    {
      label: "On track",
      max: Infinity,
      rationale: "80% or higher on the pieces they have reached so far.",
      summary:
        "These students are handling the guide comfortably and are ready for extension work.",
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

/** The option indices a student selected, or [] for any shape we can't read. */
function selectedIndicesFromSubmission(submission: unknown): number[] {
  return extractMcqSelection(submission) ?? [];
}

/** Excerpt an open answer for the prompt: never the whole essay. */
function excerptOpenAnswer(submission: unknown): string {
  const text = extractOpenText(submission) ?? "";
  return text.length > OPEN_ANSWER_MAXLEN ? `${text.slice(0, OPEN_ANSWER_MAXLEN)}…` : text;
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
    const { study_guide_id, offering_id, group_id } = (await req.json()) as AnalyzeRequest;

    if (!study_guide_id || !offering_id) {
      return json({ error: "study_guide_id and offering_id are required" }, 400);
    }

    logger.info("Analyze-study-guide request received", {
      study_guide_id,
      offering_id,
      group_id: group_id ?? null,
    });

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Authenticate caller.
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
    // can_manage_offering sees auth.uid(). It already folds in the
    // course_instructor_sections restriction, so a section-limited instructor
    // cannot analyze a section they do not teach.
    const authedClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: canManage, error: authzError } = await authedClient.rpc("can_manage_offering", {
      _offering_id: offering_id,
    });
    if (authzError || canManage !== true) {
      logger.warn("Authorization failed for analyze-study-guide", {
        user_id: user.id,
        offering_id,
        error: authzError?.message,
      });
      return json({ error: "Forbidden" }, 403);
    }

    // The guide must actually be published to this offering. Unlike a quiz
    // there is no "closed" state — a study guide is analyzed while live.
    const { data: assignments, error: asnError } = await supabase
      .from("offering_study_guides")
      .select("id, group_id, published_at")
      .eq("study_guide_id", study_guide_id)
      .eq("offering_id", offering_id)
      .not("published_at", "is", null);
    if (asnError) throw asnError;
    if (!assignments || assignments.length === 0) {
      return json({ error: "This study guide is not assigned to this class" }, 404);
    }

    // WHO the guide was published to, which is not the same as who is enrolled.
    // A guide assigned only to a group is still "published to this offering",
    // so the check above passes — but the population it was assigned to is that
    // group, not the class. Reading the whole roster here would report students
    // who were never given the guide as having not started it, and cache that
    // under the whole-class scope.
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

    const { data: guide, error: guideError } = await supabase
      .from("study_guides")
      .select("title")
      .eq("id", study_guide_id)
      .single();
    if (guideError) throw guideError;
    const guideTitle = (guide?.title as string) ?? "Study guide";

    const effectiveLanguage = await getEffectiveLanguage(supabase, courseId);
    const langInfo = getLanguageInstruction(effectiveLanguage);

    // ── Roster ───────────────────────────────────────────────────────────
    const { data: enrollments, error: enrollError } = await supabase
      .from("class_enrollments")
      .select("user_id")
      .eq("class_id", classId)
      .eq("role", "student");
    if (enrollError) throw enrollError;
    let rosterIds = ((enrollments as Array<{ user_id: string }>) || []).map((r) => r.user_id);

    // Cut the roster down to the students the guide was actually published to.
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

    // Narrow further to a sub-group when asked. The group must belong to this offering,
    // otherwise a caller could name a group from a class they do not manage and
    // read its membership back through the analysis.
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

      // …and the guide must actually have REACHED that group, or the cached
      // row ends up labelled as an assessment of a cohort it never covered.
      //
      // A whole-class assignment reaches every group of the class, so slicing
      // by any of them is legitimate ("how is my reading-support group doing on
      // this guide?"). Without one, only the targeted groups qualify: naming
      // some other group would intersect its members with the assigned
      // population and publish the overlap under that group's name, implying
      // the whole group had been assigned the guide.
      //
      // The UI only ever offers assigned groups, so this guards the API rather
      // than the screen — and the cache is scope-keyed, so a bogus scope
      // persists for whatever reads these rows next (#982 consumes them).
      if (!publishedToWholeClass && !publishedGroupIds.includes(group_id)) {
        return json({ error: "This study guide is not assigned to that group" }, 404);
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
            : "Nobody in this class has been assigned this study guide yet.",
      });
    }

    // ── Pieces and their questions ───────────────────────────────────────
    const { data: pieceRows, error: pieceError } = await supabase
      .from("study_guide_pieces")
      .select("id, position, title")
      .eq("study_guide_id", study_guide_id)
      .order("position", { ascending: true });
    if (pieceError) throw pieceError;

    interface PieceInfo {
      id: string;
      position: number;
      title: string;
    }
    const pieces: PieceInfo[] = ((pieceRows as PieceInfo[]) || []).map((p) => ({
      id: p.id,
      position: p.position,
      title: p.title,
    }));
    const pieceById = new Map(pieces.map((p) => [p.id, p]));

    interface QInfo {
      id: string;
      pieceId: string;
      position: number;
      type: string;
      difficulty: string | null;
      text: string;
      options: string[];
      competencyId: string | null;
    }
    let questions: QInfo[] = [];
    if (pieces.length > 0) {
      const { data: linkRows, error: linkError } = await supabase
        .from("study_guide_piece_questions")
        .select(
          "piece_id, position, question_id, questions(id, question, type, difficulty, payload, competency_id)",
        )
        .in("piece_id", pieces.map((p) => p.id))
        .order("position", { ascending: true });
      if (linkError) throw linkError;
      questions = ((linkRows as Array<Record<string, unknown>>) || []).map((row, idx) => {
        const q = row.questions as Record<string, unknown> | null;
        return {
          id: row.question_id as string,
          pieceId: row.piece_id as string,
          position: typeof row.position === "number" ? row.position : idx,
          type: (q?.type as string) ?? "mcq",
          difficulty: (q?.difficulty as string) ?? null,
          text: (q?.question as string) ?? "",
          options: mcqOptionsFromPayload((q?.payload as never) ?? null),
          competencyId: (q?.competency_id as string) ?? null,
        };
      });
    }
    const questionById = new Map(questions.map((q) => [q.id, q]));

    // ── Competency list, aliased behind short tokens ─────────────────────
    // Same reason as the student aliases: models cannot reliably echo a UUID
    // back verbatim, so anything we want returned to us must be a short token.
    const referencedCompetencyIds = Array.from(
      new Set(questions.map((q) => q.competencyId).filter((c): c is string => !!c)),
    );
    const competencyTitleById = new Map<string, string>();
    if (referencedCompetencyIds.length > 0) {
      const { data: comps, error: compError } = await supabase
        .from("course_competencies")
        .select("id, title")
        .in("id", referencedCompetencyIds);
      if (compError) throw compError;
      for (const c of (comps as Array<{ id: string; title: string }>) || []) {
        competencyTitleById.set(c.id, c.title);
      }
    }
    const tokenByCompetency = new Map<string, string>();
    const competencyByToken = new Map<string, string>();
    referencedCompetencyIds.forEach((id, i) => {
      const tokenValue = `C${i + 1}`;
      tokenByCompetency.set(id, tokenValue);
      competencyByToken.set(tokenValue, id);
    });

    // ── Submitted answers ────────────────────────────────────────────────
    // `study_guide_answers` is uniquely keyed on (user, offering, question), so
    // unlike quiz_answers there is nothing to dedupe here.
    const { data: answerRows, error: ansError } = await supabase
      .from("study_guide_answers")
      .select("user_id, question_id, piece_id, submission, is_correct, grade")
      .eq("study_guide_id", study_guide_id)
      .eq("offering_id", offering_id)
      .in("user_id", rosterIds);
    if (ansError) throw ansError;

    interface AnswerRow {
      user_id: string;
      question_id: string;
      piece_id: string;
      submission: unknown;
      is_correct: boolean | null;
      grade: number | null;
    }
    // Drop rows whose question is no longer part of the guide (the instructor
    // deleted a piece after students answered it): they cannot be attributed to
    // a piece or a competency, so counting them would silently skew every
    // aggregate below.
    const answers = ((answerRows as AnswerRow[]) || []).filter((a) => questionById.has(a.question_id));

    const submittedUserIds = new Set<string>(answers.map((a) => a.user_id));
    const submissionCount = submittedUserIds.size;

    // Progress: how far through the sequence each student has got.
    const { data: progressRows, error: progError } = await supabase
      .from("study_guide_progress")
      .select("user_id, current_piece_position, completed_at")
      .eq("study_guide_id", study_guide_id)
      .eq("offering_id", offering_id)
      .in("user_id", rosterIds);
    if (progError) throw progError;
    const progressByUser = new Map<string, { position: number; completed: boolean }>();
    for (
      const p of (progressRows as Array<
        { user_id: string; current_piece_position: number | null; completed_at: string | null }
      >) || []
    ) {
      progressByUser.set(p.user_id, {
        position: p.current_piece_position ?? 0,
        completed: !!p.completed_at,
      });
    }

    logger.info("Aggregated study guide responses", {
      pieces: pieces.length,
      questions: questions.length,
      answers: answers.length,
      submission_count: submissionCount,
    });

    if (submissionCount < MIN_SUBMISSIONS) {
      return json({
        analysis: null,
        insufficientData: true,
        submission_count: submissionCount,
        message:
          `Only ${submissionCount} student${submissionCount === 1 ? " has" : "s have"} submitted a piece of this study guide. ` +
          `At least ${MIN_SUBMISSIONS} are needed for a meaningful assessment.`,
      });
    }

    // ── Per-question and per-piece aggregates for the prompt ─────────────
    const answersByQuestion = new Map<string, AnswerRow[]>();
    for (const a of answers) {
      const list = answersByQuestion.get(a.question_id);
      if (list) list.push(a);
      else answersByQuestion.set(a.question_id, [a]);
    }

    const questionsByPiece = new Map<string, QInfo[]>();
    for (const q of questions) {
      const list = questionsByPiece.get(q.pieceId);
      if (list) list.push(q);
      else questionsByPiece.set(q.pieceId, [q]);
    }

    // Thin-signal accounting. Both the answer count and the DISTINCT STUDENT
    // count are tracked, and the confidence flag keys off the students: a
    // finding about the class needs several learners, not several answers from
    // one. Counting answers here would clear the threshold as soon as a single
    // student worked through three questions on a competency, publishing one
    // learner's confusion as class-level evidence — and would disagree with the
    // raw table next to it, which counts respondents (see
    // `buildCompetencyAggregates` in lib/study-guide-analytics.ts).
    const answersByPiece = new Map<string, number>();
    const respondersByPiece = new Map<string, Set<string>>();
    const answersByCompetency = new Map<string, number>();
    const respondersByCompetency = new Map<string, Set<string>>();
    for (const a of answers) {
      answersByPiece.set(a.piece_id, (answersByPiece.get(a.piece_id) ?? 0) + 1);
      const pieceResponders = respondersByPiece.get(a.piece_id) ?? new Set<string>();
      pieceResponders.add(a.user_id);
      respondersByPiece.set(a.piece_id, pieceResponders);

      const competencyId = questionById.get(a.question_id)?.competencyId;
      if (competencyId) {
        answersByCompetency.set(
          competencyId,
          (answersByCompetency.get(competencyId) ?? 0) + 1,
        );
        const compResponders = respondersByCompetency.get(competencyId) ?? new Set<string>();
        compResponders.add(a.user_id);
        respondersByCompetency.set(competencyId, compResponders);
      }
    }

    const lowConfidencePiecePositions = pieces
      .filter((p) => (respondersByPiece.get(p.id)?.size ?? 0) < LOW_CONFIDENCE_RESPONSES)
      .map((p) => p.position);
    const lowConfidenceCompetencyIds = referencedCompetencyIds.filter(
      (id) => (respondersByCompetency.get(id)?.size ?? 0) < LOW_CONFIDENCE_RESPONSES,
    );
    const lowConfidencePiecePositionSet = new Set(lowConfidencePiecePositions);
    const lowConfidenceCompetencySet = new Set(lowConfidenceCompetencyIds);

    const pieceSummaries = pieces.map((piece) => {
      const pieceQuestions = questionsByPiece.get(piece.id) ?? [];
      const questionSummaries = pieceQuestions.map((q) => {
        const qAnswers = answersByQuestion.get(q.id) ?? [];
        const base = {
          question: q.text,
          type: q.type,
          difficulty: q.difficulty,
          competency_id: q.competencyId ? tokenByCompetency.get(q.competencyId) ?? null : null,
          answered: qAnswers.length,
        };
        if (q.type === "open") {
          return {
            ...base,
            sample_answers: qAnswers.slice(0, OPEN_ANSWER_SAMPLE).map((a) => ({
              grade: a.grade,
              answer: excerptOpenAnswer(a.submission),
            })),
          };
        }
        const correct = qAnswers.filter((a) => a.is_correct === true).length;
        let optionDistribution: Array<{ option: string; count: number }> | undefined;
        if (q.type === "mcq" && q.options.length > 0) {
          const counts = new Array(q.options.length).fill(0);
          for (const a of qAnswers) {
            for (const idx of selectedIndicesFromSubmission(a.submission)) {
              if (idx >= 0 && idx < counts.length) counts[idx]++;
            }
          }
          optionDistribution = q.options.map((option, i) => ({ option, count: counts[i] }));
        }
        return {
          ...base,
          correct,
          incorrect: qAnswers.length - correct,
          ...(optionDistribution ? { option_distribution: optionDistribution } : {}),
        };
      });

      const pieceAnswers = pieceQuestions.flatMap((q) => answersByQuestion.get(q.id) ?? []);
      const grades = pieceAnswers
        .map((a) => a.grade)
        .filter((g): g is number => typeof g === "number");
      return {
        position: piece.position,
        title: piece.title,
        students_who_submitted: respondersByPiece.get(piece.id)?.size ?? 0,
        mean_score: grades.length > 0
          ? Math.round(grades.reduce((sum, g) => sum + g, 0) / grades.length)
          : null,
        low_confidence: lowConfidencePiecePositionSet.has(piece.position),
        questions: questionSummaries,
      };
    });

    // `students` is given alongside `answers` so the model can see WHY a
    // competency is flagged — thirty answers from two learners is a thin signal,
    // and stating both numbers is what stops it reading the larger one.
    const competencySummaries = referencedCompetencyIds.map((id) => ({
      competency_id: tokenByCompetency.get(id)!,
      title: competencyTitleById.get(id) ?? "Untitled competency",
      answers: answersByCompetency.get(id) ?? 0,
      students: respondersByCompetency.get(id)?.size ?? 0,
      low_confidence: lowConfidenceCompetencySet.has(id),
    }));

    // ── Alias students behind short opaque tokens (S1, S2, …) ─────────────
    // LLMs cannot reliably reproduce long random UUIDs verbatim, so we never
    // send raw user_ids. Each submitter gets a short token; the tokens are
    // mapped back to real user_ids after the call. Names never leave the DB.
    const aliasByUser = new Map<string, string>();
    const userByAlias = new Map<string, string>();
    let aliasSeq = 0;
    for (const uid of submittedUserIds) {
      const alias = `S${++aliasSeq}`;
      aliasByUser.set(uid, alias);
      userByAlias.set(alias, uid);
    }

    // ── Per-student profiles (opaque ids; no names sent to the LLM) ───────
    interface Profile {
      student_id: string;
      pieces_completed: number;
      guide_completed: boolean;
      total: number;
      correct: number;
      missed: Array<{ piece_position: number; chosen_option?: string }>;
    }
    const profileByUser = new Map<string, Profile>();
    for (const uid of submittedUserIds) {
      const progress = progressByUser.get(uid);
      profileByUser.set(uid, {
        student_id: aliasByUser.get(uid)!,
        pieces_completed: Math.min(progress?.position ?? 0, pieces.length),
        guide_completed: progress?.completed ?? false,
        total: 0,
        correct: 0,
        missed: [],
      });
    }
    for (const a of answers) {
      const profile = profileByUser.get(a.user_id);
      const question = questionById.get(a.question_id);
      const piece = pieceById.get(a.piece_id);
      if (!profile || !question || !piece) continue;
      // An open answer still awaiting instructor review carries neither
      // is_correct nor a grade — counting it would mark it as missed.
      if (a.is_correct === null && typeof a.grade !== "number") continue;
      profile.total++;
      // Objective questions carry is_correct; open answers carry only a grade,
      // so a pass mark stands in for correctness in the overall tally.
      const gotIt = a.is_correct === true ||
        (a.is_correct === null && typeof a.grade === "number" && a.grade >= OPEN_PASS_GRADE);
      if (gotIt) {
        profile.correct++;
        continue;
      }
      const chosen = question.type === "mcq"
        ? selectedIndicesFromSubmission(a.submission)
          .map((i) => question.options[i])
          .filter((o): o is string => typeof o === "string")
        : [];
      profile.missed.push({
        piece_position: piece.position,
        ...(chosen.length > 0 ? { chosen_option: chosen.join(" | ") } : {}),
      });
    }
    const studentProfiles = Array.from(profileByUser.values()).map((p) => ({
      student_id: p.student_id,
      pieces_completed: p.pieces_completed,
      guide_completed: p.guide_completed,
      correct: p.correct,
      total: p.total,
      percent_correct: p.total > 0 ? Math.round((p.correct / p.total) * 100) : null,
      missed: p.missed,
    }));

    // Cap clusters to the data: never more than we have students to group.
    const targetClusterCount = Math.max(1, Math.min(MAX_CLUSTERS, submissionCount));

    const userMessage = render(ANALYZE_STUDY_GUIDE_USER_PROMPT, {
      lang: langInfo.name,
      guide_title: guideTitle,
      piece_count: String(pieces.length),
      target_cluster_count: String(targetClusterCount),
      competencies: competencySummaries.length > 0
        ? JSON.stringify(competencySummaries, null, 2)
        : "(no competencies are attached to this guide's questions)",
      submission_count: String(submissionCount),
      pieces: JSON.stringify(pieceSummaries, null, 2),
      student_profiles: JSON.stringify(studentProfiles, null, 2),
    });

    let aiResult: AnalyzeResult;
    try {
      aiResult = await callOpenAIStructured<AnalyzeResult>({
        ...ANALYSIS_POLICY,
        promptText: ANALYZE_STUDY_GUIDE_SYSTEM_PROMPT,
        variables: {},
        input: [{ role: "user", content: userMessage }],
        structuredOutput: ANALYSIS_OUTPUT_SCHEMA,
        usageContext: createUsageContext("analyze-study-guide", {
          promptKey: "analyze_study_guide",
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
        return json({ error: "Failed to analyze this study guide. Please try again." }, 502);
      }
      throw error;
    }

    // ── Validate + sanitize AI output ────────────────────────────────────
    const knownPositions = new Set(pieces.map((p) => p.position));
    const keepPositions = (raw: unknown): number[] =>
      Array.isArray(raw) ? raw.filter((p): p is number => typeof p === "number" && knownPositions.has(p)) : [];
    // Tokens the model invents, echoes as a raw UUID, or mangles the casing of
    // map to nothing and are dropped individually — a single bad token must not
    // cost the whole finding.
    const keepCompetencies = (raw: unknown): string[] =>
      Array.isArray(raw)
        ? raw
          .map((t) => (typeof t === "string" ? competencyByToken.get(t) : undefined))
          .filter((id): id is string => !!id)
        : [];

    // The model's output is only as typed as the schema it honoured, so every
    // list is re-read as loose records before being trusted.
    const asRecords = (raw: unknown): Record<string, unknown>[] =>
      Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];

    const cleanFindings = (raw: unknown): RankedFinding[] =>
      asRecords(raw)
        .map((f) => ({
          topic: String(f?.topic ?? "").trim(),
          description: String(f?.description ?? "").trim(),
          piece_positions: keepPositions(f?.piece_positions),
          competency_ids: keepCompetencies(f?.competency_ids),
        }))
        .filter((f) => f.topic.length > 0 && f.description.length > 0);

    const report: StudyGuideReport = {
      overall_narrative: (aiResult?.overall_narrative ?? "").trim(),
      strengths: cleanFindings(aiResult?.strengths),
      weaknesses: cleanFindings(aiResult?.weaknesses),
      misconceptions: asRecords(aiResult?.misconceptions)
        .map((m) => ({
          title: String(m?.title ?? "").trim(),
          description: String(m?.description ?? "").trim(),
          evidence: String(m?.evidence ?? "").trim(),
          piece_positions: keepPositions(m?.piece_positions),
        }))
        .filter((m) => m.title.length > 0 && m.description.length > 0),
      suggested_actions: asRecords(aiResult?.suggested_actions)
        .map((a) => ({
          action: String(a?.action ?? "").trim(),
          rationale: String(a?.rationale ?? "").trim(),
          piece_positions: keepPositions(a?.piece_positions),
        }))
        .filter((a) => a.action.length > 0),
      summary: (aiResult?.summary ?? "").trim(),
      low_confidence_piece_positions: lowConfidencePiecePositions,
      low_confidence_competency_ids: lowConfidenceCompetencyIds,
    };

    // ── Map the AI aliases (S1, S2, …) back to real user_ids ─────────────
    // Keep only known submitters, and a student lands in at most one cluster —
    // the model is asked for that, but a duplicate must not put one learner in
    // two groups when these become real offering groups downstream.
    const usedUserIds = new Set<string>();
    const clusters: Cluster[] = [];
    for (const c of asRecords(aiResult?.clusters)) {
      const members: string[] = [];
      const rawMembers = Array.isArray(c?.member_user_ids) ? c.member_user_ids : [];
      for (const alias of rawMembers) {
        const uid = typeof alias === "string" ? userByAlias.get(alias) : undefined;
        if (uid && !usedUserIds.has(uid)) {
          members.push(uid);
          usedUserIds.add(uid);
        }
      }
      if (members.length === 0) continue;
      clusters.push({
        label: String(c?.label ?? "").slice(0, 120).trim() || "Group",
        rationale: String(c?.rationale ?? "").slice(0, 400).trim(),
        summary: String(c?.summary ?? "").slice(0, 800).trim(),
        member_user_ids: members,
      });
      if (clusters.length >= targetClusterCount) break;
    }

    // Deterministic fallback: with submitters but no usable model clusters,
    // band students by score so the section is never empty when data exists.
    if (clusters.length === 0 && submissionCount > 0) {
      clusters.push(...buildFallbackClusters(profileByUser, targetClusterCount));
    }

    const lowConfidence = submissionCount < LOW_CONFIDENCE_THRESHOLD;
    const generatedAt = new Date().toISOString();

    // Persist via upsert so Refresh overwrites the stored assessment. The SCOPE
    // is part of the key: a report about one group is not a report about the
    // class, and the panel cannot tell them apart from the row alone — so
    // sharing a slot would silently relabel one cohort's findings as another's.
    const { data: saved, error: saveError } = await supabase
      .from("study_guide_analyses")
      .upsert(
        {
          study_guide_id,
          offering_id,
          group_id: group_id ?? null,
          report,
          clusters,
          model: MODEL,
          submission_count: submissionCount,
          low_confidence: lowConfidence,
          generated_at: generatedAt,
          updated_at: generatedAt,
        },
        { onConflict: "study_guide_id,offering_id,group_id" },
      )
      .select()
      .single();
    if (saveError) throw saveError;

    logger.info("Study guide analysis generated", {
      study_guide_id,
      offering_id,
      submission_count: submissionCount,
      clusters: clusters.length,
      low_confidence: lowConfidence,
      low_confidence_pieces: lowConfidencePiecePositions.length,
    });

    return json({
      analysis: saved ?? {
        study_guide_id,
        offering_id,
        group_id: group_id ?? null,
        report,
        clusters,
        model: MODEL,
        submission_count: submissionCount,
        low_confidence: lowConfidence,
        generated_at: generatedAt,
      },
    });
  } catch (error) {
    logger.exception("Error analyzing study guide", error);
    return json({ error: (error as Error).message || "Failed to analyze this study guide" }, 500);
  }
};
