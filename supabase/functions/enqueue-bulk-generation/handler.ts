/**
 * Enqueue a `bulk_question_generation` job (issue #698).
 *
 * The browser cannot insert directly into `public.jobs` — the table has no
 * INSERT RLS policy by design (writes go through service-role workers per
 * #694). This function is the thin authenticated front-door: it verifies the
 * caller is a course manager for the scoped course, validates `params`
 * against the same shape the handler will eventually parse (#697), blocks a
 * second concurrent run for the same course, inserts the row, and fires the
 * job runner so the work starts immediately.
 *
 * The function returns 202 + the new `jobId` as soon as the row is in
 * `pending` state. The dialog can close immediately; the runner takes over.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logger } from "../_shared/logger.ts";
import {
  checkActiveCourseInstructor,
  checkInstitutionAdmin,
} from "../_shared/institution-authz.ts";
import {
  BULK_QUESTION_GENERATION_JOB_TYPE,
  parseBulkParams,
} from "../_shared/job-handlers/bulk-question-generation.ts";
import {
  AAL2_REQUIRED_CODE,
  AAL2_REQUIRED_MESSAGE,
  callerMfaSatisfied,
} from "../_shared/require-aal2.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

/**
 * Hard upper bound on items (chapters × types). Matches the UI cap so a
 * caller bypassing the dialog can't enqueue a runaway job. Costs scale
 * linearly with this number — every item is one OpenAI call.
 */
export const MAX_ITEMS_PER_JOB = 300;

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function isAuthorizedCourseManager(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  userId: string,
  courseId: string,
): Promise<
  { ok: true; institutionId: string } | { ok: false; status: number; error: string }
> {
  const { data: course, error: courseErr } = await supabase
    .from("courses")
    .select("id, institution_id")
    .eq("id", courseId)
    .maybeSingle();
  if (courseErr || !course) {
    return { ok: false, status: 404, error: "Course not found" };
  }
  const institutionId = (course as { institution_id: string }).institution_id;

  // Suspension-aware, and covers super-admin: `is_institution_admin` ORs in
  // `is_super_admin`, so the separate RPC this used to make is gone (#1082).
  // A check that could not be PERFORMED is not one that said no (#1155).
  const admin = await checkInstitutionAdmin(supabase, userId, institutionId);
  if (!admin.ok) {
    return { ok: false, status: 500, error: "Failed to check authorization" };
  }
  if (admin.allowed) {
    return { ok: true, institutionId };
  }

  // Membership is checked inside — `course_instructors` has no suspension
  // column, so a suspended user keeps the assignment.
  const instructor = await checkActiveCourseInstructor(
    supabase,
    userId,
    courseId,
    institutionId,
  );
  if (!instructor.ok) {
    return { ok: false, status: 500, error: "Failed to check authorization" };
  }
  if (instructor.allowed) {
    return { ok: true, institutionId };
  }

  return { ok: false, status: 403, error: "Not authorized for this course" };
}

/**
 * Fire-and-forget POST to the run-jobs worker so the new job is picked up
 * without waiting for the next pg_cron tick (#762) — an instant-kickoff
 * optimization on top of the heartbeat. Wrapped in `EdgeRuntime.waitUntil`
 * so the Deno edge runtime keeps the isolate alive after the 202 response
 * closes; without it the isolate can terminate before the POST is delivered
 * and the initial kick is lost (#786). Failures are logged but never block
 * the response, since the next cron tick (≤60s away) will claim the row.
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

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return jsonResponse(
      { error: "Server misconfigured: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing" },
      500,
    );
  }
  const supabase = createClient(supabaseUrl, serviceKey);

  const authHeader = req.headers.get("authorization");
  const token = authHeader?.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    return jsonResponse({ error: "Missing authorization" }, 401);
  }
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user?.id) {
    return jsonResponse({ error: "Invalid authorization" }, 401);
  }

  // Service-role client, so RLS's aal2 enforcement never runs here — refuse
  // an MFA-enrolled caller whose token is still aal1.
  if (!callerMfaSatisfied(user, token)) {
    return jsonResponse({ error: AAL2_REQUIRED_MESSAGE, code: AAL2_REQUIRED_CODE }, 403);
  }

  let rawParams: unknown;
  try {
    rawParams = await req.json();
  } catch {
    return jsonResponse({ error: "Body must be JSON" }, 400);
  }

  let parsed;
  try {
    parsed = parseBulkParams(rawParams);
  } catch (err) {
    return jsonResponse(
      { error: (err as Error).message ?? "Invalid params" },
      400,
    );
  }

  // Hard cap on fan-out so the dialog can't be bypassed.
  const itemCount = parsed.chapterIds.length * parsed.types.length;
  if (itemCount > MAX_ITEMS_PER_JOB) {
    return jsonResponse(
      {
        error: `Too many items: ${itemCount} exceeds the limit of ${MAX_ITEMS_PER_JOB} (chapters × types). Reduce chapters or types.`,
      },
      400,
    );
  }

  const auth = await isAuthorizedCourseManager(supabase, user.id, parsed.courseId);
  if (!auth.ok) {
    return jsonResponse({ error: auth.error }, auth.status);
  }

  // Block a second active bulk job for the same course. Two managers
  // launching at once would double-spend OpenAI budget and race each other
  // through `insertGeneratedQuestions`; the AC says only one at a time.
  const { data: existing, error: existingErr } = await supabase
    .from("jobs")
    .select("id, status")
    .eq("course_id", parsed.courseId)
    .eq("type", BULK_QUESTION_GENERATION_JOB_TYPE)
    .in("status", ["pending", "processing"])
    .limit(1);
  if (existingErr) {
    logger.error("enqueue-bulk-generation: existing-job lookup failed", {
      error: existingErr.message,
    });
    return jsonResponse({ error: "Failed to check existing jobs" }, 500);
  }
  if (existing && existing.length > 0) {
    return jsonResponse(
      {
        error: "A bulk generation job is already running for this course",
        existingJobId: existing[0].id,
      },
      409,
    );
  }

  const { data: inserted, error: insertErr } = await supabase
    .from("jobs")
    .insert({
      type: BULK_QUESTION_GENERATION_JOB_TYPE,
      status: "pending",
      params: parsed,
      created_by: user.id,
      institution_id: auth.institutionId,
      course_id: parsed.courseId,
    })
    .select("id")
    .single();

  if (insertErr || !inserted) {
    logger.error("enqueue-bulk-generation: insert failed", {
      error: insertErr?.message ?? "unknown",
    });
    return jsonResponse({ error: "Failed to enqueue job" }, 500);
  }

  triggerRunner(supabaseUrl, serviceKey);

  logger.info("enqueue-bulk-generation: job enqueued", {
    jobId: inserted.id,
    courseId: parsed.courseId,
    types: parsed.types.length,
    chapters: parsed.chapterIds.length,
    items: itemCount,
  });

  return jsonResponse({ jobId: inserted.id, itemCount }, 202);
};
