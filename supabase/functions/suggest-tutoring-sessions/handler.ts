import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getEffectiveLanguage, getLanguageInstruction } from "../_shared/language-utils.ts";
import { callOpenAIStructured } from "../_shared/openai-client.ts";
import { modelFor } from "../_shared/model-policy.ts";
import { render } from "../_shared/render.ts";
import { logger } from "../_shared/logger.ts";
import { createUsageContext } from "../_shared/usage-tracker.ts";
import {
  SUGGEST_TUTORING_SESSIONS_SYSTEM_PROMPT,
  SUGGEST_TUTORING_SESSIONS_USER_PROMPT,
} from "../_shared/prompts/suggest-tutoring-sessions.ts";
import {
  authorizeCourseManager,
  callerFromRequest,
  resolveCourseForChapter,
} from "../_shared/course-authz.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * The cap the feature is named for. Enforced three times over, deliberately:
 * stated in the prompt, and sliced below — because a strict structured-output
 * schema cannot express `maxItems`, so the schema is a request, not a
 * guarantee, and the caller must not be able to have four sessions created by
 * a model that ignored it.
 */
const MAX_SUGGESTIONS = 3;

/** How many existing titles are worth showing the model as "do not duplicate". */
const EXISTING_TITLE_LIMIT = 40;

const SUGGESTIONS_OUTPUT_SCHEMA = {
  name: "tutoring_session_suggestions",
  schema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        description:
          "'success' when at least one session could be proposed from the chapter; " +
          "'fail' when the chapter content does not support any.",
        enum: ["success", "fail"],
      },
      message: {
        type: "string",
        description: "A short explanation for the teacher, especially on failure.",
      },
      sessions: {
        type: "array",
        description:
          `The proposed sessions, in teaching order. At most ${MAX_SUGGESTIONS}; ` +
          "an empty array when status is 'fail'.",
        items: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description: "A short, concrete session title of a few words.",
            },
            topic: {
              type: "string",
              description:
                "The learning objective — what the student should be able to do or " +
                "explain after this session.",
            },
            instructions: {
              type: "string",
              description:
                "Guidance for the AI tutor on how to teach this slice. Never shown " +
                "to the student.",
            },
          },
          required: ["title", "topic", "instructions"],
          additionalProperties: false,
        },
      },
    },
    required: ["status", "message", "sessions"],
    additionalProperties: false,
  },
  strict: true,
};

interface SuggestedSession {
  title: string;
  topic: string;
  instructions: string;
}

interface SuggestionsResult {
  status: "success" | "fail";
  message: string;
  sessions: SuggestedSession[];
}

/** Max chars of inline chapter content sent to the model, matching generate-chapter-summary. */
const MAX_CONTENT_LENGTH = 500000;

