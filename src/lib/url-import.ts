/**
 * Link handling for the course-materials import dialog.
 *
 * Two imports, chosen before the link is pasted: a YouTube video becomes the
 * video's transcript, a web page becomes the page as Markdown. Recognising
 * YouTube here is what lets the dialog reject a link under the wrong action
 * before spending a round trip and a provider credit on it; the edge function
 * re-checks and refuses the same pairs.
 *
 * `parseYouTubeVideoId` is deliberately a mirror of the one in
 * `supabase/functions/_shared/youtube.ts` rather than a shared module: the edge
 * functions run on Deno and cannot import from `src/`. The server copy is the
 * authoritative one — it re-validates every URL it is handed — and this copy
 * exists to avoid a round trip. Keep the two in step.
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
 * The host is compared in full against an allow-list, never with `includes()`,
 * so `https://youtube.com.example.test/watch?v=…` is rejected.
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

export function isYouTubeUrl(rawUrl: string): boolean {
  return parseYouTubeVideoId(rawUrl) !== null;
}

/**
 * Is this link served by YouTube at all?
 *
 * Broader than `isYouTubeUrl`, and the distinction matters: plenty of YouTube
 * URLs carry no video id — `attribution_link`, `/playlist`, `/@channel`,
 * `/results?search_query=`. Treating "no video id" as "therefore an ordinary
 * web page" would hand those to the scraper, which would dutifully import
 * YouTube's own navigation furniture as though it were course material.
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

/**
 * Is this something the importer can be pointed at?
 *
 * Only a shape check for the dialog's inline error: http(s), a host with a dot
 * in it, no embedded credentials. The real gate is `assertPublicHttpUrl` in the
 * edge function, which also refuses private and link-local addresses — a link
 * pointing there is a mistake worth naming before a provider credit is spent
 * discovering it.
 */
export function isImportableUrl(rawUrl: string): boolean {
  if (!rawUrl || typeof rawUrl !== "string") return false;
  const trimmed = rawUrl.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  try {
    const parsed = new URL(withScheme);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    if (parsed.username || parsed.password) return false;
    return parsed.hostname.includes(".") && !parsed.hostname.endsWith(".");
  } catch {
    return false;
  }
}

