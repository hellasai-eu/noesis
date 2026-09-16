import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logger } from "../_shared/logger.ts";
import { validateGeneratedAnswers, GeneratedQuestionForValidation } from "../_shared/answer-validator.ts";
import {
  mcqCorrectIndexFromAnswerKey,
  mcqOptionsFromPayload,
} from "../_shared/question-payload.ts";
import {
  AAL2_REQUIRED_CODE,
  AAL2_REQUIRED_MESSAGE,
  callerMfaSatisfied,
} from "../_shared/require-aal2.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface QuestionToValidate {
  id: string;
  /** The row's real question type — see the map below and #1060. */
  type: "mcq" | "open" | "fill_gaps" | "ordering" | "classification";
  question: string;
  payload: Record<string, unknown> | null;
  answer_key: Record<string, unknown> | null;
  explanation: string | null;
  course_id: string;
}

interface ValidationResultItem {
  questionId: string;
  question: string;
  markedAnswer: string;
  verdict: string;
  confidence: number;
  message: string;
  passed: boolean;
}

/**
 * May `userId` manage the questions of `courseId`? Super-admin, institution
 * admin, or an assigned instructor — and in every case NOT suspended.
 *
 * Suspension is deliberately checked through the database's own boundary
 * rather than re-implemented here. `is_institution_admin` requires
 * `NOT is_suspended` and folds in `is_super_admin`
 * (migrations/20260323000000_add_is_suspended.sql:19-32), and that migration's
 * comment is explicit that putting the check there is what makes it cascade to
 * every dependent policy. A role-only `user_institutions` lookup silently opts
 * out of that cascade.
 *
 * The instructor branch needs its own suspension check: `course_instructors`
 * carries no such column, so a suspended user keeps their course assignment
 * and would otherwise still pass.
 */
async function isAuthorizedCourseManager(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  userId: string,
  courseId: string,
): Promise<boolean> {
  const { data: course } = await supabase
    .from("courses")
    .select("institution_id")
    .eq("id", courseId)
    .maybeSingle();
  if (!course) return false;
  const institutionId = (course as { institution_id: string }).institution_id;

  const { data: isInstAdmin } = await supabase.rpc("is_institution_admin", {
    _user_id: userId,
    _institution_id: institutionId,
  });
  if (isInstAdmin === true) return true;

  // Instructors: membership must exist AND be unsuspended before the course
  // assignment counts for anything.
  const { data: membership } = await supabase
    .from("user_institutions")
    .select("is_suspended")
    .eq("user_id", userId)
    .eq("institution_id", institutionId)
    .maybeSingle();
  if (!membership || (membership as { is_suspended: boolean }).is_suspended) return false;

  const { data: instructorRow } = await supabase
    .from("course_instructors")
    .select("user_id")
    .eq("course_id", courseId)
    .eq("user_id", userId)
    .maybeSingle();
  return !!instructorRow;
}

