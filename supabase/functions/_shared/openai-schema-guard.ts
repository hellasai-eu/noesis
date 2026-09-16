// OpenAI structured-output (strict JSON-schema) guard.
//
// OpenAI's strict `response_format` mode only accepts a subset of JSON Schema.
// Sending a forbidden keyword makes the API 400 the whole request — see #877,
// where `uniqueItems` on `correct_answers` silently broke student question
// generation because the handler tests mock OpenAI and never exercise the 400.
//
// The keywords below are ones OpenAI strict mode rejects AND that none of our
// generator schemas legitimately use. Range/length constraints that OpenAI
// *does* accept (minItems, maxItems, minimum, maximum, enum, …) are absent on
// purpose. Enforce uniqueness (and any other rejected constraint) in post-parse
// validation instead of in the schema.
export const OPENAI_FORBIDDEN_SCHEMA_KEYWORDS = [
  "uniqueItems",
  "contains",
  "minContains",
  "maxContains",
  "patternProperties",
  "unevaluatedItems",
  "unevaluatedProperties",
  "propertyNames",
  "minProperties",
  "maxProperties",
  "dependentSchemas",
] as const;

/**
 * Recursively walk a JSON-schema value and collect the JSON paths at which an
 * OpenAI-forbidden keyword appears. An empty array means the schema is safe to
 * send to OpenAI strict mode.
 */
export function findForbiddenSchemaKeywords(
  schema: unknown,
  path = "$",
): string[] {
  const hits: string[] = [];

  if (Array.isArray(schema)) {
    schema.forEach((item, i) => {
      hits.push(...findForbiddenSchemaKeywords(item, `${path}[${i}]`));
    });
    return hits;
  }

  if (schema && typeof schema === "object") {
    for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
      const childPath = `${path}.${key}`;
      if ((OPENAI_FORBIDDEN_SCHEMA_KEYWORDS as readonly string[]).includes(key)) {
        hits.push(childPath);
      }
      hits.push(...findForbiddenSchemaKeywords(value, childPath));
    }
  }

  return hits;
}

/**
 * Replace comments and string/template-literal bodies with whitespace so a later
 * key-scan can't match forbidden-keyword *text* that merely appears inside a
 * comment or a string value (e.g. `description: "… array contains …"`). A tiny
 * hand-rolled scanner is used rather than regexes so that `//` inside a string
 * and a quote inside a comment are each handled correctly.
 *
 * Exception: a string literal whose entire content is exactly a forbidden
 * keyword is preserved (as `"keyword"`) so genuine *quoted object keys* such as
 * `"uniqueItems":` remain detectable.
 */
function stripCommentsAndStrings(source: string): string {
  const forbidden = OPENAI_FORBIDDEN_SCHEMA_KEYWORDS as readonly string[];
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];

    // Line comment: `// … EOL`
    if (c === "/" && next === "/") {
      i += 2;
      while (i < n && source[i] !== "\n") i++;
      continue;
    }
    // Block comment: `/* … */`
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    // String / template literal — capture the body, honoring escapes.
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      let body = "";
      i++;
      while (i < n && source[i] !== quote) {
        if (source[i] === "\\" && i + 1 < n) {
          body += source[i] + source[i + 1];
          i += 2;
          continue;
        }
        body += source[i];
        i++;
      }
      i++; // consume closing quote
      // Keep exact-keyword contents so quoted object keys stay detectable;
      // otherwise drop the body entirely so its prose can't false-positive.
      out += forbidden.includes(body) ? `"${body}"` : " ";
      continue;
    }

    out += c;
    i++;
  }
  return out;
}

/**
 * Scan raw handler/index source for OpenAI-forbidden schema keywords used as
 * object keys (e.g. `uniqueItems: true`). This complements
 * {@link findForbiddenSchemaKeywords}: many generator schemas are module- or
 * function-local and never exported, so a source crawl is the only way to guard
 * *every* generator (including future ones) without importing each constant.
 *
 * Comments and string-literal bodies are stripped and only the `keyword:`
 * (object-key) form is matched, so prose mentions in descriptions/comments/error
 * strings (e.g. the word "contains") do not produce false positives.
 */
export function findForbiddenKeywordsInSource(source: string): string[] {
  const stripped = stripCommentsAndStrings(source);
  const hits: string[] = [];
  for (const keyword of OPENAI_FORBIDDEN_SCHEMA_KEYWORDS) {
    // Match the keyword used as an object key: `keyword:` or `"keyword":`.
    const re = new RegExp(`(?:^|[^\\w.$])["']?${keyword}["']?\\s*:`, "m");
    if (re.test(stripped)) hits.push(keyword);
  }
  return hits;
}
