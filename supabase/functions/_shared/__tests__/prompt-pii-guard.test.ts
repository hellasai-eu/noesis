// Guardrail test (issue #557): forbid student-identity variable placeholders
// in shared prompt templates. These variables historically carried a student's
// display name into the OpenAI request payload, which leaks PII outside the
// institution's data boundary. Personalization should use the student_id only.
//
// If a new prompt legitimately needs to refer to the student by an identifier,
// use {{student_id}} — that's explicitly allowed.
//
// ⚠️  SCOPE — this scans `_shared/prompts/*.ts` only.
//
//   The last OpenAI-hosted saved prompt was retired when
//   `generate-evaluation-timeline` moved its template in-repo, so there is no
//   longer a dashboard template outside this test's reach. If a `pmpt_` id is
//   ever wired into an edge function again, that template lives in the OpenAI
//   dashboard and CANNOT be scanned here — reinstate a manual-audit note and
//   check it against FORBIDDEN_PATTERNS below whenever a variable is added or
//   the pinned version is bumped. `no-hosted-saved-prompts` guards this.
//
//   Still out of reach either way: prompt text built inline in a handler
//   rather than declared in a prompt module.
//
//   Template scanning also cannot see the VALUES substituted into sanctioned
//   placeholders — {{group_audience_hint}} once carried the student's
//   full_name and student_admin_notes bodies to OpenAI with this guard green.
//   The substituted-values test below closes that class: it runs the real
//   value builder (buildStudentSnapshot) against sentinel PII and asserts
//   none of it survives into the hint.

import { assert, assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { buildStudentSnapshot } from "../student-snapshot.ts";

const PROMPTS_DIR = new URL("../prompts/", import.meta.url);

// Patterns banned because they have student-identity semantics in our prompt
// templates. Anchored to the {{ … }} delimiters so we do not accidentally
// match `{{student_id}}` or `{{student_summary}}`.
const FORBIDDEN_PATTERNS: RegExp[] = [
  /\{\{\s*student\s*\}\}/,
  /\{\{\s*student_name\s*\}\}/,
  /\{\{\s*full_name\s*\}\}/,
  /\{\{\s*name\s*\}\}/,
];

async function listPromptFiles(): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(PROMPTS_DIR)) {
    if (entry.isFile && entry.name.endsWith(".ts")) {
      files.push(entry.name);
    }
  }
  return files;
}

Deno.test("prompt-pii-guard: no shared prompt references a student-identity variable", async () => {
  const files = await listPromptFiles();
  assert(files.length > 0, "expected at least one shared prompt file");

  const violations: Array<{ file: string; pattern: string; line: number; text: string }> = [];

  for (const file of files) {
    const path = new URL(file, PROMPTS_DIR);
    const content = await Deno.readTextFile(path);
    const lines = content.split("\n");
    lines.forEach((text, idx) => {
      for (const pattern of FORBIDDEN_PATTERNS) {
        if (pattern.test(text)) {
          violations.push({ file, pattern: pattern.source, line: idx + 1, text: text.trim() });
        }
      }
    });
  }

  if (violations.length > 0) {
    const message = violations
      .map((v) => `  ${v.file}:${v.line} matches /${v.pattern}/ — "${v.text}"`)
      .join("\n");
    throw new Error(
      `Found ${violations.length} forbidden student-identity placeholder(s) in supabase/functions/_shared/prompts/. ` +
        `These ship a student's display name to OpenAI as PII. Use student_id instead, or rephrase the prompt to refer to "this student" generically.\n${message}`,
    );
  }
});

/**
 * The guard above can only scan templates that live in this repo. An OpenAI
 * Responses API *saved prompt* (`prompt: { id: "pmpt_…" }`) is stored in the
 * OpenAI dashboard: its variables, its text and its model are all invisible
 * here, so a `{{student}}` added there would ship a minor's name with nothing
 * in CI objecting.
 *
 * `generate-evaluation-timeline` was the last such caller. This test stops the
 * blind spot returning silently — if a saved prompt is genuinely wanted, the
 * failure is the prompt to also reinstate the manual-audit note at the top of
 * this file.
 */
