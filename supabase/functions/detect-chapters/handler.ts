import { callOpenAIStructured, OpenAIError, OpenAIRateLimitError } from "../_shared/openai-client.ts";
import { AiFeatureDisabledError } from "../_shared/openai-client.ts";
import { modelFor } from "../_shared/model-policy.ts";
import { logger } from "../_shared/logger.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getEffectiveLanguage } from "../_shared/language-utils.ts";
import { createUsageContext } from "../_shared/usage-tracker.ts";
import { getSignedUrl, fetchFileAsBase64 } from "../_shared/convertapi-utils.ts";
import { CHAPTER_DETECTION_PROMPT } from "../_shared/prompts/detect-chapters.ts";
import {
  authorizeCourseManager,
  callerFromRequest,
  resolveCourseForStorageObject,
} from "../_shared/course-authz.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MAX_PAGES_FOR_DETECTION = 50;

interface ChapterResult {
  chapters: Array<{ title: string; pageStart: number; pageEnd: number }>;
}

const CHAPTERS_OUTPUT_SCHEMA = {
  name: "extract_chapters",
  strict: true,
  schema: {
    type: "object",
    properties: {
      chapters: {
        type: "array",
        description: "List of chapters from the Table of Contents",
        items: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description: "Chapter title without numbering prefix",
            },
            pageStart: {
              type: "integer",
              description: "Starting page number from Table of Contents",
            },
            pageEnd: {
              type: "integer",
              description: "Ending page number, typically the page before the next chapter starts",
            },
          },
          required: ["title", "pageStart", "pageEnd"],
          additionalProperties: false,
        },
      },
    },
    required: ["chapters"],
    additionalProperties: false,
  },
};

function validateChapters(chapters: ChapterResult["chapters"], totalPages: number): any[] {
  return chapters
    .filter((ch) => ch.title && ch.pageStart > 0)
    .map((ch, index) => ({
      chapter_number: index + 1,
      title: ch.title.trim(),
      pageStart: Math.max(1, Math.min(ch.pageStart, totalPages)),
      pageEnd: Math.max(1, Math.min(ch.pageEnd || ch.pageStart + 10, totalPages)),
    }));
}

/**
 * Generate a signed URL for a PDF in Supabase Storage.
 * ConvertAPI fetches the file directly via URL, avoiding large in-memory downloads.
 */
async function getPdfSignedUrl(
  supabase: any,
  bucketName: string,
  filePath: string
): Promise<{ url: string; fileName: string }> {
  logger.info("Step 1/4: Generating signed URL for PDF", { bucketName, filePath });

  const { url, fileName } = await getSignedUrl(supabase, bucketName, filePath);

  logger.info("Step 1/4 COMPLETE: Signed URL generated", { fileName });

  return { url, fileName };
}

/**
 * Split PDF to first N pages using ConvertAPI (stores file and returns URL).
 * Uses SplitByRange parameter to get a single combined PDF.
 * fileParam should be either { Name: "File", FileValue: { Name, Url } } for
 * production (signed URL) or { Name: "File", FileValue: { Name, Data } }
 * for local dev (base64), since ConvertAPI cannot reach localhost URLs.
 */
async function splitPdfToFirstPages(
  fileParam: object,
  fileName: string,
  maxPages: number,
  totalPages: number
): Promise<{ url: string; fileName: string }> {
  const convertApiKey = Deno.env.get("CONVERT_API_KEY");
  if (!convertApiKey) {
    throw new Error("CONVERT_API_KEY is not configured");
  }

  const pagesToExtract = Math.min(totalPages, maxPages);
  const splitByRange = `1-${pagesToExtract}`;

  logger.info("Step 2a/5: Splitting PDF via ConvertAPI (SplitByRange)", {
    maxPages,
    totalPages,
    fileName,
    splitByRange
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
        fileParam,
        { Name: "SplitByRange", Value: splitByRange },
        { Name: "StoreFile", Value: true },
      ],
    }),
  });

  const durationMs = Date.now() - startTime;

  if (!response.ok) {
    const errorText = await response.text();
    logger.error("Step 2a/5 FAILED: ConvertAPI split error", {
      status: response.status,
      error: errorText,
      durationMs
    });
    throw new Error(`ConvertAPI split failed: ${response.status} - ${errorText}`);
  }

  const data = await response.json();

  if (!data.Files || data.Files.length === 0) {
    logger.error("Step 2a/5 FAILED: ConvertAPI returned no files");
    throw new Error("ConvertAPI returned no files");
  }

  const splitPdfUrl = data.Files[0].FileUrl || data.Files[0].Url;
  const splitFileName = data.Files[0].FileName || `split-${fileName}`;

  logger.info("Step 2a/5 COMPLETE: PDF split successful", {
    originalPages: totalPages,
    extractedPages: pagesToExtract,
    splitFileName,
    fileSizeBytes: data.Files[0].FileSize,
    durationMs
  });

  return { url: splitPdfUrl, fileName: splitFileName };
}

