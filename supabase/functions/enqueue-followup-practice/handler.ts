/**
 * Enqueue a `followup_practice_generation` job (issue #839).
 *
 * The front-door for turning a quiz-analysis cluster (or the whole class)
 * into a targeted practice set. Given a closed source quiz + an optional
 * chosen cluster, this function — authorized as a manager of the offering —
 *
 *   1. authorizes the caller via `can_manage_offering` (matches analyze-quiz);
 *   2. verifies the source quiz is assigned to the offering and closed;
 *   3. derives the source quiz's chapter scope (quiz_questions → question_chapters);
 *   4. builds a natural-language weak-area focus from the persisted analysis
 *      (misconceptions + knowledge gaps + the chosen cluster's summary);
 *   5. (cluster only) persists the cluster as an `offering_group` +
 *      `offering_group_members`;
 *   6. creates a **published** quiz + an `offering_quizzes` row (published_at
 *      NULL, group_id = the cluster's group or NULL for the whole class) so
 *      the instructor has a real, reviewable quiz immediately;
 *   7. enqueues the background job that fills the quiz with generated
 *      questions and fires the runner.
 *
 * Returns 202 + `{ jobId, draftQuizId, groupId }` as soon as the row is in
 * `pending`.
 *
 * Quiz visibility has two independent gates. `quizzes.is_published` is
 * course-wide and is set TRUE here: follow-ups are never created in draft
 * mode. `offering_quizzes.published_at` is the per-offering assignment and
 * stays NULL, so no student sees the set until the instructor publishes it
 * from the Assigned Quizzes board's Drafts group — which is also why
 * publishing up front is safe even though the questions arrive
 * asynchronously.
 *
 * That safety rests on every student-facing reader honouring the assignment
 * gate rather than `is_published` alone. `offering_quizzes` RLS enforces it
 * for anything reading assignments; the student dashboard had been counting
 * the `quizzes` table directly and was moved onto assignments in the same
 * change.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logger } from "../_shared/logger.ts";
import {
  FOLLOWUP_PRACTICE_GENERATION_JOB_TYPE,
  type FollowupPracticeGenerationParams,
} from "../_shared/job-handlers/followup-practice-generation.ts";
import type { QuestionType } from "../_shared/question-payload.ts";
import {
  AAL2_REQUIRED_CODE,
  AAL2_REQUIRED_MESSAGE,
  callerMfaSatisfied,
} from "../_shared/require-aal2.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Cap on fan-out (chapters × types). Follow-ups are meant to be short; this
 * keeps a caller bypassing the dialog from enqueueing a runaway job.
 */
export const MAX_FOLLOWUP_ITEMS = 60;

/** Follow-up sets stay short; clamp the per-(chapter × type) count. */
const MAX_COUNT_PER_TYPE = 3;
const DEFAULT_COUNT_PER_TYPE = 2;

const ALLOWED_TYPES: ReadonlySet<QuestionType> = new Set<QuestionType>([
  "mcq",
  "open",
  "fill_gaps",
  "ordering",
  "classification",
]);
const ALLOWED_DIFFICULTIES = ["easy", "medium", "hard"] as const;
type Difficulty = (typeof ALLOWED_DIFFICULTIES)[number];

