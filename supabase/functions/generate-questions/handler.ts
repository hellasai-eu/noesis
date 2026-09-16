import "https://deno.land/x/xhr@0.1.0/mod.ts";

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getEffectiveLanguage, getLanguageInstruction } from "../_shared/language-utils.ts";
import {
  callOpenAIStructured,
  StructuredOutputSchema,
  OpenAIError,
  OpenAIRateLimitError,
  OpenAIPaymentRequiredError,
} from "../_shared/openai-client.ts";
import { AiFeatureDisabledError } from "../_shared/openai-client.ts";
import { modelFor } from "../_shared/model-policy.ts";
import { render } from "../_shared/render.ts";
import { logger } from "../_shared/logger.ts";
import { validateGeneratedAnswers } from "../_shared/answer-validator.ts";
import { MCQ_SYSTEM_PROMPT, MCQ_USER_PROMPT } from "../_shared/prompts/generate-questions.ts";
import { capNumQuestions } from "../_shared/question-utils.ts";
import { buildGroupAudienceHint } from "../_shared/group-audience.ts";
import { resolveStudentTarget, studentTargetErrorResponse } from "../_shared/resolve-student-target.ts";
import { toMcqUnified } from "../_shared/question-payload.ts";
import {
  fetchWholeMaterialSources,
  normalizeMaterialIds,
  splitReturnedSourceIds,
  wholeMaterialPromptLines,
  type WholeMaterialSource,
} from "../_shared/whole-material-sources.ts";
import {
  DIAGRAM_SCHEMA_FRAGMENT,
  diagramInstructions,
  parseDiagramMode,
  validateDiagram,
} from "../_shared/diagram-mode.ts";
import {
  fetchStudyGuideSources,
  normalizeStudyGuideIds,
  studyGuidePromptLines,
  studyGuideTheoryBlocks,
  type StudyGuideSource,
} from "../_shared/study-guide-sources.ts";
import { isAuthorizedCourseManager } from "../_shared/study-guide-context.ts";
import {
  AAL2_REQUIRED_CODE,
  AAL2_REQUIRED_MESSAGE,
  callerMfaSatisfied,
} from "../_shared/require-aal2.ts";

export const MCQ_OUTPUT_SCHEMA: StructuredOutputSchema = {
  name: "generate_quiz_questions",
  strict: true,
  schema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        description: "Generation status of the questions (success or error)",
        enum: ["success", "error"],
      },
      questions: {
        type: "array",
        description: "Exactly N quiz questions",
        items: {
          type: "object",
          properties: {
            question: {
              type: "string",
              description: "The question text",
            },
            options: {
              type: "array",
              description: "2-4 answer options",
              items: {
                type: "string",
                description: "An answer choice",
              },
              minItems: 2,
              maxItems: 4,
            },
            correct_answers: {
              type: "array",
              description:
                "Indices of the correct answer options (0-based, must be < options.length). Most questions have a single index; mark multiple ONLY when the source genuinely supports more than one (e.g. 'which of these are prime?'). For 2-option True/False items, use exactly [0] or [1]. Never empty.",
              items: {
                type: "integer",
                minimum: 0,
                maximum: 3,
              },
              minItems: 1,
              maxItems: 3,
            },
            explanation: {
              type: "string",
              description: "Explanation of why the correct answer is right",
            },
            difficulty: {
              type: "string",
              enum: ["easy", "medium", "hard"],
              description: "The difficulty level of this question",
            },
            chapter_ids: {
              type: "array",
              description: "List of chapter IDs the question is linked to",
              items: {
                type: "string",
                description: "A chapter ID",
              },
            },
            competency_ids: {
              type: "array",
              description: "List of competency IDs the question is linked to",
              items: {
                type: "string",
                description: "A competency ID",
              },
            },
            generation_rationale: {
              type: "string",
              description:
                "A 1-3 sentence instructor-facing explanation of why this question was generated: which source input (chapter, competency, special instruction) drove it and what concept or skill it tests. Must NOT reveal which option is correct.",
            },
            diagram: DIAGRAM_SCHEMA_FRAGMENT,
          },
          required: ["question", "options", "correct_answers", "explanation", "difficulty", "chapter_ids", "competency_ids", "generation_rationale", "diagram"],
          additionalProperties: false,
        },
      },
    },
    required: ["status", "questions"],
    additionalProperties: false,
  },
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Content size limits for validation
const MAX_PAGES = 400;
const MAX_SIZE_BYTES = 32 * 1024 * 1024; // 32MB

interface ChapterInfo {
  id: string;
  title: string;
  chapter_number: number;
  content_type: string;
  material_title: string;
  material_id: string;
  material_type: string;
  chapter_openai_file_id: string | null;
  content: string | null;
  instructions: string | null;
}

interface GeneratedQuestion {
  question: string;
  options: string[];
  correct_answers: number[];
  explanation: string;
  difficulty: string;
  chapter_ids: string[];
  competency_ids: string[];
  generation_rationale?: string;
  diagram?: { format?: string; source?: string; alt?: string } | null;
}

