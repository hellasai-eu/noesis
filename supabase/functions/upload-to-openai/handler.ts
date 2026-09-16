import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logger } from "../_shared/logger.ts";
import {
  authorizeCourseManager,
  callerFromRequest,
} from "../_shared/course-authz.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

export const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { action, materialId, filePath, fileName, courseId, openaiFileId, vectorStoreId: providedVectorStoreId } = body;

    // ── Caller gate (#1135) ───────────────────────────────────────────────
    // This writes into an institution's OpenAI vector store using ids from the
    // body, and previously established no caller identity at all.
    //
    // Resolving the governing course, in order of authority:
    //
    //  * `materialId` — the row's own `course_id`. Note the original code let a
    //    body `courseId` OVERRIDE this (`if (!effectiveCourseId)`), so naming a
    //    course you manage while pointing at someone else's material was enough.
    //    The row now wins.
    //  * otherwise `courseId` + `filePath`, for the fresh-upload path where no
    //    material row exists yet (`MaterialUploadDialog` inserts it after this
    //    call). The file must live under that course's own prefix, which is how
    //    `MaterialUploadDialog` writes it — otherwise the pair is unrelated and
    //    naming a course you manage would license uploading anyone's object.
    const gateClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { autoRefreshToken: false, persistSession: false } },
    );

    const caller = await callerFromRequest(req, gateClient);
    if (!caller.ok) {
      return new Response(JSON.stringify({ error: caller.error, code: caller.code }), {
        status: caller.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let ownerCourseId: string | null = null;
    // Every id used AFTER the gate has to come from the resolved material, not
    // from the body. Authorizing on the material's course while still reading
    // the body's `filePath` would let a manager attach any course's PDF to a
    // material they own — the gate would pass and the wrong file would be
    // uploaded and indexed.
    let sourcePath: string | null = null;
    let sourceOpenaiFileId: string | null = null;

    if (materialId) {
      const { data: owningMaterial } = await gateClient
        .from("course_materials")
        .select("course_id, file_url, openai_file_id")
        .eq("id", materialId)
        .maybeSingle();
      if (!owningMaterial) {
        return new Response(JSON.stringify({ error: "Material not found" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const owned = owningMaterial as {
        course_id: string;
        file_url: string | null;
        openai_file_id: string | null;
      };
      ownerCourseId = owned.course_id;
      sourcePath = owned.file_url;
      sourceOpenaiFileId = owned.openai_file_id;

      if (filePath && filePath !== sourcePath) {
        logger.warn("Ignoring a filePath that is not the material's own", {
          callerId: caller.userId,
          materialId,
        });
      }
    } else if (courseId && filePath) {
      if (!String(filePath).startsWith(`${courseId}/`)) {
        logger.warn("filePath does not belong to the named course", { courseId });
        return new Response(JSON.stringify({ error: "Not authorized for this file" }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      ownerCourseId = courseId;
      sourcePath = filePath;
    } else {
      return new Response(
        JSON.stringify({ error: "Provide materialId, or courseId with filePath" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (!ownerCourseId) {
      return new Response(
        JSON.stringify({ error: "Provide materialId, or courseId with filePath" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const authorized = await authorizeCourseManager(gateClient, caller.userId, ownerCourseId);
    if (!authorized.ok) {
      logger.warn("Refused a vector-store write", {
        callerId: caller.userId,
        courseId: ownerCourseId,
      });
      return new Response(JSON.stringify({ error: authorized.error }), {
        status: authorized.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Handle add-to-vector-store action
    if (action === "add-to-vector-store") {
      // The file to index is the material's own, with NO fallback to the body.
      // A previous revision wrote `sourceOpenaiFileId ?? openaiFileId` for
      // backwards compatibility, which reopened the hole one line below the
      // fix: a material whose `openai_file_id` is null would fall through to
      // the caller's id and index foreign content into this institution's
      // store, labelled as the local material.
      //
      // There is nothing legitimate to index for a material that has not been
      // uploaded yet, so that is a refusal rather than a default.
      const fileToIndex = sourceOpenaiFileId;
      if (openaiFileId && openaiFileId !== sourceOpenaiFileId) {
        logger.warn("Ignoring an openaiFileId that is not the material's own", {
          callerId: caller.userId,
          materialId,
        });
      }

      if (!fileToIndex) {
        return new Response(
          JSON.stringify({ error: "This material has no uploaded OpenAI file to index" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      if (!providedVectorStoreId) {
        return new Response(JSON.stringify({ error: "Missing required parameters: openaiFileId, vectorStoreId" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
      if (!OPENAI_API_KEY) {
        logger.error("OPENAI_API_KEY is not configured");
        return new Response(JSON.stringify({ error: "OpenAI API key not configured" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      logger.info("Adding file to vector store", { openaiFileId: fileToIndex, materialId });

      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      // No session to refresh on a service-role client, and leaving the
      // refresh timer on leaks an interval in the handler tests.
      auth: { autoRefreshToken: false, persistSession: false },
    });

      // Get material and course info for metadata
      const attributes: Record<string, string> = {};
      if (materialId) {
        const { data: material } = await supabase.from("course_materials").select("course_id, title").eq("id", materialId).single();
        if (material) {
          attributes.material_id = materialId;
          if (material.title) attributes.material_title = material.title;
          if (material.course_id) {
            attributes.course_id = material.course_id;
            const { data: course } = await supabase.from("courses").select("title").eq("id", material.course_id).single();
            if (course?.title) attributes.course_name = course.title;
          }
        }
      }

      // The destination store comes from the authorized course's institution,
      // not from `providedVectorStoreId`. Gating the caller on the material's
      // course is not enough on its own: it leaves the *target* caller-chosen,
      // so a manager could push their own material into another institution's
      // index — cross-tenant pollution, and retrievable by that tenant.
      const { data: ownerCourse } = await supabase
        .from("courses")
        .select("institution_id")
        .eq("id", ownerCourseId)
        .maybeSingle();

      const ownerInstitutionId = (ownerCourse as { institution_id: string } | null)
        ?.institution_id;
      if (!ownerInstitutionId) {
        return new Response(JSON.stringify({ success: false, error: "Course not found" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { data: ownerInstitution } = await supabase
        .from("institutions")
        .select("vector_store_id")
        .eq("id", ownerInstitutionId)
        .maybeSingle();

      const targetVectorStoreId = (ownerInstitution as { vector_store_id: string | null } | null)
        ?.vector_store_id;
      if (!targetVectorStoreId) {
        return new Response(
          JSON.stringify({ success: false, error: "Institution does not have a vector store" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      if (providedVectorStoreId && providedVectorStoreId !== targetVectorStoreId) {
        logger.warn("Ignoring a vectorStoreId that is not the material's own", {
          callerId: caller.userId,
          courseId: ownerCourseId,
        });
      }

      const vectorStoreResponse = await fetch(`https://api.openai.com/v1/vector_stores/${targetVectorStoreId}/files`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
          "OpenAI-Beta": "assistants=v2",
        },
        body: JSON.stringify({ file_id: fileToIndex, attributes }),
      });

      if (!vectorStoreResponse.ok) {
        const errorText = await vectorStoreResponse.text();
        logger.error("Error adding to vector store", { status: vectorStoreResponse.status, error: errorText });
        return new Response(JSON.stringify({ success: false, error: `Failed to add to vector store: ${errorText}` }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const result = await vectorStoreResponse.json();
      logger.info("File added to vector store", { fileId: fileToIndex, status: result.status });

      return new Response(JSON.stringify({ success: true, status: result.status }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Original upload flow
    if (!sourcePath || !fileName) {
      return new Response(JSON.stringify({ error: "Missing required parameters: filePath, fileName" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
    if (!OPENAI_API_KEY) {
      logger.error("OPENAI_API_KEY is not configured");
      return new Response(JSON.stringify({ error: "OpenAI API key not configured" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    logger.info("Uploading to OpenAI", { materialId, fileName, courseId });

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      // No session to refresh on a service-role client, and leaving the
      // refresh timer on leaks an interval in the handler tests.
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const endDownloadTimer = logger.startTimer("download-file");
    const { data: fileData, error: downloadError } = await supabase.storage.from("course-materials").download(sourcePath);
    endDownloadTimer();

    if (downloadError || !fileData) {
      logger.error("Error downloading file", { error: downloadError?.message });
      return new Response(JSON.stringify({ error: "Failed to download file from storage" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    logger.info("File downloaded", { size: fileData.size });

    const formData = new FormData();
    formData.append("purpose", "assistants");
    formData.append("file", fileData, fileName);

    const endUploadTimer = logger.startTimer("upload-to-openai");
    const openaiResponse = await fetch("https://api.openai.com/v1/files", { method: "POST", headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }, body: formData });
    endUploadTimer();

    if (!openaiResponse.ok) {
      const errorText = await openaiResponse.text();
      logger.error("OpenAI API error", { status: openaiResponse.status, error: errorText });
      return new Response(JSON.stringify({ error: `OpenAI API error: ${openaiResponse.status}`, details: errorText }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const openaiData = await openaiResponse.json();
    const uploadedFileId = openaiData.id;

    logger.info("OpenAI file created", { fileId: uploadedFileId });

    if (materialId) {
      const { error: updateError } = await supabase.from("course_materials").update({ openai_file_id: uploadedFileId }).eq("id", materialId);
      if (updateError) logger.error("Error updating material", { error: updateError.message });
      else logger.info("Material updated with OpenAI file ID");
    }

    let vectorStoreId: string | null = null;
    let addedToVectorStore = false;
    const effectiveCourseId = ownerCourseId;
    let materialTitle: string | null = null;
    let courseName: string | null = null;

    if (materialId) {
      const { data: material } = await supabase.from("course_materials").select("course_id, title, author, material_type").eq("id", materialId).single();
      if (material) {
        materialTitle = material.title;
      }
    }

    if (effectiveCourseId) {
      const { data: course } = await supabase.from("courses").select("id, title, institution_id").eq("id", effectiveCourseId).single();
      if (course) {
        courseName = course.title;
        if (course.institution_id) {
          const { data: institution } = await supabase.from("institutions").select("vector_store_id").eq("id", course.institution_id).single();
          vectorStoreId = institution?.vector_store_id;

          if (vectorStoreId) {
            // Build file-level metadata attributes
            const attributes: Record<string, string> = {};
            if (effectiveCourseId) attributes.course_id = effectiveCourseId;
            if (courseName) attributes.course_name = courseName;
            if (materialId) attributes.material_id = materialId;
            if (materialTitle) attributes.material_title = materialTitle;

            logger.info("Adding file to vector store with metadata", { vectorStoreId, attributes });
            const endVectorTimer = logger.startTimer("add-to-vector-store");
            const vectorStoreResponse = await fetch(`https://api.openai.com/v1/vector_stores/${vectorStoreId}/files`, { 
              method: "POST", 
              headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" }, 
              body: JSON.stringify({ file_id: uploadedFileId, attributes }) 
            });
            endVectorTimer();
            if (vectorStoreResponse.ok) { addedToVectorStore = true; logger.info("File added to vector store with metadata"); }
            else {
              /**
               * A file that reached OpenAI but not the store is worse than no
               * file at all (#1222 review).
               *
               * It used to be reported as `success: true, addedToVectorStore:
               * false` — which no caller reads — leaving a file that no search
               * can find, that no vector-store attribute identifies, and that
               * the rollback path therefore cannot prove is ours to delete. The
               * only way to keep that state from existing is not to return it:
               * the upload is undone and the call fails, so the caller retries
               * instead of building a material on an unindexed file.
               *
               * Institutions with NO vector store are untouched — there is
               * nothing to attach to, and that is a configuration, not a fault.
               */
              const errorText = await vectorStoreResponse.text();
              logger.error("Error adding to vector store; undoing the upload", { status: vectorStoreResponse.status, error: errorText });

              const cleanup = await fetch(`https://api.openai.com/v1/files/${uploadedFileId}`, {
                method: "DELETE",
                headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
              }).catch((cleanupError) => {
                logger.error("Failed to undo the upload", {
                  fileId: uploadedFileId,
                  error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
                });
                return null;
              });
              const undone = !!cleanup && cleanup.ok;
              if (!undone) {
                logger.error("Failed to undo the upload", {
                  fileId: uploadedFileId,
                  status: cleanup?.status ?? null,
                });
              }

              // The row was stamped with this id above; it must not keep
              // pointing at a file that has just been deleted.
              if (materialId) {
                await supabase.from("course_materials").update({ openai_file_id: null }).eq("id", materialId);
              }

              /**
               * When the compensating delete ALSO fails, the id goes back to
               * the caller (#1222 review) — in the message, so it reaches the
               * person on the screen, and as a field for anything programmatic.
               *
               * Note what this does not do: it does not let the caller clean
               * the file up. An unindexed file has no `course_id` stamp, so
               * `delete-orphan` refuses it by design, and loosening that is the
               * cross-tenant hole again. What the id buys is a specific thing
               * to hand an administrator instead of "something went wrong" —
               * the server log has it either way, but nobody reads logs on
               * behalf of a teacher mid-import.
               */
              return new Response(
                JSON.stringify({
                  error: undone
                    ? "Uploaded file could not be indexed for search. Please try again."
                    : `Uploaded file could not be indexed for search, and the leftover file could not be removed (id ${uploadedFileId}). Please try again and tell an administrator.`,
                  ...(undone ? {} : { orphanedOpenAIFileId: uploadedFileId }),
                }),
                { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
              );
            }
          }
        }
      }
    }

    return new Response(JSON.stringify({ success: true, openaiFileId: uploadedFileId, fileName: openaiData.filename, bytes: openaiData.bytes, purpose: openaiData.purpose, addedToVectorStore, vectorStoreId }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (error) {
    logger.exception(error as Error, "Error in upload-to-openai");
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
};
