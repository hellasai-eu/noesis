import "https://deno.land/x/xhr@0.1.0/mod.ts";

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getEffectiveLanguage, getLanguageInstruction } from "../_shared/language-utils.ts";
import {
  callOpenAIStructured,
  StructuredOutputSchema,
  OpenAIRateLimitError,
  OpenAIPaymentRequiredError,
} from "../_shared/openai-client.ts";
import { AiFeatureDisabledError } from "../_shared/openai-client.ts";
import { modelFor } from "../_shared/model-policy.ts";
import { render } from "../_shared/render.ts";
import { logger } from "../_shared/logger.ts";
import {
  CLASSIFICATION_SYSTEM_PROMPT,
  CLASSIFICATION_USER_PROMPT,
} from "../_shared/prompts/generate-classification-questions.ts";
import { buildGroupAudienceHint } from "../_shared/group-audience.ts";
import { resolveStudentTarget, studentTargetErrorResponse } from "../_shared/resolve-student-target.ts";
import { toClassificationUnified } from "../_shared/question-payload.ts";
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
  AAL2_REQUIRED_CODE,
  AAL2_REQUIRED_MESSAGE,
  callerMfaSatisfied,
} from "../_shared/require-aal2.ts";

// Hard caps — mirror the Zod schemas on the frontend (src/types/question.ts).
const MIN_CATEGORIES = 2;
const MAX_CATEGORIES = 5;
const MIN_ITEMS = 4;
const MAX_ITEMS = 12;
const MAX_LABEL_LENGTH = 120;

const CLASSIFICATION_OUTPUT_SCHEMA: StructuredOutputSchema = {
  name: "generate_classification_questions",
  strict: true,
  schema: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        description:
          "Array of generated classification questions. Each item carries its correct category_id inline; the handler splits payload.items (no category) from answer_key.assignments before persisting.",
        items: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description:
                "The classification instruction shown to the student. Explicitly names the criterion ('Classify these properties as physical or chemical').",
            },
            categories: {
              type: "array",
              description:
                "Between 2 and 5 conceptually meaningful category buckets. Each has a stable short id and a display label.",
              minItems: MIN_CATEGORIES,
              maxItems: MAX_CATEGORIES,
              items: {
                type: "object",
                properties: {
                  id: {
                    type: "string",
                    description:
                      "Stable short id, e.g. 'a' / 'b' / 'physical'. Distinct within the question.",
                  },
                  label: {
                    type: "string",
                    description: "Display label shown to students. Distinct within the question.",
                  },
                },
                required: ["id", "label"],
                additionalProperties: false,
              },
            },
            items: {
              type: "array",
              description:
                "Between 4 and 12 items to be classified. Each is a short text (2-8 words) plus its correct category_id (must match one of the declared categories[].id).",
              minItems: MIN_ITEMS,
              maxItems: MAX_ITEMS,
              items: {
                type: "object",
                properties: {
                  id: {
                    type: "string",
                    description: "Stable short id, e.g. 'i1'. Distinct within the question.",
                  },
                  text: {
                    type: "string",
                    description:
                      "Short text (a property, term, concept name). Avoid full sentences.",
                  },
                  category_id: {
                    type: "string",
                    description: "Id of the correct category. MUST match one of categories[].id.",
                  },
                },
                required: ["id", "text", "category_id"],
                additionalProperties: false,
              },
            },
            difficulty: {
              type: "string",
              enum: ["easy", "medium", "hard"],
              description: "Question difficulty level.",
            },
            explanation: {
              type: "string",
              description:
                "Short explanation (1-3 sentences) of the classification criterion, visible to students after submission. Does NOT recite per-item placements.",
            },
            chapter_ids: {
              type: "array",
              description: "Array of chapter UUIDs this question was derived from.",
              items: { type: "string" },
            },
            competency_ids: {
              type: "array",
              description:
                "Array of competency UUIDs this question assesses (can be multiple if it tests multiple learning objectives).",
              items: { type: "string" },
            },
            generation_rationale: {
              type: "string",
              description:
                "Instructor-facing 1-3 sentence note explaining which source input drove the question and the classification criterion being tested. Must NOT reveal per-item category placements.",
            },
            diagram: DIAGRAM_SCHEMA_FRAGMENT,
          },
          required: [
            "prompt",
            "categories",
            "items",
            "difficulty",
            "explanation",
            "chapter_ids",
            "competency_ids",
            "generation_rationale",
            "diagram",
          ],
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