interface GenerateQuestionsResult {
  questions: GeneratedQuestion[];
}

export const handler = async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const {
      courseId,
      numQuestions,
      difficulty,
      chapterIds,
      // Chapterless "Other" materials, taken whole (#1019). Independent of
      // `chapterIds` — a batch can mix selected chapters with whole documents.
      materialIds,
      // Completed study guides as sources: their stored theory goes into the
      // prompt inline, and their existing questions join the dedup list.
      studyGuideIds,
      competencyIds,
      startHidden = false,
      specialInstructions,
      enableTrueFalse = false,
      diagramMode: diagramModeRaw,
      group_id: targetGroupIdInput,
      student_user_id: targetStudentUserId,
    } = await req.json();
    const diagramMode = parseDiagramMode(diagramModeRaw);
    let targetGroupId: string | undefined = targetGroupIdInput;

    // Cap numQuestions at 5 to keep quality high and batches small
    const cappedNumQuestions = capNumQuestions(numQuestions);

    logger.info("Generating questions", {
      courseId,
      numQuestions: cappedNumQuestions,
      difficulty,
      chaptersCount: chapterIds?.length || 0,
      wholeMaterialsCount: materialIds?.length || 0,
      studyGuidesCount: studyGuideIds?.length || 0,
      competenciesCount: competencyIds?.length || 0,
      hasSpecialInstructions: !!specialInstructions,
      enableTrueFalse,
    });

    const requestedMaterialIds = normalizeMaterialIds(materialIds);
    const requestedStudyGuideIds = normalizeStudyGuideIds(studyGuideIds);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Build query for chapters with material info including openai_file_id, page_count, file_size
    let query = supabase.from("material_chapters").select(`
        id,
        title,
        chapter_number,
        content_type,
        content,
        openai_file_id,
        material_id,
        instructions,
        file_name,
        course_materials(
          id,
          title,
          file_name,
          course_id,
          material_type,
          openai_file_id,
          page_count,
          file_size
        )
      `);

    // Fetch ALL competencies for this course so AI can link to relevant ones
    const { data: allCompetencies, error: allCompError } = await supabase
      .from("course_competencies")
      .select("id, title, description, chapter_id")
      .eq("course_id", courseId);

    if (allCompError) {
      logger.error("Error fetching all competencies", { error: allCompError });
    }

    const courseCompetencies = allCompetencies || [];
    logger.info("Total course competencies", { count: courseCompetencies.length });

    // If competencyIds provided, fetch selected competencies and resolve to chapter IDs
    let resolvedChapterIds = chapterIds;
    let competencyContext = "";
    let selectedCompetencies: any[] = [];

    if (competencyIds && competencyIds.length > 0) {
      selectedCompetencies = courseCompetencies.filter((c: any) => competencyIds.includes(c.id));
      logger.info("Selected competencies", { count: selectedCompetencies.length });

      // Build competency context for the prompt (selected ones to focus on)
      competencyContext = selectedCompetencies
        .map((c: any) => `- ${c.title}${c.description ? `: ${c.description}` : ""}`)
        .join("\n");

      // Resolve chapters via competency_chapters junction table
      const { data: junctionData, error: junctionError } = await supabase
        .from("competency_chapters")
        .select("chapter_id")
        .in("competency_id", competencyIds);

      if (junctionError) {
        logger.error("Error fetching competency_chapters junction", { error: junctionError });
      }

      // Get unique chapter IDs from junction table + legacy chapter_id column
      const junctionChapterIds = (junctionData || []).map((j: any) => j.chapter_id);
      const legacyChapterIds = selectedCompetencies.map((c: any) => c.chapter_id).filter(Boolean);

      const allCompetencyChapterIds = [...new Set([...junctionChapterIds, ...legacyChapterIds])] as string[];

      if (allCompetencyChapterIds.length > 0) {
        resolvedChapterIds = allCompetencyChapterIds;
        logger.info("Resolved chapters from competencies", {
          junctionCount: junctionChapterIds.length,
          legacyCount: legacyChapterIds.length,
          uniqueTotal: allCompetencyChapterIds.length
        });
      }
    }

    // Filter by specific chapter IDs if provided
    // An unfiltered chapter query means "every chapter in the course" — the
    // long-standing default when a caller names no chapters and no
    // competencies. A whole-document request must NOT inherit it: it selected
    // one document, and dragging the entire course along would generate from
    // material nobody picked and blow the page budget on the way (#1019).
    // A study-guide request is the same shape: its theory is the input, and
    // pulling every chapter in alongside it would drown the selected source.
    const wantsChapters =
      (resolvedChapterIds?.length ?? 0) > 0 ||
      (requestedMaterialIds.length === 0 && requestedStudyGuideIds.length === 0);
    if (resolvedChapterIds && resolvedChapterIds.length > 0) {
      query = query.in("id", resolvedChapterIds);
    }

    const { data: chapters, error: chaptersError } = wantsChapters
      ? await query
      : { data: [], error: null };

    if (chaptersError) {
      logger.error("Error fetching chapters", { error: chaptersError });
      throw new Error("Failed to fetch course chapters");
    }

    // Fetch course info for context
    const { data: course, error: courseError } = await supabase
      .from("courses")
      .select("title, description, theme, language, institution_id, institutions(name)")
      .eq("id", courseId)
      .single();

    if (courseError) {
      logger.error("Error fetching course", { error: courseError });
    }

    const courseTitle = course?.title || "Unknown Course";
    const courseDescription = course?.description || "";
    const courseTopic = course?.theme || "";
    const institutionId = course?.institution_id || null;
    const institutionName = (course?.institutions as any)?.name || "Unknown Institution";

    // Set logger context with course and institution info
    logger.setContext({
      courseId,
      courseName: courseTitle,
      institutionId,
      institutionName,
    });

    logger.info("Course context", {
      title: courseTitle,
      topic: courseTopic,
      descriptionLength: courseDescription.length,
    });

    // Filter to only include chapters from the correct course
    const validChapters = (chapters || []).filter(
      (ch: any) => ch.course_materials?.course_id === courseId,
    );

    // Chapterless "Other" materials, attached whole (#1019). Scoped to this
    // course inside the helper, so a body id cannot reach another institution's
    // document.
    const wholeMaterials: WholeMaterialSource[] = await fetchWholeMaterialSources(
      supabase,
      courseId,
      materialIds,
    );

    // Study guides are instructor-authored content, so this path authorizes
    // before it reads anything: resolve the caller from the bearer token and
    // require course-manager rights on the requested course. The guides are
    // then fetched scoped to that same course, so authorizing the body's
    // courseId IS authorizing each guide's course.
    if (requestedStudyGuideIds.length > 0) {
      const guideAuthToken = req.headers.get("authorization")
        ?.replace(/^Bearer\s+/i, "")
        .trim();
      if (!guideAuthToken) {
        return new Response(
          JSON.stringify({ error: "Authorization required when generating from study guides" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const { data: { user: guideUser }, error: guideAuthError } = await supabase.auth.getUser(
        guideAuthToken,
      );
      if (guideAuthError || !guideUser?.id) {
        return new Response(
          JSON.stringify({ error: "Invalid authentication" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      // Service-role client, so RLS's aal2 enforcement never runs here — refuse
      // an MFA-enrolled caller whose token is still aal1.
      if (!callerMfaSatisfied(guideUser, guideAuthToken)) {
        return new Response(
          JSON.stringify({ error: AAL2_REQUIRED_MESSAGE, code: AAL2_REQUIRED_CODE }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const guideAuth = await isAuthorizedCourseManager(supabase, guideUser.id, courseId);
      if (!guideAuth.ok) {
        return new Response(
          JSON.stringify({ error: guideAuth.error }),
          { status: guideAuth.status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    // Completed study guides as sources. Scoped to this course inside the
    // helper, which also REFUSES any guide that is not complete — every piece
    // must have theory and questions before a guide can feed the bank.
    const guideSourcesResult = await fetchStudyGuideSources(
      supabase,
      courseId,
      requestedStudyGuideIds,
    );
    if (!guideSourcesResult.ok) {
      return new Response(
        JSON.stringify({ error: guideSourcesResult.error }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    const studyGuideSources: StudyGuideSource[] = guideSourcesResult.sources;

    logger.info("Fetched chapters", {
      total: chapters?.length,
      validForCourse: validChapters.length,
      wholeMaterials: wholeMaterials.length,
      studyGuides: studyGuideSources.length,
    });

    if (
      validChapters.length === 0 &&
      wholeMaterials.length === 0 &&
      studyGuideSources.length === 0
    ) {
      return new Response(
        JSON.stringify({ error: "No course content found. Please add chapters to your materials first." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Validate total pages and size to prevent timeouts
    let totalPages = 0;
    let totalSizeBytes = 0;

    for (const ch of validChapters) {
      const material = ch.course_materials as any;
      const materialPages = material?.page_count || 0;
      const materialSize = material?.file_size || 0;

      // Estimate chapter pages from file_name or content
      let chapterPages = 0;
      const fileName = ch.file_name || "";
      const pageMatch = fileName.match(/Pages?\s*(\d+)\s*-\s*(\d+)/i);

      if (pageMatch) {
        chapterPages = parseInt(pageMatch[2]) - parseInt(pageMatch[1]) + 1;
      } else if (ch.content) {
        // ~3000 chars per page estimate
        chapterPages = Math.max(1, Math.ceil(ch.content.length / 3000));
      } else {
        chapterPages = 10; // fallback estimate
      }

      // Estimate chapter size
      let chapterSize = 0;
      if (chapterPages > 0 && materialPages > 0 && materialSize > 0) {
        chapterSize = Math.round(materialSize * (chapterPages / materialPages));
      } else if (ch.content) {
        chapterSize = new TextEncoder().encode(ch.content).length;
      }

      totalPages += chapterPages;
      totalSizeBytes += chapterSize;
    }

    // A whole document counts as itself. There is no page range to apportion —
    // the entire file is attached — so `page_count` is the real figure rather
    // than an estimate, and the same 400-page / 32MB budget applies.
    for (const m of wholeMaterials) {
      totalPages += m.pageCount || 10;
      totalSizeBytes += m.sizeBytes;
    }

    // Study guide theory goes inline, so it counts like chapter content
    // fallbacks do: ~3000 chars per page.
    for (const g of studyGuideSources) {
      const chars = g.sections.reduce((sum, s) => sum + s.text.length, 0);
      totalPages += Math.max(1, Math.ceil(chars / 3000));
      totalSizeBytes += new TextEncoder().encode(
        g.sections.map((s) => s.text).join("\n"),
      ).length;
    }

    logger.info("Content size validation", {
      totalPages,
      totalSizeMB: (totalSizeBytes / (1024 * 1024)).toFixed(2),
      maxPages: MAX_PAGES,
      maxSizeMB: MAX_SIZE_BYTES / (1024 * 1024)
    });

    // Reject if exceeds limits
    if (totalPages > MAX_PAGES || totalSizeBytes > MAX_SIZE_BYTES) {
      const pagesFormatted = totalPages.toLocaleString();
      const sizeFormatted = (totalSizeBytes / (1024 * 1024)).toFixed(1);
      return new Response(
        JSON.stringify({
          error: `Selected content exceeds limits: ${pagesFormatted} pages (max ${MAX_PAGES}) and ${sizeFormatted}MB (max 32MB). Please select fewer competencies or chapters.`
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Build chapter info with OpenAI file IDs (chapter-level only, no material fallback)
    const chapterInfos: ChapterInfo[] = validChapters.map((ch: any) => ({
      id: ch.id,
      title: ch.title,
      chapter_number: ch.chapter_number,
      content_type: ch.content_type,
      material_title: ch.course_materials?.title || ch.course_materials?.file_name || "Unknown",
      material_id: ch.material_id,
      material_type: ch.course_materials?.material_type || "textbook",
      chapter_openai_file_id: ch.openai_file_id || null,
      content: ch.content || null,
      instructions: ch.instructions || null,
    }));

    // Collect OpenAI file IDs: chapter-level only, fallback to content text
    const fileIds: string[] = [];
    // Whole documents always arrive as a file — `fetchWholeMaterialSources`
    // drops any that have not synced, because they have no chapter text to fall
    // back on.
    //
    // Collected BEFORE the chapters: the combined list is capped at 20 files
    // below, and an explicitly selected document must never be the thing that
    // cap silently discards while the prompt still names it.
    for (const m of wholeMaterials) {
      if (!fileIds.includes(m.openaiFileId)) fileIds.push(m.openaiFileId);
    }
    const contentFallbacks: { chapterId: string; title: string; content: string }[] = [];

    for (const ch of chapterInfos) {
      if (ch.chapter_openai_file_id) {
        // Chapter has its own file ID - use it
        if (!fileIds.includes(ch.chapter_openai_file_id)) {
          fileIds.push(ch.chapter_openai_file_id);
        }
      } else if (ch.content) {
        // No chapter file ID, use content as text fallback
        contentFallbacks.push({ chapterId: ch.id, title: ch.title, content: ch.content });
      }
      // Skip chapters with neither file ID nor content - they won't contribute
    }

    // If no file IDs and no content, error out
    if (fileIds.length === 0 && contentFallbacks.length === 0 && studyGuideSources.length === 0) {
      return new Response(
        JSON.stringify({
          error: "No materials have been synced to OpenAI and no chapter content available. Please upload materials or add chapter content.",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    logger.info("OpenAI file IDs collected", {
      fileIdCount: fileIds.length,
      contentFallbackCount: contentFallbacks.length
    });

    // Get language settings
    const effectiveLanguage = await getEffectiveLanguage(supabase, courseId);
    const langInfo = getLanguageInstruction(effectiveLanguage);
    logger.info("Using language", { name: langInfo.name, code: effectiveLanguage });

    // Fetch existing questions filtered by relevant chapters/competencies for better deduplication
    // Seeded with the selected study guides' own questions: they were already
    // asked of students inside the guide, and are the first thing a batch
    // generated from that guide's theory must not repeat.
    let allExistingQuestions: { question: string }[] = studyGuideSources.flatMap((g) =>
      g.askedQuestions.map((question) => ({ question }))
    );

    // A guide's source chapters join the dedup filter so bank questions on the
    // same ground — including earlier guide-sourced batches, which are linked
    // to those chapters below — are also offered to the model as "already
    // asked".
    const guideSourceChapterIds = [
      ...new Set(studyGuideSources.flatMap((g) => g.sourceChapterIds)),
    ];
    const dedupChapterIds = [
      ...new Set([...(resolvedChapterIds ?? []), ...guideSourceChapterIds]),
    ];

    // A whole-material guide has no source chapters at all — its provenance
    // channel is `question_materials`, so earlier batches from such a guide
    // are found there rather than through chapter links.
    const guideSourceMaterialIds = [
      ...new Set(
        studyGuideSources
          .map((g) => g.sourceMaterialId)
          .filter((id): id is string => !!id),
      ),
    ];
    if (guideSourceMaterialIds.length > 0) {
      const { data: materialQuestions, error: materialQError } = await supabase
        .from("questions")
        .select(`
          question,
          question_materials!inner(material_id)
        `)
        .eq("course_id", courseId)
        .in("question_materials.material_id", guideSourceMaterialIds)
        .limit(150);
      if (materialQError) {
        logger.error("Error fetching material-filtered questions", { error: materialQError });
      } else {
        for (const q of (materialQuestions ?? []) as { question: string }[]) {
          if (!allExistingQuestions.find((eq) => eq.question === q.question)) {
            allExistingQuestions.push({ question: q.question });
          }
        }
      }
    }

    // Fetch questions by chapter references if we have resolved chapter IDs
    if (dedupChapterIds.length > 0) {
      const { data: chapterQuestions, error: chapterQError } = await supabase
        .from("questions")
        .select(`
          question,
          question_chapters!inner(chapter_id)
        `)
        .eq("course_id", courseId)
        .in("question_chapters.chapter_id", dedupChapterIds)
        .limit(200);

      if (chapterQError) {
        logger.error("Error fetching chapter-filtered questions", { error: chapterQError });
      } else if (chapterQuestions) {
        for (const q of chapterQuestions as { question: string }[]) {
          if (!allExistingQuestions.find((eq) => eq.question === q.question)) {
            allExistingQuestions.push({ question: q.question });
          }
        }
      }
    }

    // Also fetch questions by competency if competency IDs provided
    if (competencyIds && competencyIds.length > 0) {
      const { data: compQuestions, error: compQError } = await supabase
        .from("questions")
        .select(`
          question,
          question_competencies!inner(competency_id)
        `)
        .eq("course_id", courseId)
        .in("question_competencies.competency_id", competencyIds)
        .limit(150);

      if (compQError) {
        logger.error("Error fetching competency-filtered questions", { error: compQError });
      } else if (compQuestions) {
        // Merge with chapter-based questions, avoiding duplicates
        for (const q of compQuestions) {
          if (!allExistingQuestions.find(eq => eq.question === q.question)) {
            allExistingQuestions.push({ question: q.question });
          }
        }
      }
    }

    // Fallback: if no chapter/competency filters or no results, fetch general course questions
    if (allExistingQuestions.length === 0) {
      const { data: fallbackQuestions, error: fallbackQError } = await supabase
        .from("questions")
        .select("question")
        .eq("course_id", courseId)
        .limit(100);

      if (fallbackQError) {
        logger.error("Error fetching fallback questions", { error: fallbackQError });
      } else if (fallbackQuestions) {
        allExistingQuestions = fallbackQuestions;
      }
    }

    const pastQuestionsList = allExistingQuestions
      .map((q: { question: string }) => q.question)
      .join("\n- ");
    const pastQuestionsText = pastQuestionsList ? `- ${pastQuestionsList}` : "";
    logger.info("Fetched existing questions for deduplication", {
      count: allExistingQuestions.length,
      filteredByChapters: dedupChapterIds.length,
      filteredByCompetencies: competencyIds?.length || 0,
      seededFromStudyGuides: studyGuideSources.reduce((n, g) => n + g.askedQuestions.length, 0),
    });

    // Limit to first 20 files to reduce token usage with file references vs inline content
    const limitedFileIds = fileIds.slice(0, 20);

    // Only the first 20 files are sent, so a large selection can leave sources
    // unattached. What follows names ONLY what the model actually receives.
    //
    // Listing a source whose file was cut is the failure worth avoiding: the
    // model is told a chapter is available, cannot see it, and still attributes
    // questions to it — inventing content for material it never got. A chapter
    // with no file of its own is different: its text goes inline via
    // `contentFallbacks`, which is never truncated, so it is genuinely present.
    const attachedFileIds = new Set(limitedFileIds);
    const attachedChapterInfos = chapterInfos.filter((ch) =>
      ch.chapter_openai_file_id ? attachedFileIds.has(ch.chapter_openai_file_id) : !!ch.content
    );
    const attachedWholeMaterials = wholeMaterials.filter((m) =>
      attachedFileIds.has(m.openaiFileId)
    );
    if (
      attachedChapterInfos.length < chapterInfos.length ||
      attachedWholeMaterials.length < wholeMaterials.length
    ) {
      logger.warn("Source list truncated to the OpenAI file cap", {
        chaptersSelected: chapterInfos.length,
        chaptersAttached: attachedChapterInfos.length,
        documentsSelected: wholeMaterials.length,
        documentsAttached: attachedWholeMaterials.length,
      });
    }

    // Build content text from fallbacks (if any chapters have no file IDs)
    const contentText = contentFallbacks.length > 0
      ? contentFallbacks.map((cf) => `=== ${cf.title} ===\n${cf.content}`).join("\n\n")
      : "";

    const llmTimer = logger.startTimer("openai_call");

    // Build the source list for the prompt: selected chapters, then any whole
    // documents, which are named separately because they have no chapter id to
    // attribute a question to, then any study guides, whose theory arrives
    // inline rather than as an attached file.
    const chapterListText = [
      ...attachedChapterInfos.map(
        (ch) => `- "${ch.title}" (Chapter ${ch.chapter_number}) from "${ch.material_title}"`,
      ),
      wholeMaterialPromptLines(attachedWholeMaterials),
      studyGuidePromptLines(studyGuideSources),
    ]
      .filter(Boolean)
      .join("\n");

    // Build chapter-specific instructions for the prompt
    const chapterInstructionsText = attachedChapterInfos
      .filter((ch) => ch.instructions && ch.instructions.trim())
      .map((ch) => `- Chapter "${ch.title}": ${ch.instructions}`)
      .join("\n");

    // Resolve target audience (optional). A targeted student lazily creates
    // a hidden singleton offering_group so all downstream group-aware paths
    // (assignment, RLS, visibility) reuse the same plumbing as targeted groups.
    let groupAudienceHintText = "";
    // Provenance (not assignment): the validated group this batch was
    // generated FOR, stamped onto every returned row. Only set once the
    // target actually resolved against this course — a bogus request id is
    // ignored, exactly as the audience hint ignores it.
    let generatedForGroupId: string | null = null;
    let resolvedTarget: {
      kind: "student";
      offering_id: string;
      group_id: string;
      student_user_id: string;
      student_full_name: string | null;
      used_admin_notes: boolean;
    } | null = null;
    if (targetStudentUserId) {
      // Auth guard: caller must be authenticated and have can_manage_offering access.
      const authHeader = req.headers.get("authorization");
      if (!authHeader) {
        return new Response(
          JSON.stringify({ error: "Authorization required when targeting a specific student" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const token = authHeader.replace("Bearer ", "");
      const { data: { user }, error: authError } = await supabase.auth.getUser(token);
      if (authError || !user) {
        return new Response(
          JSON.stringify({ error: "Invalid authentication" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      // Service-role client, so RLS's aal2 enforcement never runs here — refuse
      // an MFA-enrolled caller whose token is still aal1.
      if (!callerMfaSatisfied(user, token)) {
        return new Response(
          JSON.stringify({ error: AAL2_REQUIRED_MESSAGE, code: AAL2_REQUIRED_CODE }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const authedClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
        global: { headers: { Authorization: authHeader } },
      });
      const studentResult = await resolveStudentTarget(supabase, authedClient, courseId, targetStudentUserId);
      if (!studentResult.ok) {
        return studentTargetErrorResponse(studentResult, corsHeaders);
      }
      if (studentResult.data) {
        targetGroupId = studentResult.data.targetGroupId;
        groupAudienceHintText = studentResult.data.groupAudienceHintText;
        resolvedTarget = studentResult.data.resolvedTarget;
        generatedForGroupId = studentResult.data.targetGroupId ?? null;
      }
    } else if (targetGroupId) {
      const audience = await buildGroupAudienceHint(supabase, courseId, targetGroupId);
      if (audience) {
        generatedForGroupId = audience.group_id;
        groupAudienceHintText = "TARGET STUDENT GROUP:\n" + audience.hint;
        logger.info("Targeting group", {
          group_id: audience.group_id,
          offering_id: audience.offering_id,
          hasDescription: audience.description !== null,
        });
      } else {
        logger.warn("Target group not found or not in this course; ignoring", { targetGroupId });
      }
    }

    // Build system prompt variables. ONLY semi-static per-chapter content goes
    // here so OpenAI's prefix cache can hit across calls in the same chapter.
    // Dynamic per-call substitutions (special_instructions, group_audience_hint)
    // are placed in the user message below — see issue #558 and the prompts
    // README for the static-first / dynamic-last contract.
    // Study guide theory is inline content like the chapter fallbacks, and
    // just as stable per selection, so it belongs in the system prompt too.
    // The theory wins over anything else the model may know about the topic:
    // the instructor may have rewritten it after drafting, and a question
    // testing anything else would contradict what the student actually reads.
    const guideTheoryText = studyGuideTheoryBlocks(studyGuideSources);
    const inlineContentParts = [
      contentText ? "Here is the chapter content:\n" + contentText : "",
      guideTheoryText
        ? "Here is the study guide theory (instructor-approved prose — treat it as the source of truth for questions about these guides):\n" +
          guideTheoryText
        : "",
    ].filter(Boolean);

    const systemVariables: Record<string, string> = {
      chapter_instructions: chapterInstructionsText
        ? "Chapter-specific instructions:\n" + chapterInstructionsText
        : "",
      chapter_content: inlineContentParts.join("\n\n"),
    };

    logger.info("Calling OpenAI with local prompt", {
      fileCount: limitedFileIds.length,
      limitedFrom: fileIds.length,
      hasContentFallback: contentFallbacks.length > 0,
    });

    // Build competency list for the prompt
    // When competencies are explicitly selected, focus on those
    // When generating by chapters, instruct AI to assign relevant competencies from the full list
    const competencyListText = selectedCompetencies.length > 0
      ? selectedCompetencies.map((c: any) => `- ${c.title}${c.description ? `: ${c.description}` : ""}`).join("\n")
      : (courseCompetencies.length > 0
          ? "No specific competencies selected. Analyze each question and assign ALL relevant competencies from the full competency list below based on what the question assesses."
          : "");

    // Build full competency list with IDs for AI to reference when assigning competencies
    const fullCompetencyListText = courseCompetencies
      .map((c: any) => `- ID: ${c.id} | Title: ${c.title}${c.description ? ` | Description: ${c.description}` : ""}`)
      .join("\n");

    logger.info("Prompt context", {
      chapterCount: chapterInfos.length,
      selectedCompetencyCount: selectedCompetencies.length,
      fullCompetencyCount: courseCompetencies.length,
      hasSpecialInstructions: !!specialInstructions,
      hasChapterInstructions: !!chapterInstructionsText
    });

    // Opt-in True/False block (issue #602). T/F is implemented as a SUBSET of
     // MCQ: same type, same storage shape, just 2-option options. When the
     // instructor leaves the toggle off, this substitutes to "" and prompt +
     // schema behave identically to today (the schema is now [2,4] but the
     // model is told "exactly 4 options" so it won't emit 2-option items).
    const trueFalseInstructions = enableTrueFalse
      ? `TRUE/FALSE QUESTIONS (allowed this batch)
When the source material supports a clean, unambiguous true/false claim,
you MAY emit a 2-option MCQ instead of a 4-option one:
\t-\toptions: ["True", "False"] (localized to the content's language —
\t\te.g. "Σωστό" / "Λάθος" for Greek content).
\t-\tcorrect_answers: exactly one of [0] or [1].
\t-\tUse T/F sparingly — prefer 4-option MCQs by default. T/F is for
\t\tfacts that are genuinely binary, not for trick questions or
\t\treworded MCQs.
\t-\tReasonable ratio: ~20–30% of the batch at most.`
      : "";

    try {
      // Build substituted user message from template. Per the static-first /
      // dynamic-last contract (issue #558), per-call dynamic content
      // (group_audience_hint, special_instructions, past_questions, request
      // payload) lives in this template at the END.
      const userVariables: Record<string, string> = {
        full_competency_list: fullCompetencyListText || "No competencies defined for this course",
        chapter_list: chapterListText || "All chapters in the provided materials",
        competency_list: competencyListText || "No competencies defined for this course - skip competency assignment",
        true_false_instructions: trueFalseInstructions,
        diagram_instructions: diagramInstructions(diagramMode),
        group_audience_hint: groupAudienceHintText,
        special_instructions: specialInstructions
          ? "The instructor gave these special instructions for question generation. You should follow them.\nInstructions: " + specialInstructions
          : "",
        past_questions: pastQuestionsText,
        num: String(cappedNumQuestions),
        difficulty: difficulty || "medium",
        lang: langInfo.name,
      };
      const userMessageText = render(MCQ_USER_PROMPT, userVariables);

      const result = await callOpenAIStructured<GenerateQuestionsResult>({
        ...modelFor("question-bank.mcq"),
        promptText: MCQ_SYSTEM_PROMPT,
        variables: systemVariables,
        input: [{ role: "user" as const, content: userMessageText }],
        fileIds: limitedFileIds.length > 0 ? limitedFileIds : undefined,
        structuredOutput: MCQ_OUTPUT_SCHEMA,
        backgroundOptions: {
          enabled: true,
          pollIntervalMs: 2000,
          maxPollTimeMs: 240000,
        },
        usageContext: {
          functionName: "generate-questions",
          promptKey: "mcq_generation",
          institutionId: institutionId,
          courseId: courseId,
        },
      });

      const llmDuration = llmTimer();
      logger.info("Generated questions", { count: result.questions?.length || 0, durationMs: llmDuration });

      const questions = result.questions;
      if (!Array.isArray(questions)) {
        logger.error("Questions is not an array", { result });
        throw new Error("AI returned an invalid questions format");
      }

      // Filter out invalid questions (missing required fields).
      // Multi-correct (#592): correct_answers must be a non-empty array of
      // distinct integers, each within range of options.
      const validQuestions = questions.filter((q: GeneratedQuestion) => {
        const okShape =
          q.question &&
          typeof q.question === 'string' &&
          Array.isArray(q.options) &&
          q.options.length >= 2 &&
          Array.isArray(q.correct_answers) &&
          q.correct_answers.length >= 1;

        const okIndices = okShape && q.correct_answers.every(
          (i) => typeof i === 'number' && Number.isInteger(i) && i >= 0 && i < q.options.length,
        );
        const noDupes = okIndices && new Set(q.correct_answers).size === q.correct_answers.length;
        const isValid = okShape && okIndices && noDupes;

        if (!isValid) {
          logger.warn("Filtering out invalid question", {
            hasQuestion: !!q.question,
            optionsCount: q.options?.length,
            correctAnswers: q.correct_answers,
          });
        }
        return isValid;
      });

      logger.info("Valid questions after filtering", {
        original: questions.length,
        valid: validQuestions.length,
        filtered: questions.length - validQuestions.length
      });

      if (validQuestions.length === 0) {
        return new Response(
          JSON.stringify({ error: "AI failed to generate valid questions. Please try again." }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Validate correct answers using AI validator
      const validationResult = await validateGeneratedAnswers(validQuestions, {
        functionName: "generate-questions",
        promptKey: "answer_validation",
        institutionId: institutionId,
        courseId: courseId,
      });

      logger.info("Answer validation complete", {
        original: validQuestions.length,
        validated: validationResult.valid.length,
        filtered: validationResult.filtered.length,
      });

      // Build set of valid competency IDs for validation
      const validCompetencyIds = new Set(courseCompetencies.map((c: any) => c.id));

      const now = new Date().toISOString();

      // Return ALL questions with their validation status (not just passed ones)
      const questionsToInsert = validQuestions.map((q: GeneratedQuestion) => {
        // Find validation result for this question
        const validationEntry = validationResult.validationResults.find(
          (vr) => vr.question === q
        );
        const verdict = validationEntry?.verdict || {
          verdict: "INSUFFICIENT_INFORMATION" as const,
          confidence: 0,
          message: "Validation not completed"
        };

        // Partition AI-returned ids into chapter links and whole-document
        // links (#1019): the prompt tells the model to attribute questions
        // drawn from a chapterless document by its document id, using the
        // same `chapter_ids` channel.
        const { chapterIds: modelChapterIds, materialIds: modelMaterialIds } =
          splitReturnedSourceIds(
            q.chapter_ids,
            attachedChapterInfos.map((ch) => ch.id),
            attachedWholeMaterials,
            wholeMaterials.length,
          );

        // Guide-sourced questions link to the guide's source chapters — all of
        // them, exactly as the guide's own question writer stamps its rows.
        // The model cannot attribute these itself (it saw theory, not
        // chapters), and the links are what let the next dedup pass and the
        // bank's chapter filters find this batch again. A whole-material guide
        // has no source chapters, so its questions link to the guide's
        // material instead, via the same `question_materials` channel as
        // whole-document generation (#1019).
        const linkedChapterIds = guideSourceChapterIds.length > 0
          ? [...new Set([...modelChapterIds, ...guideSourceChapterIds])]
          : modelChapterIds;
        const linkedMaterialIds = guideSourceMaterialIds.length > 0
          ? [...new Set([...modelMaterialIds, ...guideSourceMaterialIds])]
          : modelMaterialIds;

        // Filter AI-returned competency IDs to only valid ones
        const linkedCompetencyIds = (q.competency_ids || []).filter((cId: string) => validCompetencyIds.has(cId));

        const rawRationale = typeof q.generation_rationale === "string" ? q.generation_rationale.trim() : "";
        if (!rawRationale) {
          logger.warn("Generated question missing generation_rationale", { question: q.question?.slice(0, 80) });
        }

        // #627 — best-effort diagram. Drop the field when the model emitted
        // something malformed/empty/oversize; the question is still inserted.
        const validatedDiagram = diagramMode === "off"
          ? null
          : validateDiagram(q.diagram ?? null);
        return {
          course_id: courseId,
          question: q.question,
          ...toMcqUnified({
            options: q.options,
            correct_answers: q.correct_answers,
            diagram: validatedDiagram ?? undefined,
          }),
          explanation: q.explanation || "",
          difficulty: q.difficulty || "medium",
          upvotes: 0,
          downvotes: 0,
          hidden: startHidden,
          is_user_generated: false,
          competency_id: linkedCompetencyIds.length > 0 ? linkedCompetencyIds[0] : null,
          competency_ids: linkedCompetencyIds,
          chapter_ids: linkedChapterIds,
          material_ids: linkedMaterialIds,
          generated_for_group_id: generatedForGroupId,
          generation_rationale: rawRationale || null,
          // Include validation status
          validation_status: verdict.verdict,
          validation_confidence: verdict.confidence,
          validation_message: verdict.message,
          validated_at: now,
        };
      });

      // Summary stats for the response
      const validCount = validationResult.valid.length;
      const invalidCount = validationResult.filtered.length;

      logger.info("Returning all questions with validation status", {
        total: questionsToInsert.length,
        valid: validCount,
        invalid: invalidCount,
      });

      return new Response(
        JSON.stringify({
          questions: questionsToInsert,
          warning: null,
          model: `${modelFor("question-bank.mcq").model} (Responses API)`,
          validationSummary: {
            total: questionsToInsert.length,
            valid: validCount,
            needsReview: invalidCount,
          },
          target: resolvedTarget,
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    } catch (error) {
      llmTimer();
      logger.error("OpenAI error", { error: error instanceof Error ? error.message : String(error) });

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
        return new Response(JSON.stringify({ error: "Rate limit exceeded. Please try again in a moment." }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (error instanceof OpenAIPaymentRequiredError) {
        return new Response(JSON.stringify({ error: "AI usage limit reached. Please try again later." }), {
          status: 402,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      throw error;
    }
  } catch (error) {
    logger.exception("Error in generate-questions", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
};
