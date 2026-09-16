/**
 * Study guides as question-generation sources: id normalization, the
 * completeness rule that gates them, the prompt text builders, and the
 * fetch helper's refusal paths (missing guide, incomplete guide).
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  fetchStudyGuideSources,
  guideIncompleteReason,
  MIN_GUIDE_THEORY_CHARS,
  normalizeStudyGuideIds,
  studyGuidePromptLines,
  studyGuideTheoryBlocks,
  theoryHtmlAsText,
  type StudyGuideSource,
} from "../study-guide-sources.ts";

Deno.test("normalizeStudyGuideIds: non-arrays and junk entries", () => {
  assertEquals(normalizeStudyGuideIds(undefined), []);
  assertEquals(normalizeStudyGuideIds("g-1"), []);
  assertEquals(normalizeStudyGuideIds([1, "", null, "g-1", "g-1", "g-2"]), ["g-1", "g-2"]);
});

Deno.test("theoryHtmlAsText: strips tags and collapses whitespace", () => {
  assertEquals(
    theoryHtmlAsText("<h2>Cells</h2><p>The&nbsp;cell   is <b>small</b>.</p>"),
    "Cells The cell is small .",
  );
  assertEquals(theoryHtmlAsText(null), "");
});

Deno.test("guideIncompleteReason: no pieces", () => {
  assertEquals(guideIncompleteReason([]), "it has no pieces");
});

Deno.test("guideIncompleteReason: theory reported before questions", () => {
  const reason = guideIncompleteReason([
    { theoryTextLength: 0, hasQuestions: false },
    { theoryTextLength: MIN_GUIDE_THEORY_CHARS, hasQuestions: true },
  ]);
  assertEquals(reason, "1 of 2 pieces have no theory");
});

Deno.test("guideIncompleteReason: questions missing", () => {
  const reason = guideIncompleteReason([
    { theoryTextLength: 100, hasQuestions: false },
    { theoryTextLength: 100, hasQuestions: true },
  ]);
  assertEquals(reason, "1 of 2 pieces have no questions");
});

Deno.test("guideIncompleteReason: complete guide passes", () => {
  assertEquals(
    guideIncompleteReason([{ theoryTextLength: MIN_GUIDE_THEORY_CHARS, hasQuestions: true }]),
    null,
  );
});

const SOURCE: StudyGuideSource = {
  id: "g-1",
  title: "Forces",
  sections: [
    { pieceTitle: "Gravity", text: "Things fall." },
    { pieceTitle: "Friction", text: "Things stop." },
  ],
  askedQuestions: ["What falls?"],
  sourceChapterIds: ["ch-1"],
  sourceMaterialId: null,
};

Deno.test("studyGuidePromptLines: names the guide and its piece count", () => {
  assertEquals(
    studyGuidePromptLines([SOURCE]),
    '- Study guide "Forces" (2 pieces of instructor-approved theory, provided inline)',
  );
});

Deno.test("studyGuideTheoryBlocks: one labelled block per piece, in order", () => {
  const blocks = studyGuideTheoryBlocks([SOURCE]);
  assertStringIncludes(blocks, '=== Study guide "Forces" — piece 1: Gravity ===\nThings fall.');
  assertStringIncludes(blocks, '=== Study guide "Forces" — piece 2: Friction ===\nThings stop.');
});

/**
 * Minimal thenable query-chain mock: every builder method returns the chain,
 * and awaiting it resolves to the response registered for the table.
 */
function mockClient(responses: Record<string, { data: unknown; error: unknown }>) {
  return {
    from(table: string) {
      // deno-lint-ignore no-explicit-any
      const chain: any = {};
      for (const m of ["select", "eq", "in", "order"]) chain[m] = () => chain;
      chain.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve(resolve(responses[table] ?? { data: [], error: null }));
      return chain;
    },
    // deno-lint-ignore no-explicit-any
  } as any;
}

const THEORY = `<p>${"prose ".repeat(20)}</p>`;

