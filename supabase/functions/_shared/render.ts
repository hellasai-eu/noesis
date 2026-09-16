/**
 * Prompt template rendering.
 *
 * Replaces `{{placeholder}}` in a template with supplied values, and fails loudly
 * on the three ways that silently goes wrong:
 *
 *   1. A placeholder with no value — the literal `{{chapter_content}}` ships to
 *      OpenAI, which answers something plausible about nothing. No error, full
 *      token cost, wrong output.
 *   2. A value with no placeholder — the other half of a rename. The data the
 *      caller carefully assembled never reaches the model.
 *   3. `null` / `undefined` — interpolates as the string "undefined".
 *
 * Substitution is SINGLE-PASS. The previous implementation reduced over the
 * variables calling `replaceAll` once per key, which meant a value substituted
 * early was itself scanned for later keys: an instructor typing
 * `{{past_questions}}` into the special-instructions field would have had it
 * expanded on a later iteration. Values are data and are never re-scanned.
 */

/** A value that may be substituted into a template. */
export type RenderValue = string | number | boolean;

export interface RenderOptions {
  /**
   * Template name used in error messages. Worth passing — "MCQ_USER_PROMPT" is
   * a far better error than a 6 KB string.
   */
  name?: string;
  /**
   * Placeholders permitted to survive unsubstituted. Use only where a template
   * is deliberately rendered in stages; a conditionally-empty section should be
   * passed as `""`, not listed here.
   */
  optional?: readonly string[];
  /**
   * Leave every unmatched placeholder in place instead of throwing.
   *
   * For the generic `promptText` path in `openai-client.ts`, which renders
   * arbitrary prompts: fill-gaps questions use `{{1}}`, `{{2}}`, `{{N}}` as
   * cloze gap markers, and prompts that explain that syntax to the model must
   * emit those braces literally. Distinguishing a marker from a forgotten
   * variable is not possible there.
   *
   * The unused-variable check stays on regardless — a value the template never
   * uses is unambiguously a bug, whatever the braces mean.
   */
  allowUnmatched?: boolean;
}

/** Matches `{{name}}`, tolerating inner whitespace. */
const PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/g;

export class RenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RenderError";
  }
}

/** Distinct placeholder names appearing in `template`, in order of first use. */
export function placeholdersIn(template: string): string[] {
  const seen = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER)) seen.add(match[1]);
  return [...seen];
}

/**
 * Render `template`, substituting every `{{placeholder}}` from `vars`.
 *
 * @throws RenderError if a placeholder has no value, a value has no placeholder,
 * or any value is `null`/`undefined`.
 */
export function render(
  template: string,
  vars: Record<string, RenderValue | null | undefined>,
  options: RenderOptions = {},
): string {
  const label = options.name ? `${options.name}: ` : "";
  const optional = new Set(options.optional ?? []);

  const nullish = Object.keys(vars).filter((k) => vars[k] === null || vars[k] === undefined);
  if (nullish.length > 0) {
    throw new RenderError(
      `${label}null/undefined value for ${nullish.join(", ")}. ` +
        `Pass "" for an intentionally empty section — interpolating undefined ` +
        `sends the literal text "undefined" to the model.`,
    );
  }

  const used = new Set<string>();
  const missing = new Set<string>();

  // One pass over the template. Substituted values are never re-scanned, so a
  // value containing `{{...}}` is emitted verbatim rather than expanded.
  const out = template.replace(PLACEHOLDER, (whole, key: string) => {
    if (Object.hasOwn(vars, key)) {
      used.add(key);
      return String(vars[key]);
    }
    if (optional.has(key)) return whole;
    missing.add(key);
    return whole;
  });

  if (missing.size > 0 && !options.allowUnmatched) {
    throw new RenderError(
      `${label}no value supplied for ${[...missing].join(", ")}. ` +
        `The placeholder would have been sent to the model literally.`,
    );
  }

  const unused = Object.keys(vars).filter((k) => !used.has(k));
  if (unused.length > 0) {
    throw new RenderError(
      `${label}value supplied for ${unused.join(", ")}, which the template does not use. ` +
        `Usually a renamed or misspelled placeholder — the value never reaches the model.`,
    );
  }

  return out;
}

/**
 * Render several templates from one shared variable bag.
 *
 * A single `render` call rejects any variable the template does not use, which
 * is right when the bag was built for that template — but a caller that feeds
 * one bag to a system prompt and a user prompt has each template using only a
 * subset. Validating them together keeps both checks intact: every placeholder
 * across all templates must have a value, and every value must be used by at
 * least one template, so a misspelled key is still caught.
 *
 * @throws RenderError under the same conditions as `render`, judged across the set.
 */
export function renderEach<K extends string>(
  templates: Record<K, string>,
  vars: Record<string, RenderValue | null | undefined>,
  options: RenderOptions = {},
): Record<K, string> {
  const label = options.name ? `${options.name}: ` : "";
  const entries = Object.entries(templates) as Array<[K, string]>;

  // Per-template rendering with the unused-variable check deferred to the union.
  const out = {} as Record<K, string>;
  const usedAcross = new Set<string>();

  for (const [key, template] of entries) {
    const subset = Object.fromEntries(
      Object.entries(vars).filter(([name]) => placeholdersIn(template).includes(name)),
    );
    out[key] = render(template, subset, {
      ...options,
      name: options.name ? `${options.name}.${key}` : key,
    });
    for (const name of Object.keys(subset)) usedAcross.add(name);
  }

  const unused = Object.keys(vars).filter((k) => !usedAcross.has(k));
  if (unused.length > 0) {
    throw new RenderError(
      `${label}value supplied for ${unused.join(", ")}, which none of ` +
        `${entries.map(([k]) => k).join(", ")} uses. ` +
        `Usually a renamed or misspelled placeholder — the value never reaches the model.`,
    );
  }

  return out;
}