/**
 * Download PDF from URL and return as Uint8Array
 */
async function downloadFromUrl(url: string): Promise<Uint8Array> {
  logger.info("Step 2b/5: Downloading split PDF from ConvertAPI URL");

  const startTime = Date.now();
  const response = await fetch(url);

  if (!response.ok) {
    const durationMs = Date.now() - startTime;
    logger.error("Step 2b/5 FAILED: Could not download from URL", {
      status: response.status,
      durationMs
    });
    throw new Error(`Failed to download from URL: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  const durationMs = Date.now() - startTime;
  const fileSizeKb = Math.round(bytes.length / 1024);

  logger.info("Step 2b/5 COMPLETE: Downloaded split PDF", {
    fileSizeKb,
    durationMs
  });

  return bytes;
}

/**
 * Upload PDF bytes to OpenAI Files API and return file ID
 */
async function uploadToOpenAI(pdfBytes: Uint8Array, fileName: string): Promise<string> {
  const openaiApiKey = Deno.env.get("OPENAI_API_KEY");
  if (!openaiApiKey) {
    throw new Error("OPENAI_API_KEY is not configured");
  }

  const fileSizeKb = Math.round(pdfBytes.length / 1024);
  logger.info("Step 3/5: Uploading split PDF to OpenAI", { fileName, fileSizeKb });

  const pdfBlob = new Blob([pdfBytes.buffer as ArrayBuffer], { type: "application/pdf" });

  const formData = new FormData();
  formData.append("purpose", "assistants");
  formData.append("file", pdfBlob, fileName);

  const startTime = Date.now();
  const response = await fetch("https://api.openai.com/v1/files", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${openaiApiKey}`,
    },
    body: formData,
  });

  const durationMs = Date.now() - startTime;

  if (!response.ok) {
    const errorText = await response.text();
    logger.error("Step 3/5 FAILED: OpenAI file upload error", {
      status: response.status,
      error: errorText,
      durationMs
    });
    throw new Error(`OpenAI file upload failed: ${response.status}`);
  }

  const data = await response.json();
  logger.info("Step 3/5 COMPLETE: Uploaded to OpenAI", { fileId: data.id, durationMs });

  return data.id;
}

/**
 * Delete file from OpenAI
 */
async function deleteOpenAIFile(fileId: string): Promise<void> {
  const openaiApiKey = Deno.env.get("OPENAI_API_KEY");
  if (!openaiApiKey) return;

  try {
    const response = await fetch(`https://api.openai.com/v1/files/${fileId}`, {
      method: "DELETE",
      headers: {
        "Authorization": `Bearer ${openaiApiKey}`,
      },
    });

    if (response.ok) {
      logger.info("Deleted temporary OpenAI file", { fileId });
    } else {
      logger.warn("Failed to delete temporary OpenAI file", { fileId, status: response.status });
    }
  } catch (error) {
    logger.warn("Error deleting temporary OpenAI file", { fileId, error: String(error) });
  }
}


