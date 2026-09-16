/**
 * #1019 — `loadGuideContext` must accept a guide whose source is an "other"
 * material: a standalone PDF that is never split into chapters, so there are no
 * `study_guide_source_chapters` rows and no `material_chapters` rows at all.
 *
 * Before #1019 an empty chapter set was a hard error, which meant the
 * whole-material `openai_file_id` fallback further down could never be reached
 * from that path. The real requirement is having at least one file id, from
 * either source — that is what these tests pin.
 */
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { loadGuideContext } from "../study-guide-context.ts";

interface Rows {
  study_guides: Record<string, unknown>;
  courses: Record<string, unknown>;
  study_guide_source_chapters: Array<{ chapter_id: string }>;
  material_chapters: Array<Record<string, unknown>>;
  course_materials: Record<string, unknown>;
}

/**
 * Minimal PostgREST-shaped stub. Only the call shapes `loadGuideContext`
 * actually makes are supported; anything else surfaces as an obvious failure
 * rather than a silent empty result.
 */
function fakeSupabase(rows: Rows) {
  return {
    from(table: keyof Rows) {
      const chain = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        // Not a terminator in PostgREST: the builder stays chainable and is
        // awaited later, which is exactly how `loadGuideContext` uses it.
        order: () => chain,
        single: () =>
          Promise.resolve({ data: rows[table] as unknown, error: null }),
        maybeSingle: () =>
          Promise.resolve({ data: rows[table] as unknown, error: null }),
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve(resolve({ data: rows[table], error: null })),
      } as Record<string, unknown>;
      return chain;
    },
    // `getEffectiveLanguage` reads the course; a plain rpc stub keeps it happy.
    rpc: () => Promise.resolve({ data: null, error: null }),
  };
}

function baseRows(overrides: Partial<Rows> = {}): Rows {
  return {
    study_guides: {
      id: "guide-1",
      course_id: "course-1",
      material_id: "mat-other",
      title: "Course overview",
      brief: null,
      target_piece_count: 3,
      target_questions_per_piece: 5,
    },
    courses: { title: "Physics", institution_id: "inst-1", language: "en" },
    study_guide_source_chapters: [],
    material_chapters: [],
    course_materials: {
      title: "Syllabus",
      file_name: "syllabus.pdf",
      openai_file_id: "file-syllabus",
    },
    ...overrides,
  };
}

Deno.test("loadGuideContext: a chapterless 'other' material attaches the whole document", async () => {
  const ctx = await loadGuideContext(fakeSupabase(baseRows()), "guide-1");

  assertEquals(ctx.chapters, []);
  assertEquals(ctx.fileIds, ["file-syllabus"]);
  assertEquals(ctx.materialTitle, "Syllabus");
  // The prompt says "Chapters in scope:" unconditionally, so an empty list
  // would read as a bug to the model. Say what is actually attached instead.
  assertStringIncludes(ctx.chapterList, "whole document");
});

Deno.test("loadGuideContext: chapters still win when the material has them", async () => {
  const rows = baseRows({
    material_chapters: [
      { id: "ch-1", chapter_number: 1, title: "Heat", openai_file_id: "file-1" },
      { id: "ch-2", chapter_number: 2, title: "Entropy", openai_file_id: "file-2" },
    ],
  });

  const ctx = await loadGuideContext(fakeSupabase(rows), "guide-1");

  assertEquals(ctx.fileIds, ["file-1", "file-2"]);
  assertStringIncludes(ctx.chapterList, "1. Heat");
  assertStringIncludes(ctx.chapterList, "2. Entropy");
});

Deno.test("loadGuideContext: still fails when nothing at all can be attached", async () => {
  const rows = baseRows({
    course_materials: {
      title: "Syllabus",
      file_name: "syllabus.pdf",
      openai_file_id: null,
    },
  });

  await assertRejects(
    () => loadGuideContext(fakeSupabase(rows), "guide-1"),
    Error,
    "no OpenAI file ids",
  );
});
