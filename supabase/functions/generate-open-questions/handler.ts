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
import { OPEN_QUESTIONS_SYSTEM_PROMPT, OPEN_QUESTIONS_USER_PROMPT } from "../_shared/prompts/generate-open-questions.ts";
import { buildGroupAudienceHint } from "../_shared/group-audience.ts";
import { resolveStudentTarget, studentTargetErrorResponse } from "../_shared/resolve-student-target.ts";
import { toOpenUnified } from "../_shared/question-payload.ts";
import {
  fetchWholeMaterialSources,
  normalizeMaterialIds,
  splitReturnedSourceIds,
  wholeMaterialPromptLines,
  type WholeMaterialSource,
} from "../_shared/whole-material-sources.ts";
import { isAuthorizedCourseManager } from "../_shared/study-guide-context.ts";
import {
  DIAGRAM_SCHEMA_FRAGMENT,
  diagramInstructions,
  parseDiagramMode,
  validateDiagram,
} from "../_shared/diagram-mode.ts";
import {
  AAL2_REQUIRED_CODE,
  AAL2_REQUIRED_MESSAGE,
  callerMfaSatisfied,
} from "../_shared/require-aal2.ts";

const OPEN_QUESTIONS_OUTPUT_SCHEMA: StructuredOutputSchema = {
  name: "generate_open_questions",
  strict: true,
  schema: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        description: "Array of generated open-ended questions, answers, and detailed explanations",
        items: {
          type: "object",
          properties: {
            question: {
              type: "string",
              description: "The open-ended question text",
            },
            model_answer: {
              type: "string",
              description: "The complete model answer or expected response to the question",
            },
            explanation: {
              type: "string",
              description:
                "DETAILED explanation including: 1) Solution method overview, 2) Step-by-step solution walkthrough, 3) Key concepts/formulas involved, 4) Why each step works, 5) Common mistakes students make (2-3), 6) Progressive hints (4 hints from subtle to direct). This must be comprehensive enough for an AI tutor to guide students through the problem without the original textbook.",
            },
            difficulty: {
              type: "string",
              enum: ["easy", "medium", "hard"],
              description: "Question difficulty level",
            },
            chapter_ids: {
              type: "array",
              description: "Array of chapter UUIDs this question was derived from",
              items: {
                type: "string",
              },
            },
            competency_ids: {
              type: "array",
              description:
                "Array of competency UUIDs this question assesses (can be multiple if the question tests multiple learning objectives)",
              items: {
                type: "string",
              },
            },
            generation_rationale: {
              type: "string",
              description:
                "A 1-3 sentence instructor-facing explanation of why this question was generated: which source input (chapter, competency, special instruction) drove it and what concept or skill it tests. Must NOT reveal the model answer.",
            },
            diagram: DIAGRAM_SCHEMA_FRAGMENT,
          },
          required: ["question", "model_answer", "explanation", "difficulty", "chapter_ids", "competency_ids", "generation_rationale", "diagram"],
          additionalProperties: false,
        },
      },
    },
    required: ["questions"],
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