export const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  let tempFileId: string | null = null;

  try {
    const body = await req.json();
    const {
      totalPages,
      courseId,
      filePath,
      bucketName,
      specialExtractionInstructions
    } = body;
    const maxPage = totalPages || 999;

    // Validate required parameters
    if (!filePath || !bucketName) {
      return new Response(
        JSON.stringify({
          error: "Please provide filePath and bucketName for chapter detection.",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Initialize Supabase client
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey, {
      // No session to refresh on a service-role client, and leaving the
      // refresh timer on leaks an interval in the handler tests.
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // ── Caller gate (#1135) ───────────────────────────────────────────────
    // Detecting chapters reads the whole PDF and spends OpenAI credit against
    // it, so this is an authoring action: manager level, not reader.
    //
    // The authoritative course is the one that owns the file. The body's
    // `courseId` is used only for language selection below — authorizing
    // against it would let a caller present a course they manage while
    // pointing `filePath` at one they do not.
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
      logger.warn("Chapter detection requested for a course the caller cannot manage", {
        userId: caller.userId,
        courseId: resolved.courseId,
      });
      return new Response(JSON.stringify({ error: authorized.error }), {
        status: authorized.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get effective language and instruction. Read from the course that owns
    // the file rather than the body's `courseId`, now that we have it.
    const langCode = await getEffectiveLanguage(supabase, resolved.courseId);
    // langCode kept for logging but prompt uses the book's original language

    logger.info("Using ConvertAPI split approach for chapter detection", { filePath, bucketName, maxPage });

    // Step 1: Obtain a file reference for ConvertAPI.
    // In production, we use a signed URL so ConvertAPI fetches the PDF directly.
    // In local dev, Supabase signed URLs resolve to localhost which ConvertAPI
    // cannot reach, so we download the file and send it as base64 instead.
    const isLocal = supabaseUrl.includes("localhost") || supabaseUrl.includes("127.0.0.1");
    let fileParam: object;
    let fileName: string;

    if (isLocal) {
      logger.info("Step 1/4: Local environment detected — downloading PDF directly for ConvertAPI", { bucketName, filePath });
      const { base64, fileName: fn } = await fetchFileAsBase64(supabase, bucketName, filePath);
      fileName = fn;
      fileParam = { Name: "File", FileValue: { Name: fileName, Data: base64 } };
      logger.info("Step 1/4 COMPLETE: PDF downloaded as base64", { fileName });
    } else {
      const { url: pdfUrl, fileName: fn } = await getPdfSignedUrl(supabase, bucketName, filePath);
      fileName = fn;
      fileParam = { Name: "File", FileValue: { Name: fileName, Url: pdfUrl } };
    }

    // Step 2a: Split to first 50 pages using ConvertAPI (stores file, returns URL)
    const { url: splitPdfUrl, fileName: splitFileName } = await splitPdfToFirstPages(
      fileParam,
      fileName,
      MAX_PAGES_FOR_DETECTION,
      maxPage
    );

    // Step 2b: Download the split PDF from ConvertAPI URL
    const pdfBytes = await downloadFromUrl(splitPdfUrl);

    // Step 3: Upload split PDF to OpenAI
    tempFileId = await uploadToOpenAI(pdfBytes, `chapters-preview-${splitFileName}`);


    logger.info("Step 4/5: Calling OpenAI for chapter detection", {
      totalPages: maxPage,
      lang: langCode,
    });

    try {
      const endAiTimer = logger.startTimer("ai-local-prompt-detection");
      const result = await callOpenAIStructured<ChapterResult>({
        ...modelFor("materials.detect-chapters"),
        promptText: CHAPTER_DETECTION_PROMPT,
        variables: {
          special_extraction_instructions: specialExtractionInstructions
            ? "The user has provided these additional extraction instructions:\n" + specialExtractionInstructions
            : "",
        },
        input: [tempFileId],
        structuredOutput: CHAPTERS_OUTPUT_SCHEMA,
        usageContext: createUsageContext("detect-chapters", {
          promptKey: "chapter_detection",
          courseId: resolved.courseId,
        }),
      });
      const aiDurationMs = endAiTimer();

      const validatedChapters = validateChapters(result.chapters || [], maxPage);
      logger.info("Step 4/5 COMPLETE: Chapters detected", {
        chapterCount: validatedChapters.length,
        aiDurationMs
      });

      // Step 5: Clean up temporary file
      if (tempFileId) {
        logger.info("Step 5/5: Cleaning up temporary OpenAI file", { fileId: tempFileId });
        await deleteOpenAIFile(tempFileId);
        logger.info("Step 5/5 COMPLETE: Temporary file deleted");
      }

      return new Response(JSON.stringify({ chapters: validatedChapters, totalPages: maxPage }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (error) {
      // Clean up temporary file on error
      if (tempFileId) {
        await deleteOpenAIFile(tempFileId);
      }

      // The school switched this AI family off (ai-feature-gate) — a policy

      // refusal, not a failure. Must precede the OpenAIError mapping below

      // (it is a subclass) so it cannot surface as a 5xx.

      if (error instanceof AiFeatureDisabledError) {

        return new Response(JSON.stringify({ error: error.message, code: "ai_feature_disabled" }), {

          status: 403,

          headers: { ...corsHeaders, "Content-Type": "application/json" },

        });

      }

      if (error instanceof OpenAIRateLimitError) {
        return new Response(JSON.stringify({ error: "Rate limit exceeded. Please try again later." }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (error instanceof OpenAIError && error.statusCode === 402) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 402,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      throw error;
    }
  } catch (error) {
    // Clean up temporary file on error
    if (tempFileId) {
      await deleteOpenAIFile(tempFileId);
    }

    logger.exception(error as Error, "Error in detect-chapters");
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
};