/**
 * Substituted-values guard: the two tests above scan prompt *templates*, but
 * the audience hint is a runtime *value* substituted into the sanctioned
 * {{group_audience_hint}} placeholder by all five question-generation
 * functions. Feed the builder sentinel identities everywhere a query could
 * surface one and assert the hint that would cross to OpenAI carries no
 * student *identity*. Admin-note content is allowed to cross by design (it
 * is the pedagogical context the hint exists for, disclosed in the ROPA
 * §6.2 and the subprocessor list) — but only with every roster name
 * redacted, which is exactly what this test pins down.
 */
Deno.test("prompt-pii-guard: buildStudentSnapshot never substitutes a student identity into the audience hint", async () => {
  const SENTINEL_NAME = "Xanthippe Sentinelidou";
  const CLASSMATE_NAME = "Odysseas Classmatopoulos";
  const SENTINEL_NOTE =
    "SENTINEL-NOTE: Xanthippe has dyslexia, give concrete examples. Pairs well with Odysseas Classmatopoulos.";

  const empty = { data: [], error: null };
  // Minimal PostgREST stub covering the identity-bearing tables plus the
  // institution roster (profiles fetchAll).
  // deno-lint-ignore no-explicit-any
  const stub: any = {
    from(table: string) {
      // deno-lint-ignore no-explicit-any
      const api: any = {
        select: () => api,
        eq: () => api,
        in: () => api,
        order: () => api,
        limit: () => api,
        range: () => api,
        maybeSingle: () =>
          Promise.resolve(
            table === "profiles"
              ? { data: { full_name: SENTINEL_NAME, institution_id: "inst-1" }, error: null }
              : { data: null, error: null },
          ),
        then: (resolve: (v: unknown) => void) => {
          if (table === "student_admin_notes") {
            resolve({ data: [{ body: SENTINEL_NOTE, created_at: "2026-01-01" }], error: null });
          } else if (table === "profiles") {
            resolve({ data: [{ full_name: SENTINEL_NAME }, { full_name: CLASSMATE_NAME }], error: null });
          } else {
            resolve(empty);
          }
        },
      };
      return api;
    },
  };

  const snapshot = await buildStudentSnapshot(stub, "course-1", "stu-1");
  if (!snapshot) throw new Error("expected snapshot");

  // No student identity — target's or a classmate's — may cross.
  for (const fragment of ["Xanthippe", "Sentinelidou", "Odysseas", "Classmatopoulos"]) {
    assertEquals(
      snapshot.hint.includes(fragment),
      false,
      `student identity fragment "${fragment}" reached the OpenAI-bound audience hint:\n${snapshot.hint}`,
    );
  }
  // The redacted note content must still be there — if it vanishes, the
  // feature silently died and this guard is testing nothing.
  assert(snapshot.hint.includes("SENTINEL-NOTE"), "expected redacted admin-note content in the hint");
  assert(snapshot.hint.includes("[student]"), "expected redaction placeholder in the hint");
});

Deno.test("prompt-pii-guard: no handler delegates to an OpenAI-hosted saved prompt", async () => {
  const FUNCTIONS_DIR = new URL("../../", import.meta.url);
  const offenders: Array<{ file: string; line: number; text: string }> = [];

  async function walk(dir: URL): Promise<void> {
    for await (const entry of Deno.readDir(dir)) {
      const child = new URL(
        entry.isDirectory ? `${entry.name}/` : entry.name,
        dir,
      );
      if (entry.isDirectory) {
        // Skip this directory: the id below is quoted in prose, not called.
        if (entry.name === "__tests__") continue;
        await walk(child);
      } else if (entry.name.endsWith(".ts")) {
        const content = await Deno.readTextFile(child);
        content.split("\n").forEach((text, idx) => {
          if (/["']pmpt_[a-zA-Z0-9]+["']/.test(text)) {
            offenders.push({
              file: child.pathname.replace(FUNCTIONS_DIR.pathname, ""),
              line: idx + 1,
              text: text.trim(),
            });
          }
        });
      }
    }
  }

  await walk(FUNCTIONS_DIR);

  if (offenders.length > 0) {
    const message = offenders
      .map((o) => `  ${o.file}:${o.line} — "${o.text}"`)
      .join("\n");
    throw new Error(
      `Found ${offenders.length} OpenAI-hosted saved prompt reference(s). Their template, variables and model live in the ` +
        `OpenAI dashboard, so neither this PII guard nor prompt-cache-order.test.ts can see them. Move the template into ` +
        `supabase/functions/_shared/prompts/ — see generate-evaluation-timeline.ts for the shape.\n${message}`,
    );
  }
});
