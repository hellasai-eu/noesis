/**
 * The content provider shared by the URL import paths.
 *
 * One key, one endpoint family, three uses: `youtube.ts` asks it for a video's
 * transcript and for that video's metadata, `web-content.ts` asks it for a page
 * as Markdown. All of them go through the plumbing here so the deadline, the
 * error mapping and the asynchronous job flow are defined once.
 *
 * **Every outbound fetch an import makes goes to the provider.** The importer
 * used to reach youtube.com and the page itself directly and treat the provider
 * as a fallback; it no longer does, so this module is now the only thing in the
 * import path that talks to the internet. That is what turns the provider key
 * from an improvement into a requirement — see `requireProviderApiKey`.
 *
 * `YOUTUBE_TRANSCRIPT_API_KEY` names the key for historical reasons — it
 * arrived with the YouTube importer — and is kept because it is already set in
 * deployments; `CONTENT_PROVIDER_API_KEY` is accepted as the clearer spelling.
 */

import { logger } from "./logger.ts";

/** Supadata's transcript endpoint — the default for the YouTube path. */
export const DEFAULT_TRANSCRIPT_API_URL = "https://api.supadata.ai/v1/transcript";
/** Supadata's scrape endpoint — the default for the web page path. */
export const DEFAULT_SCRAPE_API_URL = "https://api.supadata.ai/v1/web/scrape";
/**
 * Supadata's metadata endpoint — a video's title, channel and duration.
 *
 * A call of its own because the transcript response carries none of that: it
 * answers `content`, `lang` and `availableLangs`, and nothing else. Those three
 * fields used to come free from YouTube's own player response, which is no
 * longer ours to read.
 */
export const DEFAULT_METADATA_API_URL = "https://api.supadata.ai/v1/metadata";

/**
 * Deadlines for every outbound request.
 *
 * An import makes several hops to hosts nobody here controls. Without a
 * deadline a single stalled upstream holds the isolate until the edge runtime
 * kills the whole invocation, and enough of those eat the concurrency budget
 * every other function shares.
 */
export const PROVIDER_TIMEOUT_MS = 45_000;

/**
 * How long to wait out an asynchronous provider job, and how often to ask.
 *
 * The budget is deliberately shorter than an edge invocation's wall clock:
 * running out is reported as "still working, try again", which a retry
 * resolves, whereas being killed mid-wait tells the instructor nothing.
 * `CONTENT_PROVIDER_POLL_BUDGET_MS` overrides it where the runtime allows
 * longer.
 */
const PROVIDER_JOB_BUDGET_MS = 60_000;
const PROVIDER_JOB_POLL_INTERVAL_MS = 2_000;

/** An import could not be produced, with a reason worth showing a user. */
export class ContentImportError extends Error {
  /** HTTP status the handler should answer with. */
  readonly status: number;

  constructor(message: string, status = 422) {
    super(message);
    this.name = "ContentImportError";
    this.status = status;
  }
}

/** The provider's API key, under either spelling. */
function providerApiKey(): string | null {
  return Deno.env.get("CONTENT_PROVIDER_API_KEY") ||
    Deno.env.get("YOUTUBE_TRANSCRIPT_API_KEY") ||
    null;
}

/**
 * The provider's API key, or a refusal naming what an administrator must set.
 *
 * Nothing can be imported without it any more. While the importer still fetched
 * pages itself, an unset key only meant worse extraction; now it means the
 * feature is switched off, which is worth saying as a configuration fault
 * somebody can escalate rather than as "that link did not work".
 */
export function requireProviderApiKey(): string {
  const apiKey = providerApiKey();
  if (!apiKey) {
    logger.error("An import was attempted with no content provider configured");
    throw new ContentImportError(
      "Link import is not configured on this deployment. An administrator needs " +
        "to set CONTENT_PROVIDER_API_KEY.",
      503,
    );
  }
  return apiKey;
}

export interface ProviderContent {
  /** Markdown, or plain paragraphs — both are valid Markdown. */
  text: string;
  language: string | null;
  /** Page or video title, where the provider reports one. */
  title?: string | null;
}

