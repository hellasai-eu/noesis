// Wipes every student's progress on a single open question across the five
// open-question tables and records an audit row. Invoked when an instructor
// flips a question's answering_mode (#596), since the two modes are not
// interoperable.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logger } from "../_shared/logger.ts";
import {
  checkActiveCourseInstructor,
  checkInstitutionAdmin,
} from "../_shared/institution-authz.ts";
import {
  AAL2_REQUIRED_CODE,
  AAL2_REQUIRED_MESSAGE,
  callerMfaSatisfied,
} from "../_shared/require-aal2.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type Mode = "interactive" | "single";

function isMode(value: unknown): value is Mode {
  return value === "interactive" || value === "single";
}

export const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { questionId, priorMode, newMode } = await req.json();

    if (!questionId || !isMode(priorMode) || !isMode(newMode)) {
      return new Response(
        JSON.stringify({ error: "Missing or invalid required parameters" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (priorMode === newMode) {
      return new Response(
        JSON.stringify({ error: "Prior and new modes are identical" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const authHeader = req.headers.get("authorization");
    const token = authHeader?.replace("Bearer ", "");
    if (!token) {
      return new Response(JSON.stringify({ error: "Missing authorization" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user?.id) {
      return new Response(JSON.stringify({ error: "Invalid authorization" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Service-role client, so RLS's aal2 enforcement never runs here — refuse
    // an MFA-enrolled caller whose token is still aal1.
    if (!callerMfaSatisfied(user, token)) {
      return new Response(JSON.stringify({ error: AAL2_REQUIRED_MESSAGE, code: AAL2_REQUIRED_CODE }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userId = user.id;

    // Load the question's course so we can authorize and audit.
    const { data: question, error: questionErr } = await supabase
      .from("questions")
      .select("course_id, courses!inner(institution_id)")
      .eq("id", questionId)
      .eq("type", "open")
      .maybeSingle();

    if (questionErr || !question) {
      return new Response(JSON.stringify({ error: "Question not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    // PostgREST types a to-one embed as an array, and returns an object at
    // runtime. The previous cast asserted the object shape directly, which
    // TypeScript rejects as non-overlapping — so the handler carried a standing
    // type error that only surfaced once it gained a test (#1099). Handle both
    // shapes, as `verify-question-enrollment.ts` already does.
    const questionRow = question as {
      course_id: string;
      courses: { institution_id: string } | { institution_id: string }[] | null;
    };
    const courseId = questionRow.course_id;
    const courseRow = Array.isArray(questionRow.courses)
      ? questionRow.courses[0]
      : questionRow.courses;
    const institutionId = courseRow?.institution_id;

    if (!institutionId) {
      logger.error("Question resolved to no institution", { questionId });
      return new Response(JSON.stringify({ error: "Question not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Authorization: super-admin, non-suspended institution admin, or an
    // instructor of the course whose membership is live (#1082).
    // `isInstitutionAdmin` folds in the super-admin case, so the separate
    // `is_super_admin` RPC this used to make is gone.
    //
    // A check that could not be PERFORMED is not one that said no (#1155): a
    // database fault answered as 403 reports a server problem as a permission
    // one, and names a legitimate admin as an intruder in the log.
    const adminCheck = await checkInstitutionAdmin(supabase, userId, institutionId);
    if (!adminCheck.ok) {
      logger.error("Failed to check institution admin status", { error: adminCheck.error });
      return new Response(JSON.stringify({ error: "Failed to check authorization" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const isAdmin = adminCheck.allowed;

    let isCourseInstructor = false;
    if (!isAdmin) {
      const instructorCheck = await checkActiveCourseInstructor(
        supabase,
        userId,
        courseId,
        institutionId,
      );
      if (!instructorCheck.ok) {
        logger.error("Failed to check course instructor status", {
          error: instructorCheck.error,
        });
        return new Response(JSON.stringify({ error: "Failed to check authorization" }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      isCourseInstructor = instructorCheck.allowed;
    }

    if (!isAdmin && !isCourseInstructor) {
      return new Response(JSON.stringify({ error: "Not authorized" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Course-wide by design (#1162) ─────────────────────────────────────
    // The RPC below deletes by `open_question_id` alone — every chat, grade and
    // progress row for this question, for every student who answered it, across
    // every section (20260622000000_open_answering_mode.sql:96-130). A
    // section-restricted instructor changing a question's mode therefore erases
    // work belonging to sections they do not teach.
    //
    // That is accepted rather than prevented, and the reasoning is worth
    // keeping because it is not obvious:
    //
    // A section check here has to answer "whose work is about to be deleted",
    // and there is no reliable way to ask that from current state. Publication
    // does not answer it — unpublish a section and its students' rows survive,
    // keyed by the question. Nor does enrollment: a student who has since left
    // or moved section carries work that is still attributed to wherever they
    // are now, or to nowhere. Every version of the query protects the sections
    // that exist today rather than the ones whose work is at stake, so each one
    // is a check that looks sound and is not.
    //
    // The honest fix is to scope the deletion itself — make the RPC take a
    // caller and filter — which is a migration, not a gate. Until then this is
    // an admin-shaped action performed by instructors, and the confirmation in
    // `OpenQuestionsTable` says so in as many words.

    // Atomic wipe via the SECURITY DEFINER RPC defined in
    // supabase/migrations/20260622000000_open_answering_mode.sql.
    const { data: deletedCounts, error: rpcError } = await supabase.rpc(
      "reset_open_question_progress",
      { _question_id: questionId },
    );

    if (rpcError) {
      logger.error("reset_open_question_progress failed", { error: rpcError.message, questionId });
      return new Response(JSON.stringify({ error: "Failed to reset progress" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { error: auditError } = await supabase
      .from("open_question_mode_changes")
      .insert({
        question_id: questionId,
        course_id: courseId,
        changed_by: userId,
        prior_mode: priorMode,
        new_mode: newMode,
        deleted_counts: deletedCounts ?? {},
      });
    if (auditError) {
      // The wipe already happened — log the audit failure but don't error
      // the caller, since their state is now ahead of the audit log either
      // way and they need to know the wipe succeeded.
      logger.error("Failed to insert mode-change audit row", {
        error: auditError.message,
        questionId,
        userId,
      });
    }

    return new Response(
      JSON.stringify({ ok: true, deletedCounts: deletedCounts ?? {} }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    logger.exception(error as Error, "reset-open-question-progress error");
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
};
