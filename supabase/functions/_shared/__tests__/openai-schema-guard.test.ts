import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  findForbiddenKeywordsInSource,
  findForbiddenSchemaKeywords,
  OPENAI_FORBIDDEN_SCHEMA_KEYWORDS,
} from "../openai-schema-guard.ts";
import { MCQ_OUTPUT_SCHEMA as STUDENT_MCQ_SCHEMA } from "../../generate-student-questions/handler.ts";
import { MCQ_OUTPUT_SCHEMA as INSTRUCTOR_MCQ_SCHEMA } from "../../generate-questions/handler.ts";

// #877 — OpenAI strict structured-output mode 400s on forbidden JSON-schema
// keywords (e.g. `uniqueItems`). The handler tests mock OpenAI, so the 400 is
// never exercised; this guard checks the real generator schemas statically.

Deno.test("openai-schema-guard: detects uniqueItems anywhere in a schema", () => {
  const schema = {
    type: "object",
    properties: {
      correct_answers: {
        type: "array",
        items: { type: "integer" },
        uniqueItems: true,
      },
    },
  };
  const hits = findForbiddenSchemaKeywords(schema);
  assertEquals(hits, ["$.properties.correct_answers.uniqueItems"]);
});

Deno.test("openai-schema-guard: passes a clean schema with allowed constraints", () => {
  const schema = {
    type: "object",
    properties: {
      correct_answers: {
        type: "array",
        items: { type: "integer", minimum: 0, maximum: 3 },
        minItems: 1,
        maxItems: 3,
      },
      difficulty: { type: "string", enum: ["easy", "medium", "hard"] },
    },
    required: ["correct_answers"],
    additionalProperties: false,
  };
  assertEquals(findForbiddenSchemaKeywords(schema), []);
});

Deno.test("openai-schema-guard: flags every forbidden keyword", () => {
  for (const kw of OPENAI_FORBIDDEN_SCHEMA_KEYWORDS) {
    const schema = { type: "object", [kw]: true };
    assertEquals(findForbiddenSchemaKeywords(schema), [`$.${kw}`]);
  }
});

Deno.test("generate-student-questions: MCQ schema has no OpenAI-forbidden keywords (#877)", () => {
  assertEquals(findForbiddenSchemaKeywords(STUDENT_MCQ_SCHEMA), []);
});

Deno.test("generate-questions: MCQ schema has no OpenAI-forbidden keywords (#877)", () => {
  assertEquals(findForbiddenSchemaKeywords(INSTRUCTOR_MCQ_SCHEMA), []);
});

Deno.test("findForbiddenKeywordsInSource: flags a keyword used as an object key", () => {
  const src = `const SCHEMA = { items: { type: "integer" }, uniqueItems: true };`;
  assertEquals(findForbiddenKeywordsInSource(src), ["uniqueItems"]);
});

Deno.test("findForbiddenKeywordsInSource: quoted object keys are flagged", () => {
  const src = `const SCHEMA = { "uniqueItems": true };`;
  assertEquals(findForbiddenKeywordsInSource(src), ["uniqueItems"]);
});

Deno.test("findForbiddenKeywordsInSource: ignores keywords in comments and prose", () => {
  const src = `
    // uniqueItems is intentionally omitted — OpenAI strict mode rejects it.
    /* also not here: patternProperties */
    const SCHEMA = {
      description: "The list contains only allowed values; minProperties style",
      minItems: 1,
      maxItems: 3,
    };
  `;
  assertEquals(findForbiddenKeywordsInSource(src), []);
});

Deno.test("findForbiddenKeywordsInSource: keyword text inside a string value is not a key", () => {
  // Prose that happens to contain `contains:` inside a string literal must not
  // be mistaken for an object key (greptile review on #870).
  const src = `const SCHEMA = {
    description: "Array contains: the selected answer ids",
    error: 'uniqueItems: enforced in post-parse validation, not here',
    template: \`patternProperties: none allowed\`,
    minItems: 1,
  };`;
  assertEquals(findForbiddenKeywordsInSource(src), []);
});

Deno.test("findForbiddenKeywordsInSource: a real quoted key still flags even alongside string prose", () => {
  const src = `const SCHEMA = {
    description: "the array contains only allowed values",
    "uniqueItems": true,
  };`;
  assertEquals(findForbiddenKeywordsInSource(src), ["uniqueItems"]);
});

Deno.test("findForbiddenKeywordsInSource: would have caught the pre-#877 schema", () => {
  // The exact shape that shipped the #877 400: uniqueItems on correct_answers.
  const preFix = `
    correct_answers: {
      type: "array",
      items: { type: "integer", minimum: 0, maximum: 3 },
      minItems: 1,
      uniqueItems: true,
    },
  `;
  assertEquals(findForbiddenKeywordsInSource(preFix), ["uniqueItems"]);
});

// ── Comprehensive crawl: EVERY generator/AI structured-output schema ──────────
// Most generator schemas are module- or function-local and never exported, so a
// static source crawl is the only way to guard *every* generator (incl. future
// ones) against forbidden keywords. Fails, naming the file + keyword, if any
// handler/index source uses one. (#870, motivated by #877.)
async function collectSchemaSourceFiles(dir: URL): Promise<URL[]> {
  const files: URL[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const child = new URL(`${entry.name}${entry.isDirectory ? "/" : ""}`, dir);
    if (entry.isDirectory) {
      if (entry.name === "__tests__") continue; // tests intentionally mention the keywords
      files.push(...await collectSchemaSourceFiles(child));
    } else if (entry.name.endsWith(".ts")) {
      files.push(child);
    }
  }
  return files;
}

Deno.test("openai-schema-guard: no generator schema uses an OpenAI-forbidden keyword (#870)", async () => {
  const functionsDir = new URL("../../", import.meta.url); // supabase/functions/
  const guardModule = new URL("../openai-schema-guard.ts", import.meta.url).href;
  const files = await collectSchemaSourceFiles(functionsDir);

  const offenders: string[] = [];
  let scannedSchemaFiles = 0;
  for (const file of files) {
    if (file.href === guardModule) continue; // the guard lists the keywords itself
    const source = await Deno.readTextFile(file);
    // Only files that actually define a structured-output schema are relevant.
    if (!/strict:\s*true|structuredOutput|response_format/.test(source)) continue;
    scannedSchemaFiles++;
    for (const kw of findForbiddenKeywordsInSource(source)) {
      offenders.push(`${file.pathname.split("/functions/")[1]}: ${kw}`);
    }
  }

  // Sanity: the crawl must have found the real schemas, not silently matched none.
  assertEquals(
    scannedSchemaFiles > 5,
    true,
    `expected to scan multiple schema files, scanned ${scannedSchemaFiles}`,
  );
  assertEquals(
    offenders,
    [],
    `OpenAI strict mode rejects these; enforce in post-parse validation instead:\n${offenders.join("\n")}`,
  );
});
