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
    // `institutionId` is still sent by the caller and deliberately not read —
    // the store to detach from is resolved from the owning course below.
    // `courseId` is read ONLY on the orphan path, where by definition there is
    // no material row to resolve a course from.
    const { openaiFileId, vectorStoreId, action, courseId } = await req.json();

    /**
     * Roll back a file that was uploaded to OpenAI for a material that then
     * failed to be created (#1222).
     *
     * The ordinary path deliberately refuses a file no `course_materials` row
     * owns — an unattributable file is one it declines to touch. That rule is
     * exactly wrong for a rollback: `YouTubeImportDialog` and
     * `MaterialUploadDialog` both upload to OpenAI BEFORE inserting the row, so
     * that a material which never reached OpenAI is never created. When the
     * insert is what fails, the file is orphaned by construction and the
     * ordinary path cannot clean it up.
     *
     * So the ownership rule is inverted rather than dropped: this path deletes
     * ONLY a file that no material owns, and only for a caller who manages the
     * named course. A file that does have an owner is refused here and must go
     * through the ordinary path, which authorizes against that owner — naming
     * a course you manage never licenses deleting another course's file.
     */
    const isOrphanCleanup = action === "delete-orphan";

    if (!openaiFileId) {
      return new Response(
        JSON.stringify({ error: "Missing openaiFileId" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Caller gate (#1135) ───────────────────────────────────────────────
    // Destructive and previously unauthenticated: anyone could evict any
    // course's material from its institution's vector store by naming the file
    // id. The owning course comes from the `course_materials` row that carries
    // this `openai_file_id` — not from the body's `courseId`/`institutionId`,
    // which the caller chooses.
    //
    // The only call site (`CoursePage.handleDeleteMaterial`) runs this while
    // the row still exists, before deleting it. A file we cannot attribute to a
    // course is one we decline to delete.
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { autoRefreshToken: false, persistSession: false } },
    );

    const caller = await callerFromRequest(req, supabaseAdmin);
    if (!caller.ok) {
      return new Response(JSON.stringify({ error: caller.error, code: caller.code }), {
        status: caller.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: owningMaterial, error: owningMaterialError } = await supabaseAdmin
      .from("course_materials")
      .select("course_id")
      .eq("openai_file_id", openaiFileId)
      .limit(1)
      .maybeSingle();

    // A lookup that could not be PERFORMED is not a lookup that found nothing:
    // on the orphan path that difference decides whether a file with a living
    // owner gets deleted, so it fails closed.
    if (owningMaterialError) {
      logger.error("Failed to resolve the owning material; refusing to delete", {
        openaiFileId,
        error: owningMaterialError.message,
      });
      return new Response(JSON.stringify({ error: "Failed to check authorization" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let ownerCourseId: string;

    if (isOrphanCleanup) {
      if (!courseId) {
        return new Response(
          JSON.stringify({ error: "courseId is required to clean up an orphaned file" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      if (owningMaterial) {
        logger.warn("Refusing an orphan cleanup for a file that has an owner", { openaiFileId });
        return new Response(
          JSON.stringify({ error: "This file belongs to a material; delete the material instead" }),
          { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      // A chapter can carry its own `openai_file_id` (`split-chapters` uploads
      // one per chapter), so "no course_materials row owns it" is NOT the same
      // as "nothing owns it". Without this, a manager who learned a chapter
      // file's id could delete another institution's chapter source, which the
      // material-only check would have called an orphan.
      const { data: owningChapter, error: owningChapterError } = await supabaseAdmin
        .from("material_chapters")
        .select("id")
        .eq("openai_file_id", openaiFileId)
        .limit(1)
        .maybeSingle();

      if (owningChapterError) {
        logger.error("Failed to check chapter ownership; refusing to delete", {
          openaiFileId,
          error: owningChapterError.message,
        });
        return new Response(JSON.stringify({ error: "Failed to check authorization" }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (owningChapter) {
        logger.warn("Refusing an orphan cleanup for a file a chapter owns", { openaiFileId });
        return new Response(
          JSON.stringify({ error: "This file belongs to a chapter; delete the material instead" }),
          { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      ownerCourseId = courseId;
    } else {
      if (!owningMaterial) {
        logger.warn("No material owns this OpenAI file; refusing to delete", { openaiFileId });
        return new Response(JSON.stringify({ error: "Material not found" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      ownerCourseId = (owningMaterial as { course_id: string }).course_id;
    }
    const authorized = await authorizeCourseManager(supabaseAdmin, caller.userId, ownerCourseId);
    if (!authorized.ok) {
      logger.warn("Refused an OpenAI file deletion", {
        callerId: caller.userId,
        courseId: ownerCourseId,
      });
      return new Response(JSON.stringify({ error: authorized.error }), {
        status: authorized.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
    if (!OPENAI_API_KEY) {
      logger.error("OPENAI_API_KEY is not configured");
      return new Response(
        JSON.stringify({ error: "OpenAI API key not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    logger.info("Deleting file from OpenAI", { openaiFileId, courseId: ownerCourseId });

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      // No session to refresh on a service-role client, and leaving the
      // refresh timer on leaks an interval in the handler tests.
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // The store to detach from is the owning course's, never the body's.
    //
    // The previous chain was `vectorStoreId` → `institutionId` → `courseId`,
    // every link caller-supplied. Authorizing against the material that owns
    // the file and then detaching from a store the caller names is the same
    // authorize-against-X-act-on-Y shape as the upload path: an authorized
    // manager could evict a file from any institution's index.
    // A failure to RESOLVE the store is not the same as there being none, and
    // the difference matters because the file is deleted from OpenAI globally
    // further down. Swallowing the error would leave the store still pointing
    // at a file that no longer exists. So a lookup error aborts before any
    // deletion — the caller can retry — while a genuine absence of a store
    // just means there is nothing to detach from.
    let effectiveVectorStoreId: string | null = null;

    const { data: ownerCourse, error: ownerCourseError } = await supabase
      .from("courses")
      .select("institution_id")
      .eq("id", ownerCourseId)
      .maybeSingle();

    if (ownerCourseError) {
      logger.error("Failed to resolve the owning course; refusing to delete", {
        courseId: ownerCourseId,
        error: ownerCourseError.message,
      });
      return new Response(
        JSON.stringify({ error: "Failed to resolve the owning vector store" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const ownerInstitutionId = (ownerCourse as { institution_id: string } | null)
      ?.institution_id;
    if (ownerInstitutionId) {
      const { data: institution, error: institutionError } = await supabase
        .from("institutions")
        .select("vector_store_id")
        .eq("id", ownerInstitutionId)
        .maybeSingle();

      if (institutionError) {
        logger.error("Failed to resolve the owning vector store; refusing to delete", {
          institutionId: ownerInstitutionId,
          error: institutionError.message,
        });
        return new Response(
          JSON.stringify({ error: "Failed to resolve the owning vector store" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      effectiveVectorStoreId =
        (institution as { vector_store_id: string | null } | null)?.vector_store_id ?? null;
    }

    if (vectorStoreId && vectorStoreId !== effectiveVectorStoreId) {
      logger.warn("Ignoring a vectorStoreId that is not the material's own", {
        callerId: caller.userId,
        courseId: ownerCourseId,
      });
    }

    /**
     * On the orphan path, prove the file belongs to the course being authorized
     * against — do not merely establish that nothing owns it.
     *
     * Ownership is what the ordinary path gets from the material row. A
     * rollback has no row, so "unowned" was standing in for "yours", and it does
     * not: a manager who learned the id of an orphan left by ANOTHER
     * institution's failed import could name their own course, pass the gate,
     * and have us delete that file from OpenAI globally.
     *
     * `upload-to-openai` stamps `course_id` onto the vector-store file when it
     * indexes it, so the store is the record of which course a file was
     * uploaded for. Requiring that stamp to match is what turns "unowned" back
     * into "yours". A file we cannot attribute is one we decline to delete —
     * the same rule the ordinary path states — so an institution with no vector
     * store gets a refusal rather than an unchecked deletion.
     *
     * That refusal leaves one narrow case unreachable: an institution with no
     * vector store at all, whose upload therefore carries no stamp. It is the
     * right trade. Such a file is in no store, so no tenant can retrieve it and
     * nothing points at it — it is billing clutter, not exposure — whereas
     * relaxing the check to reach it would restore exactly the cross-tenant
     * deletion this exists to prevent. The other half of that gap is closed at
     * the source: `upload-to-openai` no longer returns a file id when it failed
     * to index into a store that does exist.
     */
    if (isOrphanCleanup) {
      if (!effectiveVectorStoreId) {
        logger.warn("Refusing an orphan cleanup that cannot be attributed", {
          callerId: caller.userId,
          courseId: ownerCourseId,
        });
        return new Response(
          JSON.stringify({ error: "This file cannot be attributed to the named course" }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const attributionResponse = await fetch(
        `https://api.openai.com/v1/vector_stores/${effectiveVectorStoreId}/files/${openaiFileId}`,
        { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } },
      );

      if (!attributionResponse.ok) {
        logger.warn("Orphan cleanup refused: the file is not in this course's store", {
          callerId: caller.userId,
          courseId: ownerCourseId,
          status: attributionResponse.status,
        });
        return new Response(
          JSON.stringify({ error: "This file cannot be attributed to the named course" }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const attributed = await attributionResponse.json() as {
        attributes?: Record<string, unknown> | null;
      };
      if (attributed.attributes?.course_id !== ownerCourseId) {
        logger.warn("Orphan cleanup refused: the file is stamped for another course", {
          callerId: caller.userId,
          courseId: ownerCourseId,
        });
        return new Response(
          JSON.stringify({ error: "This file cannot be attributed to the named course" }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    // Remove file from vector store first (if we have a vector store ID)
    let removedFromVectorStore = false;
    if (effectiveVectorStoreId) {
      logger.info("Removing file from vector store", { fileId: openaiFileId, vectorStoreId: effectiveVectorStoreId });

      const endVectorTimer = logger.startTimer("remove-from-vector-store");
      const vectorStoreResponse = await fetch(
        `https://api.openai.com/v1/vector_stores/${effectiveVectorStoreId}/files/${openaiFileId}`,
        {
          method: "DELETE",
          headers: {
            "Authorization": `Bearer ${OPENAI_API_KEY}`,
          },
        }
      );
      endVectorTimer();

      if (vectorStoreResponse.ok) {
        const data = await vectorStoreResponse.json();
        logger.info("File removed from vector store", { deleted: data.deleted });
        removedFromVectorStore = true;
      } else if (vectorStoreResponse.status === 404) {
        logger.info("File not found in vector store (may already be removed)");
        removedFromVectorStore = true;
      } else {
        // Anything other than 404 means the attachment may still be there, and
        // deleting the file globally below would strand it — the store would
        // keep pointing at a file that no longer exists. A 404 is the one
        // failure that is safe to continue past, because it means the
        // attachment is already gone.
        const errorText = await vectorStoreResponse.text();
        logger.error("Error removing file from vector store; refusing to delete", {
          status: vectorStoreResponse.status,
          error: errorText,
        });
        return new Response(
          JSON.stringify({ error: "Failed to remove the file from its vector store" }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    // Delete the file from OpenAI
    const endDeleteTimer = logger.startTimer("delete-openai-file");
    const response = await fetch(`https://api.openai.com/v1/files/${openaiFileId}`, {
      method: "DELETE",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
      },
    });
    endDeleteTimer();

    if (!response.ok) {
      const errorText = await response.text();
      logger.error("OpenAI API error", { status: response.status, error: errorText });
      // If file not found, consider it already deleted
      if (response.status === 404) {
        return new Response(
          JSON.stringify({ success: true, message: "File already deleted or not found", removedFromVectorStore }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({ error: `OpenAI API error: ${response.status}` }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const data = await response.json();
    logger.info("File deleted from OpenAI", { deleted: data.deleted, removedFromVectorStore });

    return new Response(
      JSON.stringify({ success: true, deleted: data.deleted, removedFromVectorStore }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    logger.exception(error as Error, "Error in delete-from-openai");
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
};
