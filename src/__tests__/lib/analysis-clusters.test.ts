import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Recorded inserts, in order, so a test can assert both what was written and
 * the sequence — the rollback path only makes sense as a sequence.
 */
interface InsertCall {
  table: string;
  values: unknown;
}
let insertCalls: InsertCall[] = [];
let deleteCalls: Array<{ table: string; ids: unknown }> = [];

/**
 * Per-table queue of results the next insert resolves to. A missing entry means
 * "succeed with a fresh id", which is what most of these tests want.
 */
let insertResults: Record<string, Array<{ data?: unknown; error?: unknown }>> = {};
/** When set, every compensating delete fails with this. */
let deleteError: unknown = null;
let idSeq = 0;

vi.mock("@/integrations/supabase/client", () => {
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    chain.insert = (values: unknown) => {
      insertCalls.push({ table, values });
      const queued = insertResults[table]?.shift();
      // Only group inserts read an id back; a member insert is awaited for its
      // error alone, so minting an id for it would skew the group ids.
      const result = queued ??
        (table === "offering_groups"
          ? { data: { id: `group-${++idSeq}` }, error: null }
          : { error: null });
      // `.insert(...)` is awaited directly for members, and
      // `.insert(...).select().single()` for groups — both must resolve.
      const selectChain = {
        single: () => Promise.resolve(result),
      };
      return {
        select: () => selectChain,
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(resolve(result)),
      };
    };
    chain.delete = () => ({
      in: (_col: string, ids: unknown) => {
        deleteCalls.push({ table, ids });
        return Promise.resolve({ error: deleteError });
      },
    });
    return chain;
  };
  return {
    supabase: {
      from: vi.fn(from),
      auth: { getUser: vi.fn(async () => ({ data: { user: { id: "instr-1" } } })) },
    },
  };
});

import { createGroupsFromClusters, followupGroupName } from "@/lib/analysis-clusters";

beforeEach(() => {
  insertCalls = [];
  deleteCalls = [];
  insertResults = {};
  deleteError = null;
  idSeq = 0;
  vi.clearAllMocks();
});

const cluster = (label: string, members: string[]) => ({
  label,
  rationale: "Shared the same wrong idea.",
  summary: "Reteach the distinction.",
  member_user_ids: members,
});

describe("followupGroupName", () => {
  it("postfixes the source so the group is identifiable in a class-wide list", () => {
    expect(followupGroupName("Confuses mitosis and meiosis", "Cell division")).toBe(
      "Confuses mitosis and meiosis — Cell division follow ups",
    );
  });

  it("trims both halves rather than emitting stray spacing", () => {
    expect(followupGroupName("  Fractions  ", "  Unit 3 quiz ")).toBe(
      "Fractions — Unit 3 quiz follow ups",
    );
  });

  it("falls back to a usable label when the cluster has none", () => {
    expect(followupGroupName("   ", "Unit 3")).toBe("Group — Unit 3 follow ups");
  });

  it("drops the postfix entirely rather than trailing a bare separator", () => {
    expect(followupGroupName("Fractions", "  ")).toBe("Fractions");
  });

  it("clips to the column budget", () => {
    const name = followupGroupName("x".repeat(400), "Unit 3");
    expect(name.length).toBe(200);
  });
});

