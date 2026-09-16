import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { logger } from "../_shared/logger.ts";
import {
  authorizeCourseReader,
  callerFromRequest,
  resolveCourseForStorageObject,
} from "../_shared/course-authz.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

export const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { filePath, bucketName } = await req.json();
    logger.info("Starting thumbnail generation", { filePath, bucketName });

    if (!filePath || !bucketName) {
      throw new Error("Missing filePath or bucketName");
    }

    // Create Supabase client to get signed URL for the PDF
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      // No session to refresh on a service-role client, and leaving the
      // refresh timer on leaks an interval in the handler tests.
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // ── Caller gate (#1135) ───────────────────────────────────────────────
    // Rendering a thumbnail is a reader-level affordance — the material
    // preview it hangs off is not manager-gated — but it still hands back a
    // picture of the file, so the caller has to be someone with business
    // reading this course's material. The course comes from the object, never
    // from the request.
    const caller = await callerFromRequest(req, supabase);
    if (!caller.ok) return json({ error: caller.error, code: caller.code }, caller.status);

    const resolved = await resolveCourseForStorageObject(supabase, bucketName, filePath);
    if (!resolved.ok) return json({ error: resolved.error }, resolved.status);

    const authorized = await authorizeCourseReader(supabase, caller.userId, resolved.courseId);
    if (!authorized.ok) {
      logger.warn("Thumbnail requested for a course the caller cannot read", {
        userId: caller.userId,
        courseId: resolved.courseId,
      });
      return json({ error: authorized.error }, authorized.status);
    }

    // Checked after the gate, so an unauthenticated caller gets a 401 rather
    // than a report on how this deployment is configured.
    const convertApiKey = Deno.env.get("CONVERT_API_KEY");
    if (!convertApiKey) {
      throw new Error("CONVERT_API_KEY not configured");
    }

    // Get a signed URL for the PDF (valid for 1 hour)
    const { data: signedUrlData, error: signedUrlError } = await supabase.storage
      .from(bucketName)
      .createSignedUrl(filePath, 3600);

    if (signedUrlError || !signedUrlData?.signedUrl) {
      logger.error("Failed to get signed URL", { error: signedUrlError?.message });
      throw new Error(`Failed to get signed URL: ${signedUrlError?.message}`);
    }

    logger.info("Got signed URL, calling ConvertAPI");

    // First, download the PDF file
    const pdfResponse = await fetch(signedUrlData.signedUrl);
    if (!pdfResponse.ok) {
      throw new Error(`Failed to download PDF: ${pdfResponse.status}`);
    }
    const pdfBlob = await pdfResponse.blob();

    // Extract filename from path
    const fileName = filePath.split("/").pop() || "document.pdf";

    // Create form data for ConvertAPI
    const formData = new FormData();
    formData.append("StoreFile", "true");
    formData.append("File", pdfBlob, fileName);
    formData.append("PageRange", "1");
    formData.append("CropTo", "ArtBox");
    formData.append("BackgroundColor", "transparent");

    // Call ConvertAPI
    const convertResponse = await fetch("https://v2.convertapi.com/convert/pdf/to/png", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${convertApiKey}`,
      },
      body: formData,
    });

    if (!convertResponse.ok) {
      const errorText = await convertResponse.text();
      logger.error("ConvertAPI error", { status: convertResponse.status, error: errorText });
      throw new Error(`ConvertAPI failed: ${convertResponse.status} - ${errorText}`);
    }

    const convertResult = await convertResponse.json();
    logger.info("ConvertAPI response received");

    if (!convertResult.Files || convertResult.Files.length === 0) {
      throw new Error("No files returned from ConvertAPI");
    }

    const tempThumbnailUrl = convertResult.Files[0].Url;
    logger.info("Downloading thumbnail from ConvertAPI");

    // Download the thumbnail image from ConvertAPI
    const thumbnailResponse = await fetch(tempThumbnailUrl);
    if (!thumbnailResponse.ok) {
      throw new Error(`Failed to download thumbnail: ${thumbnailResponse.status}`);
    }

    const thumbnailBlob = await thumbnailResponse.blob();
    const thumbnailArrayBuffer = await thumbnailBlob.arrayBuffer();
    const thumbnailUint8Array = new Uint8Array(thumbnailArrayBuffer);

    // Generate a unique filename for the thumbnail
    const thumbnailFileName = `${filePath.replace(/\.[^/.]+$/, "")}-thumb.png`;
    logger.info("Uploading to Supabase storage", { thumbnailFileName });

    // Upload to Supabase storage in the public course-thumbnails bucket
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from("course-thumbnails")
      .upload(thumbnailFileName, thumbnailUint8Array, {
        contentType: "image/png",
        upsert: true,
      });

    if (uploadError) {
      logger.error("Upload error", { error: uploadError.message });
      throw new Error(`Failed to upload thumbnail: ${uploadError.message}`);
    }

    // Get the public URL for the uploaded thumbnail
    const { data: publicUrlData } = supabase.storage
      .from("course-thumbnails")
      .getPublicUrl(thumbnailFileName);

    const thumbnailUrl = publicUrlData.publicUrl;
    logger.info("Thumbnail stored successfully", { thumbnailUrl });

    return new Response(
      JSON.stringify({
        success: true,
        thumbnailUrl,
        fileName: thumbnailFileName,
        fileSize: thumbnailUint8Array.length,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("Thumbnail generation failed", { error: errorMessage });
    return new Response(
      JSON.stringify({
        success: false,
        error: errorMessage
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      }
    );
  }
};
