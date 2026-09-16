/**
 * YouTube URL validation and transcript retrieval, server side.
 *
 * Used by `fetch-url-content` when an instructor asks to import a video, to
 * turn it into the text of its captions. Nothing here touches the database or
 * OpenAI — the caller decides what to do with the text.
 *
 * **Nothing here contacts YouTube.** The transcript and the video's metadata
 * both come from the content provider (`import-provider.ts`). That is a policy
 * decision, and it also happens to be the only thing that works: as of 2026
 * YouTube gates `api/timedtext` behind a BotGuard proof-of-origin token, so
 * from a server the caption tracks are still LISTED but every download answers
 * `200` with an empty body, and every InnerTube player client answers
 * `LOGIN_REQUIRED` / `UNPLAYABLE`. The InnerTube call, the watch-page scrape and
 * the timedtext download that used to live here were all dead weight dressed up
 * as a fast path.
 */

import { logger } from "./logger.ts";
import {
  ContentImportError,
  DEFAULT_METADATA_API_URL,
  DEFAULT_TRANSCRIPT_API_URL,
  fetchFromProvider,
  providerRequest,
  requireProviderApiKey,
} from "./import-provider.ts";

/**
 * Hosts a YouTube link may legitimately carry.
 *
 * Matched against the parsed `hostname` in full, never with `includes()`:
 * `https://youtube.com.attacker.example/watch?v=…` contains "youtube.com" and
 * would otherwise pass the "verify it's YouTube" check that is the whole point
 * of this function.
 */
const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);

const YOUTUBE_SHORT_HOSTS = new Set(["youtu.be", "www.youtu.be"]);

/** A YouTube video id is exactly 11 URL-safe base64 characters. */
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

/** Path prefixes that carry the id as the first path segment. */
const ID_IN_PATH_PREFIXES = ["shorts", "embed", "live", "v", "e"];

/**
 * The id out of a URL that names the video directly: `/watch?v=`, `/shorts/…`,
 * `/embed/…`, `/live/…`. The host is the caller's business.
 */
function directVideoId(url: URL): string | null {
  const segments = url.pathname.split("/").filter(Boolean);

  if (segments[0] === "watch") {
    const id = url.searchParams.get("v");
    return id && VIDEO_ID_PATTERN.test(id) ? id : null;
  }

  if (segments.length >= 2 && ID_IN_PATH_PREFIXES.includes(segments[0])) {
    const id = segments[1];
    return id && VIDEO_ID_PATTERN.test(id) ? id : null;
  }

  return null;
}

/**
 * The id out of an `attribution_link`, which wraps the real watch URL.
 *
 * The form YouTube's own share affordances still emit:
 * `/attribution_link?a=…&u=%2Fwatch%3Fv%3DID%26feature%3Dshare`. Without this
 * the wrapper names no video, and the import would have to refuse a link that
 * does in fact point at one.
 *
 * `u` is resolved against the **same origin**, so a `u` naming another host
 * becomes an absolute URL on that host and fails the allow-list below rather
 * than borrowing YouTube's. A wrapper nested inside a wrapper yields null: one
 * unwrap is the real format, and more would be a redirect chain to follow
 * rather than a URL to parse.
 */
function attributionLinkVideoId(url: URL): string | null {
  const wrapped = url.searchParams.get("u");
  if (!wrapped) return null;

  let target: URL;
  try {
    target = new URL(wrapped, url.origin);
  } catch {
    return null;
  }

  if (target.protocol !== "http:" && target.protocol !== "https:") return null;
  if (!YOUTUBE_HOSTS.has(target.hostname.toLowerCase())) return null;

  return directVideoId(target);
}

/**
 * Extract the video id from a YouTube URL, or null if this is not one.
 *
 * Accepts the forms a person actually pastes: `watch?v=`, `youtu.be/`,
 * `/shorts/`, `/embed/`, `/live/`, and the `attribution_link` wrapper. Extra
 * query parameters (`t`, `list`, `si`) are ignored rather than rejected.
 */
