import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { callOpenAIStructured, OpenAIRateLimitError } from "../_shared/openai-client.ts";
import { AiFeatureDisabledError } from "../_shared/openai-client.ts";
import { modelFor } from "../_shared/model-policy.ts";
import { logger } from "../_shared/logger.ts";
import { createUsageContext } from "../_shared/usage-tracker.ts";
import { SIMILARITY_CHECK_SYSTEM_PROMPT } from "../_shared/prompts/check-question-similarity.ts";
import {
  classificationCategoriesFromPayload,
  classificationItemsFromPayload,
  classificationPromptFromPayload,
  fillGapsAcceptableAnswersFromAnswerKey,
  fillGapsStemFromPayload,
  openModelAnswerFromAnswerKey,
  orderingItemsFromPayload,
  orderingPromptFromPayload,
  type QuestionType,
} from "../_shared/question-payload.ts";
import {
  authorizeCourseManager,
  callerFromRequest,
} from "../_shared/course-authz.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * #621 — the similarity scan now runs across every type in the unified
 * `questions` table. Each row is normalized to a single text representation
 * (see `normalizeForSimilarity`) so the LLM can compare apples to apples;
 * matched rows are returned with their `type` so the dialog can render the
 * right badge.
 */

interface SimilarityResult {
  questionId: string;
  questionType: QuestionType;
  questionText: string;
  similarTo: {
    id: string;
    type: QuestionType;
    text: string;
    similarityScore: number;
    reason: string;
  }[];
}

interface SimilarItem {
  questionId: string;
  similarTo: {
    id: string;
    similarityScore: number;
    reason: string;
  }[];
}

interface AnalysisResultList {
  items: SimilarItem[];
}

const SIMILARITY_OUTPUT_SCHEMA = {
  name: "analysis_result_list",
  strict: true,
  schema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            questionId: {
              type: "string",
              description: "The unique identifier (UUID) of the analyzed question.",
              minLength: 1,
            },
            similarTo: {
              type: "array",
              description: "List of questions similar to the analyzed question, with similarity scores and reasons.",
              items: {
                type: "object",
                properties: {
                  id: {
                    type: "string",
                    description: "The unique identifier (UUID) of the similar question.",
                    minLength: 1,
                  },
                  similarityScore: {
                    type: "number",
                    description: "The numeric score (0-100) showing how similar the two questions are.",
                    minimum: 0,
                    maximum: 100,
                  },
                  reason: {
                    type: "string",
                    description: "A short explanation for why the two questions are similar.",
                    minLength: 1,
                  },
                },
                required: ["id", "similarityScore", "reason"],
                additionalProperties: false,
              },
            },
          },
          required: ["questionId", "similarTo"],
          additionalProperties: false,
        },
      },
    },
    required: ["items"],
    additionalProperties: false,
  },
};

interface QuestionRow {
  id: string;
  type: string;
  question: string | null;
  payload: unknown;
  answer_key: unknown;
  difficulty: string | null;
}

const KNOWN_TYPES = new Set<QuestionType>([
  "mcq",
  "open",
  "fill_gaps",
  "ordering",
  "classification",
]);

/**
 * Reduce a question of any type to a single normalized text representation
 * suitable for cross-type similarity reasoning. Mirrors the rules in
 * `src/lib/unified-question.ts::buildSearchText`.
 */
export function normalizeForSimilarity(row: QuestionRow): string {
  const type = row.type as QuestionType;
  switch (type) {
    case "mcq":
      // Stem only — options excluded per the unified spec.
      return (row.question || "").trim();
    case "open": {
      const stem = (row.question || "").trim();
      const model = openModelAnswerFromAnswerKey(
        row.answer_key as Parameters<typeof openModelAnswerFromAnswerKey>[0],
      );
      return [stem, model].filter((s) => s && s.length > 0).join(" ").trim();
    }
    case "fill_gaps": {
      const stem = fillGapsStemFromPayload(
        row.payload as Parameters<typeof fillGapsStemFromPayload>[0],
      ).replace(/\{\{\d+\}\}/g, "___");
      const firstAcceptable = fillGapsAcceptableAnswersFromAnswerKey(
        row.answer_key as Parameters<typeof fillGapsAcceptableAnswersFromAnswerKey>[0],
      )
        .map((g) => g.acceptable[0])
        .filter((s): s is string => Boolean(s))
        .join(" ");
      return [stem, firstAcceptable].filter((s) => s.length > 0).join(" ").trim();
    }
    case "ordering": {
      const prompt = orderingPromptFromPayload(
        row.payload as Parameters<typeof orderingPromptFromPayload>[0],
      );
      const items = orderingItemsFromPayload(
        row.payload as Parameters<typeof orderingItemsFromPayload>[0],
      ).join(" ");
      return [prompt, items].filter((s) => s.length > 0).join(" ").trim();
    }
    case "classification": {
      const prompt = classificationPromptFromPayload(
        row.payload as Parameters<typeof classificationPromptFromPayload>[0],
      );
      const labels = classificationCategoriesFromPayload(
        row.payload as Parameters<typeof classificationCategoriesFromPayload>[0],
      )
        .map((c) => c.label)
        .join(" ");
      const items = classificationItemsFromPayload(
        row.payload as Parameters<typeof classificationItemsFromPayload>[0],
      )
        .map((it) => it.text)
        .join(" ");
      return [prompt, labels, items].filter((s) => s.length > 0).join(" ").trim();
    }
    default:
      return (row.question || "").trim();
  }
}