export const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { chapterId } = await req.json();

    if (!chapterId || typeof chapterId !== "string") {
      throw new Error("chapterId is required");
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey, {
      // No session to refresh on a service-role client, and leaving the
      // refresh timer on leaks an interval in the handler tests.
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // ── Caller gate ───────────────────────────────────────────────────────
    // Reads a course's chapter and spends OpenAI credit on it with the
    // service-role key, so the handler is the only boundary (AUTHORIZATION.md).
    // The course is resolved FROM THE CHAPTER, never from a body-supplied
    // courseId — authorizing against a course the caller legitimately manages
    // while reading a chapter from one they do not is the hole that closes.
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

    const courseId = resolved.courseId;
    logger.setContext({ courseId });

    const authorized = await authorizeCourseManager(supabase, caller.userId, courseId);
    if (!authorized.ok) {
      logger.warn("Refused a tutoring-session suggestion", {
        callerId: caller.userId,
        courseId,
      });
      return new Response(JSON.stringify({ error: authorized.error }), {
        status: authorized.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    logger.info("Suggesting tutoring sessions", { chapterId, courseId });

    const { data: chapter, error: chapterError } = await supabase
      .from("material_chapters")
      .select("id, title, chapter_number, content, openai_file_id, material_id")
      .eq("id", chapterId)
      .maybeSingle();

    if (chapterError) {
      throw new Error("Failed to fetch chapter: " + chapterError.message);
    }
    if (!chapter) {
      return new Response(JSON.stringify({ error: "Chapter not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Content source: the chapter's own uploaded file, or its inline text.
    //
    // Deliberately NOT falling back to the parent material's file the way
    // `generate-chapter-summary` does. That file is the whole textbook with no
    // chapter boundaries in it, and naming the chapter in the prompt is not a
    // scope — the model would be free to plan sessions from any part of the
    // book. There the fallback costs a vaguer summary; here it would silently
    // write drafts labelled "Chapter 3" out of chapter 9's material, and the
    // instructor has no way to see that from the result. A chapter with no
    // chapter-scoped content is refused below instead.
    const fileIds: string[] = [];
    let inlineContent = "";

    if (chapter.openai_file_id) {
      fileIds.push(chapter.openai_file_id);
    } else if (chapter.content) {
      inlineContent = chapter.content.length > MAX_CONTENT_LENGTH
        ? chapter.content.substring(0, MAX_CONTENT_LENGTH) + "\n\n[Content truncated...]"
        : chapter.content;
    }

    if (fileIds.length === 0 && !inlineContent) {
      logger.info("No content source available for chapter", { chapterId });
      return new Response(
        JSON.stringify({
          success: false,
          sessions: [],
          message:
            "This chapter has no content of its own yet, so there is nothing " +
            "chapter-specific to base suggestions on. Re-split the material into " +
            "chapters, or pick a chapter that has been split.",
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // What the teacher already has, so the model proposes something new rather
    // than a fourth copy of the session they created last week.
    const { data: existing } = await supabase
      .from("study_sessions")
      .select("title, topic")
      .eq("course_id", courseId)
      .order("created_at", { ascending: false })
      .limit(EXISTING_TITLE_LIMIT);

    const existingSessions = (existing ?? []).length > 0
      ? (existing as Array<{ title: string; topic: string | null }>)
        .map((s) => `- ${s.title}${s.topic ? ` (${s.topic})` : ""}`)
        .join("\n")
      : "(none yet)";

    const { data: course } = await supabase
      .from("courses")
      .select("title")
      .eq("id", courseId)
      .maybeSingle();

    const effectiveLanguage = await getEffectiveLanguage(supabase, courseId);
    const langInfo = getLanguageInstruction(effectiveLanguage);

    const contextMessage = render(SUGGEST_TUTORING_SESSIONS_USER_PROMPT, {
      max_sessions: String(MAX_SUGGESTIONS),
      chapter_num: String(chapter.chapter_number ?? ""),
      chapter_title: chapter.title ?? "Untitled chapter",
      course_title: (course as { title?: string } | null)?.title ?? "Unknown",
      existing_sessions: existingSessions,
      language_instruction: langInfo.instruction ?? "",
    });

    const input: Array<{ role: "user" | "assistant"; content: string }> = fileIds.length > 0
      ? [
        { role: "user", content: contextMessage },
        { role: "user", content: "Propose the sessions based on the attached chapter file." },
      ]
      : [
        { role: "user", content: contextMessage },
        {
          role: "user",
          content: `Propose the sessions based on the following chapter content:\n\n${inlineContent}`,
        },
      ];

    const llmTimer = logger.startTimer("ai_call");

    const result = await callOpenAIStructured<SuggestionsResult>({
      ...modelFor("tutoring.suggest-sessions"),
      promptText: SUGGEST_TUTORING_SESSIONS_SYSTEM_PROMPT,
      variables: {},
      input,
      structuredOutput: SUGGESTIONS_OUTPUT_SCHEMA,
      fileIds,
      usageContext: createUsageContext("suggest-tutoring-sessions", {
        promptKey: "suggest_tutoring_sessions",
        courseId,
      }),
    });

    logger.info("AI call completed", {
      durationMs: llmTimer(),
      status: result.status,
      returned: result.sessions?.length ?? 0,
    });

    // Drop anything unusable before capping, so a blank entry cannot occupy one
    // of the three slots and silently cost the teacher a suggestion.
    //
    // All three fields are required, not just the title: a draft with no
    // objective is one the instructor cannot save without typing one anyway
    // (`StudySessionManager.saveSession` rejects an empty topic), and a draft
    // with no tutor instructions is the part of the work this feature exists to
    // do. Half a suggestion is worse than one fewer suggestion.
    const filled = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

    const sessions = (result.sessions ?? [])
      .filter((s) => s && filled(s.title) && filled(s.topic) && filled(s.instructions))
      .slice(0, MAX_SUGGESTIONS)
      .map((s) => ({
        title: s.title.trim(),
        topic: s.topic.trim(),
        instructions: s.instructions.trim(),
      }));

    return new Response(
      JSON.stringify({
        success: result.status === "success" && sessions.length > 0,
        message: result.message,
        sessions,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    logger.exception("Error suggesting tutoring sessions", error);

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

    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
};