/** One GET to the provider, with the deadline and the error mapping applied. */
export async function providerRequest(url: URL, apiKey: string): Promise<Response> {
  try {
    return await fetch(url, {
      headers: {
        // `x-api-key` ONLY. This used to also send `Authorization: Bearer …`,
        // on the theory that offering both spellings would make pointing the
        // code at another provider a config change. It did the opposite:
        // Supadata rejects any request carrying an `Authorization` header, so
        // every import 401'd in production with a perfectly valid key.
        //
        // Measured against api.supadata.ai on 2026-09-02, on both the
        // transcript and the scrape endpoints:
        //
        //   x-api-key alone .......................... 200
        //   x-api-key + Authorization: Bearer ........ 401 Unauthorized
        //   Authorization: Bearer alone .............. 401 Unauthorized
        //
        // So do not "helpfully" add it back. A provider that wants a bearer
        // token is a one-line change here, made when there is one.
        "x-api-key": apiKey,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  } catch (error) {
    logger.error("Content provider request failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw new ContentImportError(
      "The import service did not respond in time. Please try again.",
      504,
    );
  }
}

/** Turn a provider error status into something worth showing, or null. */
export function refuseOnProviderStatus(status: number, detail: string): null {
  logger.error("Content provider refused the request", { status, detail });
  if (status === 401 || status === 403) {
    throw new ContentImportError(
      "The import service rejected our API key. An administrator needs to check it.",
      502,
    );
  }
  if (status === 429) {
    throw new ContentImportError(
      "The import service is out of quota for now. Please try again later.",
      429,
    );
  }
  // 404 is "this provider has nothing for that URL", which is an answer, not a
  // fault — the caller reports "nothing to import" rather than an outage.
  if (status === 404) return null;
  throw new ContentImportError(
    "The import service could not be reached. Please try again.",
    502,
  );
}

/**
 * Read the content out of whatever shape the provider answered with.
 *
 * Deliberately tolerant: `content` as a string (Supadata's `text=true` and its
 * scrape response), as an array of cue objects (its default transcript shape),
 * and the `transcript` / `text` / `markdown` spellings other providers use.
 * Anything unrecognised yields null and is logged rather than guessed at.
 */
export function extractProviderContent(
  payload: unknown,
  joinCues: (cues: string[]) => string,
): ProviderContent | null {
  if (!payload || typeof payload !== "object") return null;
  const body = payload as Record<string, unknown>;

  const language = typeof body.lang === "string"
    ? body.lang
    : typeof body.language === "string"
    ? body.language
    : null;
  const title = typeof body.name === "string"
    ? body.name
    : typeof body.title === "string"
    ? body.title
    : null;

  const cueText = (value: unknown): string | null => {
    if (!Array.isArray(value)) return null;
    const cues = value
      .map((entry) => {
        if (typeof entry === "string") return entry;
        const cue = entry as Record<string, unknown>;
        const text = cue?.text ?? cue?.utf8 ?? cue?.content ?? cue?.snippet;
        return typeof text === "string" ? text : "";
      })
      .filter((cue) => cue.trim().length > 0);
    return cues.length > 0 ? joinCues(cues) : null;
  };

  for (const key of ["content", "markdown", "transcript", "text", "segments", "captions", "data"]) {
    const value = body[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return { text: value.trim(), language, title };
    }
    const fromCues = cueText(value);
    if (fromCues) return { text: fromCues, language, title };
  }

  return null;
}

/**
 * Wait out an asynchronous provider job.
 *
 * Supadata answers 202 `{jobId}` for **anything over 20 minutes** and expects
 * the caller to poll `…/{jobId}` — which is most of what an instructor
 * imports, so treating the 202 as "nothing here" (as the first cut did) failed
 * the feature on its main case.
 *
 * The wait is bounded because an edge invocation has a wall clock of its own:
 * exhausting the budget is reported as "still working, try again", which is
 * true and actionable — a retry picks up the finished job's result, and the
 * provider keeps it for an hour.
 */
export async function awaitProviderJob(
  endpoint: URL,
  jobId: string,
  apiKey: string,
  joinCues: (cues: string[]) => string,
): Promise<ProviderContent | null> {
  const jobUrl = new URL(endpoint.toString());
  jobUrl.search = "";
  jobUrl.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/${jobId}`;

  const budgetMs = Number(Deno.env.get("CONTENT_PROVIDER_POLL_BUDGET_MS")) ||
    Number(Deno.env.get("YOUTUBE_TRANSCRIPT_POLL_BUDGET_MS")) ||
    PROVIDER_JOB_BUDGET_MS;
  const deadline = Date.now() + budgetMs;

  logger.info("Content provider queued an async job", { jobId, budgetMs });

  // Polled before the first sleep: a short job is often already done, and it
  // keeps the tests from having to wait out an interval.
  while (true) {
    const res = await providerRequest(jobUrl, apiKey);
    if (!res.ok) {
      return refuseOnProviderStatus(res.status, (await res.text()).slice(0, 300));
    }

    const body = await res.json().catch(() => null) as
      | { status?: string; error?: unknown }
      | null;

    if (body?.status === "failed") {
      const detail = typeof body.error === "string" ? body.error : "";
      logger.error("Content provider job failed", { jobId, detail });
      throw new ContentImportError("The import service could not process this link.");
    }

    const content = extractProviderContent(body, joinCues);
    if (content) return content;

    if (body?.status === "completed") {
      // Finished with nothing in it — an answer, not something to keep waiting on.
      logger.warn("Content provider job completed with nothing in it", { jobId });
      return null;
    }

    if (Date.now() + PROVIDER_JOB_POLL_INTERVAL_MS >= deadline) {
      logger.warn("Gave up waiting on the provider job", { jobId });
      throw new ContentImportError(
        "The import service is still working on this link. Try again in a minute.",
        504,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, PROVIDER_JOB_POLL_INTERVAL_MS));
  }
}

/**
 * One provider call, including the asynchronous job flow.
 *
 * `joinCues` is how the caller wants a cue array turned into prose — the
 * YouTube path groups captions into paragraphs, a scrape never needs it.
 */
export async function fetchFromProvider(
  endpoint: URL,
  joinCues: (cues: string[]) => string,
): Promise<ProviderContent | null> {
  // Throws rather than returning null: there is no second route to fall back
  // to, so an unset key is a configuration fault, not "the provider had
  // nothing". Null is reserved for "the provider answered, with nothing in it".
  const apiKey = requireProviderApiKey();

  const res = await providerRequest(endpoint, apiKey);
  if (!res.ok) {
    return refuseOnProviderStatus(res.status, (await res.text()).slice(0, 300));
  }

  const payload = await res.json().catch(() => null);

  // 202 means the work was queued rather than done. The job id is read off the
  // body rather than off the status alone, so a provider that answers 200 with
  // a job id is handled too.
  const jobId = (payload as { jobId?: unknown } | null)?.jobId;
  if (typeof jobId === "string" && jobId.length > 0) {
    return await awaitProviderJob(endpoint, jobId, apiKey, joinCues);
  }

  return extractProviderContent(payload, joinCues);
}
