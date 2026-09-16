/**
 * Shared model configuration and output schemas for the three study guide
 * generation functions (#1004).
 *
 * These calls are synchronous and request-scoped — the instructor clicks a
 * button and waits — so every one of them must finish inside the edge
 * function's wall-clock budget. That is the whole reason the work is split
 * into an outline call plus a theory call and a questions call per piece,
 * instead of the single job that used to produce everything.
 */

/**
 * Model choice for these three calls now lives in `model-policy.ts`, under the
 * keys `study-guide.outline`, `study-guide.theory` and `study-guide.questions`
 * — together with the reasoning that used to sit here as a comment.
 *
 * It moved because a rationale in a comment cannot be queried. The registry
 * stamps `policy_key`, `policy_version` and `model_tier` onto every row in
 * `ai_usage_logs`, so "is the flagship outline still worth its premium?" is a
 * GROUP BY rather than a re-reading of this file.
 *
 * The tier-suffix trap is unchanged and still the thing to watch: bare
 * "gpt-5.6" is an alias for Sol, so a policy entry that omits the suffix
 * silently buys the most expensive tier instead of failing.
 */

/**
 * Poll ceiling for OpenAI background mode, kept UNDER the ~180s edge function
 * cap that `openai-client.ts` documents.
 *
 * The previous job-based implementation used 240s, above that cap. A call that
 * ran long had its isolate killed mid-poll; the item was retried by the next
 * cron tick and, after three attempts, marked failed — while faster pieces
 * succeeded. That produced exactly the reported symptom: a `partially_completed`
 * job, a NULL `jobs.error`, and some pieces with questions and some without.
 *
 * Synchronous calls cannot outlive the request, so the ceiling has to fit
 * inside it. Splitting the work per piece is what makes that affordable.
 */
export const STUDY_GUIDE_MAX_POLL_MS = 150_000;

/** Matches the study_guides.target_piece_count CHECK in the #977 migration. */
export const MAX_PIECES = 20;
export const MAX_QUESTIONS_PER_PIECE = 20;

// ---------------------------------------------------------------------------
// Structured output schemas
//
// OpenAI strict mode requires every property to appear in `required`, so
// variant fields are nullable rather than optional. Keywords the schema guard
// rejects (uniqueItems, contains, patternProperties) are deliberately absent.
// ---------------------------------------------------------------------------

export const OUTLINE_OUTPUT_SCHEMA = {
  name: "study_guide_outline",
  strict: true,
  schema: {
    type: "object",
    properties: {
      pieces: {
        type: "array",
        description: "The ordered pieces of the study guide.",
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "Short concrete title naming the idea." },
            scope: {
              type: "string",
              description: "What this piece must teach and what it must leave to others.",
            },
            chapter_hint: {
              type: ["integer", "null"],
              description: "Chapter number this piece draws on most, or null if it spans several.",
            },
          },
          required: ["title", "scope", "chapter_hint"],
          additionalProperties: false,
        },
      },
    },
    required: ["pieces"],
    additionalProperties: false,
  },
};

export const THEORY_OUTPUT_SCHEMA = {
  name: "study_guide_theory",
  strict: true,
  schema: {
    type: "object",
    properties: {
      theory_html: {
        type: "string",
        description: "The theory a student reads for this piece, as HTML.",
      },
    },
    required: ["theory_html"],
    additionalProperties: false,
  },
};

export const QUESTIONS_OUTPUT_SCHEMA = {
  name: "study_guide_questions",
  strict: true,
  schema: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        description: "Follow-up questions checking understanding of this piece.",
        items: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["mcq", "open", "fill_gaps", "ordering", "classification"],
            },
            question: { type: "string", description: "The question stem shown to the student." },
            difficulty: { type: "string", enum: ["easy", "medium", "hard"] },
            explanation: {
              type: "string",
              description: "Why the answer is correct; shown after submission.",
            },
            competency_id: {
              type: ["string", "null"],
              description: "Id from the supplied competency list, or null if none fits.",
            },
            mcq_options: { type: ["array", "null"], items: { type: "string" } },
            mcq_correct_indices: { type: ["array", "null"], items: { type: "integer" } },
            open_model_answer: { type: ["string", "null"] },
            fill_gaps_stem: {
              type: ["string", "null"],
              // This description used to read "each gap written as ___", which
              // the model obeyed — producing stems the renderer could not turn
              // into inputs at all (#1035). The renderer splits on {{N}} and
              // nothing else, so the schema must say so too.
              description:
                "Passage with each gap written as a {{N}} placeholder: {{1}}, {{2}}, … 1-indexed, contiguous, one per entry in fill_gaps_gaps. Never write a gap as ___ or any other marker.",
            },
            fill_gaps_gaps: {
              type: ["array", "null"],
              description:
                "One entry per {{N}} placeholder in fill_gaps_stem, in ordinal order: entry 1 answers {{1}}.",
              items: {
                type: "object",
                properties: {
                  accepted: {
                    type: "array",
                    items: { type: "string" },
                    // This used to carry no guidance at all, and the model supplied
                    // a single answer even where the theory coordinated two equally
                    // valid fillers — "a role within a state and a constitution",
                    // key ["constitution"], student "state", marked wrong (#1042).
                    description:
                      "Every answer the theory supports for this gap, not only the first one: each filler a coordinated 'X and Y' clause licenses, plus its synonyms and inflections. Grading is an exact match against this list, so a defensible answer missing here is marked wrong.",
                  },
                },
                required: ["accepted"],
                additionalProperties: false,
              },
            },
            ordering_prompt: { type: ["string", "null"] },
            ordering_items: {
              type: ["array", "null"],
              items: { type: "string" },
              description: "Items in their CORRECT order; the student sees them shuffled.",
            },
            classification_prompt: { type: ["string", "null"] },
            classification_categories: { type: ["array", "null"], items: { type: "string" } },
            classification_items: {
              type: ["array", "null"],
              items: {
                type: "object",
                properties: {
                  text: { type: "string" },
                  category: {
                    type: "string",
                    description: "Must exactly match one of classification_categories.",
                  },
                },
                required: ["text", "category"],
                additionalProperties: false,
              },
            },
          },
          required: [
            "type",
            "question",
            "difficulty",
            "explanation",
            "competency_id",
            "mcq_options",
            "mcq_correct_indices",
            "open_model_answer",
            "fill_gaps_stem",
            "fill_gaps_gaps",
            "ordering_prompt",
            "ordering_items",
            "classification_prompt",
            "classification_categories",
            "classification_items",
          ],
          additionalProperties: false,
        },
      },
    },
    required: ["questions"],
    additionalProperties: false,
  },
};
