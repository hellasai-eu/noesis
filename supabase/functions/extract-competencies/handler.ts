import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  callOpenAIStructured,
  OpenAIRateLimitError,
  OpenAIPaymentRequiredError,
} from "../_shared/openai-client.ts";
import { AiFeatureDisabledError } from "../_shared/openai-client.ts";
import { modelFor } from "../_shared/model-policy.ts";
import { render } from "../_shared/render.ts";
import { getEffectiveLanguage } from "../_shared/language-utils.ts";
import { logger } from "../_shared/logger.ts";
import { COMPETENCIES_SYSTEM_PROMPT, COMPETENCIES_USER_PROMPT } from "../_shared/prompts/extract-competencies.ts";
import { createUsageContext } from "../_shared/usage-tracker.ts";
import {
  authorizeCourseManager,
  callerFromRequest,
  resolveCourseForMaterial,
} from "../_shared/course-authz.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Result from whole-book extraction
interface CompetencyExtractionResult {
  competencies: Array<{
    title: string;
    description: string;
    chapterIndices: number[];
  }>;
}

// Schema for whole-book extraction
const COMPETENCIES_OUTPUT_SCHEMA = {
  name: "extract_competencies_multiple_chapters",
  strict: true,
  schema: {
    type: "object",
    properties: {
      competencies: {
        type: "array",
        description: "List of competencies extracted from the entire book",
        items: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description: "Simple competency title",
            },
            description: {
              type: "string",
              description: "Detailed description of the competency",
            },
            chapterIndices: {
              type: "array",
              description: "0-based indices of chapters that cover this competency",
              items: { type: "number" },
            },
          },
          required: ["title", "description", "chapterIndices"],
          additionalProperties: false,
        },
      },
    },
    required: ["competencies"],
    additionalProperties: false,
  },
};

interface ChapterInfo {
  id: string;
  title: string;
  chapter_number: number;
  openai_file_id: string | null;
  content: string | null;
}

