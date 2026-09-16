/**
 * Regression test: every edge function's index.ts must call serve() or Deno.serve().
 *
 * This catches the bug where a merge conflict resolution or refactor accidentally
 * drops the serve() call, causing the function to 504 on all requests (including
 * OPTIONS preflight) because Supabase's gateway can't reach the function worker.
 *
 * See: PR #256 broke extract-competencies by reverting index.ts to inline handler
 * without serve().
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

// Functions that use non-standard patterns (inline Deno.serve with handler defined in index.ts)
const EXCEPTIONS = new Set([
  "accept-invitation",      // uses Deno.serve(async (req) => { ... }) inline
  "export-data",            // uses Deno.serve(handler) without withLogging
  "extract-images-from-pdf", // uses serve(async (req) => { ... }) inline, no handler.ts
]);

Deno.test("all edge function index.ts files call serve()", async () => {
  const functionsDir = new URL("../../", import.meta.url).pathname;
  const missing: string[] = [];

  for await (const entry of Deno.readDir(functionsDir)) {
    if (!entry.isDirectory || entry.name.startsWith("_")) continue;

    const indexPath = `${functionsDir}${entry.name}/index.ts`;
    try {
      const content = await Deno.readTextFile(indexPath);

      if (EXCEPTIONS.has(entry.name)) continue;

      const hasServe = content.includes("serve(withLogging(") ||
                       content.includes("serve(handler)") ||
                       content.includes("Deno.serve(");

      if (!hasServe) {
        missing.push(entry.name);
      }
    } catch {
      // No index.ts — skip (e.g., _shared)
    }
  }

  assertEquals(
    missing,
    [],
    `These edge functions are missing serve() in index.ts — they will 504 on deploy:\n  ${missing.join("\n  ")}`,
  );
});

Deno.test("all edge function index.ts files that import handler also export nothing inline", async () => {
  const functionsDir = new URL("../../", import.meta.url).pathname;
  const problems: string[] = [];

  for await (const entry of Deno.readDir(functionsDir)) {
    if (!entry.isDirectory || entry.name.startsWith("_")) continue;
    if (EXCEPTIONS.has(entry.name)) continue;

    const indexPath = `${functionsDir}${entry.name}/index.ts`;
    const handlerPath = `${functionsDir}${entry.name}/handler.ts`;

    try {
      await Deno.stat(handlerPath); // handler.ts exists
    } catch {
      continue; // no handler.ts — function uses inline pattern, skip
    }

    try {
      const content = await Deno.readTextFile(indexPath);
      const lines = content.split("\n").filter(l => {
        const trimmed = l.trim();
        return trimmed && !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*");
      });

      // If handler.ts exists, index.ts should be small (imports + serve call)
      // A large index.ts with handler.ts means someone pasted the handler back inline
      if (lines.length > 15) {
        problems.push(`${entry.name}/index.ts has ${lines.length} non-empty lines but handler.ts exists — likely duplicate inline handler`);
      }
    } catch {
      // No index.ts
    }
  }

  assertEquals(
    problems,
    [],
    `Edge function index.ts files with duplicate handlers:\n  ${problems.join("\n  ")}`,
  );
});
