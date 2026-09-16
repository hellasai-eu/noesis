import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getEffectiveLanguage } from "../_shared/language-utils.ts";
import { logger } from "../_shared/logger.ts";
import { callOpenAIStructured, OpenAIRateLimitError } from "../_shared/openai-client.ts";
import { AiFeatureDisabledError } from "../_shared/openai-client.ts";
import { modelFor } from "../_shared/model-policy.ts";
import { render } from "../_shared/render.ts";
import { FLASHCARDS_SYSTEM_PROMPT, FLASHCARDS_USER_PROMPT } from "../_shared/prompts/generate-flashcards.ts";
import { createUsageContext } from "../_shared/usage-tracker.ts";
import { withModeration } from "../_shared/moderation-middleware.ts";
import { saveFlaggedContent } from "../_shared/moderation.ts";
import {
  authorizeCourseManager,
  callerFromRequest,
  resolveCourseForChapter,
} from "../_shared/course-authz.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface FlashcardResult {
  flashcards: Array<{ front: string; back: string }>;
}

export const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { chapterId } = await req.json();

    if (!chapterId) {
      throw new Error("chapterId is required");
    }

    logger.info("Generating flashcards for chapter", { chapterId });

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      // No session to refresh on a service-role client, and leaving the
      // refresh timer on leaks an interval in the handler tests.
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // ── Caller gate (#1136) ───────────────────────────────────────────────
    // This read a course's chapter and spent OpenAI credit on it with the service-role key,
    // establishing no caller identity — so any anonymous request could read
    // another institution's content and bill this platform for it.
    const caller = await callerFromRequest(req, supabase);
    if (!caller.ok) {
      return new Response(JSON.stringify({ error: caller.error, code: caller.code }), {
        status: caller.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const resolved = await resolveCourseForChapter(supabase, chapterId);
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


    // Fetch chapter with its content, file ID, and material type
    const { data: chapter, error: chapterError } = await supabase
      .from("material_chapters")
      .select(
        `
        id,
        title,
        content,
        chapter_number,
        instructions,
        material_id,
        openai_file_id,
        course_materials (
          title,
          material_type,
          course_id,
          courses (
            title,
            language,
            institution_id
          )
        )
      `,
      )
      .eq("id", chapterId)
      .single();

    if (chapterError || !chapter) {
      throw new Error("Chapter not found");
    }

    // Skip flashcard generation for non-textbook materials
    const materialType = (chapter.course_materials as any)?.material_type || "textbook";
    if (materialType !== "textbook") {
      logger.info("Skipping flashcard generation for non-textbook material", { materialType });
      return new Response(
        JSON.stringify({
          success: false,
          message: `Flashcards are only generated for textbook materials, not ${materialType.replace("_", " ")} materials`,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Check content availability: prefer file ID, fallback to text content
    const hasFileId = !!chapter.openai_file_id;
    const hasContent = chapter.content && chapter.content.trim().length >= 100;

    if (!hasFileId && !hasContent) {
      logger.info("Chapter has no file ID and insufficient content for flashcard generation");
      return new Response(
        JSON.stringify({
          success: false,
          message: "Insufficient content to generate flashcards",
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Get effective language
    const courseData = (chapter.course_materials as any)?.courses;
    const courseId = (chapter.course_materials as any)?.course_id;
    const effectiveLanguage = await getEffectiveLanguage(supabase, courseId);

    const materialTitle = (chapter.course_materials as any)?.title || "Unknown Material";
    const courseTitle = courseData?.title || "Unknown Course";
    const institutionId = courseData?.institution_id || null;

    // Set logger context with course and institution info
    logger.setContext({
      courseId,
      courseName: courseTitle,
      institutionId,
    });

    const FLASHCARDS_OUTPUT_SCHEMA = {
      name: "create_flashcards",
      strict: true,
      schema: {
        type: "object",
        properties: {
          flashcards: {
            type: "array",
            description: "Array of flashcards to create",
            items: {
              type: "object",
              properties: {
                front: {
                  type: "string",
                  description: "The question or prompt on the front of the flashcard",
                },
                back: {
                  type: "string",
                  description: "The answer or explanation on the back of the flashcard",
                },
              },
              required: ["front", "back"],
              additionalProperties: false,
            },
          },
        },
        required: ["flashcards"],
        additionalProperties: false,
      },
    };

    logger.info("Calling OpenAI API for flashcard generation", {
      language: effectiveLanguage,
      useFileId: hasFileId
    });
    const llmTimer = logger.startTimer("ai_call");

    let result: FlashcardResult;
    try {
      // Define the LLM call function
      const llmCall = async (): Promise<FlashcardResult> => {
        const userMessage = render(FLASHCARDS_USER_PROMPT, {
          course_title: courseTitle,
          material_title: materialTitle,
          chapter_number: String(chapter.chapter_number),
          chapter_title: chapter.title,
          lang: effectiveLanguage,
          instructor_notes: chapter.instructions || "",
        });

        if (hasFileId) {
          // Use file ID - attach via fileIds, user prompt as text input
          logger.info("Using OpenAI file ID for flashcard generation", { openai_file_id: chapter.openai_file_id });

          return await callOpenAIStructured<FlashcardResult>({
            ...modelFor("materials.flashcards"),
            promptText: FLASHCARDS_SYSTEM_PROMPT,
            variables: {},
            input: [{ role: "user", content: userMessage }],
            fileIds: [chapter.openai_file_id],
            structuredOutput: FLASHCARDS_OUTPUT_SCHEMA,
            usageContext: createUsageContext("generate-flashcards", {
              promptKey: "flashcard_generation",
              institutionId,
              courseId,
            }),
          });
        } else {
          // Fallback to inline content
          logger.info("Using inline content for flashcard generation (no file ID available)");

          // Truncate content if too long
          const maxContentLength = 500000;
          const contentForPrompt =
            chapter.content.length > maxContentLength
              ? chapter.content.substring(0, maxContentLength) + "\n\n[Content truncated...]"
              : chapter.content;

          return await callOpenAIStructured<FlashcardResult>({
            ...modelFor("materials.flashcards"),
            promptText: FLASHCARDS_SYSTEM_PROMPT,
            variables: {},
            input: [
              { role: "user", content: userMessage },
              { role: "user", content: contentForPrompt },
            ],
            structuredOutput: FLASHCARDS_OUTPUT_SCHEMA,
            usageContext: createUsageContext("generate-flashcards", {
              promptKey: "flashcard_generation",
              institutionId,
              courseId,
            }),
          });
        }
      };

      // Wrap with moderation - moderate the LLM output
      const moderationResult = await withModeration(
        llmCall,
        "", // No user input to moderate
        {
          language: effectiveLanguage,
          throwOnBlocked: true,
          logger: {
            info: (msg, data) => logger.info(msg, data),
            warn: (msg, data) => logger.warn(msg, data),
            error: (msg, data) => logger.error(msg, data),
          },
          onOutputBlocked: async (moderationData) => {
            logger.warn("Flashcard output blocked by moderation", {
              categories: moderationData.flaggedCategories,
              chapterId,
              courseId,
            });

            // Save to flagged_content table
            await saveFlaggedContent({
              supabase,
              data: {
                type: "flashcard_generation",
                chapterId,
                courseId,
                institutionId,
                chapterTitle: chapter.title,
              },
              description: `Flashcard generation blocked: ${moderationData.flaggedCategories?.join(", ") || "unknown categories"}`,
              logger: {
                error: (msg, data) => logger.error(msg, data),
              },
            });
          },
        }
      );

      result = moderationResult.result;
    } catch (error) {
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
        return new Response(JSON.stringify({ success: false, error: "Rate limit exceeded. Please try again later." }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      // Handle moderation blocking error
      if (error instanceof Error && error.message.includes("blocked by moderation")) {
        return new Response(JSON.stringify({
          success: false,
          error: "Generated content was flagged by our content safety system. Please try again or contact support.",
        }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      throw error;
    }

    const llmDuration = llmTimer();

    if (!result || !result.flashcards) {
      throw new Error("No flashcards generated");
    }

    // Note: Per-flashcard moderation removed - LLM output is already moderated by withModeration wrapper
    const flashcards = result.flashcards;

    if (!flashcards || !Array.isArray(flashcards) || flashcards.length === 0) {
      throw new Error("No flashcards generated");
    }

    logger.info("Flashcards generated", {
      count: flashcards.length,
      durationMs: llmDuration,
    });

    // Update the chapter with the flashcards
    const { error: updateError } = await supabase
      .from("material_chapters")
      .update({
        flashcards: flashcards,
        flashcards_visible: true, // Default to visible
      })
      .eq("id", chapterId);

    if (updateError) {
      throw updateError;
    }

    return new Response(
      JSON.stringify({
        success: true,
        flashcards,
        count: flashcards.length,
        message: "Flashcards generated successfully",
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error: any) {
    logger.exception("Error generating flashcards", error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error.message,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
};
