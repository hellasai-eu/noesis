import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { buildStudentSnapshot } from "../student-snapshot.ts";

const OPTS = { sanitizeOps: false, sanitizeResources: false };

type FetchResult = { data: unknown; error: unknown };

interface TableResponder {
  fetchAll: (filters: Array<{ col: string; val: unknown }>) => FetchResult;
  maybeSingle: (filters: Array<{ col: string; val: unknown }>) => FetchResult;
}

function makeStub(spec: Record<string, TableResponder>) {
  // deno-lint-ignore no-explicit-any
  const from = (table: string): any => {
    const filters: Array<{ col: string; val: unknown }> = [];
    let inFilter: { col: string; vals: unknown[] } | null = null;

    const respond = (mode: "fetchAll" | "maybeSingle"): FetchResult => {
      const responder = spec[table];
      if (!responder) return { data: [], error: null };
      const merged: Array<{ col: string; val: unknown }> = [...filters];
      // .in() is just a filter that says col ∈ vals; pass through using a synthesised vals filter.
      if (inFilter) merged.push({ col: inFilter.col + "::in", val: inFilter.vals });
      return responder[mode](merged);
    };

    const api = {
      select(_cols: string) {
        return api;
      },
      eq(col: string, val: unknown) {
        filters.push({ col, val });
        return api;
      },
      in(col: string, vals: unknown[]) {
        inFilter = { col, vals };
        return api;
      },
      order(_col: string, _opts: unknown) {
        return api;
      },
      limit(_n: number) {
        return api;
      },
      range(_from: number, _to: number) {
        return api;
      },
      async maybeSingle() {
        return respond("maybeSingle");
      },
      then(resolve: (v: FetchResult) => void) {
        resolve(respond("fetchAll"));
      },
    };
    return api;
  };
  return { from };
}

const EMPTY: TableResponder = {
  fetchAll: () => ({ data: [], error: null }),
  maybeSingle: () => ({ data: null, error: null }),
};

/** profiles serves two query shapes: maybeSingle = target lookup, fetchAll = institution roster. */
function profilesResponder(targetName: string | null, roster: Array<string | null>): TableResponder {
  return {
    fetchAll: () => ({ data: roster.map((full_name) => ({ full_name })), error: null }),
    maybeSingle: () => ({ data: { full_name: targetName, institution_id: "inst-1" }, error: null }),
  };
}

Deno.test({
  name: "buildStudentSnapshot: includes admin notes with every roster name redacted",
  ...OPTS,
  async fn() {
    const stub = makeStub({
      profiles: profilesResponder("Maria K.", ["Maria K.", "Nikos Papas"]),
      student_competency_mastery: {
        fetchAll: () => ({
          data: [
            { competency_id: "c-1", mastery_percentage: 20, correct_mcq_answers: 1, total_mcq_questions: 5 },
            { competency_id: "c-2", mastery_percentage: 90, correct_mcq_answers: 9, total_mcq_questions: 10 },
          ],
          error: null,
        }),
        maybeSingle: () => ({ data: null, error: null }),
      },
      quiz_answers: {
        fetchAll: () => ({
          data: [
            { question_id: "q-1", is_correct: true },
            { question_id: "q-2", is_correct: false },
            { question_id: "q-3", is_correct: true },
          ],
          error: null,
        }),
        maybeSingle: () => ({ data: null, error: null }),
      },
      questions: {
        fetchAll: () => ({
          data: [
            { id: "q-1", difficulty: "easy" },
            { id: "q-2", difficulty: "hard" },
            { id: "q-3", difficulty: "easy" },
          ],
          error: null,
        }),
        maybeSingle: () => ({ data: null, error: null }),
      },
      course_competencies: {
        fetchAll: () => ({
          data: [
            { id: "c-1", title: "Fractions" },
            { id: "c-2", title: "Geometry" },
          ],
          error: null,
        }),
        maybeSingle: () => ({ data: null, error: null }),
      },
      student_evaluations: EMPTY,
      evaluation_competency_scores: EMPTY,
      student_admin_notes: {
        fetchAll: () => ({
          data: [
            { body: "Maria has dyslexia — give concrete examples. Pairs well with Nikos Papas.", created_at: "2026-06-01" },
          ],
          error: null,
        }),
        maybeSingle: () => ({ data: null, error: null }),
      },
    });

    // deno-lint-ignore no-explicit-any
    const snapshot = await buildStudentSnapshot(stub as any, "course-1", "stu-1");
    if (!snapshot) throw new Error("expected snapshot");
    assertEquals(snapshot.used_admin_notes, true);
    // full_name is returned for instructor-UI labeling…
    assertEquals(snapshot.full_name, "Maria K.");
    assertEquals(snapshot.total_quiz_answers, 3);
    // …but the hint crosses to OpenAI, so no roster name may appear in it
    // (issue #557) — while the notes' pedagogical content must.
    assertEquals(snapshot.hint.includes("Maria"), false);
    assertEquals(snapshot.hint.includes("Nikos"), false);
    assertEquals(snapshot.hint.includes("Papas"), false);
    assertStringIncludes(snapshot.hint, "dyslexia");
    assertStringIncludes(snapshot.hint, "[student]");
    assertStringIncludes(snapshot.hint, "Teacher guidance on file");
    assertStringIncludes(snapshot.hint, "Targeted student:");
    assertStringIncludes(snapshot.hint, "Fractions");
    assertStringIncludes(snapshot.hint, "67% correct over 3 answers");
  },
});

