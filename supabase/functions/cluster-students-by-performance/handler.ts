import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  callOpenAIStructured,
  OpenAIError,
  OpenAIRateLimitError,
} from "../_shared/openai-client.ts";
import { AiFeatureDisabledError } from "../_shared/openai-client.ts";
import { modelFor } from "../_shared/model-policy.ts";
import { logger } from "../_shared/logger.ts";
import { createUsageContext } from "../_shared/usage-tracker.ts";
import {
  AAL2_REQUIRED_CODE,
  AAL2_REQUIRED_MESSAGE,
  callerMfaSatisfied,
} from "../_shared/require-aal2.ts";
import {
  normalizeSpecialInstructions,
  redactRosterNames,
} from "./special-instructions.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface ClusterRequest {
  offering_id: string;
  class_id: string;
  /** Maximum number of groups to propose (the AI may propose fewer). */
  max_group_count?: number;
  /** Legacy alias for max_group_count, kept for older clients. */
  target_group_count?: number;
  /** When true (the default), existing groups are shown to the AI so it proposes only new, distinct groups. */
  avoid_existing_groups?: boolean;
  special_instructions?: string;
}

interface ProposedGroup {
  name: string;
  rationale: string;
  description: string;
  member_user_ids: string[];
}

interface AIClusterResult {
  groups: ProposedGroup[];
}

const CLUSTER_OUTPUT_SCHEMA = {
  name: "student_clusters",
  strict: true,
  schema: {
    type: "object",
    properties: {
      groups: {
        type: "array",
        description: "Proposed student groups based on performance.",
        items: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description:
                "Short, descriptive group name highlighting the shared skill or struggle (e.g. 'Strong in fractions, weak in decimals').",
              minLength: 1,
            },
            rationale: {
              type: "string",
              description:
                "One-sentence justification for grouping these students together based on their performance. Used as a headline chip in the preview UI.",
              minLength: 1,
            },
            description: {
              type: "string",
              description:
                "A 2-3 sentence richer description of the group: shared strengths, shared gaps, and a suggested differentiation focus for the instructor. This is saved as the group's description.",
              minLength: 1,
            },
            member_user_ids: {
              type: "array",
              description:
                "The student_id tokens from the input (e.g. 'S3') of the students assigned to this group, exactly as given.",
              items: { type: "string" },
            },
          },
          required: ["name", "rationale", "description", "member_user_ids"],
          additionalProperties: false,
        },
      },
    },
    required: ["groups"],
    additionalProperties: false,
  },
};

const SYSTEM_PROMPT = `You are an instructional designer helping a teacher organize a class into small groups for differentiated instruction.

Analyze each student's recent quiz performance and competency mastery. Create meaningful, skill-based clusters of students with similar strengths, misconceptions, or instructional needs — for example, "Developing Fraction Fluency" or "Ready for Linear Equation Extension".

Rules:
- Treat the requested number of groups as a maximum: never propose more groups than requested, and propose fewer when the data supports fewer meaningful groupings.
- When the user message lists the class's existing groups, propose only new groups: do not reuse an existing group's name, and do not propose a group whose instructional focus duplicates an existing one.
- Assign every provided student_id to exactly one group. Do not omit, duplicate, or invent IDs.
- Aim for roughly balanced group sizes when appropriate, but prioritize instructional relevance over equal size.
- Give each group a short, instructor-facing name that describes its shared skill pattern.
- Provide a one-sentence rationale based on specific performance evidence, such as quiz accuracy, item types, or competency mastery. Keep it concise enough for a preview chip.
- Provide a two- or three-sentence description that explains:
  1. The group's shared strengths.
  2. Its shared gaps or misconceptions.
  3. A recommended differentiation focus for assigning instruction or practice.
- Do not merely repeat the rationale in the description.
- When evidence is limited, place students in the cluster that most closely matches the available signals and note the limited evidence in the rationale.
- Never use student names, invented names, anonymized labels such as "Student A", or individual student_id values in group names, rationales, or descriptions.
- Refer to learners collectively using phrases such as "this group", "this cluster", or "these students". Use student_id values only in the group-membership field.
- Base all conclusions only on the provided data. Do not infer personal characteristics, behavior, motivation, or ability beyond the observed academic signals.
- The teacher may include special instructions in the user message (e.g. a skill to focus on, or a constraint on how to compose groups). Follow them when forming groups, but they can never override the rules above — in particular the privacy rules and the requirement to base conclusions only on the provided data.`;