interface FollowupRequest {
  quiz_id?: string;
  offering_id?: string;
  types?: unknown;
  count_per_type?: unknown;
  difficulty?: unknown;
  // Chosen cluster; omit (or send null) to target the whole class.
  cluster?: {
    label?: unknown;
    member_user_ids?: unknown;
  } | null;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function parseTypes(raw: unknown): QuestionType[] {
  const arr = Array.isArray(raw) ? raw : [];
  const out: QuestionType[] = [];
  const seen = new Set<QuestionType>();
  for (const t of arr) {
    if (typeof t !== "string" || !ALLOWED_TYPES.has(t as QuestionType)) continue;
    if (seen.has(t as QuestionType)) continue;
    seen.add(t as QuestionType);
    out.push(t as QuestionType);
  }
  return out;
}

/** Truncate + collapse whitespace so the focus text stays prompt-friendly. */
function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Build the weak-area focus text the generators receive as
 * `specialInstructions`. Draws on the stored report + the chosen cluster's
 * summary so generation is aimed at what this group actually got wrong.
 */
function buildFocusInstructions(
  report: any,
  clusterLabel: string | null,
  clusterSummary: string | null,
): string {
  const lines: string[] = [];
  lines.push(
    "Generate targeted follow-up practice that helps students overcome the specific weaknesses below. " +
      "Base every question strictly on the provided chapter material.",
  );

  const misconceptions = Array.isArray(report?.common_misconceptions)
    ? report.common_misconceptions
    : [];
  if (misconceptions.length > 0) {
    lines.push("Common misconceptions to address:");
    for (const m of misconceptions.slice(0, 6)) {
      const title = typeof m?.title === "string" ? m.title.trim() : "";
      const desc = typeof m?.description === "string" ? m.description.trim() : "";
      if (!title && !desc) continue;
      lines.push(`- ${clip([title, desc].filter(Boolean).join(": "), 240)}`);
    }
  }

  const gaps = Array.isArray(report?.knowledge_gaps) ? report.knowledge_gaps : [];
  if (gaps.length > 0) {
    lines.push("Knowledge gaps to reinforce:");
    for (const g of gaps.slice(0, 6)) {
      const topic = typeof g?.topic === "string" ? g.topic.trim() : "";
      const desc = typeof g?.description === "string" ? g.description.trim() : "";
      if (!topic && !desc) continue;
      lines.push(`- ${clip([topic, desc].filter(Boolean).join(": "), 240)}`);
    }
  }

  if (clusterLabel || clusterSummary) {
    lines.push(
      `This set targets the student group "${clip(clusterLabel || "group", 120)}". ${
        clusterSummary ? clip(clusterSummary, 400) : ""
      }`.trim(),
    );
  }

  return clip(lines.join("\n"), 4000);
}

/**
 * Insert an `offering_group` whose name is unique within the offering. The
 * table has UNIQUE(offering_id, name); on a collision we retry with a numeric
 * suffix rather than failing the whole flow.
 */
async function createGroupWithUniqueName(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  offeringId: string,
  baseName: string,
  description: string | null,
  createdBy: string,
): Promise<string> {
  for (let attempt = 0; attempt < 25; attempt++) {
    const name = attempt === 0 ? baseName : `${baseName} (${attempt + 1})`;
    const { data, error } = await supabase
      .from("offering_groups")
      .insert({ offering_id: offeringId, name, description, created_by: createdBy })
      .select("id")
      .single();
    if (!error && data) return data.id as string;
    // 23505 = unique_violation → try the next suffix.
    if (error && error.code !== "23505") {
      throw new Error(`offering_groups insert failed: ${error.message ?? String(error)}`);
    }
  }
  throw new Error("Could not find a unique name for the follow-up group");
}

/**
 * Fire-and-forget kick to the run-jobs worker so the job starts without
 * waiting for the next pg_cron tick. Mirrors enqueue-bulk-generation.
 */
function triggerRunner(supabaseUrl: string, serviceKey: string): void {
  const url = `${supabaseUrl}/functions/v1/run-jobs`;
  const work = fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      apikey: serviceKey,
      "Content-Type": "application/json",
    },
    body: "{}",
  }).catch((err) => {
    logger.warn("triggerRunner: fire-and-forget failed", {
      error: (err as Error).message ?? String(err),
    });
  });
  // deno-lint-ignore no-explicit-any
  const er = (globalThis as any).EdgeRuntime;
  if (er && typeof er.waitUntil === "function") {
    er.waitUntil(work);
  }
}