export function parseYouTubeVideoId(rawUrl: string): string | null {
  if (!rawUrl || typeof rawUrl !== "string") return null;

  const trimmed = rawUrl.trim();
  // A bare "youtube.com/watch?v=…" has no scheme; `new URL` would reject it.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  const host = parsed.hostname.toLowerCase();

  if (YOUTUBE_SHORT_HOSTS.has(host)) {
    const id = parsed.pathname.split("/").filter(Boolean)[0];
    return id && VIDEO_ID_PATTERN.test(id) ? id : null;
  }

  if (!YOUTUBE_HOSTS.has(host)) return null;

  if (parsed.pathname.split("/").filter(Boolean)[0] === "attribution_link") {
    return attributionLinkVideoId(parsed);
  }

  return directVideoId(parsed);
}

/**
 * Is this link served by YouTube at all?
 *
 * Broader than `parseYouTubeVideoId`, and the distinction matters: plenty of
 * YouTube URLs carry no video id — `attribution_link`, `/playlist`,
 * `/@channel`, `/results?search_query=`. Treating "no video id" as "therefore
 * an ordinary web page" would send those to the scrape endpoint, which would
 * import YouTube's own navigation furniture as though it were course material.
 *
 * The host is compared in full against the same allow-list, so a look-alike
 * like `youtube.com.attacker.example` is still an ordinary page.
 */
export function isYouTubeHost(rawUrl: string): boolean {
  if (!rawUrl || typeof rawUrl !== "string") return false;

  const trimmed = rawUrl.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  try {
    const parsed = new URL(withScheme);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    return YOUTUBE_HOSTS.has(host) || YOUTUBE_SHORT_HOSTS.has(host);
  } catch {
    return false;
  }
}

/** The canonical watch URL for a video id — what gets recorded on the material. */
export function canonicalYouTubeUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export interface YouTubeTranscript {
  videoId: string;
  /** Video title, when the provider's metadata call returned one. */
  title: string | null;
  /** Channel name. */
  author: string | null;
  /** Video length in seconds, when known. */
  durationSeconds: number | null;
  /** BCP-47-ish language code of the transcript that was used. */
  language: string | null;
  /** The transcript, as paragraphs separated by a blank line. */
  text: string;
}

/**
 * A transcript could not be produced, with a reason worth showing a user.
 *
 * The same class the web-page path throws, so the handler has one thing to
 * catch whichever route the link took.
 */
export { ContentImportError };

