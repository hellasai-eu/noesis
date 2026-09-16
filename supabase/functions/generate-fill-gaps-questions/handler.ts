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
import {
  FILL_GAPS_SYSTEM_PROMPT,
  FILL_GAPS_USER_PROMPT,
} from "../_shared/prompts/generate-fill-gaps-questions.ts";
import { buildGroupAudienceHint } from "../_shared/group-audience.ts";
import { resolveStudentTarget, studentTargetErrorResponse } from "../_shared/resolve-student-target.ts";
import { toFillGapsUnified } from "../_shared/question-payload.ts";
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

// Generation cap — new questions are constrained to 1-4 gaps per #784.
// The frontend storage cap (FILL_GAPS_MAX_GAPS, src/types/question.ts)
// stays at 8 so historical questions with 5-8 gaps still parse.
const MAX_GENERATED_GAPS = 4;
// Raised from 5 with #1042: the prompt now requires every filler the source
// text supports, plus each one's inflections, so a legitimate key can be
// longer than it used to be. Exceeding the cap discards the whole question,
// so the cap has to leave room for a complete key.
const MAX_ACCEPTABLE_PER_GAP = 8;
const MAX_ACCEPTABLE_LENGTH = 64;

const FILL_GAPS_OUTPUT_SCHEMA: StructuredOutputSchema = {
  name: "generate_fill_gaps_questions",
  strict: true,
  schema: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        description:
          "Array of generated fill-the-gaps questions. Each stem contains contiguous 1-indexed {{N}} markers and the matching gaps[] entries.",
        items: {
          type: "object",
          properties: {
            stem: {
              type: "string",
              description:
                "The cloze sentence. Contains contiguous 1-indexed placeholders like {{1}}, {{2}}, … one per blank.",
            },
            gaps: {
              type: "array",
              description:
                "One entry per placeholder in the stem. Ordinals match the {{N}} markers exactly and are contiguous from 1. Limit: 1-4 gaps per question (composite multi-word names occupy a single gap).",
              minItems: 1,
              maxItems: MAX_GENERATED_GAPS,
              items: {
                type: "object",
                properties: {
                  ordinal: {
                    type: "integer",
                    description: "1-indexed placeholder number (matches {{N}} in the stem).",
                  },
                  acceptable: {
                    type: "array",
                    description:
                      "Every answer the source text supports for this gap. First entry is the primary; the rest are the other fillers the source licenses (including each alternative offered by a coordinated 'X and Y' clause) plus their synonyms and inflections. A defensible answer left out of this list is graded wrong.",
                    items: { type: "string" },
                  },
                },
                required: ["ordinal", "acceptable"],
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
                "Short explanation (1-3 sentences) of why the acceptable answer(s) are correct, referencing the source concept. Visible to students after submission.",
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
                "Instructor-facing 1-3 sentence note explaining which source input drove the question and what concept is being tested. Must NOT reveal the acceptable answers.",
            },
            diagram: DIAGRAM_SCHEMA_FRAGMENT,
          },
          required: [
            "stem",
            "gaps",
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

interface GeneratedGap {
  ordinal: number;
  acceptable: string[];
}

interface GeneratedFillGapsQuestion {
  stem: string;
  gaps: GeneratedGap[];
  difficulty: string;
  explanation: string;
  chapter_ids: string[];
  competency_ids?: string[];
  generation_rationale?: string;
  diagram?: { format?: string; source?: string; alt?: string } | null;
}

interface GenerateResult {
  questions: GeneratedFillGapsQuestion[];
}

/**
 * Runtime validator — confirms the structured-output contract. The schema
 * cannot express the cross-field invariant "stem ordinals == gap ordinals
 * == 1..N contiguous", so do it here. Returns a reason for rejection or
 * null on success.
 */
export function validateGenerated(q: GeneratedFillGapsQuestion): string | null {
  if (typeof q.stem !== "string" || q.stem.trim().length === 0) {
    return "empty stem";
  }
  if (!Array.isArray(q.gaps) || q.gaps.length === 0) {
    return "no gaps";
  }
  if (q.gaps.length > MAX_GENERATED_GAPS) {
    return `too many gaps (${q.gaps.length} > ${MAX_GENERATED_GAPS})`;
  }
  let stemRawCount = 0;
  const stemOrdinals = new Set<number>();
  for (const m of q.stem.matchAll(/\{\{(\d+)\}\}/g)) {
    stemOrdinals.add(Number(m[1]));
    stemRawCount++;
  }
  if (stemRawCount !== stemOrdinals.size) return "duplicate ordinal in stem";
  const gapOrdinals = new Set<number>();
  for (const g of q.gaps) {
    if (!Number.isInteger(g.ordinal) || g.ordinal <= 0) return "invalid ordinal";
    if (gapOrdinals.has(g.ordinal)) return "duplicate ordinal";
    gapOrdinals.add(g.ordinal);
    if (!Array.isArray(g.acceptable) || g.acceptable.length === 0) {
      return `gap ${g.ordinal}: no acceptable answers`;
    }
    if (g.acceptable.length > MAX_ACCEPTABLE_PER_GAP) {
      return `gap ${g.ordinal}: too many acceptable answers`;
    }
    for (const a of g.acceptable) {
      if (typeof a !== "string" || a.trim().length === 0) {
        return `gap ${g.ordinal}: empty acceptable answer`;
      }
      if (a.length > MAX_ACCEPTABLE_LENGTH) {
        return `gap ${g.ordinal}: acceptable answer exceeds ${MAX_ACCEPTABLE_LENGTH} chars`;
      }
    }
  }
  if (stemOrdinals.size !== gapOrdinals.size) {
    return `stem/gaps ordinal count mismatch (stem=${stemOrdinals.size}, gaps=${gapOrdinals.size})`;
  }
  for (const o of stemOrdinals) {
    if (!gapOrdinals.has(o)) return `stem references ordinal ${o} with no gap entry`;
  }
  for (const o of gapOrdinals) {
    if (!stemOrdinals.has(o)) return `gap ordinal ${o} not referenced in stem`;
  }
  // Contiguous 1..N
  const sorted = Array.from(gapOrdinals).sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i] !== i + 1) return `gap ordinals not contiguous from 1 (got ${sorted.join(",")})`;
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

    logger.info("Generating fill-the-gaps questions", {
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
      .eq("type", "fill_gaps")
      .limit(100);
    if (existingQError) {
      logger.error("Error fetching existing fill-gaps stems", { error: existingQError });
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
      // `{{N}}` is a cloze gap marker the prompt shows the model, not a
      // variable — it must reach OpenAI literally. Declared here by name so a
      // genuinely missing variable still throws.
      const userMessageText = render(FILL_GAPS_USER_PROMPT, userVariables, {
        name: "FILL_GAPS_USER_PROMPT",
        optional: ["N"],
      });

      const result = await callOpenAIStructured<GenerateResult>({
        ...modelFor("question-bank.fill-gaps"),
        promptText: FILL_GAPS_SYSTEM_PROMPT,
        variables: systemVariables,
        input: [{ role: "user" as const, content: userMessageText }],
        fileIds: limitedFileIds.length > 0 ? limitedFileIds : undefined,
        structuredOutput: FILL_GAPS_OUTPUT_SCHEMA,
        backgroundOptions: {
          enabled: true,
          pollIntervalMs: 2000,
          maxPollTimeMs: 240000,
        },
        usageContext: {
          functionName: "generate-fill-gaps-questions",
          promptKey: "fill_gaps_question_generation",
          institutionId: institutionId,
          courseId: courseId,
        },
      });

      const llmDuration = llmTimer();
      logger.info("Generated fill-gaps questions", {
        rawCount: result.questions?.length || 0,
        durationMs: llmDuration,
      });

      const rawQuestions = result.questions;
      if (!Array.isArray(rawQuestions)) {
        throw new Error("AI returned an invalid questions format");
      }

      // Runtime validation drops malformed items (stem/ordinal mismatch, etc.)
      const validatedQuestions: GeneratedFillGapsQuestion[] = [];
      const rejections: { stem: string; reason: string }[] = [];
      for (const q of rawQuestions) {
        const reason = validateGenerated(q);
        if (reason) {
          rejections.push({ stem: (q.stem || "").slice(0, 80), reason });
          continue;
        }
        validatedQuestions.push(q);
      }
      if (rejections.length > 0) {
        logger.warn("Rejected malformed fill-gaps questions", { rejections });
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
        // For instructor-facing list views the existing `question` text
        // column already drives the table. Use the stem as the row's
        // primary text and stash the structured data via toFillGapsUnified.
        const validatedDiagram = diagramMode === "off"
          ? null
          : validateDiagram(q.diagram ?? null);
        return {
          id,
          course_id: courseId,
          question: q.stem,
          ...toFillGapsUnified({
            stem: q.stem,
            gaps: q.gaps.map((g) => ({
              ordinal: g.ordinal,
              acceptable: g.acceptable.map((a) => a.trim()).filter((a) => a.length > 0),
            })),
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
        ? `${rejections.length} generated question(s) were dropped for malformed gap ordinals.`
        : undefined;

      return new Response(
        JSON.stringify({
          questions: questionsToInsert,
          model: `${modelFor("question-bank.fill-gaps").model} (Responses API)`,
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
    logger.exception("Error in generate-fill-gaps-questions", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
};