export const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { courseId } = await req.json();

    if (!courseId) {
      return new Response(JSON.stringify({ error: "courseId is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey, {
      // No session to refresh on a service-role client, and leaving the
      // refresh timer on leaks an interval in the handler tests.
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // ── Caller gate (#1136) ───────────────────────────────────────────────
    // This read a course's entire question bank with the service-role key and
    // established no caller identity.
    //
    // `courseId` comes from the body, which is safe HERE and only here: the
    // question bank being read is that same course's, so the caller is checked
    // against exactly the resource acted on. The defect elsewhere in this
    // series was always checking one id and acting on another.
    const caller = await callerFromRequest(req, supabase);
    if (!caller.ok) {
      return new Response(JSON.stringify({ error: caller.error, code: caller.code }), {
        status: caller.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const authorized = await authorizeCourseManager(supabase, caller.userId, courseId);
    if (!authorized.ok) {
      logger.warn("Refused a question-bank read", {
        callerId: caller.userId,
        courseId,
      });
      return new Response(JSON.stringify({ error: authorized.error }), {
        status: authorized.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }


    const endDbTimer = logger.startTimer("fetch-questions");
    const { data: questions, error: questionsError } = await supabase
      .from("questions")
      .select("id, type, question, payload, answer_key, difficulty")
      .eq("course_id", courseId)
      .order("created_at", { ascending: false });
    endDbTimer();

    if (questionsError) {
      logger.error("Error fetching questions", { error: questionsError.message });
      throw new Error("Failed to fetch questions");
    }

    const rows = (questions ?? []) as unknown as QuestionRow[];
    const normalized = rows
      .filter((r) => KNOWN_TYPES.has(r.type as QuestionType))
      .map((r) => ({
        row: r,
        text: normalizeForSimilarity(r),
      }))
      .filter((r) => r.text.length > 0);

    if (normalized.length < 2) {
      return new Response(
        JSON.stringify({
          similarQuestions: [],
          message: "Not enough questions to check for similarity",
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    logger.info("Checking similarity", {
      courseId,
      questionCount: normalized.length,
    });
    logger.setContext({ courseId });

    // Include the `type` tag so the model can reason across types but keep
    // its output bound to question ids — the dialog re-attaches metadata.
    const questionsList = normalized
      .map(
        (n, idx) =>
          `[${idx + 1}] (ID: ${n.row.id}) [${n.row.type}] ${n.text}`,
      )
      .join("\n");

    let similarityResults: SimilarItem[] = [];
    try {
      const endAiTimer = logger.startTimer("ai-similarity-check");
      const result = await callOpenAIStructured<AnalysisResultList>({
        ...modelFor("question-bank.similarity"),
        promptText: SIMILARITY_CHECK_SYSTEM_PROMPT,
        variables: {},
        input: [{ role: "user", content: questionsList }],
        structuredOutput: SIMILARITY_OUTPUT_SCHEMA,
        usageContext: createUsageContext("check-question-similarity", {
          promptKey: "similarity_check",
          courseId,
        }),
      });
      endAiTimer();
      similarityResults = result.items || [];
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
        return new Response(
          JSON.stringify({ error: "Rate limit exceeded. Please try again later." }),
          {
            status: 429,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
      throw error;
    }

    const byId = new Map(normalized.map((n) => [n.row.id, n]));

    const enrichedResults: SimilarityResult[] = similarityResults
      .map((result) => {
        const source = byId.get(result.questionId);
        if (!source) return null;
        return {
          questionId: result.questionId,
          questionType: source.row.type as QuestionType,
          questionText: source.text,
          similarTo: result.similarTo
            .map((sim) => {
              const target = byId.get(sim.id);
              if (!target) return null;
              return {
                id: sim.id,
                type: target.row.type as QuestionType,
                text: target.text,
                similarityScore: sim.similarityScore,
                reason: sim.reason,
              };
            })
            .filter((s): s is NonNullable<typeof s> => s !== null),
        };
      })
      .filter((r): r is SimilarityResult => r !== null && r.similarTo.length > 0);

    logger.info("Similarity check complete", {
      similarGroupsFound: enrichedResults.length,
    });

    return new Response(JSON.stringify({ similarQuestions: enrichedResults }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    logger.exception(error as Error, "Error in check-question-similarity");
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
};