/** Turn the caption cues into readable paragraphs. */
export function cuesToParagraphs(cues: string[], maxParagraphChars = 900): string {
  const cleaned = cues
    .map((cue) => cue.replace(/\s+/g, " ").trim())
    .filter((cue) => cue.length > 0);

  const paragraphs: string[] = [];
  let current = "";

  for (const cue of cleaned) {
    current = current ? `${current} ${cue}` : cue;
    // Break on a sentence end once the paragraph has enough in it, so the text
    // reads as prose rather than as one wall of captions.
    if (current.length >= maxParagraphChars && /[.!?;·。？！]["»']?$/.test(current)) {
      paragraphs.push(current);
      current = "";
    } else if (current.length >= maxParagraphChars * 2) {
      // No sentence end in sight (unpunctuated auto-captions) — cut anyway.
      paragraphs.push(current);
      current = "";
    }
  }
  if (current) paragraphs.push(current);

  return paragraphs.join("\n\n");
}

/** What the metadata call is worth asking for. */
export interface YouTubeMetadata {
  title: string | null;
  author: string | null;
  durationSeconds: number | null;
}

const EMPTY_METADATA: YouTubeMetadata = { title: null, author: null, durationSeconds: null };

/**
 * Read the fields worth keeping out of the provider's metadata response.
 *
 * Exported for the tests. Supadata's shape is `{title, author: {displayName},
 * media: {duration}}`; the flatter spellings are accepted too so that pointing
 * `CONTENT_METADATA_API_URL` at another provider stays a config change, which
 * is the same tolerance `extractProviderContent` applies to the content shapes.
 */
export function extractYouTubeMetadata(payload: unknown): YouTubeMetadata {
  if (!payload || typeof payload !== "object") return EMPTY_METADATA;
  const body = payload as Record<string, unknown>;

  const text = (value: unknown): string | null =>
    typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

  const author = body.author as Record<string, unknown> | undefined;
  const media = body.media as Record<string, unknown> | undefined;

  const duration = Number(media?.duration ?? body.duration ?? body.lengthSeconds);

  return {
    title: text(body.title) ?? text(body.name),
    author: text(author?.displayName) ?? text(author?.username) ?? text(body.channel) ??
      text(body.author),
    durationSeconds: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null,
  };
}

/**
 * Ask the provider for a video's title, channel and length.
 *
 * Deliberately best-effort: a transcript with no title is still worth
 * importing — the dialog falls back to the video id for the filename and the
 * instructor can type a title — whereas failing the whole import because the
 * second of two calls did not answer would throw away work that succeeded.
 *
 * Called only after a transcript is in hand, so a video that has nothing to
 * import costs one provider credit rather than two.
 */
async function fetchMetadataFromProvider(videoId: string): Promise<YouTubeMetadata> {
  const endpoint = new URL(
    Deno.env.get("CONTENT_METADATA_API_URL") || DEFAULT_METADATA_API_URL,
  );
  endpoint.searchParams.set("url", canonicalYouTubeUrl(videoId));

  try {
    const res = await providerRequest(endpoint, requireProviderApiKey());
    if (!res.ok) {
      // Read and discard, so the body is not left dangling on the connection.
      await res.body?.cancel();
      logger.warn("Provider returned no metadata for the video", {
        videoId,
        status: res.status,
      });
      return EMPTY_METADATA;
    }
    return extractYouTubeMetadata(await res.json().catch(() => null));
  } catch (error) {
    logger.warn("Metadata lookup failed; importing the transcript without it", {
      videoId,
      error: error instanceof Error ? error.message : String(error),
    });
    return EMPTY_METADATA;
  }
}

interface ProviderTranscript {
  text: string;
  language: string | null;
}

/**
 * Ask the provider for the transcript.
 *
 * `text=true` asks for prose rather than timed cues; the cue joiner is still
 * passed because the provider falls back to cues for some videos, and grouping
 * those into paragraphs is what makes a transcript readable.
 */
async function fetchTranscriptFromProvider(
  videoId: string,
  preferredLanguages: string[],
): Promise<ProviderTranscript | null> {
  const endpoint = new URL(
    Deno.env.get("CONTENT_TRANSCRIPT_API_URL") ||
      Deno.env.get("YOUTUBE_TRANSCRIPT_API_URL") ||
      DEFAULT_TRANSCRIPT_API_URL,
  );
  endpoint.searchParams.set("url", canonicalYouTubeUrl(videoId));
  endpoint.searchParams.set("text", "true");
  if (preferredLanguages[0]) endpoint.searchParams.set("lang", preferredLanguages[0]);

  const content = await fetchFromProvider(endpoint, (cues) => cuesToParagraphs(cues));
  if (!content) {
    logger.warn("Provider returned no transcript", { videoId });
    return null;
  }
  return { text: content.text, language: content.language };
}

/**
 * Fetch a video's transcript.
 *
 * Throws `ContentImportError` with a message meant for the instructor when the
 * video exists but has nothing to transcribe (no captions, private, age
 * restricted); those are ordinary outcomes of pasting a link, not faults.
 */
export async function fetchYouTubeTranscript(
  videoId: string,
  preferredLanguages: string[] = [],
): Promise<YouTubeTranscript> {
  // Before either call, so an unconfigured deployment says so once rather than
  // reporting it as a video that could not be read.
  requireProviderApiKey();

  const transcript = await fetchTranscriptFromProvider(videoId, preferredLanguages);

  if (!transcript?.text) {
    throw new ContentImportError(
      "Could not get a transcript for this video. It may have no captions, or be " +
        "private, age restricted or unavailable.",
    );
  }

  const metadata = await fetchMetadataFromProvider(videoId);

  return {
    videoId,
    title: metadata.title,
    author: metadata.author,
    durationSeconds: metadata.durationSeconds,
    language: transcript.language ?? preferredLanguages[0] ?? null,
    text: transcript.text,
  };
}
