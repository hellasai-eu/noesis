import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getEffectiveLanguage, getLanguageInstruction } from "../_shared/language-utils.ts";
import {
  callOpenAIStructured,
  StructuredOutputSchema,
  OpenAIRateLimitError,
  OpenAIPaymentRequiredError,
  OpenAIError,
} from "../_shared/openai-client.ts";
import { AiFeatureDisabledError } from "../_shared/openai-client.ts";
import { modelFor } from "../_shared/model-policy.ts";
import { render } from "../_shared/render.ts";
import { logger } from "../_shared/logger.ts";
import { withModeration } from "../_shared/moderation-middleware.ts";
import { validateGeneratedAnswers } from "../_shared/answer-validator.ts";
import { MCQ_SYSTEM_PROMPT, MCQ_USER_PROMPT } from "../_shared/prompts/generate-questions.ts";
import { toMcqUnified } from "../_shared/question-payload.ts";
import {
  DIAGRAM_SCHEMA_FRAGMENT,
  diagramInstructions,
  parseDiagramMode,
  validateDiagram,
} from "../_shared/diagram-mode.ts";
import { resolveStudentActiveOfferingForCourse } from "../_shared/resolve-student-offerings.ts";
import { authorizeCourseReader } from "../_shared/course-authz.ts";
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
              description: "Exactly 4 answer options",
              items: {
                type: "string",
                description: "An answer choice",
              },
              minItems: 4,
              maxItems: 4,
            },
            correct_answers: {
              type: "array",
              description:
                "Indices of correct answer options (0-3). Most questions have a single index; mark multiple ONLY when the source genuinely supports it. Never empty.",
              items: { type: "integer", minimum: 0, maximum: 3 },
              minItems: 1,
              maxItems: 3,
              // NOTE: `uniqueItems` is intentionally omitted — OpenAI strict
              // structured-output mode rejects it (400). Uniqueness is enforced
              // in post-parse validation below instead (see #877).
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
            diagram: DIAGRAM_SCHEMA_FRAGMENT,
          },
          required: ["question", "options", "correct_answers", "explanation", "difficulty", "chapter_ids", "competency_ids", "diagram"],
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

const DAILY_LIMIT = 10;
const QUESTIONS_PER_GENERATION = 10;

interface GeneratedQuestion {
  question: string;
  options: string[];
  correct_answers: number[];
  explanation: string;
  difficulty: string;
  chapter_ids?: string[];
  competency_ids?: string[];
  diagram?: { format?: string; source?: string; alt?: string } | null;
}

interface GenerateQuestionsResult {
  status: "success" | "error";
  questions: GeneratedQuestion[];
}