const MAX_PAGES = 400;
const MAX_SIZE_BYTES = 32 * 1024 * 1024;

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

interface GeneratedCategory {
  id: string;
  label: string;
}

interface GeneratedItem {
  id: string;
  text: string;
  category_id: string;
}

interface GeneratedClassificationQuestion {
  prompt: string;
  categories: GeneratedCategory[];
  items: GeneratedItem[];
  difficulty: string;
  explanation: string;
  chapter_ids: string[];
  competency_ids?: string[];
  generation_rationale?: string;
  diagram?: { format?: string; source?: string; alt?: string } | null;
}

interface GenerateResult {
  questions: GeneratedClassificationQuestion[];
}

/**
 * Runtime validator — confirms the structured-output contract beyond what
 * the JSON schema can express:
 *   - non-empty prompt
 *   - 2 <= categories.length <= 5, 4 <= items.length <= 12 (defensive re-check)
 *   - distinct category ids AND distinct labels (NFC + lowercase)
 *   - distinct item ids AND distinct texts (NFC + trim + lowercase)
 *   - every item's category_id is one of categories[].id
 *   - no empty / overlong labels or texts
 * Returns a reason for rejection or null on success.
 */
export function validateGenerated(q: GeneratedClassificationQuestion): string | null {
  if (typeof q.prompt !== "string" || q.prompt.trim().length === 0) {
    return "empty prompt";
  }
  if (!Array.isArray(q.categories)) return "categories is not an array";
  if (q.categories.length < MIN_CATEGORIES) {
    return `too few categories (${q.categories.length} < ${MIN_CATEGORIES})`;
  }
  if (q.categories.length > MAX_CATEGORIES) {
    return `too many categories (${q.categories.length} > ${MAX_CATEGORIES})`;
  }
  const categoryIds = new Set<string>();
  const categoryLabels = new Set<string>();
  for (const c of q.categories) {
    if (!c || typeof c !== "object") return "malformed category";
    if (typeof c.id !== "string" || c.id.trim().length === 0) return "empty category id";
    if (typeof c.label !== "string" || c.label.trim().length === 0) {
      return "empty category label";
    }
    if (c.label.length > MAX_LABEL_LENGTH) {
      return `category label exceeds ${MAX_LABEL_LENGTH} chars`;
    }
    if (categoryIds.has(c.id)) return "duplicate category id";
    categoryIds.add(c.id);
    const labelKey = c.label.normalize("NFC").trim().toLowerCase();
    if (categoryLabels.has(labelKey)) return "duplicate category label";
    categoryLabels.add(labelKey);
  }

  if (!Array.isArray(q.items)) return "items is not an array";
  if (q.items.length < MIN_ITEMS) {
    return `too few items (${q.items.length} < ${MIN_ITEMS})`;
  }
  if (q.items.length > MAX_ITEMS) {
    return `too many items (${q.items.length} > ${MAX_ITEMS})`;
  }
  const itemIds = new Set<string>();
  const itemTexts = new Set<string>();
  for (const it of q.items) {
    if (!it || typeof it !== "object") return "malformed item";
    if (typeof it.id !== "string" || it.id.trim().length === 0) return "empty item id";
    if (typeof it.text !== "string" || it.text.trim().length === 0) return "empty item text";
    if (it.text.length > MAX_LABEL_LENGTH) {
      return `item text exceeds ${MAX_LABEL_LENGTH} chars`;
    }
    if (typeof it.category_id !== "string" || it.category_id.trim().length === 0) {
      return "missing item category_id";
    }
    if (!categoryIds.has(it.category_id)) {
      return `unknown item category_id ${it.category_id}`;
    }
    if (itemIds.has(it.id)) return "duplicate item id";
    itemIds.add(it.id);
    const textKey = it.text.normalize("NFC").trim().toLowerCase();
    if (itemTexts.has(textKey)) return "duplicate item text";
    itemTexts.add(textKey);
  }
  return null;
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
      referenceFileIds,
      diagramMode: diagramModeRaw,
      group_id: targetGroupIdInput,
      student_user_id: targetStudentUserId,
    } = await req.json();
    const diagramMode = parseDiagramMode(diagramModeRaw);
    let targetGroupId: string | undefined = targetGroupIdInput;

    logger.info("Generating classification questions", {
      courseId,
      numQuestions,
      difficulty,
      chaptersCount: chapterIds?.length || 0,
      wholeMaterialsCount: materialIds?.length || 0,
      competenciesCount: competencyIds?.length || 0,
      hasSpecialInstructions: !!specialInstructions,
    });

    const requestedMaterialIds = normalizeMaterialIds(materialIds);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

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

    const { data: allCompetencies, error: allCompError } = await supabase
      .from("course_competencies")
      .select("id, title, description, chapter_id")
      .eq("course_id", courseId);

    if (allCompError) {
      logger.error("Error fetching all competencies", { error: allCompError });
    }

    const courseCompetencies = allCompetencies || [];

    let resolvedChapterIds = chapterIds;
    let competencyContext = "";
    let selectedCompetencies: any[] = [];

    if (competencyIds && competencyIds.length > 0) {
      selectedCompetencies = courseCompetencies.filter((c: any) => competencyIds.includes(c.id));

      competencyContext = selectedCompetencies
        .map((c: any) => `- ${c.title}${c.description ? `: ${c.description}` : ""}`)
        .join("\n");

      const { data: junctionData, error: junctionError } = await supabase
        .from("competency_chapters")
        .select("chapter_id")
        .in("competency_id", competencyIds);

      if (junctionError) {
        logger.error("Error fetching competency_chapters junction", { error: junctionError });
      }

      const junctionChapterIds = (junctionData || []).map((j: any) => j.chapter_id);
      const legacyChapterIds = selectedCompetencies.map((c: any) => c.chapter_id).filter(Boolean);
      const allCompetencyChapterIds = [
        ...new Set([...junctionChapterIds, ...legacyChapterIds]),
      ] as string[];

      if (allCompetencyChapterIds.length > 0) {
        resolvedChapterIds = allCompetencyChapterIds;
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

    const { data: chapters, error: chaptersError } = wantsChapters
      ? await query
      : { data: [], error: null };
    if (chaptersError) {
      logger.error("Error fetching chapters", { error: chaptersError });
      throw new Error("Failed to fetch course chapters");
    }

    const { data: course } = await supabase
      .from("courses")
      .select("title, description, theme, language, institution_id, institutions(name)")
      .eq("id", courseId)
      .single();

    const courseTitle = course?.title || "Unknown Course";
    const institutionId = course?.institution_id || null;
    const institutionName = (course?.institutions as any)?.name || "Unknown Institution";

    logger.setContext({
      courseId,
      courseName: courseTitle,
      institutionId,
      institutionName,
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

    if (validChapters.length === 0 && wholeMaterials.length === 0) {
      return new Response(
        JSON.stringify({
          error: "No course content found. Please add chapters to your materials first.",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    let totalPages = 0;
    let totalSizeBytes = 0;

    for (const ch of validChapters) {
      const material = ch.course_materials as any;
      const materialPages = material?.page_count || 0;
      const materialSize = material?.file_size || 0;
      let chapterPages = 0;
      const fileName = ch.file_name || "";
      const pageMatch = fileName.match(/Pages?\s*(\d+)\s*-\s*(\d+)/i);
      if (pageMatch) {
        chapterPages = parseInt(pageMatch[2]) - parseInt(pageMatch[1]) + 1;
      } else if (ch.content) {
        chapterPages = Math.max(1, Math.ceil(ch.content.length / 3000));
      } else {
        chapterPages = 10;
      }
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

    if (totalPages > MAX_PAGES || totalSizeBytes > MAX_SIZE_BYTES) {
      const pagesFormatted = totalPages.toLocaleString();
      const sizeFormatted = (totalSizeBytes / (1024 * 1024)).toFixed(1);
      return new Response(
        JSON.stringify({
          error:
            `Selected content exceeds limits: ${pagesFormatted} pages (max ${MAX_PAGES}) and ${sizeFormatted}MB (max 32MB). Please select fewer competencies or chapters.`,
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

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
        if (!fileIds.includes(ch.chapter_openai_file_id)) fileIds.push(ch.chapter_openai_file_id);
      } else if (ch.content) {
        contentFallbacks.push({ chapterId: ch.id, title: ch.title, content: ch.content });
      }
    }
    if (referenceFileIds && Array.isArray(referenceFileIds)) {
      for (const refId of referenceFileIds) {
        if (refId && !fileIds.includes(refId)) fileIds.push(refId);
      }
    }
    if (fileIds.length === 0 && contentFallbacks.length === 0) {
      return new Response(
        JSON.stringify({
          error:
            "No materials have been synced to OpenAI and no chapter content available. Please upload materials or add chapter content.",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const effectiveLanguage = await getEffectiveLanguage(supabase, courseId);
    const langInfo = getLanguageInstruction(effectiveLanguage);

    const { data: existingQuestions, error: existingQError } = await supabase
      .from("questions")
      .select("question")
      .eq("course_id", courseId)
      .eq("type", "classification")
      .limit(100);
    if (existingQError) {
      logger.error("Error fetching existing classification prompts", { error: existingQError });
    }
    const pastQuestionsList = (existingQuestions || [])
      .map((q: { question: string }) => q.question)
      .join("\n- ");
    const pastQuestionsText = pastQuestionsList ? `- ${pastQuestionsList}` : "";

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
    const contentText = contentFallbacks.length > 0
      ? contentFallbacks.map((cf) => `=== ${cf.title} ===\n${cf.content}`).join("\n\n")
      : "";

    const llmTimer = logger.startTimer("openai_call");

    const chapterListText = [
      ...attachedChapterInfos.map(
        (ch) => `- "${ch.title}" (Chapter ${ch.chapter_number}) from "${ch.material_title}"`,
      ),
      wholeMaterialPromptLines(attachedWholeMaterials),
    ]
      .filter(Boolean)
      .join("\n");

    const chapterInstructionsText = attachedChapterInfos
      .filter((ch) => ch.instructions && ch.instructions.trim())
      .map((ch) => `- Chapter "${ch.title}": ${ch.instructions}`)
      .join("\n");

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
      const studentResult = await resolveStudentTarget(
        supabase,
        authedClient,
        courseId,
        targetStudentUserId,
      );
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
      }
    }

    const systemVariables: Record<string, string> = {
      chapter_instructions: chapterInstructionsText
        ? "Chapter-specific instructions:\n" + chapterInstructionsText
        : "",
      chapter_content: contentText ? "Here is the chapter content:\n" + contentText : "",
    };

    const competencyListText = selectedCompetencies.length > 0
      ? selectedCompetencies
        .map((c: any) => `- ${c.title}${c.description ? `: ${c.description}` : ""}`)
        .join("\n")
      : (courseCompetencies.length > 0
        ? "No specific competencies selected. Analyze each question and assign ALL relevant competencies from the full competency list below based on what the question assesses."
        : "");

    const fullCompetencyListText = courseCompetencies
      .map(
        (c: any) =>
          `- ID: ${c.id} | Title: ${c.title}${c.description ? ` | Description: ${c.description}` : ""}`,
      )
      .join("\n");

    try {
      const userVariables: Record<string, string> = {
        full_competency_list: fullCompetencyListText || "No competencies defined for this course",
        chapter_list: chapterListText || "All chapters in the provided materials",
        competency_list: competencyListText ||
          "No competencies defined for this course - skip competency assignment",
        diagram_instructions: diagramInstructions(diagramMode),
        group_audience_hint: groupAudienceHintText,
        special_instructions: specialInstructions
          ? "The instructor gave these special instructions for question generation. You should follow them.\nInstructions: " +
            specialInstructions
          : "",
        past_questions: pastQuestionsText,
        num: String(numQuestions || 3),
        difficulty: difficulty || "medium",
        lang: langInfo.name,
      };
      const userMessageText = render(CLASSIFICATION_USER_PROMPT, userVariables);

      const result = await callOpenAIStructured<GenerateResult>({
        ...modelFor("question-bank.classification"),
        promptText: CLASSIFICATION_SYSTEM_PROMPT,
        variables: systemVariables,
        input: [{ role: "user" as const, content: userMessageText }],
        fileIds: limitedFileIds.length > 0 ? limitedFileIds : undefined,
        structuredOutput: CLASSIFICATION_OUTPUT_SCHEMA,
        backgroundOptions: {
          enabled: true,
          pollIntervalMs: 2000,
          maxPollTimeMs: 240000,
        },
        usageContext: {
          functionName: "generate-classification-questions",
          promptKey: "classification_question_generation",
          institutionId: institutionId,
          courseId: courseId,
        },
      });

      const llmDuration = llmTimer();
      logger.info("Generated classification questions", {
        rawCount: result.questions?.length || 0,
        durationMs: llmDuration,
      });

      const rawQuestions = result.questions;
      if (!Array.isArray(rawQuestions)) {
        throw new Error("AI returned an invalid questions format");
      }

      const validatedQuestions: GeneratedClassificationQuestion[] = [];
      const rejections: { prompt: string; reason: string }[] = [];
      for (const q of rawQuestions) {
        const reason = validateGenerated(q);
        if (reason) {
          rejections.push({ prompt: (q.prompt || "").slice(0, 80), reason });
          continue;
        }
        validatedQuestions.push(q);
      }
      if (rejections.length > 0) {
        logger.warn("Rejected malformed classification questions", { rejections });
      }

      const validCompetencyIds = new Set(courseCompetencies.map((c: any) => c.id));

      const questionsToInsert = validatedQuestions.map((q) => {
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
        const linkedCompetencyIds = (q.competency_ids || []).filter((cId: string) =>
          validCompetencyIds.has(cId)
        );
        const rawRationale = typeof q.generation_rationale === "string"
          ? q.generation_rationale.trim()
          : "";
        const id = crypto.randomUUID();
        // Split model output's per-item category_id into payload.items (no
        // category leak) + answer_key.assignments (the actual answer).
        const assignments: Record<string, string> = {};
        for (const it of q.items) {
          assignments[it.id] = it.category_id;
        }
        const validatedDiagram = diagramMode === "off"
          ? null
          : validateDiagram(q.diagram ?? null);
        return {
          id,
          course_id: courseId,
          question: q.prompt,
          ...toClassificationUnified({
            prompt: q.prompt,
            categories: q.categories.map((c) => ({ id: c.id, label: c.label })),
            items: q.items.map((it) => ({ id: it.id, text: it.text })),
            assignments,
            diagram: validatedDiagram ?? undefined,
          }),
          explanation: q.explanation ?? "",
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

      const warning = rejections.length > 0
        ? `${rejections.length} generated question(s) were dropped for malformed items.`
        : undefined;

      return new Response(
        JSON.stringify({
          questions: questionsToInsert,
          model: `${modelFor("question-bank.classification").model} (Responses API)`,
          target: resolvedTarget,
          warning,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    } catch (error) {
      llmTimer();
      logger.error("OpenAI error", {
        error: error instanceof Error ? error.message : String(error),
      });

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
        return new Response(
          JSON.stringify({ error: "Rate limit exceeded. Please try again in a moment." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      if (error instanceof OpenAIPaymentRequiredError) {
        return new Response(
          JSON.stringify({ error: "AI usage limit reached. Please try again later." }),
          { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      throw error;
    }
  } catch (error) {
    logger.exception("Error in generate-classification-questions", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
};