export const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { questionIds } = await req.json();

    if (!questionIds || !Array.isArray(questionIds) || questionIds.length === 0) {
      return new Response(
        JSON.stringify({ error: "questionIds array is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    logger.info("Validating questions", { count: questionIds.length });

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // AUTHORIZE THE CALLER BEFORE READING OR WRITING ANYTHING.
    //
    // This handler runs on the service-role key and updates rows chosen purely
    // by caller-supplied ids, and `verify_jwt = false` means Supabase does not
    // gate it either — so without this block anyone who can reach the URL could
    // overwrite `validation_status` for any question in any institution. That
    // is not cosmetic: AssessmentQuestionBank hides MCQs that are not CORRECT
    // above 0.7 confidence, and the student practice query drops INCORRECT
    // rows, so a forged verdict can hide a good question or surface a bad one.
    //
    // The gap predates this code but was unreachable in practice while nothing
    // called the function; #1081 wires up a live caller, so it is fixed here
    // rather than shipped alongside a new entry point.
    const authHeader = req.headers.get("authorization");
    const token = authHeader?.replace(/^Bearer\s+/i, "").trim();
    if (!token) {
      return new Response(
        JSON.stringify({ error: "Missing authorization" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user?.id) {
      return new Response(
        JSON.stringify({ error: "Invalid authorization" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Service-role client, so RLS's aal2 enforcement never runs here — refuse
    // an MFA-enrolled caller whose token is still aal1.
    if (!callerMfaSatisfied(user, token)) {
      return new Response(
        JSON.stringify({ error: AAL2_REQUIRED_MESSAGE, code: AAL2_REQUIRED_CODE }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Fetch WITHOUT the type filter first, so authorization is decided on the
    // rows actually addressed. Filtering to mcq up front would let an
    // unauthorized caller probe other institutions' ids through the difference
    // between 403 and 404.
    const { data: addressed, error: fetchError } = await supabase
      .from("questions")
      .select("id, type, question, payload, answer_key, explanation, course_id")
      .in("id", questionIds);

    if (fetchError) {
      logger.error("Error fetching questions", { error: fetchError });
      throw new Error("Failed to fetch questions");
    }

    if (!addressed || addressed.length === 0) {
      return new Response(
        JSON.stringify({ error: "No questions found with the provided IDs" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Every distinct course touched must be one this caller manages — a mixed
    // batch is rejected outright rather than partially applied.
    const courseIds = [
      ...new Set((addressed as QuestionToValidate[]).map((q) => q.course_id).filter(Boolean)),
    ];
    for (const cid of courseIds) {
      if (!(await isAuthorizedCourseManager(supabase, user.id, cid))) {
        logger.warn("Rejected unauthorized validation request", {
          userId: user.id,
          courseId: cid,
        });
        return new Response(
          JSON.stringify({ error: "Not authorized for these questions" }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // Only MCQs carry a rubric this validator can judge. Non-MCQ rows are
    // reported honestly rather than silently dropped into the 404 above, which
    // read as "these ids do not exist".
    const questions = (addressed as QuestionToValidate[]).filter((q) => q.type === "mcq");
    if (questions.length === 0) {
      return new Response(
        JSON.stringify({
          error: "Validation currently supports multiple-choice questions only",
          unsupported_type: true,
        }),
        { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    logger.info("Fetched questions for validation", { found: questions.length, requested: questionIds.length });

    // Get course and institution info for usage tracking
    const courseId = questions[0].course_id;
    const { data: course } = await supabase
      .from("courses")
      .select("institution_id")
      .eq("id", courseId)
      .single();

    const institutionId = course?.institution_id || null;

    // Pass the row's REAL type through. This used to hard-code "mcq" for every
    // row (#1060), so an ordering or fill-gaps question was relabelled before
    // the validator could route it and came back judged by the MCQ rubric.
    // validateGeneratedAnswers now passes non-MCQ types through with an honest
    // "not validated for this type" verdict instead of inventing one.
    const questionsForValidation: GeneratedQuestionForValidation[] = questions.map((q: QuestionToValidate) => ({
      id: q.id,
      question: q.question,
      type: q.type,
      payload: q.payload,
      answer_key: q.answer_key,
      explanation: q.explanation || "",
    }));

    // Call the validator (passing courseId for institution-specific prompt override)
    const validationResult = await validateGeneratedAnswers(questionsForValidation, {
      functionName: "validate-questions",
      promptKey: "answer_validation",
      institutionId: institutionId,
      courseId: courseId,
    });

    logger.info("Validation complete", {
      total: questions.length,
      valid: validationResult.valid.length,
      filtered: validationResult.filtered.length,
    });

    // Build results array and update database
    const results: ValidationResultItem[] = [];
    const now = new Date().toISOString();

    for (const vr of validationResult.validationResults) {
      const questionId = (vr.question as any).id;
      const options = mcqOptionsFromPayload(vr.question.payload);
      const correctIndex = mcqCorrectIndexFromAnswerKey(vr.question.answer_key);
      const result: ValidationResultItem = {
        questionId,
        question: vr.question.question,
        markedAnswer: correctIndex >= 0 ? (options[correctIndex] || `Option ${correctIndex + 1}`) : "Unknown",
        verdict: vr.verdict.verdict,
        confidence: vr.verdict.confidence,
        message: vr.verdict.message,
        passed: vr.passed,
      };
      results.push(result);

      // Update the question in database with validation status
      const { error: updateError } = await supabase
        .from("questions")
        .update({
          validation_status: vr.verdict.verdict,
          validation_confidence: vr.verdict.confidence,
          validation_message: vr.verdict.message,
          validated_at: now,
        })
        .eq("id", questionId);

      if (updateError) {
        logger.warn("Failed to update question validation status", { questionId, error: updateError });
      }
    }

    return new Response(
      JSON.stringify({
        results,
        summary: {
          total: results.length,
          valid: validationResult.valid.length,
          filtered: validationResult.filtered.length,
        },
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    logger.exception("Error in validate-questions", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
};
