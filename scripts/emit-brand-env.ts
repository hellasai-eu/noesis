/**
 * Derives the edge functions' `BRAND_*` environment from the deployment
 * overlay, so the product name has one source rather than two.
 *
 *     npm run brand:env                # the `supabase secrets set` line
 *     npm run brand:env -- --dotenv    # KEY=value lines, for a .env file
 *
 * The frontend reads its brand from `deployment/brand.meta.json` at build
 * time. Edge functions cannot — they are a separate Deno runtime, deployed
 * separately, with no access to that directory — so the same few facts have to
 * be set as Supabase secrets (see `supabase/config.toml`).
 *
 * That is the drift this script exists to prevent: an operator who renames
 * their product in `brand.meta.json` and forgets the secrets ends up with one
 * name in the page title and another in every invitation email. Running this
 * means the two cannot disagree about anything it covers.
 *
 * It does NOT cover `BRAND_FROM_EMAIL`, and that is deliberate. A sending
 * address requires a verified domain at the mail provider, which is a
 * different decision from what the product is called, and guessing it from a
 * contact address would produce mail that silently fails to deliver.
 */

import { readFileSync } from "fs";
import path from "path";

import { resolveDeploymentDir } from "./deployment-dir.ts";

const root = path.resolve(import.meta.dirname, "..");
const deploymentDir = resolveDeploymentDir(root, process.env.NODE_ENV ?? "production");
const metaFile = path.join(deploymentDir, "brand.meta.json");

const args = new Set(process.argv.slice(2));
const asDotenv = args.has("--dotenv");

let meta: Record<string, unknown>;
try {
  meta = JSON.parse(readFileSync(metaFile, "utf8"));
} catch (error) {
  const code = (error as { code?: string }).code;
  if (code === "ENOENT") {
    process.stderr.write(
      `[brand] no ${metaFile}; nothing to derive. The edge functions will fall back to their defaults.\n`,
    );
    process.exit(0);
  }
  process.stderr.write(
    `[brand] ${metaFile} is not valid JSON: ${(error as Error).message}\n`,
  );
  process.exit(1);
}

const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

/**
 * Only the fields that genuinely mean the same thing on both sides.
 *
 * `canonicalUrl` is the app's own origin, which is exactly what an email's
 * sign-in link needs. `contactEmail` is the address a visitor is invited to
 * write to, which is where the contact form should deliver.
 */
const derived: Record<string, string | null> = {
  BRAND_NAME: str(meta.name),
  BRAND_APP_URL: str(meta.canonicalUrl),
  BRAND_CONTACT_EMAIL: str(meta.contactEmail),
};

const present = Object.entries(derived).filter(([, value]) => value !== null) as [
  string,
  string,
][];

const missing = Object.entries(derived)
  .filter(([, value]) => value === null)
  .map(([key]) => key);

/** Single-quote for a POSIX shell: wrap, and close-escape-reopen for quotes. */
const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * A field the overlay no longer sets has to be *cleared*, not merely omitted.
 *
 * `supabase secrets set` is additive: omitting a variable leaves whatever was
 * set before. So an operator who removes `canonicalUrl` and reruns this would
 * keep the old `BRAND_APP_URL`, and their security emails would go on linking
 * to the previous deployment — the opposite of the documented unset
 * behaviour, and silent.
 *
 * Emitted as an explicit empty assignment rather than `secrets unset`, because
 * `edgeBrand()` already treats blank as unset and one `set` line is a single
 * atomic change an operator can paste and verify.
 */
if (asDotenv) {
  for (const [key, value] of present) process.stdout.write(`${key}=${value}\n`);
  for (const key of missing) process.stdout.write(`${key}=\n`);
} else {
  const pairs = [
    ...present.map(([key, value]) => `${key}=${shellQuote(value)}`),
    ...missing.map((key) => `${key}=''`),
  ];
  process.stdout.write(`supabase secrets set ${pairs.join(" ")}\n`);
}

// Guidance on stderr, so stdout stays pipeable.
process.stderr.write(
  `[brand] derived ${present.map(([key]) => key).join(", ")} from ` +
    `${path.relative(root, metaFile)}\n`,
);
if (missing.length > 0) {
  process.stderr.write(
    `[brand] not set in the overlay, so emitted empty to clear any previous ` +
      `value: ${missing.join(", ")}\n`,
  );
}
process.stderr.write(
  `[brand] set separately — BRAND_FROM_EMAIL (needs a verified sending domain), ` +
    `and optionally BRAND_TAGLINE and BRAND_TUTOR_NAME.\n`,
);