Deno.test("fetchStudyGuideSources: no ids is a no-op, not an error", async () => {
  const result = await fetchStudyGuideSources(mockClient({}), "course-1", undefined);
  assertEquals(result, { ok: true, sources: [] });
});

Deno.test("fetchStudyGuideSources: a guide outside the course is refused", async () => {
  const result = await fetchStudyGuideSources(
    mockClient({ study_guides: { data: [], error: null } }),
    "course-1",
    ["g-other-course"],
  );
  assertEquals(result.ok, false);
  if (!result.ok) assertStringIncludes(result.error, "not found in this course");
});

Deno.test("fetchStudyGuideSources: an incomplete guide is refused by name", async () => {
  const result = await fetchStudyGuideSources(
    mockClient({
      study_guides: { data: [{ id: "g-1", title: "Forces" }], error: null },
      study_guide_pieces: {
        data: [
          { id: "p-1", study_guide_id: "g-1", title: "Gravity", position: 0, theory_html: THEORY },
          { id: "p-2", study_guide_id: "g-1", title: "Friction", position: 1, theory_html: null },
        ],
        error: null,
      },
      study_guide_piece_questions: {
        data: [{ piece_id: "p-1", questions: { question: "What falls?" } }],
        error: null,
      },
    }),
    "course-1",
    ["g-1"],
  );
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error, 'Study guide "Forces" is not complete');
    assertStringIncludes(result.error, "1 of 2 pieces have no theory");
  }
});

Deno.test("fetchStudyGuideSources: a complete guide yields theory, asked questions and chapters", async () => {
  const result = await fetchStudyGuideSources(
    mockClient({
      study_guides: { data: [{ id: "g-1", title: "Forces", material_id: "mat-1" }], error: null },
      study_guide_pieces: {
        data: [
          { id: "p-1", study_guide_id: "g-1", title: "Gravity", position: 0, theory_html: THEORY },
          { id: "p-2", study_guide_id: "g-1", title: "Friction", position: 1, theory_html: THEORY },
        ],
        error: null,
      },
      study_guide_piece_questions: {
        data: [
          { piece_id: "p-1", questions: { question: "What falls?" } },
          { piece_id: "p-2", questions: { question: "What stops?" } },
        ],
        error: null,
      },
      study_guide_source_chapters: {
        data: [
          { study_guide_id: "g-1", chapter_id: "ch-1" },
          { study_guide_id: "g-1", chapter_id: "ch-2" },
        ],
        error: null,
      },
    }),
    "course-1",
    ["g-1"],
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.sources.length, 1);
    const g = result.sources[0];
    assertEquals(g.sections.map((s) => s.pieceTitle), ["Gravity", "Friction"]);
    assertEquals(g.askedQuestions, ["What falls?", "What stops?"]);
    assertEquals(g.sourceChapterIds, ["ch-1", "ch-2"]);
    // Chapter-scoped guide → the chapters, not the material, carry provenance.
    assertEquals(g.sourceMaterialId, null);
  }
});

Deno.test("fetchStudyGuideSources: a whole-material guide carries its material as provenance", async () => {
  // An empty study_guide_source_chapters is how the schema spells "the whole
  // material" — such a guide must not lose provenance to an empty chapter list.
  const result = await fetchStudyGuideSources(
    mockClient({
      study_guides: { data: [{ id: "g-2", title: "Syllabus", material_id: "mat-9" }], error: null },
      study_guide_pieces: {
        data: [
          { id: "p-1", study_guide_id: "g-2", title: "Week one", position: 0, theory_html: THEORY },
        ],
        error: null,
      },
      study_guide_piece_questions: {
        data: [{ piece_id: "p-1", questions: { question: "When is week one?" } }],
        error: null,
      },
      study_guide_source_chapters: { data: [], error: null },
    }),
    "course-1",
    ["g-2"],
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.sources[0].sourceChapterIds, []);
    assertEquals(result.sources[0].sourceMaterialId, "mat-9");
  }
});