describe("createGroupsFromClusters", () => {
  it("creates one group per cluster, named with the follow-ups postfix", async () => {
    const result = await createGroupsFromClusters({
      offeringId: "off-1",
      sourceTitle: "Cell division",
      clusters: [cluster("Confuses phases", ["u1", "u2"]), cluster("Secure", ["u3"])],
    });

    expect(result.groupIds).toEqual(["group-1", "group-2"]);
    expect(result.names).toEqual([
      "Confuses phases — Cell division follow ups",
      "Secure — Cell division follow ups",
    ]);

    const groupInserts = insertCalls.filter((c) => c.table === "offering_groups");
    expect(groupInserts).toHaveLength(2);
    expect(groupInserts[0].values).toMatchObject({
      offering_id: "off-1",
      name: "Confuses phases — Cell division follow ups",
      // The model's summary becomes the group's persistent description.
      description: "Reteach the distinction.",
      created_by: "instr-1",
    });

    const memberInserts = insertCalls.filter((c) => c.table === "offering_group_members");
    expect(memberInserts[0].values).toEqual([
      { group_id: "group-1", user_id: "u1", added_by: "instr-1" },
      { group_id: "group-1", user_id: "u2", added_by: "instr-1" },
    ]);
  });

  it("skips clusters nobody is in rather than creating an empty group", async () => {
    await createGroupsFromClusters({
      offeringId: "off-1",
      sourceTitle: "Cell division",
      clusters: [cluster("Empty", []), cluster("Real", ["u1"])],
    });

    const groupInserts = insertCalls.filter((c) => c.table === "offering_groups");
    expect(groupInserts).toHaveLength(1);
    expect(groupInserts[0].values).toMatchObject({
      name: "Real — Cell division follow ups",
    });
  });

  it("refuses outright when no cluster has students", async () => {
    await expect(
      createGroupsFromClusters({
        offeringId: "off-1",
        sourceTitle: "Cell division",
        clusters: [cluster("Empty", [])],
      }),
    ).rejects.toThrow(/students in them/i);
    expect(insertCalls).toHaveLength(0);
  });

  it("retries with a numeric suffix when the name is already taken", async () => {
    // Regenerating an analysis and creating groups a second time yields the
    // same labels, which the UNIQUE(offering_id, name) index rejects.
    insertResults.offering_groups = [
      { data: null, error: { code: "23505", message: "duplicate key" } },
      { data: { id: "group-9" }, error: null },
    ];

    const result = await createGroupsFromClusters({
      offeringId: "off-1",
      sourceTitle: "Cell division",
      clusters: [cluster("Confuses phases", ["u1"])],
    });

    expect(result.names).toEqual(["Confuses phases — Cell division follow ups (2)"]);
    const groupInserts = insertCalls.filter((c) => c.table === "offering_groups");
    expect(groupInserts).toHaveLength(2);
  });

  it("rolls back everything it created when a later insert fails", async () => {
    // Group 1 and its members land; group 2's members fail. A half-created set
    // is worse than none — the instructor cannot tell which groups are whole.
    insertResults.offering_group_members = [
      { error: null },
      { error: { code: "23503", message: "member insert failed" } },
    ];

    await expect(
      createGroupsFromClusters({
        offeringId: "off-1",
        sourceTitle: "Cell division",
        clusters: [cluster("First", ["u1"]), cluster("Second", ["u2"])],
      }),
    ).rejects.toMatchObject({ message: "member insert failed" });

    expect(deleteCalls).toEqual([
      { table: "offering_group_members", ids: ["group-1", "group-2"] },
      { table: "offering_groups", ids: ["group-1", "group-2"] },
    ]);
  });

  it("names the groups left behind when the compensating cleanup also fails", async () => {
    // Creation is not atomic — PostgREST gives no client-side transaction — so
    // a failed cleanup leaves rows the instructor has to find by hand. Saying
    // nothing would leave them believing nothing was created.
    insertResults.offering_group_members = [
      { error: { code: "23503", message: "member insert failed" } },
    ];
    deleteError = { code: "42501", message: "delete denied" };

    const err = await createGroupsFromClusters({
      offeringId: "off-1",
      sourceTitle: "Cell division",
      clusters: [cluster("First", ["u1"])],
    }).catch((e: Error) => e);

    // The original failure leads — it explains what actually went wrong…
    expect((err as Error).message).toMatch(/member insert failed/);
    // …and the orphaned group is named, so it can be found and removed.
    expect((err as Error).message).toMatch(/cleaning up afterwards also failed/);
    expect((err as Error).message).toMatch(/First — Cell division follow ups/);
  });

  it("propagates a non-collision insert error instead of retrying it", async () => {
    insertResults.offering_groups = [
      { data: null, error: { code: "42501", message: "permission denied" } },
    ];

    await expect(
      createGroupsFromClusters({
        offeringId: "off-1",
        sourceTitle: "Cell division",
        clusters: [cluster("First", ["u1"])],
      }),
    ).rejects.toMatchObject({ message: "permission denied" });

    // One attempt, not twenty-five.
    expect(insertCalls.filter((c) => c.table === "offering_groups")).toHaveLength(1);
  });
});
