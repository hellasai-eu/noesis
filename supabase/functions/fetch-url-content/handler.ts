/**
 * Turn a link into Markdown a course material can be built from.
 *
 * Two routes behind one endpoint, and the caller says which: `kind: "youtube"`
 * yields the video's transcript, `kind: "web"` yields the page as Markdown.
 * They are separate actions in the UI (two items behind one button), so the
 * request names the one that was chosen rather than leaving the server to infer
 * intent from the URL — a mistyped link then gets "that is not a YouTube link"
 * instead of silently being scraped as a web page. `kind` is optional: an older
 * caller that omits it still gets the inferred route.
 *
 * Neither route fetches anything itself. Both go out through the content
 * provider, which is also the only way the YouTube one can work — see
 * `_shared/youtube.ts`.
 *
 * This handler only READS. The caller (`UrlImportDialog`) takes the Markdown it
 * returns and runs the same storage → OpenAI → `course_materials` path a PDF
 * upload does, so an imported material is indistinguishable from an uploaded
 * one afterwards.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logger } from "../_shared/logger.ts";
import {
  authorizeCourseManager,
  callerFromRequest,
} from "../_shared/course-authz.ts";
import { ContentImportError } from "../_shared/import-provider.ts";
import {
  canonicalYouTubeUrl,
  fetchYouTubeTranscript,
  isYouTubeHost,
  parseYouTubeVideoId,
} from "../_shared/youtube.ts";
import { fetchWebContentAsMarkdown } from "../_shared/web-content.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

export const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const { url, courseId, language, kind } = body as {
      url?: string;
      courseId?: string;
      language?: string;
      kind?: string;
    };

    if (kind !== undefined && kind !== "youtube" && kind !== "web") {
      return json({ error: 'kind must be "youtube" or "web"' }, 400);
    }

    // ── Caller gate ───────────────────────────────────────────────────────
    // `verify_jwt = false` plus the service-role key means this handler is the
    // only boundary (see AUTHORIZATION.md). It fetches a caller-supplied URL
    // from inside our infrastructure and spends provider credits, so it is
    // gated on managing a real course rather than merely being signed in —
    // `courseId` is required for that reason, even though nothing is written.
    if (!courseId) {
      return json({ error: "courseId is required" }, 400);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { autoRefreshToken: false, persistSession: false } },
    );

    const caller = await callerFromRequest(req, supabase);
    if (!caller.ok) {
      return json({ error: caller.error, code: caller.code }, caller.status);
    }

    const authorized = await authorizeCourseManager(supabase, caller.userId, courseId);
    if (!authorized.ok) {
      logger.warn("Refused a URL import", { callerId: caller.userId, courseId });
      return json({ error: authorized.error }, authorized.status);
    }

    if (!url || typeof url !== "string" || url.trim().length === 0) {
      return json({ error: "url is required" }, 400);
    }

    // The course's own language, so a provider that can serve several picks the
    // one the class is taught in. Falls back to nothing rather than to English:
    // an unset course language should not silently mean "give me English".
    const courseLanguage = typeof language === "string" && language.length > 0
      ? language
      : null;

    const videoId = parseYouTubeVideoId(url);

    // A YouTube URL naming no single video — a playlist, a channel, a search
    // page, an `attribution_link`. Neither route can do anything with it, and
    // the one thing not to do is let it fall through to the scraper, which
    // would import YouTube's own navigation furniture as course material.
    // Refused whichever action was chosen, and whether or not one was.
    if (isYouTubeHost(url) && !videoId) {
      return json(
        {
          error: "That is a YouTube link, but not a single video. Playlists, channels " +
            "and search pages have no transcript to import.",
        },
        400,
      );
    }

    // The remaining two refusals: a link pasted under the wrong action, each
    // with the right one to point at.
    if (kind === "youtube" && !videoId) {
      return json(
        { error: "That is not a YouTube video link. Use “From a web page” for other links." },
        400,
      );
    }
    if (kind === "web" && videoId) {
      return json(
        { error: "That is a YouTube link. Use “From a YouTube video” to import its transcript." },
        400,
      );
    }

    if (kind === "youtube" || (kind === undefined && videoId)) {
      logger.info("Importing a YouTube transcript", { videoId, courseId, courseLanguage });
      const transcript = await fetchYouTubeTranscript(
        videoId as string,
        [courseLanguage, "en"].filter((code): code is string => !!code),
      );

      return json({
        kind: "youtube",
        url: canonicalYouTubeUrl(videoId as string),
        videoId,
        title: transcript.title,
        author: transcript.author,
        durationSeconds: transcript.durationSeconds,
        language: transcript.language,
        markdown: transcript.text,
        characterCount: transcript.text.length,
      });
    }

    logger.info("Importing a web page", { courseId, courseLanguage });
    const page = await fetchWebContentAsMarkdown(url, courseLanguage);

    return json({
      kind: "web",
      url: page.url,
      videoId: null,
      title: page.title,
      author: new URL(page.url).hostname,
      durationSeconds: null,
      language: page.language,
      markdown: page.markdown,
      characterCount: page.markdown.length,
    });
  } catch (error) {
    if (error instanceof ContentImportError) {
      logger.warn("URL import refused", { error: error.message });
      return json({ error: error.message }, error.status);
    }
    logger.exception(error as Error, "Error in fetch-url-content");
    return json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      500,
    );
  }
};
