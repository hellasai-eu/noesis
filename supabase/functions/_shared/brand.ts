/**
 * The product identity for edge functions — the backend half of the
 * deployment overlay.
 *
 * The frontend reads its brand from `deployment/` at build time. Edge
 * functions cannot: they are a separate Deno runtime, deployed separately,
 * with no access to that directory. So the same few facts arrive here as
 * environment variables, declared in `supabase/config.toml` under
 * `[edge_runtime.secrets]` and supplied by whichever repository does the
 * hosting.
 *
 * That is two places for one product name, which is a drift risk rather than a
 * design preference. `npm run brand:env` exists to close it: it derives the
 * `supabase secrets set` line from the overlay's own `brand.meta.json`, so the
 * name in an invitation email comes from the same file as the name in the page
 * title.
 *
 * Read lazily rather than captured at module load, so a test can set an
 * environment variable and see it take effect. The values are cheap to read
 * and these are not hot paths.
 */

/** The literal an unconfigured deployment falls back to, matching the frontend's. */
const DEFAULT_NAME = "Study Platform";

export interface EdgeBrand {
  /** Product name, for email copy and subject lines. */
  name: string;
  /**
   * Footer line under the copyright. `null` omits it — an unconfigured
   * deployment should not claim a slogan it has not chosen.
   */
  tagline: string | null;
  /**
   * The Resend `from` header, already formatted as `Name <address>`, or
   * `null` when no sending address is configured.
   *
   * `null` is not an error to paper over: without a verified sending domain
   * there is no honest address to send as, and mailing people as somebody
   * else's domain is worse than not mailing them. Every caller has a
   * no-send path already — security notices warn and return false, the
   * invitation functions return an error — so they use it.
   */
  from: string | null;
  /** Where contact-form submissions go. `null` disables the operator copy. */
  contactRecipient: string | null;
  /**
   * Absolute base URL of the deployed app, used to build links in emails
   * whose recipient is not the caller.
   *
   * `null` when unset or unusable. Callers must treat that as "no link"
   * rather than substituting something — see `signInUrl`.
   */
  appUrl: string | null;
  /**
   * The sign-in link for security emails, derived from `appUrl`.
   *
   * Deliberately NOT built from the request's `Origin` (#1232): `Origin` is a
   * request header, honest from a browser and arbitrary from a direct HTTP
   * call. These are security emails whose recipient is often not the caller,
   * so letting request metadata choose the link would let an institution
   * admin mail a genuine, correctly-branded security notice pointing at a site
   * of their choosing. An operator-set environment variable is not request
   * metadata, so it is safe where `Origin` is not.
   */
  signInUrl: string | null;
  /** The AI tutor's persona name in prompts. Defaults to "<name> Tutor". */
  tutorName: string;
}

/** Empty and whitespace-only are treated as unset, not as a value. */
function env(name: string): string | null {
  const value = Deno.env.get(name);
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Validates an operator-supplied absolute URL.
 *
 * Scheme-checked rather than merely parsed: these values end up as `href`s in
 * email that people are primed to click, and `javascript:` and `data:` parse
 * perfectly well as URLs. A bad value yields `null` — no link — instead of a
 * link somewhere unexpected.
 */
function absoluteHttpUrl(value: string | null): string | null {
  if (value === null) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  // Normalise away a trailing slash so callers can append a path safely.
  return parsed.origin + parsed.pathname.replace(/\/$/, "");
}

export function edgeBrand(): EdgeBrand {
  const name = env("BRAND_NAME") ?? DEFAULT_NAME;
  const fromAddress = env("BRAND_FROM_EMAIL");
  const appUrl = absoluteHttpUrl(env("BRAND_APP_URL"));

  return {
    name,
    tagline: env("BRAND_TAGLINE"),
    // Resend accepts `Name <address>`. The display name is operator-set, and a
    // stray angle bracket or comma in it would corrupt the header, so strip
    // the characters that delimit one.
    from: fromAddress ? `${name.replace(/[<>,;"]/g, "")} <${fromAddress}>` : null,
    contactRecipient: env("BRAND_CONTACT_EMAIL"),
    appUrl,
    signInUrl: appUrl ? `${appUrl}/auth` : null,
    tutorName: env("BRAND_TUTOR_NAME") ?? `${name} Tutor`,
  };
}

/**
 * The shared email footer, so several templates do not each decide how to
 * write a copyright line.
 */
export function emailFooterText(brand: EdgeBrand = edgeBrand()): string {
  const copyright = `© ${new Date().getFullYear()} ${brand.name}.`;
  return brand.tagline ? `${copyright} ${brand.tagline}` : copyright;
}

/**
 * A single glyph for the tile at the top of an email.
 *
 * The templates used to hardcode a Greek nu — a monogram for one particular
 * product name, and meaningless under any other. Emails cannot carry the
 * overlay's logo (there is no asset pipeline here and remote images are
 * blocked by most clients by default), so the brand's own first letter is the
 * honest substitute.
 *
 * Uses the first letter of the first *word*, so "Acme Learn" gives "A".
 * Falls back to "·" for a name that starts with something uncased, which is
 * better than an empty tile.
 */
export function monogram(name: string): string {
  const first = name.trim().charAt(0);
  if (first === "") return "·";
  const upper = first.toLocaleUpperCase();
  // A digit or punctuation uppercases to itself; that is fine, an empty
  // string is not.
  return upper === "" ? "·" : upper;
}
