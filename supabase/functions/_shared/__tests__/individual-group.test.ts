import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { ensureIndividualGroup } from "../individual-group.ts";

const OPTS = { sanitizeOps: false, sanitizeResources: false };

// Minimal fluent-query stub that mirrors the surface we use.
type Row = Record<string, unknown>;

interface QueryStub {
  __op: "select" | "insert";
  __table: string;
  __filters: Array<{ col: string; val: unknown }>;
  __row?: Row;
  __selectResult: Row | null;
  __insertResult: Row | null;
  __insertError?: { code?: string; message?: string };
  __maybeSingleCalled: boolean;
}

interface SupabaseStub {
  groupsTable: Row[];
  membersTable: Row[];
  insertGroupError?: { code?: string; message?: string };
  insertMemberError?: { code?: string; message?: string };
  from: (table: string) => unknown;
}

function makeSupabaseStub(initial?: Partial<SupabaseStub>): SupabaseStub {
  const groupsTable: Row[] = initial?.groupsTable ?? [];
  const membersTable: Row[] = initial?.membersTable ?? [];
  const insertGroupError = initial?.insertGroupError;
  const insertMemberError = initial?.insertMemberError;

  // deno-lint-ignore no-explicit-any
  const fromImpl = (table: string): any => {
    const filters: Array<{ col: string; val: unknown }> = [];

    const queryApi = {
      select(_cols: string) {
        return queryApi;
      },
      eq(col: string, val: unknown) {
        filters.push({ col, val });
        return queryApi;
      },
      async maybeSingle() {
        if (table === "offering_groups") {
          const row = groupsTable.find((r) => filters.every((f) => r[f.col] === f.val));
          return { data: row ?? null, error: null };
        }
        return { data: null, error: null };
      },
    };

    const insertApi = (values: Row) => {
      let returnRow: Row | null = null;
      const api = {
        select(_cols: string) {
          return api;
        },
        async maybeSingle() {
          if (table === "offering_groups") {
            if (insertGroupError) return { data: null, error: insertGroupError };
            const id = `grp-${groupsTable.length + 1}`;
            const row = { ...values, id };
            groupsTable.push(row);
            returnRow = row;
            return { data: { id }, error: null };
          }
          return { data: returnRow, error: null };
        },
        // Awaiting the chain without .maybeSingle() (used by member insert).
        then(resolve: (v: unknown) => void) {
          if (table === "offering_group_members") {
            if (insertMemberError) {
              resolve({ data: null, error: insertMemberError });
              return;
            }
            membersTable.push({ ...values });
            resolve({ data: null, error: null });
            return;
          }
          resolve({ data: null, error: null });
        },
      };
      return api;
    };

    return {
      select: (cols: string) => queryApi.select(cols),
      insert: (values: Row) => insertApi(values),
    };
  };

  return {
    groupsTable,
    membersTable,
    insertGroupError,
    insertMemberError,
    from: fromImpl,
  };
}

Deno.test({
  name: "ensureIndividualGroup: returns existing singleton without inserting",
  ...OPTS,
  async fn() {
    const stub = makeSupabaseStub({
      groupsTable: [
        {
          id: "grp-existing",
          offering_id: "off-1",
          owner_user_id: "stu-1",
          is_individual: true,
        },
      ],
    });
    // deno-lint-ignore no-explicit-any
    const result = await ensureIndividualGroup(stub as any, "off-1", "stu-1");
    assertEquals(result.group_id, "grp-existing");
    assertEquals(result.created, false);
    assertEquals(stub.groupsTable.length, 1);
    assertEquals(stub.membersTable.length, 0);
  },
});

Deno.test({
  name: "ensureIndividualGroup: inserts new singleton + member when absent",
  ...OPTS,
  async fn() {
    const stub = makeSupabaseStub();
    // deno-lint-ignore no-explicit-any
    const result = await ensureIndividualGroup(stub as any, "off-1", "stu-2");
    assertEquals(result.created, true);
    assertEquals(stub.groupsTable.length, 1);
    assertEquals(stub.groupsTable[0].owner_user_id, "stu-2");
    assertEquals(stub.groupsTable[0].is_individual, true);
    assertEquals(stub.groupsTable[0].name, "_individual_stu-2");
    assertEquals(stub.membersTable.length, 1);
    assertEquals(stub.membersTable[0].user_id, "stu-2");
  },
});

Deno.test({
  name: "ensureIndividualGroup: tolerates duplicate-key race on member insert",
  ...OPTS,
  async fn() {
    const stub = makeSupabaseStub({ insertMemberError: { code: "23505" } });
    // deno-lint-ignore no-explicit-any
    const result = await ensureIndividualGroup(stub as any, "off-1", "stu-3");
    assertEquals(result.created, true);
    // Group still got created even though the member insert "raced".
    assertEquals(stub.groupsTable.length, 1);
  },
});
