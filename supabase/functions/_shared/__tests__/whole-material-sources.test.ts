/**
 * `fetchWholeMaterialSources` — the gate between a request's `materialIds` and
 * what actually gets attached to a generation prompt (#1019).
 *
 * The generators call this with ids straight out of the request body, so what
 * it refuses matters as much as what it returns.
 */
import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  fetchWholeMaterialSources,
  splitReturnedSourceIds,
  wholeMaterialPromptLines,
  type WholeMaterialSource,
} from "../whole-material-sources.ts";

const COURSE = "course-1";

// deno-lint-ignore no-explicit-any
function clientReturning(rows: unknown[], capture?: { ids?: unknown }): any {
  return {
    from: () => ({
      select: () => ({
        in: (_col: string, ids: unknown) => {
          if (capture) capture.ids = ids;
          return Promise.resolve({ data: rows, error: null });
        },
      }),
    }),
  };
}

const OTHER = {
  id: "mat-1",
  title: "Syllabus",
  file_name: "syllabus.pdf",
  course_id: COURSE,
  material_type: "other",
  openai_file_id: "file-1",
  page_count: 12,
  file_size: 2048,
};

Deno.test("fetchWholeMaterialSources: returns a synced 'other' material in this course", async () => {
  const sources = await fetchWholeMaterialSources(clientReturning([OTHER]), COURSE, ["mat-1"]);
  assertEquals(sources, [{
    id: "mat-1",
    title: "Syllabus",
    openaiFileId: "file-1",
    pageCount: 12,
    sizeBytes: 2048,
  }]);
});

Deno.test("fetchWholeMaterialSources: refuses a material from another course", async () => {
  // The id is well-formed and the material is a real "other" document — it just
  // is not this course's. Trusting the body here would attach another
  // institution's file to the prompt.
  const foreign = { ...OTHER, course_id: "course-2" };
  const sources = await fetchWholeMaterialSources(clientReturning([foreign]), COURSE, ["mat-1"]);
  assertEquals(sources, []);
});

Deno.test("fetchWholeMaterialSources: refuses a material that is not chapterless", async () => {
  // A textbook is generated from through its chapters. Taking it whole would
  // bypass the chapter selection and the page budget it exists to enforce.
  const textbook = { ...OTHER, material_type: "textbook" };
  const sources = await fetchWholeMaterialSources(clientReturning([textbook]), COURSE, ["mat-1"]);
  assertEquals(sources, []);
});

Deno.test("fetchWholeMaterialSources: drops a material that has not synced to OpenAI", async () => {
  // No file to attach, and unlike a chapter there is no extracted text to fall
  // back on — including it would send the model nothing.
  const unsynced = { ...OTHER, openai_file_id: null };
  const sources = await fetchWholeMaterialSources(clientReturning([unsynced]), COURSE, ["mat-1"]);
  assertEquals(sources, []);
});

Deno.test("fetchWholeMaterialSources: falls back to the file name when untitled", async () => {
  const untitled = { ...OTHER, title: null };
  const sources = await fetchWholeMaterialSources(clientReturning([untitled]), COURSE, ["mat-1"]);
  assertEquals(sources[0].title, "syllabus.pdf");
});

Deno.test("fetchWholeMaterialSources: no ids means no query and no sources", async () => {
  // The generators pass `materialIds` through unconditionally, so the common
  // chapters-only request must not cost a round trip.
  let queried = false;
  // deno-lint-ignore no-explicit-any
  const client: any = {
    from: () => {
      queried = true;
      return { select: () => ({ in: () => Promise.resolve({ data: [], error: null }) }) };
    },
  };
  assertEquals(await fetchWholeMaterialSources(client, COURSE, undefined), []);
  assertEquals(await fetchWholeMaterialSources(client, COURSE, []), []);
  assertEquals(queried, false);
});

Deno.test("fetchWholeMaterialSources: ignores non-string and duplicate ids", async () => {
  const capture: { ids?: unknown } = {};
  await fetchWholeMaterialSources(
    clientReturning([OTHER], capture),
    COURSE,
    ["mat-1", "mat-1", "", null, 7],
  );
  assertEquals(capture.ids, ["mat-1"]);
});

Deno.test("wholeMaterialPromptLines: tells the model to attribute by document id", async () => {
  // The prompts ask for a chapter id per question. A chapterless document is
  // attributed by its own id through the same `chapter_ids` channel; the line
  // must therefore carry the id and say where to put it.
  const line = wholeMaterialPromptLines([{
    id: "mat-1",
    title: "Syllabus",
    openaiFileId: "file-1",
    pageCount: 12,
    sizeBytes: 2048,
  }]);
  assertEquals(line.includes('"Syllabus"'), true);
  assertEquals(line.includes("mat-1"), true);
  assertEquals(line.includes("chapter_ids"), true);
  assertEquals(wholeMaterialPromptLines([]), "");
});

// ── splitReturnedSourceIds ──────────────────────────────────────────────────

function doc(id: string): WholeMaterialSource {
  return { id, title: id, openaiFileId: `file-${id}`, pageCount: 1, sizeBytes: 1 };
}

Deno.test("splitReturnedSourceIds: partitions returned ids into chapters and documents", () => {
  const out = splitReturnedSourceIds(
    ["ch-1", "mat-1", "bogus", "ch-1", "mat-1"],
    ["ch-1", "ch-2"],
    [doc("mat-1")],
    1,
  );
  assertEquals(out.chapterIds, ["ch-1"]);
  assertEquals(out.materialIds, ["mat-1"]);
});

Deno.test("splitReturnedSourceIds: chapters-only fallback pins the first chapter", () => {
  // Long-standing behavior: a chapters-only batch never leaves a question
  // unattributed.
  const out = splitReturnedSourceIds(["bogus"], ["ch-1", "ch-2"], [], 0);
  assertEquals(out.chapterIds, ["ch-1"]);
  assertEquals(out.materialIds, []);
});

Deno.test("splitReturnedSourceIds: mixed batch gets no fallback", () => {
  // Guessing between a chapter and a document would file the question under
  // material it may not have come from.
  const out = splitReturnedSourceIds([], ["ch-1"], [doc("mat-1")], 1);
  assertEquals(out.chapterIds, []);
  assertEquals(out.materialIds, []);
});

Deno.test("splitReturnedSourceIds: documents-only fallback pins the first document", () => {
  const out = splitReturnedSourceIds(undefined, [], [doc("mat-1"), doc("mat-2")], 2);
  assertEquals(out.chapterIds, []);
  assertEquals(out.materialIds, ["mat-1"]);
});

Deno.test("splitReturnedSourceIds: no fallback once the model attributed a document", () => {
  const out = splitReturnedSourceIds(["mat-2"], [], [doc("mat-1"), doc("mat-2")], 2);
  assertEquals(out.materialIds, ["mat-2"]);
});
