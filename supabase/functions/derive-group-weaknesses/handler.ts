import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { logger } from "../_shared/logger.ts";
import {
  type ChapterMeta,
  type CompetencyMeta,
  deriveGroupWeaknesses,
  type EvalScoreRow,
  type QuestionCompetencyRow,
  type QuizAnswerRow,
} from "../_shared/group-weaknesses.ts";
import {
  AAL2_REQUIRED_CODE,
  AAL2_REQUIRED_MESSAGE,
  callerMfaSatisfied,
} from "../_shared/require-aal2.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/** Upper bound on explicit member_user_ids to keep `.in(...)` query clauses reasonably sized. */
const MAX_MEMBERS = 200;

interface DeriveRequest {
  offering_id: string;
  group_id?: string;
  member_user_ids?: string[];
  top_n?: number;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

export const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = (await req.json()) as DeriveRequest;
    const { offering_id, group_id } = body;
    const topN = Math.max(1, Math.min(10, body.top_n ?? 3));

    if (!offering_id) {
      return json({ error: "offering_id is required" }, 400);
    }
    if (!group_id && (!body.member_user_ids || body.member_user_ids.length === 0)) {
      return json({ error: "Provide group_id or member_user_ids" }, 400);
    }
    if (body.member_user_ids && body.member_user_ids.length > MAX_MEMBERS) {
      return json({ error: `member_user_ids cannot exceed ${MAX_MEMBERS} entries` }, 400);
    }

