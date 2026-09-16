import { assert, assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  getLanguageInstruction,
  getQualityInstructionForCourse,
  GREEK_QUALITY_INSTRUCTION,
  LANGUAGE_NAMES,
} from "../language-utils.ts";

Deno.test("getLanguageInstruction: Greek returns qualityInstruction", () => {
  const info = getLanguageInstruction("el");
  assertEquals(info.name, "Greek (Ελληνικά)");
  assert(info.qualityInstruction);
  assert(info.qualityInstruction!.includes("final sigma"));
  // The final-sigma rule is emphatic and shows the correct final form (ς).
  assert(info.qualityInstruction!.includes("ς"));
  assert(info.qualityInstruction!.includes("μαθητής"));
  assert(info.qualityInstruction!.includes("Demotic"));
});

Deno.test("getLanguageInstruction: English has no qualityInstruction", () => {
  const info = getLanguageInstruction("en");
  assertEquals(info.qualityInstruction, undefined);
});

Deno.test("getLanguageInstruction: unknown language falls back to English", () => {
  const info = getLanguageInstruction("xx-not-real");
  assertEquals(info.name, "English");
  assertEquals(info.qualityInstruction, undefined);
});

Deno.test("LANGUAGE_NAMES: only Greek has a qualityInstruction today", () => {
  for (const [code, config] of Object.entries(LANGUAGE_NAMES)) {
    if (code === "el") {
      assertEquals(config.qualityInstruction, GREEK_QUALITY_INSTRUCTION);
    } else {
      assertEquals(
        config.qualityInstruction,
        undefined,
        `Language ${code} unexpectedly has a qualityInstruction`,
      );
    }
  }
});

/**
 * Minimal supabase client stub for getQualityInstructionForCourse tests.
 * Mirrors the chained `.from(...).select(...).eq(...).single()` shape the helper uses.
 */
function mockSupabase(courseLanguage: string | null, institutionLanguage: string | null = null) {
  return {
    from(table: string) {
      return {
        select(_cols: string) {
          return {
            eq(_col: string, _val: string) {
              return {
                async single() {
                  if (table === "courses") {
                    return { data: { language: courseLanguage, institution_id: institutionLanguage ? "inst-1" : null } };
                  }
                  if (table === "institutions") {
                    return { data: { default_language: institutionLanguage } };
                  }
                  return { data: null };
                },
              };
            },
          };
        },
      };
    },
  };
}

Deno.test("getQualityInstructionForCourse: returns Greek rules for Greek course", async () => {
  const supabase = mockSupabase("el");
  const quality = await getQualityInstructionForCourse(supabase, "course-1");
  assertEquals(quality, GREEK_QUALITY_INSTRUCTION);
});

Deno.test("getQualityInstructionForCourse: returns undefined for English course", async () => {
  const supabase = mockSupabase("en");
  const quality = await getQualityInstructionForCourse(supabase, "course-1");
  assertEquals(quality, undefined);
});

Deno.test("getQualityInstructionForCourse: falls back to institution default_language", async () => {
  const supabase = mockSupabase(null, "el");
  const quality = await getQualityInstructionForCourse(supabase, "course-1");
  assertEquals(quality, GREEK_QUALITY_INSTRUCTION);
});
