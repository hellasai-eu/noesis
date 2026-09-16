/**
 * Fetch an ordinary web page and return it as Markdown.
 *
 * One route, the content provider's scrape endpoint. There used to be a second:
 * fetch the page from here and run a small regex converter over the HTML, so
 * that a page could still be imported with no API key. It is gone on purpose.
 * Extracting the *article* from a modern page — past the nav, the cookie
 * banner, the related-articles rail — is the whole difficulty, and a regex
 * never did it as well; and fetching arbitrary user-supplied URLs from inside
 * our infrastructure is a liability (see `assertPublicHttpUrl`) that buying a
 * scrape does away with entirely.
 */

import { logger } from "./logger.ts";
import {
  ContentImportError,
  DEFAULT_SCRAPE_API_URL,
  fetchFromProvider,
} from "./import-provider.ts";

export interface WebContent {
  url: string;
  title: string | null;
  /** The page as Markdown. */
  markdown: string;
  language: string | null;
}

/**
 * Hostnames the importer must never be talked into reaching for.
 *
 * The provider does the fetching now, which removes the SSRF sink this list was
 * written for — Supadata reaching `http://localhost` reaches its own localhost,
 * not ours. The check is kept for two reasons that survive the change: a link
 * pointing at a private address is a mistake worth naming immediately instead of
 * spending a provider credit to have it fail, and it keeps the refusal in place
 * should anything here ever fetch a page itself again.
 */
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "instance-data",
]);

const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

function isPrivateIPv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => Number(part));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = octets;
  return (
    a === 0 || // "this network"
    a === 10 || // private
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local, incl. cloud metadata at 169.254.169.254
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) || // private
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    a >= 224 // multicast and reserved
  );
}

function isPrivateIPv6(host: string): boolean {
  const address = host.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    address === "::1" ||
    address === "::" ||
    address.startsWith("fc") || // unique local
    address.startsWith("fd") ||
    address.startsWith("fe80") || // link-local
    address.startsWith("::ffff:") // IPv4-mapped, e.g. ::ffff:169.254.169.254
  );
}

/**
 * Accept only a public http(s) URL, or throw.
 *
 * Exported for the tests, which are the point: every entry in the blocked list
 * is a URL somebody could paste into the import dialog.
 */
export function assertPublicHttpUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ContentImportError("That is not a valid link.", 400);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ContentImportError("Only http and https links can be imported.", 400);
  }
  // Credentials in the URL are never needed for a public page and are a way to
  // aim an authenticated request at an internal service.
  if (parsed.username || parsed.password) {
    throw new ContentImportError("Links with embedded credentials cannot be imported.", 400);
  }

  const host = parsed.hostname.toLowerCase();
  if (
    BLOCKED_HOSTNAMES.has(host) ||
    BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix)) ||
    isPrivateIPv4(host) ||
    isPrivateIPv6(host)
  ) {
    logger.warn("Refused to import a non-public host", { host });
    throw new ContentImportError("That link points somewhere we cannot fetch.", 400);
  }

  return parsed;
}

/**
 * Fetch a web page as Markdown.
 *
 * `language` is the course's own, passed to the provider so a page it can
 * serve in several languages comes back in the one the class is taught in.
 */
export async function fetchWebContentAsMarkdown(
  rawUrl: string,
  language?: string | null,
): Promise<WebContent> {
  const url = assertPublicHttpUrl(rawUrl);

  const endpoint = new URL(
    Deno.env.get("CONTENT_SCRAPE_API_URL") || DEFAULT_SCRAPE_API_URL,
  );
  endpoint.searchParams.set("url", url.toString());
  if (language) endpoint.searchParams.set("lang", language);

  // A cue array never comes back from a scrape; the joiner is required by the
  // shared signature and simply concatenates.
  const scraped = await fetchFromProvider(endpoint, (cues) => cues.join("\n\n"));

  if (!scraped?.text) {
    throw new ContentImportError(
      "Could not read that page. It may be unreachable, it may require signing in, " +
        "or it may have no readable text.",
    );
  }

  return {
    url: url.toString(),
    title: scraped.title ?? null,
    markdown: scraped.text,
    language: scraped.language ?? language ?? null,
  };
}