export const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const {
      courseId,
      courseTitle,
      courseDescription,
      materialId,
      chapterIds,        // NEW: Specific chapter IDs to process (for batch mode)
      competencies,      // NEW: Previously extracted competencies for deduplication
    } = await req.json();

    if (!courseId) {
      throw new Error("courseId is required");
    }

    if (!materialId) {
      throw new Error("materialId is required");
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey, {
      // No session to refresh on a service-role client, and leaving the
      // refresh timer on leaks an interval in the handler tests.
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // ── Caller gate (#1136) ───────────────────────────────────────────────
    // This read a course's material and spent OpenAI credit on it with the service-role key,
    // establishing no caller identity — so any anonymous request could read
    // another institution's content and bill this platform for it.
    const caller = await callerFromRequest(req, supabase);
    if (!caller.ok) {
      return new Response(JSON.stringify({ error: caller.error, code: caller.code }), {
        status: caller.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const resolved = materialId
      ? await resolveCourseForMaterial(supabase, materialId)
      : { ok: true as const, courseId };
    if (!resolved.ok) {
      return new Response(JSON.stringify({ error: resolved.error }), {
        status: resolved.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const authorized = await authorizeCourseManager(supabase, caller.userId, resolved.courseId);
    if (!authorized.ok) {
      logger.warn("Refused a content read", {
        callerId: caller.userId,
        courseId: resolved.courseId,
      });
      return new Response(JSON.stringify({ error: authorized.error }), {
        status: authorized.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }


    const effectiveLanguage = await getEffectiveLanguage(supabase, resolved.courseId);

    // Fetch the material with its openai_file_id (as fallback)
    const endMaterialTimer = logger.startTimer("fetch-material");
    const { data: material, error: materialError } = await supabase
      .from("course_materials")
      .select("id, title, file_name, openai_file_id")
      .eq("id", materialId)
      .single();
    endMaterialTimer();

    if (materialError) throw new Error(`Failed to fetch material: ${materialError.message}`);
    if (!material) throw new Error("Material not found");

    // Fetch chapters - either specific ones (batch mode) or all (full mode)
    const endChaptersTimer = logger.startTimer("fetch-chapters");
    let chaptersQuery = supabase
      .from("material_chapters")
      .select("id, title, chapter_number, openai_file_id, content")
      .eq("material_id", materialId)
      .order("chapter_number", { ascending: true }).order("id");

    // If specific chapterIds provided, filter to just those
    if (chapterIds && chapterIds.length > 0) {
      chaptersQuery = chaptersQuery.in("id", chapterIds);
    }

    const { data: chapters, error: chaptersError } = await chaptersQuery;
    endChaptersTimer();

    if (chaptersError) throw new Error(`Failed to fetch chapters: ${chaptersError.message}`);

    const chapterList = (chapters || []) as ChapterInfo[];

    // Build file IDs list - prefer chapter-level file IDs, fallback to material
    const fileIds: string[] = [];
    const inlineContents: string[] = [];

    for (const ch of chapterList) {
      if (ch.openai_file_id && !fileIds.includes(ch.openai_file_id)) {
        fileIds.push(ch.openai_file_id);
      } else if (ch.content) {
        // Fallback to chapter content if no file ID
        inlineContents.push(`=== Chapter ${ch.chapter_number}: ${ch.title} ===\n${ch.content}`);
      }
    }

    // Fallback to material file ID if no chapter file IDs available
    if (fileIds.length === 0 && inlineContents.length === 0 && material.openai_file_id) {
      fileIds.push(material.openai_file_id);
    }

    const hasFileIds = fileIds.length > 0;
    const hasInlineContent = inlineContents.length > 0;

    if (!hasFileIds && !hasInlineContent) {
      throw new Error("No content available. Please sync the material or add chapter content.");
    }

    // Limit to first 20 files to reduce token usage with file references vs inline content
    const limitedFileIds = fileIds.slice(0, 20);

    // Combine inline content for chapters without file IDs
    const combinedInlineContent = inlineContents.join("\n\n");

    // Build chapter list string for context
    const chapterListStr = chapterList
      .map((ch, idx) => `${idx}. Chapter ${ch.chapter_number}: ${ch.title}`)
      .join("\n");

    // Format previous competencies for deduplication prompt
    const previousCompetenciesStr = competencies || "";

    logger.info("Extracting competencies", {
      courseId: resolved.courseId,
      materialId,
      materialTitle: material.title || material.file_name,
      chapterCount: chapterList.length,
      fileIdCount: limitedFileIds.length,
      inlineContentChapters: inlineContents.length,
      hasPreviousCompetencies: !!previousCompetenciesStr,
      isBatchMode: !!(chapterIds && chapterIds.length > 0),
      language: effectiveLanguage,
    });

    try {
      const endAiTimer = logger.startTimer("ai-extraction");

      const userMessage = render(COMPETENCIES_USER_PROMPT, {
        language: effectiveLanguage,
        coursetitle: courseTitle || "Untitled Course",
        coursedescription: courseDescription || "",
        competencies: previousCompetenciesStr,
      });

      // Build input and fileIds based on content availability
      let input: Array<{ role: "user" | "assistant"; content: string }>;
      let attachedFileIds: string[] | undefined;

      if (hasFileIds) {
        // Attach files via fileIds param, user prompt as text input
        input = [{ role: "user" as const, content: userMessage }];
        attachedFileIds = limitedFileIds;
      } else {
        // Inline content as additional user message
        input = [
          { role: "user" as const, content: userMessage },
          { role: "user" as const, content: combinedInlineContent },
        ];
      }

      const result = await callOpenAIStructured<CompetencyExtractionResult>({
        ...modelFor("materials.extract-competencies"),
        promptText: COMPETENCIES_SYSTEM_PROMPT,
        variables: {},
        input,
        fileIds: attachedFileIds,
        structuredOutput: COMPETENCIES_OUTPUT_SCHEMA,
        usageContext: createUsageContext("extract-competencies", {
          promptKey: "competency_extraction",
          courseId: resolved.courseId,
        }),
      });

      endAiTimer();

      logger.info("Extraction complete", {
        totalCompetencies: result.competencies?.length || 0,
        materialId,
        chaptersProcessed: chapterList.length,
        usedFileIds: hasFileIds,
        usedInlineContent: !hasFileIds && hasInlineContent,
      });

      return new Response(JSON.stringify({
        competencies: result.competencies || [],
        materialId,
        chaptersProcessed: chapterList.length,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });

    } catch (error) {
      logger.exception(error as Error, "Error during AI extraction");

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
        return new Response(JSON.stringify({
          error: "Rate limit exceeded. Please try again in a moment.",
        }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (error instanceof OpenAIPaymentRequiredError) {
        return new Response(JSON.stringify({
          error: "AI usage limit reached. Please try again later.",
        }), {
          status: 402,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      throw error;
    }

  } catch (error) {
    logger.exception(error as Error, "Error extracting competencies");
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
};
