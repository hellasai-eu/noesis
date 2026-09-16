import { assert, assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { buildGroupAudienceHint } from "../group-audience.ts";

const OPTS = { sanitizeOps: false, sanitizeResources: false };

type Row = Record<string, unknown>;

/**
 * Minimal stub for the single query the builder makes. `queriedTables` records
 * every table touched, so a test can assert that the builder stays at one
 * round-trip rather than quietly growing new lookups.
 */
function makeSupabaseStub(groupRow: Row | null, error: unknown = null) {
  const queriedTables: string[] = [];
  // deno-lint-ignore no-explicit-any
  const from = (table: string): any => {
    queriedTables.push(table);
    const api = {
      select: (_cols: string) => api,
      eq: (_col: string, _val: unknown) => api,
      maybeSingle: () => Promise.resolve({ data: groupRow, error }),
    };
    return api;
  };
  // deno-lint-ignore no-explicit-any
  return { client: { from } as any, queriedTables };
}

const GROUP = {
  id: "grp-1",
  name: "Needs fractions work",
  description: "Struggles to add fractions with unlike denominators.",
  offering_id: "off-1",
  offerings: { course_id: "course-1" },
};

Deno.test("buildGroupAudienceHint: the description carries the steer", OPTS, async () => {
  const { client, queriedTables } = makeSupabaseStub(GROUP);

  const audience = await buildGroupAudienceHint(client, "course-1", "grp-1");

  assert(audience, "expected an audience for a group in this course");
  assertEquals(audience.group_id, "grp-1");
  assertEquals(audience.offering_id, "off-1");
  assertEquals(audience.description, "Struggles to add fractions with unlike denominators.");
  assert(audience.hint.includes("Needs fractions work"));
  assert(audience.hint.includes("Struggles to add fractions with unlike denominators."));
  // The whole point: the model is told to aim at the stated weakness…
  assert(audience.hint.includes("aim each question at the weakness that description names"));
  // …without inventing material to do it.
  assert(audience.hint.includes("never invent content"));
  // One round-trip — no mastery aggregation behind the instructor's back.
  assertEquals(queriedTables, ["offering_groups"]);
});

Deno.test("buildGroupAudienceHint: no description means no weakness to target", OPTS, async () => {
  const { client } = makeSupabaseStub({ ...GROUP, description: "   " });

  const audience = await buildGroupAudienceHint(client, "course-1", "grp-1");

  assert(audience);
  assertEquals(audience.description, null);
  assert(audience.hint.includes("No description was written for this group"));
  assert(!audience.hint.includes("aim each question at the weakness"));
});

Deno.test("buildGroupAudienceHint: a runaway description is clamped", OPTS, async () => {
  // The column is unbounded free text and the group editor sets no maxLength,
  // so a pasted wall of text must not crowd out the source material.
  const long = "word ".repeat(4000);
  const { client } = makeSupabaseStub({ ...GROUP, description: long });

  const audience = await buildGroupAudienceHint(client, "course-1", "grp-1");

  assert(audience);
  assert(audience.description);
  assert(
    audience.description.length <= 1001,
    `expected the description to be clamped, got ${audience.description.length}`,
  );
  assert(audience.description.endsWith("…"));
  // Still a usable steer, not a stump.
  assert(audience.hint.includes("aim each question at the weakness that description names"));
});

Deno.test("buildGroupAudienceHint: a description at the limit is left intact", OPTS, async () => {
  const exact = "x".repeat(1000);
  const { client } = makeSupabaseStub({ ...GROUP, description: exact });

  const audience = await buildGroupAudienceHint(client, "course-1", "grp-1");

  assert(audience);
  assertEquals(audience.description, exact);
});

Deno.test("buildGroupAudienceHint: a group from another course is ignored", OPTS, async () => {
  const { client } = makeSupabaseStub({ ...GROUP, offerings: { course_id: "other-course" } });

  assertEquals(await buildGroupAudienceHint(client, "course-1", "grp-1"), null);
});

Deno.test("buildGroupAudienceHint: a missing group is ignored", OPTS, async () => {
  const { client } = makeSupabaseStub(null);

  assertEquals(await buildGroupAudienceHint(client, "course-1", "grp-1"), null);
});

Deno.test("buildGroupAudienceHint: a query error is ignored rather than thrown", OPTS, async () => {
  const { client } = makeSupabaseStub(null, { message: "boom" });

  assertEquals(await buildGroupAudienceHint(client, "course-1", "grp-1"), null);
});