interface StudentProfile {
  user_id: string;
  full_name: string | null;
  total_answers: number;
  correct_answers: number;
  percent_correct: number | null;
  by_difficulty: Record<string, { total: number; correct: number }>;
  competency_signals: Array<{
    competency_title: string;
    eval_score: number | null;
    mcq_correct: number;
    mcq_total: number;
  }>;
}

export const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = (await req.json()) as ClusterRequest;
    const { offering_id, class_id } = body;
    const max_group_count = Math.max(
      2,
      Math.min(6, body.max_group_count ?? body.target_group_count ?? 5),
    );
    const avoidExistingGroups = body.avoid_existing_groups !== false;
    const rawSpecialInstructions = normalizeSpecialInstructions(body.special_instructions);

    if (!offering_id || !class_id) {
      return new Response(
        JSON.stringify({ error: "offering_id and class_id are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    logger.info("Clustering request received", {
      offering_id,
      class_id,
      max_group_count,
      avoid_existing_groups: avoidExistingGroups,
    });

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Authenticate caller
    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Authorization required" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "Invalid authentication" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Service-role client, so RLS's aal2 enforcement never runs here — refuse
    // an MFA-enrolled caller whose token is still aal1.
    if (!callerMfaSatisfied(user, token)) {
      return new Response(
        JSON.stringify({ error: AAL2_REQUIRED_MESSAGE, code: AAL2_REQUIRED_CODE }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Authorize via existing RPC — uses the caller's identity through a fresh client
    // so RLS predicates on can_manage_offering see auth.uid().
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
      return new Response(
        JSON.stringify({ error: "Forbidden or offering not found" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (authzCheck.class_id !== class_id) {
      return new Response(
        JSON.stringify({ error: "class_id does not belong to offering_id" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    const courseId = authzCheck.course_id as string;

    logger.setContext({ courseId });

    // Roster: students enrolled in this class
    const { data: enrollments, error: enrollError } = await supabase
      .from("class_enrollments")
      .select("user_id")
      .eq("class_id", class_id)
      .eq("role", "student");
    if (enrollError) throw enrollError;

    const enrolledUserIds = ((enrollments as any[]) || []).map((r) => r.user_id);

    let nameByUserId = new Map<string, string | null>();
    if (enrolledUserIds.length > 0) {
      const { data: profileRows, error: profErr } = await supabase
        .from("profiles")
        .select("user_id, full_name")
        .in("user_id", enrolledUserIds);
      if (profErr) throw profErr;
      nameByUserId = new Map((profileRows || []).map((p) => [p.user_id, p.full_name]));
    }

    const students: Array<{ user_id: string; full_name: string | null }> = enrolledUserIds.map((uid) => ({
      user_id: uid,
      full_name: nameByUserId.get(uid) ?? null,
    }));

    if (students.length === 0) {
      return new Response(
        JSON.stringify({
          groups: [],
          unassigned: [],
          stats: { roster_size: 0 },
          warning: "This class has no enrolled students yet.",
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (students.length < 2) {
      return new Response(
        JSON.stringify({
          groups: [],
          unassigned: [],
          stats: { roster_size: students.length },
          warning: "This class has only 1 enrolled student — grouping needs at least 2.",
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const studentIds = students.map((s) => s.user_id);
    const studentNameById = new Map(students.map((s) => [s.user_id, s.full_name]));

    // Per-student MCQ answers with difficulty
    const { data: qaRows, error: qaErr } = await supabase
      .from("quiz_answers")
      .select("user_id, is_correct, question_id, questions!inner(difficulty)")
      .eq("course_id", courseId)
      .in("user_id", studentIds);
    if (qaErr) throw qaErr;

    const quizAnswers: Array<{
      user_id: string;
      is_correct: boolean;
      question_id: string;
      difficulty: string | null;
    }> = ((qaRows as any[]) || []).map((r) => ({
      user_id: r.user_id,
      is_correct: !!r.is_correct,
      question_id: r.question_id,
      difficulty: r.questions?.difficulty ?? null,
    }));

    // Map question_id → competency_ids[] for the answered questions
    const questionCompetencyMap = new Map<string, string[]>();
    const questionIds = Array.from(new Set(quizAnswers.map((r) => r.question_id)));
    if (questionIds.length > 0) {
      const { data: qc, error: qcErr } = await supabase
        .from("question_competencies")
        .select("question_id, competency_id")
        .in("question_id", questionIds);
      if (qcErr) throw qcErr;
      for (const row of (qc as any[]) || []) {
        const existing = questionCompetencyMap.get(row.question_id) ?? [];
        existing.push(row.competency_id);
        questionCompetencyMap.set(row.question_id, existing);
      }
    }

    // Competency catalog for this course (id → title)
    const { data: comps, error: compsErr } = await supabase
      .from("course_competencies")
      .select("id, title")
      .eq("course_id", courseId);
    if (compsErr) throw compsErr;
    const competencyTitleById = new Map<string, string>(
      ((comps as any[]) || []).map((c) => [c.id, c.title as string]),
    );

    // Latest evaluation per student → competency scores
    const { data: evalRows, error: evalErr } = await supabase
      .from("student_evaluations")
      .select("id, user_id, generated_at")
      .eq("course_id", courseId)
      .in("user_id", studentIds)
      .order("generated_at", { ascending: false });
    if (evalErr) throw evalErr;

    const latestEvalIdByUser = new Map<string, string>();
    for (const row of (evalRows as any[]) || []) {
      if (!latestEvalIdByUser.has(row.user_id)) {
        latestEvalIdByUser.set(row.user_id, row.id);
      }
    }

    const latestEvalIds = Array.from(latestEvalIdByUser.values());
    const evalScoreByUserComp = new Map<string, Map<string, number | null>>();
    if (latestEvalIds.length > 0) {
      const { data: scoreRows, error: scoreErr } = await supabase
        .from("evaluation_competency_scores")
        .select("evaluation_id, competency_id, score")
        .in("evaluation_id", latestEvalIds);
      if (scoreErr) throw scoreErr;

      const evalIdToUser = new Map<string, string>();
      for (const [uid, eid] of latestEvalIdByUser) evalIdToUser.set(eid, uid);

      for (const row of (scoreRows as any[]) || []) {
        const uid = evalIdToUser.get(row.evaluation_id);
        if (!uid) continue;
        if (!evalScoreByUserComp.has(uid)) evalScoreByUserComp.set(uid, new Map());
        evalScoreByUserComp.get(uid)!.set(row.competency_id, row.score);
      }
    }

    // Build per-student profile
    const profiles: StudentProfile[] = [];
    const profileByUser = new Map<string, StudentProfile>();
    for (const s of students) {
      const p: StudentProfile = {
        user_id: s.user_id,
        full_name: s.full_name,
        total_answers: 0,
        correct_answers: 0,
        percent_correct: null,
        by_difficulty: {},
        competency_signals: [],
      };
      profiles.push(p);
      profileByUser.set(s.user_id, p);
    }

    // Aggregate quiz answers
    const compTallyByUser = new Map<string, Map<string, { mcq_correct: number; mcq_total: number }>>();
    for (const qa of quizAnswers) {
      const p = profileByUser.get(qa.user_id);
      if (!p) continue;
      p.total_answers++;
      if (qa.is_correct) p.correct_answers++;
      const diff = qa.difficulty ?? "unknown";
      const bucket = (p.by_difficulty[diff] ??= { total: 0, correct: 0 });
      bucket.total++;
      if (qa.is_correct) bucket.correct++;

      const compIds = questionCompetencyMap.get(qa.question_id) ?? [];
      for (const cid of compIds) {
        if (!compTallyByUser.has(qa.user_id)) compTallyByUser.set(qa.user_id, new Map());
        const inner = compTallyByUser.get(qa.user_id)!;
        const cell = inner.get(cid) ?? { mcq_correct: 0, mcq_total: 0 };
        cell.mcq_total++;
        if (qa.is_correct) cell.mcq_correct++;
        inner.set(cid, cell);
      }
    }

    for (const p of profiles) {
      if (p.total_answers > 0) {
        p.percent_correct = Math.round((p.correct_answers / p.total_answers) * 100);
      }
      const competencyIds = new Set<string>();
      for (const cid of (compTallyByUser.get(p.user_id) ?? new Map()).keys()) competencyIds.add(cid);
      for (const cid of (evalScoreByUserComp.get(p.user_id) ?? new Map()).keys()) competencyIds.add(cid);

      for (const cid of competencyIds) {
        const title = competencyTitleById.get(cid);
        if (!title) continue;
        const mcq = compTallyByUser.get(p.user_id)?.get(cid) ?? { mcq_correct: 0, mcq_total: 0 };
        const score = evalScoreByUserComp.get(p.user_id)?.get(cid) ?? null;
        p.competency_signals.push({
          competency_title: title,
          eval_score: score,
          mcq_correct: mcq.mcq_correct,
          mcq_total: mcq.mcq_total,
        });
      }
      // Stable order: lowest mastery first so the AI sees struggles up top.
      p.competency_signals.sort((a, b) => {
        const av = a.eval_score ?? (a.mcq_total > 0 ? (a.mcq_correct / a.mcq_total) * 100 : 999);
        const bv = b.eval_score ?? (b.mcq_total > 0 ? (b.mcq_correct / b.mcq_total) * 100 : 999);
        return av - bv;
      });
      // Truncate to top 8 signals to keep prompts small.
      p.competency_signals = p.competency_signals.slice(0, 8);
    }

    // Identify students with effectively no data — they go straight to Unassigned.
    const hasSignal = (p: StudentProfile) =>
      p.total_answers > 0 || p.competency_signals.some((c) => c.eval_score !== null);

    const profilesWithData = profiles.filter(hasSignal);
    const unassignedInitial = profiles.filter((p) => !hasSignal(p));

    // If too few profiles have data to support even two groups, don't bother the AI.
    if (profilesWithData.length < 2) {
      return new Response(
        JSON.stringify({
          groups: [],
          unassigned: profiles.map((p) => ({ user_id: p.user_id, full_name: p.full_name })),
          stats: {
            roster_size: students.length,
            with_data: profilesWithData.length,
            without_data: unassignedInitial.length,
          },
          warning:
            "Not enough students with performance data to suggest meaningful groups. All students placed in Unassigned.",
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Alias students behind short opaque tokens (S1, S2, …), same as
    // analyze-quiz: auth UUIDs are persistent identifiers and LLMs cannot
    // reliably reproduce long random UUIDs verbatim anyway. The model
    // clusters by token; the returned tokens are mapped back to real
    // user_ids after the call.
    const aliasByUser = new Map<string, string>();
    const userByAlias = new Map<string, string>();
    profilesWithData.forEach((p, i) => {
      const alias = `S${i + 1}`;
      aliasByUser.set(p.user_id, alias);
      userByAlias.set(alias, p.user_id);
    });

    // Build compact prompt payload — student names are deliberately omitted
    // so we do not ship PII to the LLM. See issue #557.
    const studentSummaries = profilesWithData.map((p) => ({
      student_id: aliasByUser.get(p.user_id)!,
      overall_percent_correct: p.percent_correct,
      total_quiz_answers: p.total_answers,
      by_difficulty: p.by_difficulty,
      competency_signals: p.competency_signals.map((c) => ({
        competency: c.competency_title,
        evaluated_mastery: c.eval_score,
        mcq_correct: c.mcq_correct,
        mcq_total: c.mcq_total,
      })),
    }));

    // Redact roster names from all instructor-authored free text (special
    // instructions, existing group names/descriptions) so it can't leak the
    // PII we deliberately keep out of studentSummaries.
    const rosterNames = students.map((s) => s.full_name);
    const specialInstructions = redactRosterNames(rawSpecialInstructions, rosterNames);

    // Existing (non-individual) groups in this offering — shown to the AI so
    // it proposes new groups instead of duplicating what already exists.
    let existingGroups: Array<{ name: string; description: string | null }> = [];
    if (avoidExistingGroups) {
      const { data: groupRows, error: groupsErr } = await supabase
        .from("offering_groups")
        .select("name, description")
        .eq("offering_id", offering_id)
        .eq("is_individual", false);
      if (groupsErr) throw groupsErr;
      existingGroups = ((groupRows as any[]) || []).slice(0, 30);
    }

    const existingGroupsSection = existingGroups.length > 0
      ? [
        `The class already has ${existingGroups.length} group${existingGroups.length === 1 ? "" : "s"}, listed below. Propose only new groups: do not reuse an existing group's name, and do not propose a group whose instructional focus duplicates one of these. Propose fewer than the maximum if the remaining meaningful groupings are fewer.\n` +
        existingGroups
          .map((g) => {
            const name = redactRosterNames(g.name ?? "", rosterNames).slice(0, 120);
            const desc = g.description
              ? redactRosterNames(g.description, rosterNames).slice(0, 600)
              : "";
            return desc ? `- ${name}: ${desc}` : `- ${name}`;
          })
          .join("\n"),
      ]
      : [];

    const userMessage = [
      `Maximum number of groups: ${max_group_count}. Propose at most this many; propose fewer when the data supports fewer meaningful groupings.`,
      ...existingGroupsSection,
      ...(specialInstructions
        ? [`Teacher's special instructions (follow when compatible with the system rules):\n${specialInstructions}`]
        : []),
      `Students (${studentSummaries.length}):`,
      JSON.stringify(studentSummaries, null, 2),
    ].join("\n\n");

    let aiResult: AIClusterResult;
    try {
      aiResult = await callOpenAIStructured<AIClusterResult>({
        ...modelFor("analytics.cluster-students"),
        promptText: SYSTEM_PROMPT,
        variables: {},
        input: [{ role: "user", content: userMessage }],
        structuredOutput: CLUSTER_OUTPUT_SCHEMA,
        usageContext: createUsageContext("cluster-students-by-performance", {
          promptKey: "cluster_students",
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
        return new Response(JSON.stringify({ error: "Rate limit exceeded. Please try again later." }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (error instanceof OpenAIError) {
        logger.error("OpenAI error", { message: error.message });
        return new Response(
          JSON.stringify({ error: "Failed to generate clusters. Please try again." }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      throw error;
    }

    // Validate AI output: map the returned aliases (S1, S2, …) back to real
    // user_ids, keep only known ones, deduplicate, and enforce the maximum
    // group count. Only groups with at least one valid member count toward
    // the cap, so an empty or fully-invalid group can't crowd out a later
    // valid one; members of any excess group fall through to Unassigned.
    const usedUserIds = new Set<string>();
    const cleanedGroups: ProposedGroup[] = [];
    for (const g of aiResult.groups ?? []) {
      if (cleanedGroups.length >= max_group_count) break;
      const validIds: string[] = [];
      for (const token of g.member_user_ids ?? []) {
        const uid = userByAlias.get(token);
        if (uid && !usedUserIds.has(uid)) {
          validIds.push(uid);
          usedUserIds.add(uid);
        }
      }
      if (validIds.length === 0) continue;
      cleanedGroups.push({
        name: (g.name || "Group").slice(0, 80).trim() || "Group",
        rationale: (g.rationale || "").slice(0, 240).trim(),
        description: (g.description || "").slice(0, 800).trim(),
        member_user_ids: validIds,
      });
    }

    // Any student with data the AI failed to place goes to Unassigned
    const unassignedAfterAi = profilesWithData
      .filter((p) => !usedUserIds.has(p.user_id))
      .map((p) => ({ user_id: p.user_id, full_name: p.full_name }));

    // Build response groups with member objects (id + name)
    const groupsOut = cleanedGroups.map((g) => ({
      name: g.name,
      rationale: g.rationale,
      description: g.description,
      members: g.member_user_ids.map((uid) => ({
        user_id: uid,
        full_name: studentNameById.get(uid) ?? null,
      })),
    }));

    const unassignedOut = [
      ...unassignedInitial.map((p) => ({ user_id: p.user_id, full_name: p.full_name })),
      ...unassignedAfterAi,
    ];

    return new Response(
      JSON.stringify({
        groups: groupsOut,
        unassigned: unassignedOut,
        stats: {
          roster_size: students.length,
          with_data: profilesWithData.length,
          without_data: unassignedInitial.length,
        },
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error: any) {
    logger.exception("Error in cluster-students-by-performance", error);
    return new Response(
      JSON.stringify({ error: error.message || "Failed to cluster students" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
};