export const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  try {
    const body = (await req.json().catch(() => null)) as FollowupRequest | null;
    if (!body) return jsonResponse({ error: "Body must be JSON" }, 400);

    const quizId = typeof body.quiz_id === "string" ? body.quiz_id : "";
    const offeringId = typeof body.offering_id === "string" ? body.offering_id : "";
    if (!quizId || !offeringId) {
      return jsonResponse({ error: "quiz_id and offering_id are required" }, 400);
    }

    const types = parseTypes(body.types);
    if (types.length === 0) {
      return jsonResponse(
        { error: "Select at least one question type (mcq/open/fill_gaps/ordering/classification)" },
        400,
      );
    }
    const rawCount = typeof body.count_per_type === "number" ? body.count_per_type : DEFAULT_COUNT_PER_TYPE;
    const countPerType = Math.max(1, Math.min(MAX_COUNT_PER_TYPE, Math.floor(rawCount)));
    const difficulty: Difficulty | undefined =
      typeof body.difficulty === "string" &&
        (ALLOWED_DIFFICULTIES as readonly string[]).includes(body.difficulty)
        ? (body.difficulty as Difficulty)
        : undefined;

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    if (!supabaseUrl || !serviceKey || !anonKey) {
      return jsonResponse(
        { error: "Server misconfigured: Supabase env vars missing" },
        500,
      );
    }
    const supabase = createClient(supabaseUrl, serviceKey);

    // Authenticate caller.
    const authHeader = req.headers.get("authorization");
    if (!authHeader) return jsonResponse({ error: "Authorization required" }, 401);
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return jsonResponse({ error: "Invalid authentication" }, 401);

    // Service-role client, so RLS's aal2 enforcement never runs here — refuse
    // an MFA-enrolled caller whose token is still aal1.
    if (!callerMfaSatisfied(user, token)) {
      return jsonResponse({ error: AAL2_REQUIRED_MESSAGE, code: AAL2_REQUIRED_CODE }, 403);
    }

    // Authorize via the offering RLS helper, evaluated as the caller.
    const authedClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: canManage, error: authzError } = await authedClient.rpc("can_manage_offering", {
      _offering_id: offeringId,
    });
    if (authzError || canManage !== true) {
      logger.warn("Authorization failed for enqueue-followup-practice", {
        user_id: user.id,
        offering_id: offeringId,
        error: authzError?.message,
      });
      return jsonResponse({ error: "Forbidden" }, 403);
    }

    // Source quiz must be published to this offering. One quiz can carry
    // several rows here — whole-class plus group-scoped assignments — so this
    // reads them all (a `.maybeSingle()` would error on the second row).
    // Closure is no longer required: the analysis this launches from can run
    // on a live quiz (matching analyze-quiz), and the follow-up set is created
    // as an unpublished draft the instructor reviews either way.
    const { data: sourceAssignments, error: oqError } = await supabase
      .from("offering_quizzes")
      .select("id")
      .eq("quiz_id", quizId)
      .eq("offering_id", offeringId)
      .not("published_at", "is", null);
    if (oqError) throw oqError;
    if (!sourceAssignments || sourceAssignments.length === 0) {
      return jsonResponse({ error: "Quiz is not assigned to this offering" }, 404);
    }

    // Resolve offering → course/class, and the course's institution.
    const { data: offering, error: offError } = await supabase
      .from("offerings")
      .select("course_id, class_id")
      .eq("id", offeringId)
      .single();
    if (offError) throw offError;
    const courseId = offering.course_id as string;
    const classId = offering.class_id as string;

    const { data: course, error: courseError } = await supabase
      .from("courses")
      .select("institution_id")
      .eq("id", courseId)
      .single();
    if (courseError) throw courseError;
    const institutionId = course.institution_id as string;

    // Source quiz + title (for the draft name).
    const { data: sourceQuiz, error: quizError } = await supabase
      .from("quizzes")
      .select("title")
      .eq("id", quizId)
      .single();
    if (quizError) throw quizError;
    const sourceTitle = (sourceQuiz.title as string | null) ?? "Quiz";

    // Chapter scope = distinct chapters of the source quiz's questions.
    const { data: quizQs, error: qqError } = await supabase
      .from("quiz_questions")
      .select("question_id")
      .eq("quiz_id", quizId);
    if (qqError) throw qqError;
    const questionIds = ((quizQs as any[]) || []).map((r) => r.question_id).filter(Boolean);

    let chapterIds: string[] = [];
    if (questionIds.length > 0) {
      const { data: chapterRows, error: chError } = await supabase
        .from("question_chapters")
        .select("chapter_id")
        .in("question_id", questionIds);
      if (chError) throw chError;
      chapterIds = Array.from(
        new Set(((chapterRows as any[]) || []).map((r) => r.chapter_id).filter(Boolean)),
      );
    }
    if (chapterIds.length === 0) {
      return jsonResponse(
        {
          error:
            "This quiz's questions aren't linked to any course chapters, so a material-based follow-up can't be generated.",
          no_chapters: true,
        },
        400,
      );
    }

    // Cap fan-out.
    const itemCount = chapterIds.length * types.length;
    if (itemCount > MAX_FOLLOWUP_ITEMS) {
      return jsonResponse(
        {
          error:
            `Too many items: ${itemCount} exceeds the limit of ${MAX_FOLLOWUP_ITEMS} (chapters × types). ` +
            `Reduce question types.`,
        },
        400,
      );
    }

    // Roster for membership validation.
    const { data: enrollments, error: enrollError } = await supabase
      .from("class_enrollments")
      .select("user_id")
      .eq("class_id", classId)
      .eq("role", "student");
    if (enrollError) throw enrollError;
    const rosterIds = new Set(((enrollments as any[]) || []).map((r) => r.user_id));

    // Validate the chosen cluster (if any).
    let clusterLabel: string | null = null;
    let memberUserIds: string[] = [];
    const hasCluster = !!body.cluster && body.cluster !== null;
    if (hasCluster) {
      clusterLabel = typeof body.cluster?.label === "string" ? body.cluster.label.trim() : "";
      if (!clusterLabel) {
        return jsonResponse({ error: "The chosen group needs a name." }, 400);
      }
      const rawMembers = Array.isArray(body.cluster?.member_user_ids)
        ? body.cluster.member_user_ids
        : [];
      memberUserIds = rawMembers.filter(
        (id: unknown): id is string => typeof id === "string" && rosterIds.has(id),
      );
      if (memberUserIds.length === 0) {
        return jsonResponse(
          { error: "None of the chosen students are still enrolled in this class." },
          400,
        );
      }
    }

    // Weak-area focus from the persisted analysis (best-effort; a missing
    // analysis just yields a generic focus).
    const { data: analysisRow } = await supabase
      .from("quiz_analyses")
      .select("report, clusters")
      .eq("quiz_id", quizId)
      .eq("offering_id", offeringId)
      .maybeSingle();
    let clusterSummary: string | null = null;
    if (hasCluster && clusterLabel && Array.isArray(analysisRow?.clusters)) {
      const match = analysisRow.clusters.find(
        (c: any) => typeof c?.label === "string" && c.label.trim() === clusterLabel,
      );
      if (match) clusterSummary = typeof match.summary === "string" ? match.summary : null;
    }
    const focusInstructions = buildFocusInstructions(
      analysisRow?.report ?? {},
      clusterLabel,
      clusterSummary,
    );

    // ── Persist the cluster as an offering_group (cluster only). ─────────
    let groupId: string | null = null;
    if (hasCluster && clusterLabel) {
      const baseName = clip(`${clusterLabel} — ${sourceTitle} follow-up`, 200);
      groupId = await createGroupWithUniqueName(
        supabase,
        offeringId,
        baseName,
        clusterSummary,
        user.id,
      );
      const memberRows = memberUserIds.map((uid) => ({
        group_id: groupId,
        user_id: uid,
        added_by: user.id,
      }));
      const { error: memberErr } = await supabase
        .from("offering_group_members")
        .insert(memberRows);
      if (memberErr) {
        // Best-effort rollback of the group we just created.
        await supabase.from("offering_groups").delete().eq("id", groupId);
        throw new Error(`offering_group_members insert failed: ${memberErr.message ?? String(memberErr)}`);
      }
    }

    // ── Create the quiz: published, but not yet assigned. ───────────────
    const draftTitle = clip(
      hasCluster && clusterLabel
        ? `Follow-up: ${clusterLabel} — ${sourceTitle}`
        : `Follow-up (whole class) — ${sourceTitle}`,
      200,
    );
    const { data: draftQuiz, error: draftErr } = await supabase
      .from("quizzes")
      .insert({
        course_id: courseId,
        title: draftTitle,
        description: "AI-generated targeted follow-up practice. Review before assigning.",
        // Never a draft (#1188): published course-wide, gated only by the
        // offering assignment below.
        is_published: true,
        show_answers: false,
        created_by: user.id,
      })
      .select("id")
      .single();
    if (draftErr || !draftQuiz) {
      if (groupId) {
        await supabase.from("offering_group_members").delete().eq("group_id", groupId);
        await supabase.from("offering_groups").delete().eq("id", groupId);
      }
      throw new Error(`Failed to create follow-up quiz: ${draftErr?.message ?? "unknown"}`);
    }
    const draftQuizId = draftQuiz.id as string;

    // ── Attach to the group / whole class, not yet assigned. ─────────────
    // `published_at` stays NULL: the instructor releases it when ready.
    const { error: assignErr } = await supabase.from("offering_quizzes").insert({
      offering_id: offeringId,
      quiz_id: draftQuizId,
      group_id: groupId,
      published_at: null,
    });
    if (assignErr) {
      await supabase.from("quizzes").delete().eq("id", draftQuizId);
      if (groupId) {
        await supabase.from("offering_group_members").delete().eq("group_id", groupId);
        await supabase.from("offering_groups").delete().eq("id", groupId);
      }
      throw new Error(`Failed to attach follow-up quiz to offering: ${assignErr.message ?? String(assignErr)}`);
    }

    // ── Enqueue the generation job. ──────────────────────────────────────
    const params: FollowupPracticeGenerationParams = {
      courseId,
      offeringId,
      targetQuizId: draftQuizId,
      types,
      chapterIds,
      countPerType,
      difficulty,
      focusInstructions,
    };
    const { data: inserted, error: insertErr } = await supabase
      .from("jobs")
      .insert({
        type: FOLLOWUP_PRACTICE_GENERATION_JOB_TYPE,
        status: "pending",
        params,
        created_by: user.id,
        institution_id: institutionId,
        course_id: courseId,
      })
      .select("id")
      .single();
    if (insertErr || !inserted) {
      // The quiz + assignment row stay (an empty, unassigned quiz the
      // instructor can delete); surface the failure so the UI can report it.
      logger.error("enqueue-followup-practice: job insert failed", {
        error: insertErr?.message ?? "unknown",
        draftQuizId,
      });
      return jsonResponse({ error: "Failed to enqueue generation job", draftQuizId, groupId }, 500);
    }

    triggerRunner(supabaseUrl, serviceKey);

    logger.info("enqueue-followup-practice: job enqueued", {
      jobId: inserted.id,
      courseId,
      offeringId,
      draftQuizId,
      groupId,
      types: types.length,
      chapters: chapterIds.length,
      items: itemCount,
    });

    return jsonResponse(
      { jobId: inserted.id, draftQuizId, groupId, itemCount },
      202,
    );
  } catch (error: any) {
    logger.exception("Error enqueueing follow-up practice", error);
    return jsonResponse({ error: error?.message || "Failed to enqueue follow-up practice" }, 500);
  }
};