    logger.info("Derive group weaknesses request received", {
      offering_id,
      group_id,
      explicit_members: body.member_user_ids?.length ?? 0,
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

    // Authorize via RLS: a caller-scoped client can only see the offering if
    // they manage it (can_manage_offering). Mirrors cluster-students-by-performance.
    const authedClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: authzCheck, error: authzError } = await authedClient
      .from("offerings")
      .select("id, course_id, class_id")
      .eq("id", offering_id)
      .maybeSingle();
    if (authzError || !authzCheck) {
      logger.warn("Authorization failed for offering", {
        user_id: user.id,
        offering_id,
        error: authzError?.message,
      });
      return json({ error: "Forbidden or offering not found" }, 403);
    }
    const courseId = authzCheck.course_id as string;
    const classId = authzCheck.class_id as string;
    logger.setContext({ courseId });

    // Resolve the requested members.
    let requestedMemberIds: string[];
    if (group_id) {
      // Verify the group belongs to this offering, then read its membership.
      const { data: grp, error: grpErr } = await supabase
        .from("offering_groups")
        .select("id, offering_id")
        .eq("id", group_id)
        .maybeSingle();
      if (grpErr) throw grpErr;
      if (!grp || grp.offering_id !== offering_id) {
        return json({ error: "Group not found in this offering" }, 400);
      }
      const { data: memberRows, error: memErr } = await supabase
        .from("offering_group_members")
        .select("user_id")
        .eq("group_id", group_id);
      if (memErr) throw memErr;
      requestedMemberIds = ((memberRows as { user_id: string }[]) || []).map((r) => r.user_id);
    } else {
      requestedMemberIds = Array.from(new Set(body.member_user_ids ?? []));
    }

    // Enforce institutional isolation: keep only members enrolled as students in
    // the offering's class — arbitrary ids from other classes never leak data.
    const { data: enrollRows, error: enrollErr } = await supabase
      .from("class_enrollments")
      .select("user_id")
      .eq("class_id", classId)
      .eq("role", "student")
      .in("user_id", requestedMemberIds.length > 0 ? requestedMemberIds : ["00000000-0000-0000-0000-000000000000"]);
    if (enrollErr) throw enrollErr;
    const enrolled = new Set(((enrollRows as { user_id: string }[]) || []).map((r) => r.user_id));
    const memberIds = requestedMemberIds.filter((id) => enrolled.has(id));

    if (memberIds.length === 0) {
      return json({
        insufficient_data: true,
        reason: "This group has no members enrolled in the offering's class.",
        suggested_difficulty: null,
        overall: {
          member_count: 0,
          members_with_data: 0,
          total_answers: 0,
          correct_answers: 0,
          percent_correct: null,
        },
        weak_competencies: [],
      });
    }

    // --- Fetch signals -----------------------------------------------------

    // MCQ answers for the group in this course.
    const { data: qaRows, error: qaErr } = await supabase
      .from("quiz_answers")
      .select("user_id, is_correct, question_id")
      .eq("course_id", courseId)
      .in("user_id", memberIds);
    if (qaErr) throw qaErr;
    const quizAnswers: QuizAnswerRow[] = ((qaRows as any[]) || []).map((r) => ({
      user_id: r.user_id,
      is_correct: !!r.is_correct,
      question_id: r.question_id,
    }));

    // question_id → competency links for the answered questions.
    const questionIds = Array.from(new Set(quizAnswers.map((r) => r.question_id)));
    let questionCompetencies: QuestionCompetencyRow[] = [];
    if (questionIds.length > 0) {
      const { data: qc, error: qcErr } = await supabase
        .from("question_competencies")
        .select("question_id, competency_id")
        .in("question_id", questionIds);
      if (qcErr) throw qcErr;
      questionCompetencies = ((qc as any[]) || []).map((r) => ({
        question_id: r.question_id,
        competency_id: r.competency_id,
      }));
    }

    // Latest evaluation per member → competency scores.
    const { data: evalRows, error: evalErr } = await supabase
      .from("student_evaluations")
      .select("id, user_id, generated_at")
      .eq("course_id", courseId)
      .in("user_id", memberIds)
      .order("generated_at", { ascending: false });
    if (evalErr) throw evalErr;

    const latestEvalIdByUser = new Map<string, string>();
    for (const row of (evalRows as any[]) || []) {
      if (!latestEvalIdByUser.has(row.user_id)) {
        latestEvalIdByUser.set(row.user_id, row.id);
      }
    }
    const userIdByEvalId = new Map<string, string>();
    for (const [userId, evalId] of latestEvalIdByUser) {
      userIdByEvalId.set(evalId, userId);
    }
    const latestEvalIds = Array.from(latestEvalIdByUser.values());

    let evalScores: EvalScoreRow[] = [];
    if (latestEvalIds.length > 0) {
      const { data: scoreRows, error: scoreErr } = await supabase
        .from("evaluation_competency_scores")
        .select("evaluation_id, competency_id, score")
        .in("evaluation_id", latestEvalIds);
      if (scoreErr) throw scoreErr;
      evalScores = ((scoreRows as any[]) || []).map((r) => ({
        competency_id: r.competency_id,
        score: r.score === null || r.score === undefined ? null : Number(r.score),
        user_id: userIdByEvalId.get(r.evaluation_id)!,
      }));
    }

    // Competency catalog for this course, with chapter links from both the
    // direct chapter_id column and the competency_chapters junction.
    const { data: comps, error: compsErr } = await supabase
      .from("course_competencies")
      .select("id, title, chapter_id")
      .eq("course_id", courseId);
    if (compsErr) throw compsErr;
    const compRows = (comps as any[]) || [];
    const competencyIds = compRows.map((c) => c.id);

    const chapterIdsByComp = new Map<string, string[]>();
    for (const c of compRows) {
      chapterIdsByComp.set(c.id, c.chapter_id ? [c.chapter_id] : []);
    }
    if (competencyIds.length > 0) {
      const { data: ccRows, error: ccErr } = await supabase
        .from("competency_chapters")
        .select("competency_id, chapter_id")
        .in("competency_id", competencyIds);
      if (ccErr) throw ccErr;
      for (const row of (ccRows as any[]) || []) {
        const list = chapterIdsByComp.get(row.competency_id) ?? [];
        list.push(row.chapter_id);
        chapterIdsByComp.set(row.competency_id, list);
      }
    }

    const competencies: CompetencyMeta[] = compRows.map((c) => ({
      id: c.id,
      title: c.title,
      chapter_ids: Array.from(new Set(chapterIdsByComp.get(c.id) ?? [])),
    }));

    // Chapter titles for the chapters referenced by any competency.
    const allChapterIds = Array.from(
      new Set(competencies.flatMap((c) => c.chapter_ids)),
    );
    let chapters: ChapterMeta[] = [];
    if (allChapterIds.length > 0) {
      const { data: chRows, error: chErr } = await supabase
        .from("material_chapters")
        .select("id, title")
        .in("id", allChapterIds);
      if (chErr) throw chErr;
      chapters = ((chRows as any[]) || []).map((r) => ({ id: r.id, title: r.title }));
    }

    // --- Aggregate ---------------------------------------------------------
    const result = deriveGroupWeaknesses({
      memberCount: memberIds.length,
      quizAnswers,
      questionCompetencies,
      evalScores,
      competencies,
      chapters,
      topN,
    });

    return json(result);
  } catch (error: any) {
    logger.exception("Error in derive-group-weaknesses", error);
    return json({ error: error.message || "Failed to derive group weaknesses" }, 500);
  }
};