/** The URL to send, with the scheme a person leaves out filled in. */
export function normalizeImportUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/** "1:04:09" / "7:32" — for the fetched-video summary line. */
export function formatVideoDuration(seconds: number | null | undefined): string | null {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return null;
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

/**
 * Escape the characters a Markdown renderer would treat as structure.
 *
 * Applied to a **transcript** only, which is prose that was never Markdown: a
 * caption paragraph beginning "# 1 thing to know" would otherwise render as an
 * H1, and one beginning "- so anyway" as a bullet. A scraped page arrives as
 * real Markdown and is left exactly as it is — escaping that would destroy the
 * structure that makes it worth importing.
 *
 * Only line starts, and only the constructs that actually collide; escaping
 * mid-line `*` and `_` too would mangle far more text than it would save.
 */
export function escapeMarkdownBlockStarts(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^(\s*)([#>\-+*=]|\d+[.)])/, "$1\\$2"))
    .join("\n");
}

export type ImportKind = "youtube" | "web";

/**
 * The wording each of the two imports uses, in one place.
 *
 * The menu item, the dialog it opens and the error it shows for the wrong kind
 * of link all read from here, so the two actions cannot drift into describing
 * themselves differently in the three places a person meets them.
 */
export const IMPORT_KIND_COPY: Record<
  ImportKind,
  { action: string; title: string; description: string; placeholder: string }
> = {
  youtube: {
    action: "From a YouTube video",
    title: "Import a YouTube transcript",
    description:
      "Paste a YouTube link. The video's transcript is imported as text — no video, no images. " +
      "Edit the Markdown if the transcript needs tidying, then save it as a material.",
    placeholder: "https://www.youtube.com/watch?v=…",
  },
  web: {
    action: "From a web page",
    title: "Import a web page",
    description:
      "Paste a link to an article or page. Its text is imported as Markdown — no images. " +
      "Edit it if the extraction needs tidying, then save it as a material.",
    placeholder: "https://…",
  },
};

/**
 * A YouTube link that names no single video: a playlist, a channel, a search
 * page, an `attribution_link`. Neither import can do anything with it, so both
 * say the same thing rather than sending the instructor to the other one.
 */
const NOT_A_SINGLE_VIDEO =
  "That is a YouTube link, but not a single video. Playlists, channels and " +
  "search pages have no transcript to import.";

/**
 * Why this link cannot be imported under the chosen action, or null if it can.
 *
 * Checked before the request so a link pasted under the wrong action is named
 * immediately rather than after a round trip and a provider credit.
 *
 * Three outcomes, not two, and the third is the one worth being careful about:
 * a YouTube URL carrying no video id is NOT thereby an ordinary web page.
 * Routing it to the scraper would import YouTube's own navigation furniture as
 * though it were course material, so both actions refuse it and say why.
 */
export function importKindMismatch(kind: ImportKind, rawUrl: string): string | null {
  if (isYouTubeHost(rawUrl) && !isYouTubeUrl(rawUrl)) return NOT_A_SINGLE_VIDEO;

  if (kind === "youtube") {
    return isYouTubeUrl(rawUrl)
      ? null
      : "That is not a YouTube video link. Use “From a web page” for other links.";
  }

  return isYouTubeUrl(rawUrl)
    ? "That is a YouTube link. Use “From a YouTube video” to import its transcript."
    : null;
}

/**
 * The text to seed the import editor with.
 *
 * A transcript is prose that was never Markdown, so its accidental block
 * markers are escaped — but **here**, at the point the instructor first sees
 * the text, rather than on the way to storage. That is what keeps the editor
 * honest: whatever is in the box is what lands in the file, so a heading they
 * add is a heading, and a caption that merely began with "- so anyway" stays a
 * sentence. A scraped page is already real Markdown and is left alone.
 */
export function seedImportedContent(kind: ImportKind, content: string): string {
  return kind === "youtube" ? escapeMarkdownBlockStarts(content) : content;
}

export interface ImportedDocumentInput {
  title: string;
  sourceUrl: string;
  kind: ImportKind;
  author?: string | null;
  language?: string | null;
  /** Transcript prose for a video, Markdown for a page. */
  content: string;
}

/**
 * The Markdown document stored as the material.
 *
 * Markdown rather than a rendered PDF: OpenAI accepts `.md` both as an
 * `input_file` and in a vector store, so the study-guide path works on it
 * unchanged — and keeping text as text means it stays searchable and
 * correctable, where a PDF of a transcript is a picture of a document nobody
 * can fix.
 *
 * The header records where the text came from, since the file outlives this
 * dialog and a study guide built from it should be attributable.
 */
export function buildImportedMarkdown({
  title,
  sourceUrl,
  kind,
  author,
  language,
  content,
}: ImportedDocumentInput): string {
  const provenance = [
    `Source: ${sourceUrl}`,
    author ? `${kind === "youtube" ? "Channel" : "Site"}: ${author}` : null,
    language ? `Language: ${language}` : null,
  ].filter(Boolean) as string[];

  // `content` is stored verbatim. A transcript's accidental Markdown is
  // escaped once, when the editor is seeded (`seedImportedContent`), so that
  // what the instructor reads, previews and approves is exactly what is saved —
  // escaping here instead would silently rewrite their own headings and lists
  // into literal text after they had approved them.
  const body = content.trim();

  return [
    `# ${escapeMarkdownBlockStarts(title)}`,
    "",
    provenance.join("  \n"),
    "",
    "---",
    "",
    body,
    "",
  ].join("\n");
}

/**
 * A storage-safe file stem for the generated `.md`.
 *
 * The bucket key must be ASCII (the same sanitising `MaterialUploadDialog`
 * does), which erases a Greek or Japanese title entirely — hence the fallback,
 * so the object never ends up named `_______.md`.
 */
export function importedFileStem(title: string, fallback: string): string {
  const sanitize = (value: string) =>
    value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^[._-]+|[._-]+$/g, "")
      .slice(0, 60);

  const sanitizedTitle = sanitize(title);
  const sanitizedFallback = sanitize(fallback) || "import";

  return sanitizedTitle.length >= 3
    ? `${sanitizedTitle}-${sanitizedFallback}`
    : sanitizedFallback;
}

/** The `fallback` for `importedFileStem`: a video id, or the site's host. */
export function importFallbackStem(sourceUrl: string, videoId?: string | null): string {
  if (videoId) return `youtube-${videoId}`;
  try {
    return new URL(sourceUrl).hostname.replace(/^www\./, "");
  } catch {
    return "web-import";
  }
}