// Study-guide theory is already distilled prose, so the cap only exists to keep
// a pathologically long guide from blowing the context window.
const MAX_THEORY_CHARS = 120_000;

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
  model_answer: string;
  explanation: string;
  difficulty: string;
  chapter_ids: string[];
  competency_ids?: string[];
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
      competencyIds,
      startHidden = false,
      specialInstructions,
      studyGuideId,
      pieceIds,
      referenceFileIds,
      diagramMode: diagramModeRaw,
      group_id: targetGroupIdInput,
      student_user_id: targetStudentUserId,
    } = await req.json();
    const diagramMode = parseDiagramMode(diagramModeRaw);
    let targetGroupId: string | undefined = targetGroupIdInput;

    logger.info("Generating open-ended questions", {
      courseId,
      numQuestions,
      difficulty,
      chaptersCount: chapterIds?.length || 0,
      wholeMaterialsCount: materialIds?.length || 0,
      competenciesCount: competencyIds?.length || 0,
      studyGuideId: studyGuideId || null,
      hasSpecialInstructions: !!specialInstructions,
    });

    const requestedMaterialIds = normalizeMaterialIds(materialIds);

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

    // Study-guide mode: the guide's generated theory IS the source material for
    // these questions — it is what the students actually read. The guide's
    // source chapters are still resolved, but only so the returned
    // `chapter_ids` keep their provenance; their files are deliberately not
    // attached, since a question must test the theory, not the raw textbook.
    const isStudyGuideMode = typeof studyGuideId === "string" && studyGuideId.length > 0;
    let studyGuideTheoryText = "";

    if (isStudyGuideMode) {
      // A guide's theory is authored content that only a course manager may
      // read. The gateway authenticates nothing here (verify_jwt = false) and
      // this client is service-role, so the caller is resolved from the bearer
      // token and authorized against the course BEFORE any guide row is read
      // — see supabase/functions/AUTHORIZATION.md.
      //
      // study-guide-context.ts authorizes against the course resolved FROM the
      // guide, so that a caller cannot qualify on a course they manage while
      // generating into one they do not. Authorizing on the request's courseId
      // is equivalent here only because the guide is then required to belong to
      // that same course (the check below); keep the two together.
      const authHeader = req.headers.get("authorization");
      const token = authHeader?.replace(/^Bearer\s+/i, "").trim();
      if (!token) {
        return new Response(
          JSON.stringify({ error: "Authorization required when generating from a study guide" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const { data: { user }, error: authError } = await supabase.auth.getUser(token);
      if (authError || !user?.id) {
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
      const auth = await isAuthorizedCourseManager(supabase, user.id, courseId);
      if (!auth.ok) {
        logger.warn("Study guide generation refused", { userId: user.id, courseId, status: auth.status });
        return new Response(
          JSON.stringify({ error: auth.error }),
          { status: auth.status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const { data: guide, error: guideError } = await supabase
        .from("study_guides")
        .select("id, title, course_id")
        .eq("id", studyGuideId)
        .maybeSingle();

      if (guideError) {
        logger.error("Error fetching study guide", { error: guideError });
      }

      // Course scoping: a guide from another course is never a valid source,
      // whatever courseId the caller paired it with.
      if (!guide || guide.course_id !== courseId) {
        return new Response(
          JSON.stringify({ error: "Study guide not found for this course." }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      let pieceQuery = supabase
        .from("study_guide_pieces")
        .select("id, position, title, theory_html")
        .eq("study_guide_id", studyGuideId)
        .order("position", { ascending: true });

      // Absent pieceIds = the whole guide.
      if (Array.isArray(pieceIds) && pieceIds.length > 0) {
        pieceQuery = pieceQuery.in("id", pieceIds);
      }

      const { data: pieces, error: piecesError } = await pieceQuery;
      if (piecesError) {
        logger.error("Error fetching study guide pieces", { error: piecesError });
        throw new Error("Failed to fetch study guide theory");
      }

      const piecesWithTheory = (pieces || []).filter(
        (p: any) => typeof p.theory_html === "string" && p.theory_html.trim().length > 0,
      );

      if (piecesWithTheory.length === 0) {
        return new Response(
          JSON.stringify({
            error:
              "The selected study guide has no generated theory yet. Generate the theory first, then generate questions from it.",
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const theoryBody = piecesWithTheory
        .map((p: any) => `=== ${p.title} ===\n${p.theory_html}`)
        .join("\n\n");
      const truncated = theoryBody.length > MAX_THEORY_CHARS;

      studyGuideTheoryText =
        `Study guide: "${guide.title}"\n\n` +
        (truncated ? theoryBody.slice(0, MAX_THEORY_CHARS) : theoryBody);

      logger.info("Study guide theory context", {
        studyGuideId,
        pieceCount: piecesWithTheory.length,
        theoryChars: theoryBody.length,
        truncated,
      });

      // Provenance only — an explicit chapter selection still wins.
      if (!resolvedChapterIds || resolvedChapterIds.length === 0) {
        const { data: sourceChapters, error: sourceError } = await supabase
          .from("study_guide_source_chapters")
          .select("chapter_id")
          .eq("study_guide_id", studyGuideId);

        if (sourceError) {
          logger.error("Error fetching study guide source chapters", { error: sourceError });
        }

        const sourceChapterIds = (sourceChapters || []).map((r: any) => r.chapter_id);
        if (sourceChapterIds.length > 0) {
          resolvedChapterIds = sourceChapterIds;
          logger.info("Resolved chapters from study guide", { count: sourceChapterIds.length });
        }
      }
    }

    // An unfiltered chapter query means "every chapter in the course" — the
    // long-standing default when a caller names no chapters and no
    // competencies. A whole-document request must NOT inherit it: it selected
    // one document, and dragging the entire course along would generate from
    // material nobody picked and blow the page budget on the way (#1019).
    const wantsChapters =
      (resolvedChapterIds?.length ?? 0) > 0 || requestedMaterialIds.length === 0;
    if (resolvedChapterIds && resolvedChapterIds.length > 0) {
      query = query.in("id", resolvedChapterIds);
    }

    // An unfiltered chapter query means "every chapter in the course", which is
    // right for chapter/competency mode but wrong for a guide that recorded no
    // source chapters — there is nothing to attribute those questions to, and
    // the whole course would be listed as their origin.
    const skipChapterQuery =
      (isStudyGuideMode && (!resolvedChapterIds || resolvedChapterIds.length === 0)) ||
      !wantsChapters;

    let chapters: any[] | null = [];
    let chaptersError: any = null;
    if (!skipChapterQuery) {
      const chaptersResult = await query;
      chapters = chaptersResult.data;
      chaptersError = chaptersResult.error;
    }

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

    logger.info("Fetched chapters", {
      total: chapters?.length,
      validForCourse: validChapters.length,
      wholeMaterials: wholeMaterials.length,
    });

    // In study-guide mode the theory carries the content, so a guide with no
    // usable source chapters of its own is still generatable.
    if (validChapters.length === 0 && wholeMaterials.length === 0 && !isStudyGuideMode) {
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

    logger.info("Content size validation", {
      totalPages,
      totalSizeMB: (totalSizeBytes / (1024 * 1024)).toFixed(2),
      maxPages: MAX_PAGES,
      maxSizeMB: MAX_SIZE_BYTES / (1024 * 1024)
    });

    // Reject if exceeds limits. Not applicable in study-guide mode: the
    // chapters are resolved for linking only and none of their bytes are sent.
    if (!isStudyGuideMode && (totalPages > MAX_PAGES || totalSizeBytes > MAX_SIZE_BYTES)) {
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

    for (const ch of isStudyGuideMode ? [] : chapterInfos) {
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

    // Add reference file IDs if provided (for reference exercises)
    if (referenceFileIds && Array.isArray(referenceFileIds)) {
      for (const refId of referenceFileIds) {
        if (refId && !fileIds.includes(refId)) {
          fileIds.push(refId);
        }
      }
    }

    // If no file IDs and no content, error out. Study-guide mode supplies its
    // own content (the theory), so it never depends on synced material.
    if (fileIds.length === 0 && contentFallbacks.length === 0 && !isStudyGuideMode) {
      return new Response(
        JSON.stringify({
          error: "No materials have been synced to OpenAI and no chapter content available. Please upload materials or add chapter content.",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    logger.info("OpenAI file IDs collected", {
      fileIdCount: fileIds.length,
      contentFallbackCount: contentFallbacks.length,
      fromReferences: referenceFileIds?.length || 0,
    });

    // Get language settings
    const effectiveLanguage = await getEffectiveLanguage(supabase, courseId);
    const langInfo = getLanguageInstruction(effectiveLanguage);
    logger.info("Using language", { name: langInfo.name, code: effectiveLanguage });

    // Fetch existing open questions for this course to avoid duplicates.
    // After #582 the unified `questions` table is the only source.
    const { data: existingQuestions, error: existingQError } = await supabase
      .from("questions")
      .select("question")
      .eq("course_id", courseId)
      .eq("type", "open")
      .limit(100);

    if (existingQError) {
      logger.error("Error fetching existing open questions", { error: existingQError });
    }

    const pastQuestionsList = (existingQuestions || []).map((q: { question: string }) => q.question).join("\n- ");
    const pastQuestionsText = pastQuestionsList ? `- ${pastQuestionsList}` : "";
    logger.info("Fetched existing open questions for deduplication", { count: existingQuestions?.length || 0 });

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
    const attachedChapterInfos = isStudyGuideMode ? chapterInfos : chapterInfos.filter((ch) =>
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

    // Build chapter list for the prompt
    const chapterListText = [
      ...attachedChapterInfos.map(
        (ch) => `- "${ch.title}" (Chapter ${ch.chapter_number}) from "${ch.material_title}"`,
      ),
      wholeMaterialPromptLines(attachedWholeMaterials),
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
    // generated FOR, stamped onto every returned row.
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
    const systemVariables: Record<string, string> = {
      chapter_instructions: chapterInstructionsText
        ? "Chapter-specific instructions:\n" + chapterInstructionsText
        : "",
      chapter_content: contentText
        ? "Here is the chapter content:\n" + contentText
        : "",
      study_guide_theory: studyGuideTheoryText
        ? "STUDY GUIDE THEORY — this is the text the students have studied. " +
          "Base every question ONLY on it, and never on material it does not cover:\n" +
          studyGuideTheoryText
        : "",
    };

    logger.info("Calling OpenAI with local prompt", {
      fileCount: limitedFileIds.length,
      limitedFrom: fileIds.length,
      hasContentFallback: contentFallbacks.length > 0,
    });

    // Build competency list for the prompt
    // When competencies are explicitly selected, focus on those
    // When generating by chapters, instruct AI to assign relevant competencies from the full list
    const competencyListText =
      selectedCompetencies.length > 0
        ? selectedCompetencies.map((c: any) => `- ${c.title}${c.description ? `: ${c.description}` : ""}`).join("\n")
        : (courseCompetencies.length > 0
            ? "No specific competencies selected. Analyze each question and assign ALL relevant competencies from the full competency list below based on what the question assesses."
            : "");

    // Build full competency list with IDs for AI to reference
    const fullCompetencyListText = courseCompetencies
      .map((c: any) => `- ID: ${c.id} | Title: ${c.title}${c.description ? ` | Description: ${c.description}` : ""}`)
      .join("\n");

    logger.info("Prompt context", {
      chapterCount: chapterInfos.length,
      competencyCount: selectedCompetencies.length > 0 ? selectedCompetencies.length : courseCompetencies.length,
      fullCompetencyCount: courseCompetencies.length,
      hasSpecialInstructions: !!specialInstructions,
      hasChapterInstructions: !!chapterInstructionsText,
      hasStudyGuideTheory: !!studyGuideTheoryText,
    });

    try {
      // Build substituted user message from template. Per the static-first /
      // dynamic-last contract (issue #558), per-call dynamic content
      // (group_audience_hint, special_instructions, past_questions, request
      // payload) lives in this template at the END.
      const userVariables: Record<string, string> = {
        full_competency_list: fullCompetencyListText || "No competencies defined for this course",
        chapter_list: chapterListText ||
          (isStudyGuideMode
            ? "No chapters — the study guide theory above is the only source."
            : "All chapters in the provided materials"),
        competency_list: competencyListText || "No competencies defined for this course - skip competency assignment",
        diagram_instructions: diagramInstructions(diagramMode),
        group_audience_hint: groupAudienceHintText,
        special_instructions: specialInstructions
          ? "The instructor gave these special instructions for question generation. You should follow them.\nInstructions: " + specialInstructions
          : "",
        past_questions: pastQuestionsText,
        num: String(numQuestions || 3),
        difficulty: difficulty || "medium",
        lang: langInfo.name,
      };
      const userMessageText = render(OPEN_QUESTIONS_USER_PROMPT, userVariables);

      // Build input: file IDs are passed separately, user prompt always as a message
      const result = await callOpenAIStructured<GenerateQuestionsResult>({
        ...modelFor("question-bank.open"),
        promptText: OPEN_QUESTIONS_SYSTEM_PROMPT,
        variables: systemVariables,
        input: [{ role: "user" as const, content: userMessageText }],
        fileIds: limitedFileIds.length > 0 ? limitedFileIds : undefined,
        structuredOutput: OPEN_QUESTIONS_OUTPUT_SCHEMA,
        backgroundOptions: {
          enabled: true,
          pollIntervalMs: 2000,
          maxPollTimeMs: 240000,
        },
        usageContext: {
          functionName: "generate-open-questions",
          promptKey: "open_question_generation",
          institutionId: institutionId,
          courseId: courseId,
        },
      });

      const llmDuration = llmTimer();
      logger.info("Generated open-ended questions", { count: result.questions?.length || 0, durationMs: llmDuration });

      const questions = result.questions;
      if (!Array.isArray(questions)) {
        logger.error("Questions is not an array", { result });
        throw new Error("AI returned an invalid questions format");
      }

      // Build set of valid competency IDs for validation
      const validCompetencyIds = new Set(courseCompetencies.map((c: any) => c.id));

      const questionsToInsert = questions.map((q: GeneratedQuestion) => {
        // Partition AI-returned ids into chapter links and whole-document
        // links (#1019): the prompt tells the model to attribute questions
        // drawn from a chapterless document by its document id, using the
        // same `chapter_ids` channel.
        const { chapterIds: linkedChapterIds, materialIds: linkedMaterialIds } =
          splitReturnedSourceIds(
            q.chapter_ids,
            attachedChapterInfos.map((ch) => ch.id),
            attachedWholeMaterials,
            wholeMaterials.length,
          );

        // Filter AI-returned competency IDs to only valid ones
        const linkedCompetencyIds = (q.competency_ids || []).filter((cId: string) => validCompetencyIds.has(cId));

        const rawRationale = typeof q.generation_rationale === "string" ? q.generation_rationale.trim() : "";
        if (!rawRationale) {
          logger.warn("Generated open question missing generation_rationale", { question: q.question?.slice(0, 80) });
        }

        // Pre-generate the UUID so the frontend writer can use it both for
        // the `questions` insert and the junction rows (chapters, competencies).
        const id = crypto.randomUUID();
        const validatedDiagram = diagramMode === "off"
          ? null
          : validateDiagram(q.diagram ?? null);
        return {
          id,
          course_id: courseId,
          question: q.question,
          ...toOpenUnified({
            model_answer: q.model_answer,
            rubric: null,
            explanation: q.explanation,
            diagram: validatedDiagram ?? undefined,
          }),
          explanation: q.explanation,
          difficulty: q.difficulty,
          upvotes: 0,
          downvotes: 0,
          hidden: startHidden,
          competency_id: linkedCompetencyIds.length > 0 ? linkedCompetencyIds[0] : null,
          competency_ids: linkedCompetencyIds,
          chapter_ids: linkedChapterIds,
          material_ids: linkedMaterialIds,
          generated_for_group_id: generatedForGroupId,
          generation_rationale: rawRationale || null,
        };
      });

      return new Response(
        JSON.stringify({
          questions: questionsToInsert,
          model: `${modelFor("question-bank.open").model} (Responses API)`,
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
    logger.exception("Error in generate-open-questions", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
};
