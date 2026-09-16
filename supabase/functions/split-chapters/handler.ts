import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logger } from "../_shared/logger.ts";
import { uploadPdfToOpenAI } from "../_shared/file-upload-utils.ts";
import {
  authorizeCourseManager,
  callerFromRequest,
  resolveCourseForStorageObject,
} from "../_shared/course-authz.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface ChapterInput {
  chapterIndex: number;
  pageStart: number;
  pageEnd: number;
  title: string;
}

interface ChapterOutput {
  chapterIndex: number;
  openai_file_id: string;
}

/**
 * Generate signed URL for PDF in Supabase Storage
 */
async function getPdfSignedUrl(
  supabase: any,
  bucketName: string,
  filePath: string
): Promise<{ url: string; fileName: string }> {
  logger.info("Generating signed URL for PDF", { bucketName, filePath });

  const { data: signedUrlData, error: signedUrlError } = await supabase.storage
    .from(bucketName)
    .createSignedUrl(filePath, 3600);

  if (signedUrlError || !signedUrlData?.signedUrl) {
    logger.error("Failed to generate signed URL", { error: signedUrlError });
    throw new Error(`Failed to generate signed URL: ${signedUrlError?.message || "Unknown error"}`);
  }

  const fileName = filePath.split("/").pop() || "document.pdf";
  logger.info("Signed URL generated successfully", { fileName });

  return { url: signedUrlData.signedUrl, fileName };
}

/**
 * Split PDF by multiple page ranges using ConvertAPI
 * Returns an array of file URLs, one per range
 */
async function splitPdfByRanges(
  pdfUrl: string,
  fileName: string,
  chapters: ChapterInput[]
): Promise<{ urls: string[]; fileNames: string[] }> {
  const convertApiKey = Deno.env.get("CONVERT_API_KEY");
  if (!convertApiKey) {
    throw new Error("CONVERT_API_KEY is not configured");
  }

  // Build comma-separated range string: "1-10,11-25,26-40"
  const splitByRange = chapters.map(ch => `${ch.pageStart}-${ch.pageEnd}`).join(",");

  logger.info("Splitting PDF via ConvertAPI (multiple ranges)", {
    fileName,
    splitByRange,
    chapterCount: chapters.length
  });

  const startTime = Date.now();
  const response = await fetch("https://v2.convertapi.com/convert/pdf/to/split", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${convertApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      Parameters: [
        { Name: "File", FileValue: { Name: fileName, Url: pdfUrl } },
        { Name: "SplitByRange", Value: splitByRange },
        { Name: "StoreFile", Value: true },
      ],
    }),
  });

  const durationMs = Date.now() - startTime;

  if (!response.ok) {
    const errorText = await response.text();
    logger.error("ConvertAPI split error", {
      status: response.status,
      error: errorText,
      durationMs
    });
    throw new Error(`ConvertAPI split failed: ${response.status} - ${errorText}`);
  }

  const data = await response.json();

  if (!data.Files || data.Files.length === 0) {
    throw new Error("ConvertAPI returned no files");
  }

  const urls = data.Files.map((f: any) => f.FileUrl || f.Url);
  const fileNames = data.Files.map((f: any) => f.FileName);

  logger.info("PDF split successful", {
    chapterCount: chapters.length,
    filesReturned: data.Files.length,
    fileSizes: data.Files.map((f: any) => f.FileSize),
    durationMs
  });

  return { urls, fileNames };
}

/**
 * Download PDF from URL as Uint8Array
 */
async function downloadFromUrl(url: string): Promise<Uint8Array> {
  logger.info("Downloading PDF from URL");

  const startTime = Date.now();
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to download PDF: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const durationMs = Date.now() - startTime;

  logger.info("PDF downloaded successfully", {
    sizeBytes: arrayBuffer.byteLength,
    durationMs
  });

  return new Uint8Array(arrayBuffer);
}

export const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { filePath, bucketName, chapters } = await req.json() as {
      filePath: string;
      bucketName: string;
      chapters: ChapterInput[];
    };

    if (!filePath || !bucketName || !chapters || chapters.length === 0) {
      return new Response(
        JSON.stringify({ error: "Missing required parameters: filePath, bucketName, chapters" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    logger.info("Starting chapter split operation", {
      filePath,
      bucketName,
      chapterCount: chapters.length
    });

    // Initialize Supabase client
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      // No session to refresh on a service-role client, and leaving the
      // refresh timer on leaks an interval in the handler tests.
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // ── Caller gate (#1135) ───────────────────────────────────────────────
    // This reads a PDF and writes new objects back into the bucket, so it is
    // the most destructive of the four: manager level, against the course that
    // owns the source file.
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
      logger.warn("Chapter split requested for a course the caller cannot manage", {
        userId: caller.userId,
        courseId: resolved.courseId,
      });
      return new Response(JSON.stringify({ error: authorized.error }), {
        status: authorized.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Step 1: Generate signed URL for the source PDF
    const { url: pdfUrl, fileName } = await getPdfSignedUrl(supabase, bucketName, filePath);

    // Step 2: Split PDF by all chapter ranges using ConvertAPI
    const { urls: splitUrls, fileNames: splitFileNames } = await splitPdfByRanges(pdfUrl, fileName, chapters);

    // Verify we got the expected number of files
    if (splitUrls.length !== chapters.length) {
      logger.warn("ConvertAPI returned different number of files than expected", {
        expected: chapters.length,
        received: splitUrls.length
      });
    }

    // Step 3: Download each split PDF and upload to OpenAI
    const results: ChapterOutput[] = [];

    for (let i = 0; i < splitUrls.length; i++) {
      const chapter = chapters[i];
      const splitUrl = splitUrls[i];
      const splitFileName = splitFileNames[i] || `chapter-${chapter.chapterIndex}.pdf`;

      logger.info(`Processing chapter ${i + 1}/${splitUrls.length}`, {
        chapterIndex: chapter.chapterIndex,
        title: chapter.title,
        pageRange: `${chapter.pageStart}-${chapter.pageEnd}`
      });

      // Download the split PDF
      const pdfBytes = await downloadFromUrl(splitUrl);

      // Upload to OpenAI with a descriptive filename
      const openaiFileName = `${chapter.title.replace(/[^a-zA-Z0-9\s-]/g, "").substring(0, 50)} - Pages ${chapter.pageStart}-${chapter.pageEnd}.pdf`;
      const pdfBlob = new Blob([pdfBytes.buffer as ArrayBuffer], { type: "application/pdf" });
      const openaiFileId = await uploadPdfToOpenAI(pdfBlob, openaiFileName);

      results.push({
        chapterIndex: chapter.chapterIndex,
        openai_file_id: openaiFileId
      });

      logger.info(`Chapter ${i + 1} uploaded to OpenAI`, {
        chapterIndex: chapter.chapterIndex,
        openai_file_id: openaiFileId
      });
    }

    logger.info("All chapters split and uploaded successfully", {
      totalChapters: results.length
    });

    return new Response(
      JSON.stringify({ results }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    logger.error("split-chapters error", { error: error instanceof Error ? error.message : String(error) });
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
};
