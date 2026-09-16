import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getEffectiveLanguage, getLanguageInstruction } from "../_shared/language-utils.ts";
import { callOpenAIStructured } from "../_shared/openai-client.ts";
import { modelFor } from "../_shared/model-policy.ts";
import { render } from "../_shared/render.ts";
import { logger } from "../_shared/logger.ts";
import { createUsageContext } from "../_shared/usage-tracker.ts";
import { CHAPTER_SUMMARY_SYSTEM_PROMPT, CHAPTER_SUMMARY_USER_PROMPT } from "../_shared/prompts/generate-chapter-summary.ts";
import {
  authorizeCourseManager,
  callerFromRequest,
  resolveCourseForChapter,
  resolveCourseForMaterial,
} from "../_shared/course-authz.ts";
import {
  fetchWholeMaterialSources,
  type WholeMaterialSource,
} from "../_shared/whole-material-sources.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Output schema as specified by user
const SUMMARY_OUTPUT_SCHEMA = {
  name: "summary_generation_status",
  schema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        description: "The result of the summary generation; 'success' if it was generated, 'fail' if not.",
        enum: ["success", "fail"]
      },
      message: {
        type: "string",
        description: "A generic explanatory message giving feedback or the reason for failure."
      },
      summary: {
        type: "string",
        description: "The generated summary if status is 'success', otherwise an explanation or can be an empty string."
      }
    },
    required: ["status", "message", "summary"],
    additionalProperties: false
  },
  strict: true
};

interface SummaryResult {
  status: "success" | "fail";
  message: string;
  summary: string;
}

interface ChapterData {
  id: string;
  title: string;
  content: string | null;
  material_id: string;
  chapter_number: number;
  openai_file_id: string | null;
}

