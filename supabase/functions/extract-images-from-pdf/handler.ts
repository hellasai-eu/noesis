import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { logger } from "../_shared/logger.ts";
import {
  authorizeCourseManager,
  callerFromRequest,
  resolveCourseForStorageObject,
} from "../_shared/course-authz.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

export const handler = async (req: Request): Promise<Response> => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // `courseId` is still sent by the client and deliberately not read — the
    // owning course is resolved from the file below.
    const { filePath, bucketName, page } = await req.json();

    if (!filePath || !bucketName || !page) {
      return new Response(
        JSON.stringify({ error: "Missing required parameters: filePath, bucketName, page" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Initialize Supabase client with service role for storage access
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      // No session to refresh on a service-role client, and leaving the
      // refresh timer on leaks an interval in the handler tests.
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // ── Caller gate (#1135) ───────────────────────────────────────────────
    // This does not merely read the PDF: it uploads new objects and inserts
    // `course_materials` rows, so the extracted images become course content
    // for everyone on the course. That is an authoring action, so the gate is
    // manager level even though the preview this hangs off is reachable by
    // enrolled students. (The Extract button in `PdfViewerWithExtract` is not
    // manager-gated either — that is a UI gap this makes harmless.)
    //
    // The body's `courseId` decided both the authorization and the destination
    // path. It is now ignored for both: the course is resolved from the source
    // file, so a caller cannot write images into a course they merely name.
    const caller = await callerFromRequest(req, supabase);
    if (!caller.ok) {
      return new Response(JSON.stringify({ error: caller.error, code: caller.code }), {
        status: caller.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const resolved = await resolveCourseForStorageObject(supabase, bucketName, filePath);
    if (!resolved.ok) {
      return new Response(JSON.stringify({ error: resolved.error }), {
        status: resolved.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const authorized = await authorizeCourseManager(supabase, caller.userId, resolved.courseId);
    if (!authorized.ok) {
      logger.warn("Image extraction requested for a course the caller cannot manage", {
        userId: caller.userId,
        courseId: resolved.courseId,
      });
      return new Response(JSON.stringify({ error: authorized.error }), {
        status: authorized.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Checked after the gate, so an unauthenticated caller gets a 401 rather
    // than a report on how this deployment is configured.
    const convertApiKey = Deno.env.get("CONVERT_API_KEY");
    if (!convertApiKey) {
      return new Response(
        JSON.stringify({ error: "CONVERT_API_KEY not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const ownerCourseId = resolved.courseId;

    logger.setContext({ courseId: ownerCourseId });
    logger.info("Extracting images from page", { page, filePath });

    // Get signed URL for the PDF
    const { data: signedUrlData, error: signedUrlError } = await supabase.storage
      .from(bucketName)
      .createSignedUrl(filePath, 60 * 10); // 10 minutes

    if (signedUrlError || !signedUrlData?.signedUrl) {
      logger.error("Failed to get signed URL", { error: signedUrlError?.message });
      return new Response(
        JSON.stringify({ error: "Failed to get PDF URL" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Extract filename from path
    const pdfFileName = filePath.split("/").pop() || "document.pdf";

    // Call ConvertAPI to extract images from the specific page
    logger.info("Calling ConvertAPI", { page });
    const convertResponse = await fetch("https://v2.convertapi.com/convert/pdf/to/extract-images", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${convertApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        Parameters: [
          { Name: "File", FileValue: { Name: pdfFileName, Url: signedUrlData.signedUrl } },
          { Name: "PageRange", Value: `${page}-${page}` },
          { Name: "StoreFile", Value: true },
          { Name: "ImageOutputFormat", Value: "png" },
          { Name: "ImageResolution", Value: "800" },
        ],
      }),
    });

    if (!convertResponse.ok) {
      const errorText = await convertResponse.text();
      logger.error("ConvertAPI error", { status: convertResponse.status, error: errorText });
      
      // Check if this is a "no images found" error (code 5001)
      try {
        const errorJson = JSON.parse(errorText);
        if (errorJson.Code === 5001) {
          logger.info("No images found on this page (ConvertAPI 5001)");
          return new Response(
            JSON.stringify({ success: true, extractedCount: 0, images: [] }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
      } catch {
        // Error text is not JSON, continue with generic error handling
      }
      
      return new Response(
        JSON.stringify({ error: `ConvertAPI error: ${convertResponse.status}` }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const convertData = await convertResponse.json();
    logger.info("ConvertAPI response received", { snippet: JSON.stringify(convertData).substring(0, 500) });

    // Check if we got any files
    const extractedFiles = convertData.Files || [];
    if (extractedFiles.length === 0) {
      logger.info("No images found on this page");
      return new Response(
        JSON.stringify({ success: true, extractedCount: 0, images: [] }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Process each extracted image
    const savedImages: Array<{
      id: string;
      fileName: string;
      filePath: string;
      fileSize: number;
    }> = [];

    const timestamp = Date.now();

    for (let i = 0; i < extractedFiles.length; i++) {
      const file = extractedFiles[i];
      const fileUrl = file.Url;
      
      // Create unique filename - always PNG since we convert to PNG
      const newFileName = `page${page}-img${i + 1}-${timestamp}.png`;
      const storagePath = `${ownerCourseId}/${newFileName}`;

      logger.info("Downloading and saving image", { index: i + 1, newFileName, fileUrl });

      try {
        // Download the image from ConvertAPI's URL
        const imageResponse = await fetch(fileUrl);
        if (!imageResponse.ok) {
          logger.error("Failed to download image", { index: i + 1, status: imageResponse.status });
          continue;
        }

        const imageBlob = await imageResponse.blob();
        const arrayBuffer = await imageBlob.arrayBuffer();
        const binaryData = new Uint8Array(arrayBuffer);

        // Always PNG content type
        const contentType = "image/png";

        const { error: uploadError } = await supabase.storage
          .from(bucketName)
          .upload(storagePath, binaryData, {
            contentType,
            upsert: false,
          });

        if (uploadError) {
          logger.error("Failed to upload image", { index: i + 1, error: uploadError.message });
          continue;
        }

        // Create course_materials record
        const { data: materialData, error: materialError } = await supabase
          .from("course_materials")
          .insert({
            course_id: ownerCourseId,
            file_name: newFileName,
            file_url: storagePath,
            file_size: binaryData.length,
            material_type: "images",
            title: `Extracted: Page ${page} - Image ${i + 1}`,
            description: `Extracted from ${pdfFileName} page ${page}`,
            is_moderated: false,
          })
          .select("id")
          .single();

        if (materialError) {
          logger.error("Failed to create material record for image", { index: i + 1, error: materialError.message });
          // Try to clean up the uploaded file
          await supabase.storage.from(bucketName).remove([storagePath]);
          continue;
        }

        savedImages.push({
          id: materialData.id,
          fileName: newFileName,
          filePath: storagePath,
          fileSize: binaryData.length,
        });
      } catch (err) {
        logger.exception(err, "Error processing image", { index: i + 1 });
      }
    }

    logger.info("Saved extracted images", { count: savedImages.length });

    return new Response(
      JSON.stringify({
        success: true,
        extractedCount: savedImages.length,
        images: savedImages,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    logger.exception(error, "Error in extract-images-from-pdf");
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
};
