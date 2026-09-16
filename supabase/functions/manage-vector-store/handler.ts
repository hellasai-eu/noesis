import "https://deno.land/x/xhr@0.1.0/mod.ts";

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { withLogging, logger } from "../_shared/logger.ts";
import { checkInstitutionAdmin } from "../_shared/institution-authz.ts";
import { callerFromRequest } from "../_shared/course-authz.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

export const handler = withLogging("manage-vector-store", async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const openAIApiKey = Deno.env.get("OPENAI_API_KEY");
    if (!openAIApiKey) {
      throw new Error("OPENAI_API_KEY is not configured");
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      // No session to refresh on a service-role client, and leaving the
      // refresh timer on leaks an interval in the handler tests.
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // `userId` is deliberately no longer read from the body — see the gate below.
    const { action, institutionId, institutionName, courseId } = await req.json();

    // ── Caller gate (#1135) ───────────────────────────────────────────────
    // The only check here was `is_super_admin` against a **body-supplied**
    // `userId`, which authorizes nothing: the caller picks the id being
    // checked, so sending any known super-admin's id passed. Every other
    // action had no check at all.
    //
    // The caller now comes from the bearer token, and each action is
    // authorized against the institution it names.
    const caller = await callerFromRequest(req, supabase);
    if (!caller.ok) {
      return new Response(JSON.stringify({ success: false, error: caller.error, code: caller.code }), {
        status: caller.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // For resync-metadata, we need courseId
    if (action === "resync-metadata") {
      if (!courseId) {
        throw new Error("courseId is required for resync-metadata");
      }

      // Super-admin only, checked against the TOKEN's user.
      const { data: isSuperAdmin } = await supabase.rpc("is_super_admin", {
        _user_id: caller.userId,
      });
      if (!isSuperAdmin) {
        return new Response(
          JSON.stringify({ success: false, error: "Only super admins can resync metadata" }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      logger.info("Resyncing metadata for course", { courseId, userId: caller.userId });

      // Get course and institution info
      const { data: course, error: courseError } = await supabase
        .from("courses")
        .select("id, title, institution_id")
        .eq("id", courseId)
        .single();

      if (courseError || !course) {
        throw new Error(`Failed to fetch course: ${courseError?.message || "Not found"}`);
      }

      // Get institution's vector store
      const { data: institution, error: instError } = await supabase
        .from("institutions")
        .select("vector_store_id")
        .eq("id", course.institution_id)
        .single();

      if (instError || !institution?.vector_store_id) {
        throw new Error("Institution does not have a vector store");
      }

      const vectorStoreId = institution.vector_store_id;

      // Get all materials with openai_file_id for this course
      const { data: materials, error: materialsError } = await supabase
        .from("course_materials")
        .select("id, title, file_name, openai_file_id")
        .eq("course_id", courseId)
        .not("openai_file_id", "is", null);

      if (materialsError) {
        throw new Error(`Failed to fetch materials: ${materialsError.message}`);
      }

      logger.info("Found materials to resync", { count: materials?.length || 0 });

      let updatedCount = 0;
      let errorCount = 0;

      for (const material of materials || []) {
        if (!material.openai_file_id) continue;

        try {
          // Step 1: Remove file from vector store
          const removeResponse = await fetch(
            `https://api.openai.com/v1/vector_stores/${vectorStoreId}/files/${material.openai_file_id}`,
            {
              method: "DELETE",
              headers: {
                Authorization: `Bearer ${openAIApiKey}`,
                "OpenAI-Beta": "assistants=v2",
              },
            }
          );

          if (!removeResponse.ok && removeResponse.status !== 404) {
            logger.warn("Failed to remove file from vector store", { 
              fileId: material.openai_file_id, 
              status: removeResponse.status 
            });
          }

          // Step 2: Re-add file with metadata
          const attributes: Record<string, string> = {
            course_id: courseId,
            course_name: course.title,
            material_id: material.id,
          };
          if (material.title) attributes.material_title = material.title;

          const addResponse = await fetch(
            `https://api.openai.com/v1/vector_stores/${vectorStoreId}/files`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${openAIApiKey}`,
                "Content-Type": "application/json",
                "OpenAI-Beta": "assistants=v2",
              },
              body: JSON.stringify({ 
                file_id: material.openai_file_id,
                attributes 
              }),
            }
          );

          if (addResponse.ok) {
            logger.debug("Resynced file metadata", { fileName: material.file_name, attributes });
            updatedCount++;
          } else {
            const errorText = await addResponse.text();
            logger.error("Failed to re-add file", { fileName: material.file_name, error: errorText });
            errorCount++;
          }
        } catch (e) {
          logger.error("Error resyncing file", { fileName: material.file_name, error: e });
          errorCount++;
        }
      }

      logger.info("Resync metadata complete", { updated: updatedCount, errors: errorCount });

      return new Response(
        JSON.stringify({
          success: true,
          message: `Metadata resync complete: ${updatedCount} updated, ${errorCount} errors`,
          updatedCount,
          errorCount,
          totalMaterials: materials?.length || 0,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!institutionId) {
      throw new Error("institutionId is required");
    }

    logger.info("Managing vector store", { action, institutionId });

    // The remaining actions all act on one institution's vector store.
    // `checkInstitutionAdmin` ORs in super-admin and excludes suspended members
    // (#1082), so it is the whole rule.
    if (!institutionId) {
      return new Response(
        JSON.stringify({ success: false, error: "institutionId is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // A check that could not be PERFORMED is not one that said no (#1155).
    const adminCheck = await checkInstitutionAdmin(supabase, caller.userId, institutionId);
    if (!adminCheck.ok) {
      logger.error("Failed to check institution admin status", { error: adminCheck.error });
      return new Response(
        JSON.stringify({ success: false, error: "Failed to check authorization" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (!adminCheck.allowed) {
      logger.warn("Refused a vector-store action", {
        callerId: caller.userId,
        institutionId,
        action,
      });
      return new Response(
        JSON.stringify({ success: false, error: "Not authorized for this institution" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (action === "create" || action === "sync") {
      // Check if vector store already exists for this institution
      const { data: institution, error: institutionError } = await supabase
        .from("institutions")
        .select("vector_store_id, name")
        .eq("id", institutionId)
        .single();

      if (institutionError) {
        throw new Error(`Failed to fetch institution: ${institutionError.message}`);
      }

      // If vector store already exists, return it
      if (institution.vector_store_id && action !== "sync") {
        logger.info("Institution already has vector store", { vectorStoreId: institution.vector_store_id });
        return new Response(
          JSON.stringify({ 
            success: true, 
            vectorStoreId: institution.vector_store_id,
            message: "Vector store already exists" 
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // If syncing and store exists, verify it exists in OpenAI
      if (institution.vector_store_id && action === "sync") {
        try {
          const checkResponse = await fetch(
            `https://api.openai.com/v1/vector_stores/${institution.vector_store_id}`,
            {
              method: "GET",
              headers: {
                Authorization: `Bearer ${openAIApiKey}`,
                "OpenAI-Beta": "assistants=v2",
              },
            }
          );

          if (checkResponse.ok) {
            logger.info("Vector store verified", { vectorStoreId: institution.vector_store_id });
            return new Response(
              JSON.stringify({ 
                success: true, 
                vectorStoreId: institution.vector_store_id,
                message: "Vector store verified" 
              }),
              { headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
          }
          // If not found, we'll create a new one
          logger.info("Vector store not found in OpenAI, creating new one", { vectorStoreId: institution.vector_store_id });
        } catch (e) {
          logger.warn("Error checking vector store, will create new one", { error: e });
        }
      }

      // Create new vector store in OpenAI
      const vectorStoreName = institutionName || institution.name || `Institution ${institutionId}`;
      logger.info("Creating vector store for institution", { institutionId, name: vectorStoreName });

      const createResponse = await fetch("https://api.openai.com/v1/vector_stores", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openAIApiKey}`,
          "Content-Type": "application/json",
          "OpenAI-Beta": "assistants=v2",
        },
        body: JSON.stringify({
          name: `institution_${institutionId}`,
          metadata: {
            institution_id: institutionId,
            institution_name: vectorStoreName,
          },
          chunking_strategy: {
            type: "static",
            static: {
              max_chunk_size_tokens: 800,
              chunk_overlap_tokens: 150,
            },
          },
        }),
      });

      if (!createResponse.ok) {
        const errorText = await createResponse.text();
        logger.error("OpenAI API error", { status: createResponse.status, error: errorText });
        throw new Error(`OpenAI API error: ${createResponse.status} - ${errorText}`);
      }

      const vectorStore = await createResponse.json();
      logger.info("Created vector store", { vectorStoreId: vectorStore.id });

      // Update institution with vector_store_id
      const { error: updateError } = await supabase
        .from("institutions")
        .update({ vector_store_id: vectorStore.id })
        .eq("id", institutionId);

      if (updateError) {
        logger.error("Failed to update institution", { error: updateError });
        // Try to delete the created vector store to avoid orphans
        await fetch(`https://api.openai.com/v1/vector_stores/${vectorStore.id}`, {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${openAIApiKey}`,
            "OpenAI-Beta": "assistants=v2",
          },
        });
        throw new Error(`Failed to update institution: ${updateError.message}`);
      }

      return new Response(
        JSON.stringify({ 
          success: true, 
          vectorStoreId: vectorStore.id,
          message: "Vector store created successfully" 
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (action === "bulk-sync-files") {
      // Get institution and its vector store
      const { data: institution, error: institutionError } = await supabase
        .from("institutions")
        .select("vector_store_id, name")
        .eq("id", institutionId)
        .single();

      if (institutionError) {
        throw new Error(`Failed to fetch institution: ${institutionError.message}`);
      }

      if (!institution.vector_store_id) {
        throw new Error("Institution does not have a vector store. Create one first.");
      }

      // Get all courses for this institution
      const { data: courses, error: coursesError } = await supabase
        .from("courses")
        .select("id")
        .eq("institution_id", institutionId);

      if (coursesError) {
        throw new Error(`Failed to fetch courses: ${coursesError.message}`);
      }

      const courseIds = courses?.map(c => c.id) || [];

      // Get all materials with openai_file_id for all courses in this institution
      const { data: materials, error: materialsError } = await supabase
        .from("course_materials")
        .select("id, file_name, openai_file_id")
        .in("course_id", courseIds)
        .not("openai_file_id", "is", null);

      if (materialsError) {
        throw new Error(`Failed to fetch materials: ${materialsError.message}`);
      }

      logger.info("Found materials with OpenAI file IDs", { count: materials?.length || 0, courses: courseIds.length });

      // Get existing files in vector store
      const existingFilesResponse = await fetch(
        `https://api.openai.com/v1/vector_stores/${institution.vector_store_id}/files?limit=100`,
        {
          headers: {
            Authorization: `Bearer ${openAIApiKey}`,
            "OpenAI-Beta": "assistants=v2",
          },
        }
      );

      let existingFileIds: Set<string> = new Set();
      if (existingFilesResponse.ok) {
        const existingFilesData = await existingFilesResponse.json();
        existingFileIds = new Set(existingFilesData.data?.map((f: any) => f.id) || []);
        logger.info("Vector store has existing files", { count: existingFileIds.size });
      }

      // Add each file to vector store
      let addedCount = 0;
      let skippedCount = 0;
      let errorCount = 0;

      for (const material of materials || []) {
        if (!material.openai_file_id) continue;

        // Skip if already in vector store
        if (existingFileIds.has(material.openai_file_id)) {
          logger.debug("Skipping file - already in vector store", { fileName: material.file_name });
          skippedCount++;
          continue;
        }

        try {
          const addResponse = await fetch(
            `https://api.openai.com/v1/vector_stores/${institution.vector_store_id}/files`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${openAIApiKey}`,
                "Content-Type": "application/json",
                "OpenAI-Beta": "assistants=v2",
              },
              body: JSON.stringify({ file_id: material.openai_file_id }),
            }
          );

          if (addResponse.ok) {
            logger.debug("Added file to vector store", { fileName: material.file_name });
            addedCount++;
          } else {
            const errorText = await addResponse.text();
            logger.error("Failed to add file", { fileName: material.file_name, status: addResponse.status, error: errorText });
            errorCount++;
          }
        } catch (e) {
          logger.error("Error adding file", { fileName: material.file_name, error: e });
          errorCount++;
        }
      }

      logger.info("Bulk sync complete", { added: addedCount, skipped: skippedCount, errors: errorCount });

      return new Response(
        JSON.stringify({ 
          success: true, 
          message: `Bulk sync complete: ${addedCount} added, ${skippedCount} skipped, ${errorCount} errors`,
          addedCount,
          skippedCount,
          errorCount,
          totalMaterials: materials?.length || 0
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (action === "delete") {
      const { data: institution, error: institutionError } = await supabase
        .from("institutions")
        .select("vector_store_id")
        .eq("id", institutionId)
        .single();

      if (institutionError) {
        throw new Error(`Failed to fetch institution: ${institutionError.message}`);
      }

      if (institution.vector_store_id) {
        // Delete from OpenAI
        const deleteResponse = await fetch(
          `https://api.openai.com/v1/vector_stores/${institution.vector_store_id}`,
          {
            method: "DELETE",
            headers: {
              Authorization: `Bearer ${openAIApiKey}`,
              "OpenAI-Beta": "assistants=v2",
            },
          }
        );

        if (!deleteResponse.ok && deleteResponse.status !== 404) {
          logger.warn("Failed to delete from OpenAI", { status: deleteResponse.status });
        }

        // Clear vector_store_id from institution
        await supabase
          .from("institutions")
          .update({ vector_store_id: null })
          .eq("id", institutionId);
      }

      logger.info("Vector store deleted", { institutionId });

      return new Response(
        JSON.stringify({ success: true, message: "Vector store deleted" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    throw new Error(`Unknown action: ${action}`);
  } catch (error) {
    logger.exception("Error managing vector store", error);
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: error instanceof Error ? error.message : "Unknown error" 
      }),
      { 
        status: 500, 
        headers: { ...corsHeaders, "Content-Type": "application/json" } 
      }
    );
  }
});