export const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const {
      courseId,
      chapterId,
      difficulty,
      numQuestions,
      format,
      diagramMode: diagramModeRaw,
    } = await req.json();

    // Use provided values or defaults
    const questionsToGenerate = numQuestions || QUESTIONS_PER_GENERATION;
    const questionFormat = format || "mcq";
    const diagramMode = parseDiagramMode(diagramModeRaw);

    logger.info("Student generating questions", { courseId, chapterId, difficulty, numQuestions: questionsToGenerate, format: questionFormat });

    // Validate difficulty
    if (!["easy", "medium", "hard", "mixed"].includes(difficulty)) {
      return new Response(JSON.stringify({ error: "Invalid difficulty. Must be easy, medium, hard, or mixed." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Get user from auth header
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const token = authHeader.replace("Bearer ", "");
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser(token);

    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Service-role client, so RLS's aal2 enforcement never runs here — refuse
    // an MFA-enrolled caller whose token is still aal1.
    if (!callerMfaSatisfied(user, token)) {
      return new Response(JSON.stringify({ error: AAL2_REQUIRED_MESSAGE, code: AAL2_REQUIRED_CODE }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userId = user.id;

    // ── Authorization (#1136) ─────────────────────────────────────────────
    // The caller was resolved and then never checked against `courseId`, so any
    // signed-in student could generate questions from any course's chapters —
    // reading another institution's content and spending this platform's OpenAI
    // budget. The offering lookup further down is post-hoc: it sits in a
    // try/catch that only warns, so it never gated anything.
    //
    // `authorizeCourseReader` is the right level: an enrolled student is the
    // intended caller, and a course manager also legitimately generates here.
    const access = await authorizeCourseReader(supabase, userId, courseId);
    if (!access.ok) {
      logger.warn("Refused generation for a course the caller has no claim on", {
        callerId: userId,
        courseId,
      });
      return new Response(JSON.stringify({ error: access.error }), {
        status: access.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Check if user is superadmin or admin (they have unlimited generation)
    const { data: isSuperAdmin } = await supabase.rpc("is_super_admin", { _user_id: userId });
    const { data: isAdmin } = await supabase.rpc("is_admin", { _user_id: userId });

    const hasUnlimitedAccess = isSuperAdmin === true || isAdmin === true;
    logger.info("User access check", { superadmin: isSuperAdmin, admin: isAdmin, unlimited: hasUnlimitedAccess });

    let todayCount = 0;

    // Only check daily limit for non-admin users
    if (!hasUnlimitedAccess) {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      // Limit is per student per course
      const { data: todayQuestions, error: countError } = await supabase
        .from("questions")
        .select("id")
        .eq("created_by", userId)
        .eq("course_id", courseId)
        .eq("is_user_generated", true)
        .gte("created_at", todayStart.toISOString());

      if (countError) {
        logger.error("Error checking daily limit", { error: countError });
        throw new Error("Failed to check daily limit");
      }

      todayCount = todayQuestions?.length || 0;
      if (todayCount >= DAILY_LIMIT) {
        return new Response(
          JSON.stringify({
            error: `Daily limit reached. You can generate up to ${DAILY_LIMIT} questions per day. Try again tomorrow!`,
            remaining: 0,
          }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    // Fetch the chapter with material info - include chapter's openai_file_id and instructions
    const { data: chapter, error: chapterError } = await supabase
      .from("material_chapters")
      .select(
        `
        id,
        title,
        content,
        content_type,
        material_id,
        openai_file_id,
        instructions,
        course_materials(
          id,
          title,
          file_name,
          course_id
        )
      `,
      )
      .eq("id", chapterId)
      .single();

    if (chapterError || !chapter) {
      return new Response(JSON.stringify({ error: "Chapter not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Verify chapter belongs to the course
    if ((chapter.course_materials as any)?.course_id !== courseId) {
      return new Response(JSON.stringify({ error: "Chapter does not belong to this course" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Use chapter's openai_file_id if available, otherwise use chapter content as fallback
    // Never use the material's (whole book) openai_file_id
    const chapterFileId = chapter.openai_file_id;
    const chapterContent = chapter.content;

    if (!chapterFileId && !chapterContent) {
      return new Response(
        JSON.stringify({ error: "This chapter has no content available. Please ask your instructor to add content or sync it to OpenAI." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
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
    const institutionId = course?.institution_id || null;
    const institutionName = (course?.institutions as any)?.name || "Unknown Institution";

    // Set logger context with course and institution info
    logger.setContext({
      courseId,
      courseName: courseTitle,
      institutionId,
      institutionName,
    });

    // Get language settings
    const effectiveLanguage = await getEffectiveLanguage(supabase, courseId);
    const langInfo = getLanguageInstruction(effectiveLanguage);
    logger.info("Using language", { name: langInfo.name, code: effectiveLanguage });

    // Fetch existing questions to avoid duplicates. Prefer questions linked to
    // the target chapter — those are the ones a new generation is most likely
    // to duplicate — then fill the remainder course-wide, newest first.
    // (Mirrors the chapter-scoped dedup in generate-questions/handler.ts.)
    const DEDUP_LIMIT = 100;
    const existingQuestionTexts: string[] = [];
    const seenQuestions = new Set<string>();

    const { data: chapterQuestions, error: chapterQError } = await supabase
      .from("questions")
      .select("question, question_chapters!inner(chapter_id)")
      .eq("course_id", courseId)
      .eq("question_chapters.chapter_id", chapterId)
      .limit(DEDUP_LIMIT);

    if (chapterQError) {
      logger.error("Error fetching chapter-linked questions for deduplication", { error: chapterQError });
    }
    for (const q of chapterQuestions || []) {
      if (!seenQuestions.has(q.question)) {
        seenQuestions.add(q.question);
        existingQuestionTexts.push(q.question);
      }
    }
    const chapterDedupCount = existingQuestionTexts.length;

    if (existingQuestionTexts.length < DEDUP_LIMIT) {
      // Overfetch: up to DEDUP_LIMIT of these rows may be dropped as
      // chapter-list overlaps or duplicate texts, so fetching exactly
      // DEDUP_LIMIT could underfill the final list (greptile, #1349).
      const { data: courseQuestions, error: courseQError } = await supabase
        .from("questions")
        .select("question")
        .eq("course_id", courseId)
        .order("created_at", { ascending: false })
        .limit(DEDUP_LIMIT * 2);

      if (courseQError) {
        logger.error("Error fetching course questions for deduplication", { error: courseQError });
      }
      for (const q of courseQuestions || []) {
        if (existingQuestionTexts.length >= DEDUP_LIMIT) break;
        if (!seenQuestions.has(q.question)) {
          seenQuestions.add(q.question);
          existingQuestionTexts.push(q.question);
        }
      }
    }

    const pastQuestionsList = existingQuestionTexts.join("\n- ");
    const pastQuestionsText = pastQuestionsList ? `- ${pastQuestionsList}` : "";
    logger.info("Fetched existing questions for deduplication", {
      count: existingQuestionTexts.length,
      fromChapter: chapterDedupCount,
    });

    const materialTitle =
      (chapter.course_materials as any)?.title || (chapter.course_materials as any)?.file_name || "Unknown";

    logger.info("Generating questions from chapter", {
      chapterTitle: chapter.title,
      hasFileId: !!chapterFileId,
      hasContent: !!chapterContent,
    });

    // Build chapter list for the prompt (single chapter for student)
    const chapterListText = `- "${chapter.title}" from "${materialTitle}"`;

    // Fetch competencies for this chapter
    const { data: chapterCompetencies } = await supabase
      .from("course_competencies")
      .select("id, title, description")
      .eq("chapter_id", chapterId);

    const competencyListText = (chapterCompetencies || [])
      .map((c: any) => `- ${c.title}${c.description ? `: ${c.description}` : ""}`)
      .join("\n");

    // Fetch ALL competencies for this course so AI can link to relevant ones
    const { data: allCourseCompetencies, error: allCompError } = await supabase
      .from("course_competencies")
      .select("id, title, description, chapter_id")
      .eq("course_id", courseId);

    if (allCompError) {
      logger.error("Error fetching all competencies", { error: allCompError });
    }

    const courseCompetencies = allCourseCompetencies || [];

    // Build full competency list with IDs for AI to reference when assigning competencies
    const fullCompetencyListText = courseCompetencies
      .map((c: any) => `- ID: ${c.id} | Title: ${c.title}${c.description ? ` | Description: ${c.description}` : ""}`)
      .join("\n");

    logger.info("Calling OpenAI with inline prompt", {
      chapterTitle: chapter.title,
      chapterCompetencyCount: chapterCompetencies?.length || 0,
      fullCompetencyCount: courseCompetencies.length,
      usingFileId: !!chapterFileId,
      usingContentFallback: !chapterFileId && !!chapterContent,
    });
    const llmTimer = logger.startTimer("openai_call");

    // Build content text if using fallback (no file ID)
    const contentText = !chapterFileId && chapterContent
      ? `=== ${chapter.title} ===\n${chapterContent}`
      : "";

    // Build system prompt variables. {{special_instructions}} lives in the
    // user prompt (dynamic per-call content per #558) — substituted below.
    const chapterInstructions = chapter.instructions?.trim() || "";
    const systemVariables: Record<string, string> = {
      chapter_instructions: "",
      chapter_content: contentText
        ? "Here is the chapter content:\n" + contentText
        : "",
    };

    // Build substituted user message from template. The shared MCQ_USER_PROMPT
    // also references {{diagram_instructions}}, {{true_false_instructions}},
    // and {{group_audience_hint}} — substitute all of them so unfilled
    // placeholders never leak into the LLM input. T/F and group-audience are
    // not student-generation features, so they substitute to "".
    const userVariables: Record<string, string> = {
      num: String(questionsToGenerate),
      difficulty: difficulty || "medium",
      lang: langInfo.name,
      past_questions: pastQuestionsText,
      chapter_list: chapterListText,
      competency_list: competencyListText || "No specific competencies defined for this chapter",
      full_competency_list: fullCompetencyListText || "No competencies defined for this course",
      diagram_instructions: diagramInstructions(diagramMode),
      true_false_instructions: "",
      group_audience_hint: "",
      special_instructions: chapterInstructions
        ? "The instructor gave these special instructions for question generation. You should follow them.\nInstructions: " + chapterInstructions
        : "",
    };
    const userMessageText = render(MCQ_USER_PROMPT, userVariables);

    try {
      // Call with chapter's file ID if available, otherwise use content fallback
      // Wrap with moderation middleware to check LLM output
      const moderatedResult = await withModeration(
        async () => callOpenAIStructured<GenerateQuestionsResult>({
          ...modelFor("question-bank.student-questions"),
          promptText: MCQ_SYSTEM_PROMPT,
          variables: systemVariables,
          input: [{ role: "user" as const, content: userMessageText }],
          fileIds: chapterFileId ? [chapterFileId] : undefined,
          structuredOutput: MCQ_OUTPUT_SCHEMA,
          backgroundOptions: {
            enabled: true,
            pollIntervalMs: 2000,
            maxPollTimeMs: 240000,
          },
          usageContext: {
            functionName: "generate-student-questions",
            promptKey: "mcq_generation",
            institutionId: institutionId,
            courseId: courseId,
            userId: userId,
          },
        }),
        `Generate ${questionsToGenerate} ${difficulty} ${questionFormat} questions for chapter: ${chapter.title}`,
        {
          language: effectiveLanguage,
          throwOnBlocked: true,
          logger,
          onOutputBlocked: async (result, output) => {
            logger.warn("Generated questions blocked by moderation", {
              categories: result.flaggedCategories,
              courseId,
              chapterId,
            });
            // Log to flagged_content for review
            await supabase.from("flagged_content").insert({
              description: `Student-generated questions blocked by output moderation: ${result.flaggedCategories.join(", ")}`,
              data: {
                type: "student_generated_question_output",
                course_id: courseId,
                user_id: userId,
                chapter_id: chapterId,
                moderation_result: result,
                output_preview: output.substring(0, 500),
              },
            });
          },
        }
      );

      const result = moderatedResult.result;
      const llmDuration = llmTimer();
      logger.info("AI response received", {
        durationMs: llmDuration,
        outputModerated: !!moderatedResult.outputModeration,
        outputFlagged: moderatedResult.outputModeration?.flagged || false,
      });

      if (result.status === "error") {
        throw new Error("AI reported an error during question generation");
      }

      // De-dupe `correct_answers` indices per question. The schema can no
      // longer enforce `uniqueItems` (OpenAI strict mode rejects it, #877), so
      // uniqueness is enforced here — mirroring the instructor path's
      // post-parse validation (generate-questions/handler.ts).
      const generatedQuestions = (result.questions || []).map((q) => ({
        ...q,
        correct_answers: Array.isArray(q.correct_answers)
          ? [...new Set(q.correct_answers)]
          : q.correct_answers,
      }));

      if (!Array.isArray(generatedQuestions) || generatedQuestions.length === 0) {
        throw new Error("No questions were generated");
      }

      logger.info("Generated questions", { count: generatedQuestions.length });

      // Note: Per-question moderation removed.
      // The full LLM output is already moderated by the withModeration wrapper above,
      // and per-question moderation was causing false failures when the moderation API errors.
      const moderatedQuestions = generatedQuestions;

      // Validate correct answers using AI validator
      const validationResult = await validateGeneratedAnswers(moderatedQuestions, {
        functionName: "generate-student-questions",
        promptKey: "answer_validation",
        institutionId: institutionId,
        courseId: courseId,
        userId: userId,
      });

      logger.info("Answer validation complete", {
        original: moderatedQuestions.length,
        validated: validationResult.valid.length,
        filtered: validationResult.filtered.length,
      });

      // Build a map of validation results by question text for lookup
      const validationMap = new Map<string, { verdict: string; confidence: number; message: string }>();
      for (const vr of validationResult.validationResults) {
        validationMap.set(vr.question.question, {
          verdict: vr.verdict.verdict,
          confidence: vr.verdict.confidence,
          message: vr.verdict.message,
        });
      }

      const validatedQuestions = validationResult.valid;

      if (validatedQuestions.length === 0) {
        return new Response(
          JSON.stringify({
            error: "No questions passed answer validation. Please try again.",
            remaining: hasUnlimitedAccess ? -1 : DAILY_LIMIT - todayCount,
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      // Build set of valid competency IDs for validation
      const validCompetencyIds = new Set(courseCompetencies.map((c: any) => c.id));

      // Build questions to insert with their linked competency IDs for junction table
      const questionsWithCompetencies = validatedQuestions.map((q: GeneratedQuestion) => {
        // Filter AI-returned competency IDs to only valid ones
        const linkedCompetencyIds = (q.competency_ids || []).filter((cId: string) => validCompetencyIds.has(cId));

        // Get validation result for this question
        const validation = validationMap.get(q.question);

        // Auto-hide questions with INCORRECT or UNCERTAIN validation status
        const shouldHide = validation?.verdict === "INCORRECT" || validation?.verdict === "UNCERTAIN";

        // #636 — best-effort diagram pass-through. Dropped when malformed.
        const validatedDiagram = diagramMode === "off"
          ? null
          : validateDiagram(q.diagram ?? null);

        return {
          question: {
            course_id: courseId,
            question: q.question,
            ...toMcqUnified({
              options: q.options,
              correct_answers: q.correct_answers,
              diagram: validatedDiagram ?? undefined,
            }),
            explanation: q.explanation,
            difficulty: q.difficulty || difficulty,
            upvotes: 0,
            downvotes: 0,
            hidden: shouldHide, // Auto-hide if validation failed
            is_user_generated: true,
            created_by: userId,
            competency_id: linkedCompetencyIds.length > 0 ? linkedCompetencyIds[0] : null,
            // Store validation status
            validation_status: validation?.verdict || "CORRECT",
            validation_confidence: validation?.confidence || 1.0,
            validation_message: validation?.message || "Passed validation",
            validated_at: new Date().toISOString(),
          },
          competencyIds: linkedCompetencyIds,
        };
      });

      const questionsToInsert = questionsWithCompetencies.map((q) => q.question);

      const { data: insertedQuestions, error: insertError } = await supabase
        .from("questions")
        .insert(questionsToInsert)
        .select();

      if (insertError) {
        logger.error("Error inserting questions", { error: insertError });
        throw new Error("Failed to save generated questions");
      }

      // Insert competency links into junction table
      const competencyLinks = (insertedQuestions || []).flatMap((insertedQ: any, idx: number) => {
        const compIds = questionsWithCompetencies[idx]?.competencyIds || [];
        return compIds.map((compId: string) => ({
          question_id: insertedQ.id,
          competency_id: compId,
        }));
      });

      if (competencyLinks.length > 0) {
        const { error: compLinkError } = await supabase
          .from("question_competencies")
          .insert(competencyLinks);

        if (compLinkError) {
          logger.warn("Error inserting competency links", { error: compLinkError });
          // Don't fail the whole operation, questions are already saved
        } else {
          logger.info("Competency links created", { count: competencyLinks.length });
        }
      }

      // Insert chapter links into junction table (each student question is tied to a single chapter)
      const chapterLinks = (insertedQuestions || []).map((insertedQ: any) => ({
        question_id: insertedQ.id,
        chapter_id: chapter.id,
      }));

      if (chapterLinks.length > 0) {
        const { error: chapterLinkError } = await supabase
          .from("question_chapters")
          .insert(chapterLinks);

        if (chapterLinkError) {
          logger.error("Error inserting chapter links", { error: chapterLinkError });
          throw new Error("Failed to save chapter associations for generated questions");
        } else {
          logger.info("Chapter links created", { count: chapterLinks.length });
        }
      }

      // Find the student's active offering for this course and assign
      // questions to it. Uses the shared helper because PostgREST cannot
      // resolve a `class_enrollments` embed under `offerings` (no direct FK
      // — both only FK to `classes`). See #743, #750, #770.
      let studentOffering: { id: string; class_id: string } | null = null;
      try {
        studentOffering = await resolveStudentActiveOfferingForCourse(supabase, {
          userId,
          courseId,
        });
      } catch (offeringLookupError) {
        logger.warn("Failed to resolve student offering for question assignment", {
          error: offeringLookupError instanceof Error
            ? offeringLookupError.message
            : String(offeringLookupError),
        });
      }

      if (studentOffering) {
        logger.info("Found student offering", { offeringId: studentOffering.id });

        // Insert into offering_questions to assign these questions to the student's class
        const offeringQuestionLinks = (insertedQuestions || []).map((q: any) => ({
          offering_id: studentOffering.id,
          question_id: q.id,
          published_at: new Date().toISOString(),
        }));

        if (offeringQuestionLinks.length > 0) {
          const { error: offeringLinkError } = await supabase
            .from("offering_questions")
            .insert(offeringQuestionLinks);

          if (offeringLinkError) {
            logger.warn("Error linking questions to offering", { error: offeringLinkError });
            // Don't fail - questions are already saved, just not linked to offering
          } else {
            logger.info("Questions linked to offering", {
              count: offeringQuestionLinks.length,
              offeringId: studentOffering.id
            });
          }
        }
      } else {
        logger.info("No active offering found for student, questions not assigned to specific class");
      }

      logger.info("Questions created successfully", { count: insertedQuestions?.length || 0 });

      return new Response(
        JSON.stringify({
          questions: insertedQuestions,
          remaining: hasUnlimitedAccess ? -1 : DAILY_LIMIT - todayCount - (insertedQuestions?.length || 0),
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    } catch (error) {
      llmTimer();
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
        return new Response(JSON.stringify({ error: "AI service is busy. Please try again in a moment." }), {
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
      // Handle moderation blocks (403)
      if (error instanceof OpenAIError && error.statusCode === 403) {
        return new Response(
          JSON.stringify({
            error: "Generated content was blocked by content moderation. Please try again.",
            remaining: hasUnlimitedAccess ? -1 : DAILY_LIMIT - todayCount,
          }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      throw error;
    }
  } catch (error) {
    logger.exception("Error in generate-student-questions", error);
    return new Response(
      JSON.stringify({ error: error instanceof OpenAIError ? error.message : error instanceof Error ? error.message : "Unknown error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
};
