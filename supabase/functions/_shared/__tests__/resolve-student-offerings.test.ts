/**
 * Locks in the split-query shape of the offering resolver. The point of this
 * test is the regression guard: we MUST query `class_enrollments` first and
 * `offerings` second — never embed one under the other. See #770 (and the
 * earlier siblings #743, #750) for the failure mode the embed would trigger.
 */
import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  resolveStudentActiveOfferingForCourse,
  resolveStudentEnrolledOfferingsForCourse,
} from "../resolve-student-offerings.ts";

interface FakeQuery {
  table: string;
  filters: Array<{ kind: string; col?: string; val?: unknown }>;
  result: { data: unknown; error: unknown };
  selectCols?: string;
}

function makeClient(
  responses: Record<string, { data: unknown; error: unknown }>,
): { client: unknown; calls: FakeQuery[] } {
  const calls: FakeQuery[] = [];
  const client = {
    // deno-lint-ignore no-explicit-any
    from(table: string): any {
      const entry: FakeQuery = {
        table,
        filters: [],
        result: responses[table] ?? { data: [], error: null },
      };
      calls.push(entry);
      const chain = {
        // deno-lint-ignore no-explicit-any
        select(cols: string): any {
          entry.selectCols = cols;
          return chain;
        },
        // deno-lint-ignore no-explicit-any
        eq(col: string, val: unknown): any {
          entry.filters.push({ kind: "eq", col, val });
          return chain;
        },
        // deno-lint-ignore no-explicit-any
        in(col: string, val: unknown): any {
          entry.filters.push({ kind: "in", col, val });
          return chain;
        },
        then(
          resolve: (v: { data: unknown; error: unknown }) => unknown,
          reject?: (e: unknown) => unknown,
        ) {
          try {
            return Promise.resolve(resolve(entry.result));
          } catch (e) {
            return Promise.resolve(reject?.(e));
          }
        },
      };
      return chain;
    },
  };
  return { client, calls };
}

Deno.test("resolveStudentEnrolledOfferingsForCourse: split queries, no class_enrollments embed", async () => {
  const { client, calls } = makeClient({
    class_enrollments: {
      data: [{ class_id: "class-a" }, { class_id: "class-b" }],
      error: null,
    },
    offerings: {
      data: [
        { id: "off-1", class_id: "class-a" },
        { id: "off-2", class_id: "class-b" },
      ],
      error: null,
    },
  });

  const rows = await resolveStudentEnrolledOfferingsForCourse(
    // deno-lint-ignore no-explicit-any
    client as any,
    { userId: "user-1", courseId: "course-1" },
  );

  assertEquals(rows, [
    { id: "off-1", class_id: "class-a" },
    { id: "off-2", class_id: "class-b" },
  ]);
  assertEquals(calls[0].table, "class_enrollments");
  assertEquals(calls[1].table, "offerings");
  // Critical regression guard: the offerings query selects only `id, class_id`
  // — no `class_enrollments!inner(...)` PostgREST embed (which would error
  // because there's no FK between the two tables).
  assertEquals(calls[1].selectCols, "id, class_id");
});

Deno.test("resolveStudentEnrolledOfferingsForCourse: short-circuits when student has no enrollments", async () => {
  const { client, calls } = makeClient({
    class_enrollments: { data: [], error: null },
  });

  const rows = await resolveStudentEnrolledOfferingsForCourse(
    // deno-lint-ignore no-explicit-any
    client as any,
    { userId: "user-1", courseId: "course-1" },
  );

  assertEquals(rows, []);
  // Should not have hit `offerings` at all.
  assertEquals(calls.length, 1);
  assertEquals(calls[0].table, "class_enrollments");
});

Deno.test("resolveStudentEnrolledOfferingsForCourse: filters by is_active when activeOnly=true", async () => {
  const { client, calls } = makeClient({
    class_enrollments: { data: [{ class_id: "class-a" }], error: null },
    offerings: { data: [{ id: "off-1", class_id: "class-a" }], error: null },
  });

  await resolveStudentEnrolledOfferingsForCourse(
    // deno-lint-ignore no-explicit-any
    client as any,
    { userId: "user-1", courseId: "course-1", activeOnly: true },
  );

  const offeringFilters = calls[1].filters;
  const hasActiveFilter = offeringFilters.some(
    (f) => f.kind === "eq" && f.col === "is_active" && f.val === true,
  );
  assertEquals(hasActiveFilter, true);
});

Deno.test("resolveStudentActiveOfferingForCourse: returns first offering or null", async () => {
  const { client: clientWithRow } = makeClient({
    class_enrollments: { data: [{ class_id: "class-a" }], error: null },
    offerings: { data: [{ id: "off-1", class_id: "class-a" }], error: null },
  });
  const found = await resolveStudentActiveOfferingForCourse(
    // deno-lint-ignore no-explicit-any
    clientWithRow as any,
    { userId: "user-1", courseId: "course-1" },
  );
  assertEquals(found, { id: "off-1", class_id: "class-a" });

  const { client: clientEmpty } = makeClient({
    class_enrollments: { data: [{ class_id: "class-a" }], error: null },
    offerings: { data: [], error: null },
  });
  const notFound = await resolveStudentActiveOfferingForCourse(
    // deno-lint-ignore no-explicit-any
    clientEmpty as any,
    { userId: "user-1", courseId: "course-1" },
  );
  assertEquals(notFound, null);
});