Deno.test({
  name: "buildStudentSnapshot: omits admin notes when the roster cannot be read",
  ...OPTS,
  async fn() {
    const stub = makeStub({
      // Roster read (profiles fetchAll) fails → notes are unredactable free
      // text → excluded. The target lookup (maybeSingle) still succeeds.
      profiles: {
        fetchAll: () => ({ data: null, error: { message: "timeout", code: "57014" } }),
        maybeSingle: () => ({ data: { full_name: "Maria K.", institution_id: "inst-1" }, error: null }),
      },
      student_competency_mastery: EMPTY,
      quiz_answers: EMPTY,
      questions: EMPTY,
      course_competencies: EMPTY,
      student_evaluations: EMPTY,
      evaluation_competency_scores: EMPTY,
      student_admin_notes: {
        fetchAll: () => ({
          data: [{ body: "Has dyslexia — give concrete examples.", created_at: "2026-06-01" }],
          error: null,
        }),
        maybeSingle: () => ({ data: null, error: null }),
      },
    });

    // deno-lint-ignore no-explicit-any
    const snapshot = await buildStudentSnapshot(stub as any, "course-1", "stu-1");
    if (!snapshot) throw new Error("expected snapshot");
    assertEquals(snapshot.used_admin_notes, false);
    assertEquals(snapshot.hint.includes("dyslexia"), false);
    assertEquals(snapshot.hint.includes("Teacher guidance"), false);
    // The performance-signal hint still builds.
    assertStringIncludes(snapshot.hint, "No prior MCQ attempts");
  },
});

Deno.test({
  name: "buildStudentSnapshot: redacts the student's name out of instructor-authored titles",
  ...OPTS,
  async fn() {
    const stub = makeStub({
      profiles: profilesResponder("Μαρία Παπαδοπούλου", []),
      student_competency_mastery: {
        fetchAll: () => ({
          data: [
            { competency_id: "c-1", mastery_percentage: 30, correct_mcq_answers: 3, total_mcq_questions: 10 },
          ],
          error: null,
        }),
        maybeSingle: () => ({ data: null, error: null }),
      },
      quiz_answers: EMPTY,
      questions: EMPTY,
      course_competencies: {
        // Instructor-authored free text can carry a name (accent-free all-caps,
        // as Greek titles often are) — the redaction pass must scrub it.
        fetchAll: () => ({
          data: [{ id: "c-1", title: "Επανάληψη για ΜΑΡΙΑ — κλάσματα" }],
          error: null,
        }),
        maybeSingle: () => ({ data: null, error: null }),
      },
      student_evaluations: EMPTY,
      evaluation_competency_scores: EMPTY,
    });

    // deno-lint-ignore no-explicit-any
    const snapshot = await buildStudentSnapshot(stub as any, "course-1", "stu-1");
    if (!snapshot) throw new Error("expected snapshot");
    assertEquals(snapshot.hint.includes("ΜΑΡΙΑ"), false);
    assertEquals(snapshot.hint.includes("Μαρία"), false);
    assertStringIncludes(snapshot.hint, "[student]");
    assertStringIncludes(snapshot.hint, "κλάσματα");
    assertStringIncludes(snapshot.hint, "No prior MCQ attempts");
  },
});

Deno.test({
  name: "buildStudentSnapshot: fails closed when the profile query errors",
  ...OPTS,
  async fn() {
    // If the profile read errors, a name may exist that the redaction pass
    // cannot see — the snapshot must be dropped (no hint at all) rather than
    // built without redaction tokens.
    const stub = makeStub({
      profiles: {
        fetchAll: () => ({ data: [], error: null }),
        maybeSingle: () => ({ data: null, error: { message: "timeout", code: "57014" } }),
      },
      student_competency_mastery: {
        fetchAll: () => ({
          data: [
            { competency_id: "c-1", mastery_percentage: 30, correct_mcq_answers: 3, total_mcq_questions: 10 },
          ],
          error: null,
        }),
        maybeSingle: () => ({ data: null, error: null }),
      },
      quiz_answers: EMPTY,
      questions: EMPTY,
      course_competencies: {
        fetchAll: () => ({
          data: [{ id: "c-1", title: "Επανάληψη για ΜΑΡΙΑ — κλάσματα" }],
          error: null,
        }),
        maybeSingle: () => ({ data: null, error: null }),
      },
      student_evaluations: EMPTY,
      evaluation_competency_scores: EMPTY,
    });

    // deno-lint-ignore no-explicit-any
    const snapshot = await buildStudentSnapshot(stub as any, "course-1", "stu-1");
    assertEquals(snapshot, null);
  },
});
