import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { checkInstitutionAdmin } from "../_shared/institution-authz.ts";
import { logger } from "../_shared/logger.ts";
import {
  AAL2_REQUIRED_CODE,
  AAL2_REQUIRED_MESSAGE,
  callerMfaSatisfied,
} from "../_shared/require-aal2.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface RolloverRequest {
  institution_id: string;
  new_academic_period: string;
}

export const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { institution_id, new_academic_period }: RolloverRequest = await req.json();

    if (!institution_id || !new_academic_period) {
      return new Response(
        JSON.stringify({ success: false, error: "institution_id and new_academic_period are required" }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } },
      );
    }

    logger.info("Starting academic year rollover", { institution_id, new_academic_period });

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Verify the caller is admin for the institution
    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ success: false, error: "Authorization required" }),
        { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } },
      );
    }

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(
        JSON.stringify({ success: false, error: "Invalid authentication" }),
        { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } },
      );
    }

    // Service-role client, so RLS's aal2 enforcement never runs here — refuse
    // an MFA-enrolled caller whose token is still aal1.
    if (!callerMfaSatisfied(user, token)) {
      return new Response(
        JSON.stringify({ error: AAL2_REQUIRED_MESSAGE, code: AAL2_REQUIRED_CODE }),
        { status: 403, headers: { "Content-Type": "application/json", ...corsHeaders } },
      );
    }

    // Admin gate. `checkInstitutionAdmin` goes through the database boundary, so
    // it honours `is_suspended` — the direct `user_institutions.role` read this
    // replaces did not, and a suspended admin could roll an institution's
    // academic year over (#1082). It also ORs in `is_super_admin`, which is what
    // the `profiles.is_super_admin` fallback here was doing by hand.
    // A check that could not be PERFORMED is not one that said no (#1155).
    const adminCheck = await checkInstitutionAdmin(supabase, user.id, institution_id);
    if (!adminCheck.ok) {
      logger.error("Failed to check institution admin status", { error: adminCheck.error });
      return new Response(
        JSON.stringify({ success: false, error: "Failed to check authorization" }),
        { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } },
      );
    }
    if (!adminCheck.allowed) {
      return new Response(
        JSON.stringify({ success: false, error: "Admin access required" }),
        { status: 403, headers: { "Content-Type": "application/json", ...corsHeaders } },
      );
    }

    // Step 1: Update institution's academic_period
    const { error: updateError } = await supabase
      .from("institutions")
      .update({ academic_period: new_academic_period })
      .eq("id", institution_id);

    if (updateError) throw updateError;

    // Step 2: Fetch all active sections for the institution
    const { data: activeSections, error: fetchError } = await supabase
      .from("classes")
      .select("id, name, grade_level_id, section_name, category, allow_self_enrollment, academic_period")
      .eq("institution_id", institution_id)
      .eq("is_active", true);

    if (fetchError) throw fetchError;

    if (!activeSections || activeSections.length === 0) {
      return new Response(
        JSON.stringify({
          success: true,
          data: { archived_count: 0, created_count: 0, offerings_copied: 0 },
        }),
        { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } },
      );
    }

    // Step 3: Archive all active sections
    const oldSectionIds = activeSections.map((s) => s.id);
    const { error: archiveError } = await supabase
      .from("classes")
      .update({ is_active: false })
      .in("id", oldSectionIds);

    if (archiveError) throw archiveError;

    // Step 4: Create new sections with the same grade_level_id + section_name
    // + category (the TEXT `grade_level` column no longer exists after #799).
    const newSections = activeSections.map((s) => ({
      name: s.name,
      institution_id,
      grade_level_id: s.grade_level_id ?? null,
      section_name: s.section_name,
      category: s.category,
      academic_period: new_academic_period,
      is_active: true,
      allow_self_enrollment: s.allow_self_enrollment,
    }));

    const { data: createdSections, error: createError } = await supabase
      .from("classes")
      .insert(newSections)
      .select("id, grade_level_id, section_name, category");

    if (createError) throw createError;

    // Step 5: Fetch offerings from old sections
    const { data: oldOfferings, error: offeringsError } = await supabase
      .from("offerings")
      .select("class_id, course_id, is_active")
      .in("class_id", oldSectionIds);

    if (offeringsError) throw offeringsError;

    // Step 6: Map old offerings to new sections (match by grade_level_id +
    // category + section_name — FK identity).
    let offeringsCopied = 0;
    if (oldOfferings && oldOfferings.length > 0 && createdSections) {
      // Build lookup: old class_id -> { grade_level_id, section_name, category }
      const oldSectionMap = new Map(
        activeSections.map((s) => [s.id, { grade_level_id: s.grade_level_id, section_name: s.section_name, category: s.category }]),
      );

      // Build lookup: grade_level_id+category+section_name -> new class_id
      const newSectionMap = new Map(
        createdSections.map((s) => [`${s.grade_level_id ?? ""}|${s.category ?? ""}|${s.section_name}`, s.id]),
      );

      const newOfferings = oldOfferings
        .map((o) => {
          const oldInfo = oldSectionMap.get(o.class_id);
          if (!oldInfo) return null;
          const newClassId = newSectionMap.get(`${oldInfo.grade_level_id ?? ""}|${oldInfo.category ?? ""}|${oldInfo.section_name}`);
          if (!newClassId) return null;
          return {
            class_id: newClassId,
            course_id: o.course_id,
            is_active: o.is_active,
          };
        })
        .filter((o): o is NonNullable<typeof o> => o !== null);

      if (newOfferings.length > 0) {
        const { error: copyError } = await supabase.from("offerings").insert(newOfferings);
        if (copyError) throw copyError;
        offeringsCopied = newOfferings.length;
      }
    }

    const result = {
      archived_count: oldSectionIds.length,
      created_count: createdSections?.length || 0,
      offerings_copied: offeringsCopied,
    };

    logger.info("Academic year rollover completed", result);

    return new Response(
      JSON.stringify({ success: true, data: result }),
      { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } },
    );
  } catch (error: any) {
    logger.exception(error, "Error in academic-year-rollover");
    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } },
    );
  }
};