export const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { chapterIds, chapterId, materialIds, courseId, studentNotes } = await req.json();

    // Support both single chapterId and array of chapterIds
    const chapterIdList: string[] = chapterIds || (chapterId ? [chapterId] : []);

    // Chapterless "Other" materials, summarised whole (#1019). A tutoring
    // session can be grounded in one of these instead of — or alongside —
    // chapters, so neither list is required on its own.
    const materialIdList: string[] = Array.isArray(materialIds)
      ? materialIds.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];

    if (chapterIdList.length === 0 && materialIdList.length === 0) {
      throw new Error("chapterIds or materialIds is required");
    }

    logger.info("Generating chapter summary", {
      chapterIds: chapterIdList,
      materialIds: materialIdList,
      courseId,
      multiChapter: chapterIdList.length > 1
    });

    if (courseId) {
      logger.setContext({ courseId });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey, {
      // No session to refresh on a service-role client, and leaving the
      // refresh timer on leaks an interval in the handler tests.
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // ── Caller gate (#1136) ───────────────────────────────────────────────
    // This read a course's chapters and spent OpenAI credit on it with the service-role key,
    // establishing no caller identity — so any anonymous request could read
    // another institution's content and bill this platform for it.
    const caller = await callerFromRequest(req, supabase);
    if (!caller.ok) {
      return new Response(JSON.stringify({ error: caller.error, code: caller.code }), {
        status: caller.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // EVERY chapter, not just the first. A list that starts with a chapter from
    // a course the caller manages and continues into others would otherwise
    // authorize on the first and then fetch and send them all to OpenAI —
    // check-one-act-on-many, the same shape as trusting a body id.
    let resolved: { ok: true; courseId: string } | { ok: false; status: number; error: string } =
      { ok: true as const, courseId };

    const seenCourseIds = new Set<string>();
    for (const id of chapterIdList) {
      const forChapter = await resolveCourseForChapter(supabase, id);
      if (!forChapter.ok) {
        resolved = forChapter;
        break;
      }
      seenCourseIds.add(forChapter.courseId);
      resolved = forChapter;
    }
    // Whole documents are resolved the same way and for the same reason: the
    // row is the authority on which course it belongs to, never the body.
    if (resolved.ok) {
      for (const id of materialIdList) {
        const forMaterial = await resolveCourseForMaterial(supabase, id);
        if (!forMaterial.ok) {
          resolved = forMaterial;
          break;
        }
        seenCourseIds.add(forMaterial.courseId);
        resolved = forMaterial;
      }
    }
    if (!resolved.ok) {
      return new Response(JSON.stringify({ error: resolved.error }), {
        status: resolved.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // A mixed-course list is authorized course by course; one refusal is a
    // refusal for the whole request.
    // A summary spanning two courses has no single language to render in and no
    // single course to bill the tokens to, and neither call site produces one —
    // `StudySessionManager` is scoped to one course and sends its chapters
    // together. Refusing is better than picking one of them arbitrarily, which
    // is what carrying the last resolved course through would do.
    if (seenCourseIds.size > 1) {
      logger.warn("Refused a source list spanning several courses", {
        callerId: caller.userId,
        courseCount: seenCourseIds.size,
      });
      return new Response(
        JSON.stringify({ error: "All sources must belong to the same course" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    for (const id of seenCourseIds.size > 0 ? seenCourseIds : [resolved.courseId]) {
      const authorized = await authorizeCourseManager(supabase, caller.userId, id);
      if (!authorized.ok) {
        logger.warn("Refused a content read", {
          callerId: caller.userId,
          courseId: id,
        });
        return new Response(JSON.stringify({ error: authorized.error }), {
          status: authorized.status,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }


    // Fetch all chapters
    const { data: chapters, error: chapterError } = chapterIdList.length > 0
      ? await supabase
        .from("material_chapters")
        .select("id, title, content, material_id, chapter_number, openai_file_id")
        .in("id", chapterIdList)
        .order("chapter_number").order("id")
      : { data: [], error: null };

    if (chapterError) {
      throw new Error("Failed to fetch chapters: " + chapterError.message);
    }

    if (chapterIdList.length > 0 && (!chapters || chapters.length === 0)) {
      throw new Error("No chapters found for the provided IDs");
    }

    const typedChapters = (chapters ?? []) as ChapterData[];

    // The authorization pass above already established that every id belongs to
    // the caller's course; this re-reads them as sources and drops any that are
    // not a synced whole document.
    const wholeMaterials: WholeMaterialSource[] = materialIdList.length > 0
      ? await fetchWholeMaterialSources(
        supabase,
        [...seenCourseIds][0] ?? resolved.courseId,
        materialIdList,
      )
      : [];

    if (typedChapters.length === 0 && wholeMaterials.length === 0) {
      throw new Error("No chapters or whole documents found for the provided IDs");
    }

    // Collect all unique material IDs — the materials the CHAPTERS belong to,
    // not the whole documents requested in the body.
    const chapterMaterialIds = [...new Set(typedChapters.map(ch => ch.material_id).filter(Boolean))];

    // Fetch materials for course_id and openai_file_id fallback
    let resolvedCourseId = resolved.courseId ?? courseId;
    const materialFileIds: Record<string, string> = {};

    if (chapterMaterialIds.length > 0) {
      const { data: materials } = await supabase
        .from("course_materials")
        .select("id, course_id, openai_file_id")
        .in("id", chapterMaterialIds);

      if (materials) {
        for (const mat of materials) {
          if (!resolvedCourseId && mat.course_id) {
            resolvedCourseId = mat.course_id;
          }
          if (mat.openai_file_id) {
            materialFileIds[mat.id] = mat.openai_file_id;
          }
        }
      }
    }

    // Collect file IDs and inline content from chapters
    const fileIds: string[] = [];
    let combinedInlineContent = "";
    const chapterTitles: string[] = [];

    for (const chapter of typedChapters) {
      chapterTitles.push(`Chapter ${chapter.chapter_number}: ${chapter.title}`);

      // Priority: chapter.openai_file_id > chapter.content > material.openai_file_id
      if (chapter.openai_file_id) {
        fileIds.push(chapter.openai_file_id);
        logger.info("Using chapter OpenAI file ID", { chapterId: chapter.id, fileId: chapter.openai_file_id });
      } else if (chapter.content) {
        combinedInlineContent += `\n\n## Chapter ${chapter.chapter_number}: ${chapter.title}\n${chapter.content}`;
        logger.info("Using inline chapter content", { chapterId: chapter.id, contentLength: chapter.content.length });
      } else if (chapter.material_id && materialFileIds[chapter.material_id]) {
        // Only add material file ID once per material
        const matFileId = materialFileIds[chapter.material_id];
        if (!fileIds.includes(matFileId)) {
          fileIds.push(matFileId);
          logger.info("Using material OpenAI file ID as fallback", { chapterId: chapter.id, materialFileId: matFileId });
        }
      }
    }

    // Whole documents contribute their own file and their own title. They have
    // no chapter number, so they are named by title rather than folded into the
    // "Chapter N" list.
    const wholeMaterialTitles = wholeMaterials.map((m) => m.title);
    for (const m of wholeMaterials) {
      if (!fileIds.includes(m.openaiFileId)) {
        fileIds.push(m.openaiFileId);
        logger.info("Using whole-document OpenAI file ID", { materialId: m.id, fileId: m.openaiFileId });
      }
    }

    // If no content source available, return error
    if (fileIds.length === 0 && !combinedInlineContent) {
      logger.info("No content source available for chapters", { chapterIds: chapterIdList });
      return new Response(
        JSON.stringify({
          success: false,
          skipped: true,
          reason: "No OpenAI file ID or inline content available.",
          llmResponse: null
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Build objective from the sources this summary is grounded in. A whole
    // document is named by its title — it has no chapter number to give.
    const sourceNames = [...chapterTitles, ...wholeMaterialTitles];
    const isMultiSource = sourceNames.length > 1;
    const sourceListStr = sourceNames.join(", ");
    const objective = isMultiSource
      ? `Generate a comprehensive study summary covering the following material: ${sourceListStr}. Synthesize the key concepts from all of it, identify connections between topics, and create a cohesive learning guide.`
      : `Generate a comprehensive study summary for "${sourceNames[0]}". Focus on key concepts, important details, and learning objectives.`;

    // Build instructions - include language and any special instructions
    let instructions = "";
    if (resolvedCourseId) {
      const effectiveLanguage = await getEffectiveLanguage(supabase, resolvedCourseId);
      const langInfo = getLanguageInstruction(effectiveLanguage);
      if (langInfo.instruction) {
        instructions += langInfo.instruction + "\n";
      }
      logger.info("Using language", { name: langInfo.name, code: effectiveLanguage });
    }

    logger.info("Calling OpenAI", {
      chapterCount: typedChapters.length,
      wholeMaterialCount: wholeMaterials.length,
      fileIdCount: fileIds.length,
      hasInlineContent: combinedInlineContent.length > 0,
      inlineContentLength: combinedInlineContent.length
    });

    // Truncate content if too long (max 500000 chars)
    const maxContentLength = 500000;
    const contentForPrompt = combinedInlineContent.length > maxContentLength
      ? combinedInlineContent.substring(0, maxContentLength) + "\n\n[Content truncated...]"
      : combinedInlineContent;

    // Prepare variables for saved prompt - student_notes receives actual student notes from UI
    const promptVariables: Record<string, string> = {
      objective,
      // Empty for a summary built only from whole documents — there is no
      // chapter number to state, and the objective already names the sources.
      chapter_num: typedChapters.map(ch => String(ch.chapter_number)).join(", "),
      instructions: instructions || "No additional instructions.",
      student_notes: studentNotes || "",
    };

    const llmTimer = logger.startTimer("ai_call");

    // Build context user message from template
    const contextMessage = render(CHAPTER_SUMMARY_USER_PROMPT, promptVariables);

    // Build input - context message + chapter content
    let inputContent: Array<{ role: "user" | "assistant"; content: string }>;

    if (fileIds.length > 0) {
      // File IDs will be passed separately and attached by the API
      inputContent = [
        { role: "user", content: contextMessage },
        { role: "user", content: "Generate the summary based on the attached files." },
      ];
    } else if (contentForPrompt) {
      // Pass inline content directly in the input message
      inputContent = [
        { role: "user", content: contextMessage },
        { role: "user", content: `Generate a comprehensive study summary for the following chapter content:\n\n${contentForPrompt}` },
      ];
    } else {
      inputContent = [
        { role: "user", content: contextMessage },
        { role: "user", content: "Generate the summary based on the provided information." },
      ];
    }

    const result = await callOpenAIStructured<SummaryResult>({
      ...modelFor("materials.chapter-summary"),
      promptText: CHAPTER_SUMMARY_SYSTEM_PROMPT,
      variables: {},
      input: inputContent,
      structuredOutput: SUMMARY_OUTPUT_SCHEMA,
      fileIds: fileIds.length > 0 ? fileIds : [],
      usageContext: createUsageContext("generate-chapter-summary", {
        promptKey: "chapter_summary",
        courseId: resolvedCourseId,
      }),
    });

    const llmDuration = llmTimer();
    logger.info("AI call completed", { durationMs: llmDuration, result });

    // Return the LLM response so user can see it
    return new Response(
      JSON.stringify({
        success: result.status === "success",
        llmResponse: result
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    logger.exception("Error generating chapter summary", error);

    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    if (errorMessage.includes("429") || errorMessage.includes("rate limit")) {
      return new Response(JSON.stringify({ error: "Rate limit exceeded. Please try again later." }), {
        status: 429,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (errorMessage.includes("402") || errorMessage.includes("credits")) {
      return new Response(JSON.stringify({ error: "API credits exhausted." }), {
        status: 402,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
};
