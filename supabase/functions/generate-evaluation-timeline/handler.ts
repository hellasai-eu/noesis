import {
  callOpenAIStructured,
  OpenAIError,
  OpenAIRateLimitError,
} from "../_shared/openai-client.ts";
import { AiFeatureDisabledError } from "../_shared/openai-client.ts";
import { modelFor } from "../_shared/model-policy.ts";
import { render } from "../_shared/render.ts";
import { createUsageContext } from "../_shared/usage-tracker.ts";
import {
  EVALUATION_TIMELINE_SYSTEM_PROMPT,
  EVALUATION_TIMELINE_USER_PROMPT,
} from "../_shared/prompts/generate-evaluation-timeline.ts";
import { logger } from "../_shared/logger.ts";
import { requireCaller } from "../_shared/require-caller.ts";

/**
 * Per-student analysis of a handful of prior evaluations — the same shape of
 * work as `generate-student-evaluation`, which produces the rows this reads,
 * so it takes the same model. The input is a few hundred tokens of prose and
 * the output is a fixed schema; medium effort is the sibling analysis default
 * (`analyze-quiz`, `analyze-study-guide`).
 *
 * Named explicitly here because moving off the hosted saved prompt moved the
 * model choice out of the OpenAI dashboard and into this file. Previously
 * `version: "2"` pinned it invisibly.
 */
// Resolved once, so the model named in the log line and the model actually
// called come from the same object.
const TIMELINE_POLICY = modelFor("analytics.evaluation-timeline");
const MODEL = TIMELINE_POLICY.model;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface Evaluation {
  id: string;
  strengths: string[];
  weaknesses: string[];
  recommendations: string[];
  overallAssessment: string;
  generatedAt: string;
  instructorFeedback: string | null;
  isManual: boolean;
}

const STUDENT_COMPETENCY_ANALYSIS_SCHEMA = {
  name: "student_competency_analysis",
  strict: true,
  schema: {
    type: "object",
    properties: {
      analysis: {
        type: "object",
        description: "Analysis of a student's competencies including trends, strengths, areas for improvement, and recommendations.",
        properties: {
          summary: {
            type: "string",
            description: "A summary of the student's overall competency progress."
          },
          overallTrend: {
            type: "string",
            enum: ["improving", "declining", "stable"],
            description: "Overall trend in the student's progress."
          },
          competencyInsights: {
            type: "array",
            description: "Detailed insights for each competency area.",
            items: {
              type: "object",
              properties: {
                competencyTitle: {
                  type: "string",
                  description: "The title or name of the competency."
                },
                trend: {
                  type: "string",
                  enum: ["improving", "declining", "stable"],
                  description: "The trend (improving, stable, declining) for this competency."
                },
                insight: {
                  type: "string",
                  description: "Detailed insight about progress in this competency."
                }
              },
              required: ["competencyTitle", "trend", "insight"],
              additionalProperties: false
            }
          },
          strengths: {
            type: "array",
            description: "A list of the student's strengths.",
            items: { type: "string" }
          },
          areasForImprovement: {
            type: "array",
            description: "Areas where the student needs to improve.",
            items: { type: "string" }
          },
          recommendations: {
            type: "array",
            description: "Actionable recommendations for the student.",
            items: { type: "string" }
          }
        },
        required: ["summary", "overallTrend", "competencyInsights", "strengths", "areasForImprovement", "recommendations"],
        additionalProperties: false
      }
    },
    required: ["analysis"],
    additionalProperties: false
  }
};

export const handler = async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // ── Caller gate (#1137) ───────────────────────────────────────────────
    // Runs an OpenAI completion over data supplied entirely by the caller.
    //
    // Authentication only: there is no tenant resource in this request to
    // authorize anyone against. That is the whole difference between an
    // endpoint the internet can spend money through and one only signed-in
    // users can.
    const caller = await requireCaller(req);
    if (!caller.ok) {
      return new Response(JSON.stringify({ error: caller.error, code: caller.code }), {
        status: caller.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { evaluations, language } = await req.json();


    if (!evaluations || evaluations.length < 2) {
      return new Response(
        JSON.stringify({ error: "Need at least 2 evaluations for timeline analysis" }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    logger.info("Generating timeline analysis", {
      evaluationsCount: evaluations.length,
      language,
    });

    // Most recent FIRST — the user prompt says so in as many words, and the
    // model weights a trend by which end it reads first. This used to sort
    // ascending against a hosted template nobody in this repo could read.
    const sortedEvaluations = [...evaluations].sort((a: Evaluation, b: Evaluation) =>
      new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime()
    );

    // Numbered newest-first too, so "Evaluation 1" is the latest rather than
    // silently disagreeing with the order the entries appear in.
    const evaluationHistory = sortedEvaluations.map((e: Evaluation, i: number) => `
### Evaluation ${i + 1} (${new Date(e.generatedAt).toLocaleDateString()})
- Type: ${e.isManual ? 'Manual (Instructor)' : 'AI Generated'}
- Overall Assessment: ${e.overallAssessment}
- Strengths: ${e.strengths.join('; ')}
- Weaknesses: ${e.weaknesses.join('; ')}
- Recommendations: ${e.recommendations.join('; ')}
${e.instructorFeedback ? `- Instructor Feedback: ${e.instructorFeedback}` : ''}
`).join('\n');

    const userMessage = render(EVALUATION_TIMELINE_USER_PROMPT, {
      lang: language || "en",
      competency_history: evaluationHistory,
    });

    logger.info("Calling OpenAI for timeline analysis", { model: MODEL });
    const llmTimer = logger.startTimer("ai_call");

    let parsed: { analysis?: unknown };
    try {
      parsed = await callOpenAIStructured<{ analysis?: unknown }>({
        ...TIMELINE_POLICY,
        promptText: EVALUATION_TIMELINE_SYSTEM_PROMPT,
        variables: {},
        input: [{ role: "user", content: userMessage }],
        structuredOutput: STUDENT_COMPETENCY_ANALYSIS_SCHEMA,
        usageContext: createUsageContext("generate-evaluation-timeline", {
          promptKey: "evaluation_timeline",
        }),
      });
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
          { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      if (error instanceof OpenAIError) {
        logger.error("OpenAI error", { message: error.message });
        return new Response(
          JSON.stringify({ error: "Failed to analyze this timeline. Please try again." }),
          { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      throw error;
    }

    const llmDuration = llmTimer();
    logger.info("OpenAI response received", { durationMs: llmDuration });

    const analysis = parsed?.analysis;
    if (!analysis) {
      throw new Error("Invalid response format from OpenAI - no analysis object");
    }

    logger.info("Timeline analysis generated successfully");

    return new Response(
      JSON.stringify({ analysis }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    logger.exception("Error generating timeline analysis", error);

    // Handle rate limits and payment errors
    if (error instanceof Error) {
      if (error.message.includes('429') || error.message.includes('rate')) {
        return new Response(
          JSON.stringify({ error: "Rate limit exceeded. Please try again later." }),
          { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      if (error.message.includes('402') || error.message.includes('payment')) {
        return new Response(
          JSON.stringify({ error: "Usage limit reached. Please add credits." }),
          { status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
};
