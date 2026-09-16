import { assert, assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { resolveOrCreateGradeLevel } from "../grade-levels.ts";

// ── Minimal mock of the supabase-js query builder chain we call ─────────

interface Op {
  table: string;
  action: "select" | "insert";
  filters: Record<string, unknown>;
  payload?: Record<string, unknown>;
  order?: { column: string; ascending: boolean };
  limit?: number;
  select?: string;
}

interface MockResponse {
  data?: unknown;
  // Error shape mirrors what supabase-js surfaces so the helper can pattern-match on it.
  error?: { code?: string; message?: string } | null;
}

type Responder = (op: Op) => MockResponse;

function createMockClient(responder: Responder): { client: unknown; ops: Op[] } {
  const ops: Op[] = [];

  function chain(op: Op): Record<string, unknown> {
    const api: Record<string, unknown> = {};
    api.select = (cols?: string) => {
      op.action = op.action ?? "select";
      op.select = cols;
      return chain(op);
    };
    api.eq = (column: string, value: unknown) => {
      op.filters[column] = value;
      return chain(op);
    };
    api.order = (column: string, opts: { ascending: boolean }) => {
      op.order = { column, ascending: opts.ascending };
      return chain(op);
    };
    api.limit = (n: number) => {
      op.limit = n;
      return chain(op);
    };
    api.maybeSingle = () => {
      ops.push(op);
      return Promise.resolve(responder(op));
    };
    api.single = api.maybeSingle;
    return api;
  }

  const client = {
    from(table: string) {
      return {
        select(cols?: string) {
          const op: Op = { table, action: "select", filters: {}, select: cols };
          return chain(op);
        },
        insert(payload: Record<string, unknown>) {
          const op: Op = { table, action: "insert", filters: {}, payload };
          return chain(op);
        },
      };
    },
  };

  return { client, ops };
}

// ── Tests ──────────────────────────────────────────────────────────────

Deno.test("resolveOrCreateGradeLevel: returns null for empty code", async () => {
  const { client, ops } = createMockClient(() => ({ data: null, error: null }));
  const result = await resolveOrCreateGradeLevel(client, {
    institutionId: "inst-1",
    code: "",
  });
  assertEquals(result, null);
  assertEquals(ops.length, 0);
});

Deno.test("resolveOrCreateGradeLevel: returns null for whitespace code", async () => {
  const { client, ops } = createMockClient(() => ({ data: null, error: null }));
  const result = await resolveOrCreateGradeLevel(client, {
    institutionId: "inst-1",
    code: "   ",
  });
  assertEquals(result, null);
  assertEquals(ops.length, 0);
});

Deno.test("resolveOrCreateGradeLevel: returns null for null code", async () => {
  const { client, ops } = createMockClient(() => ({ data: null, error: null }));
  const result = await resolveOrCreateGradeLevel(client, {
    institutionId: "inst-1",
    code: null,
  });
  assertEquals(result, null);
  assertEquals(ops.length, 0);
});

Deno.test("resolveOrCreateGradeLevel: returns existing id when row present", async () => {
  const { client, ops } = createMockClient((op) => {
    if (op.action === "select" && op.table === "grade_levels") {
      assertEquals(op.filters.institution_id, "inst-1");
      assertEquals(op.filters.code, "dimotiko_1");
      return { data: { id: "gl-existing" }, error: null };
    }
    throw new Error(`unexpected op: ${JSON.stringify(op)}`);
  });
  const result = await resolveOrCreateGradeLevel(client, {
    institutionId: "inst-1",
    code: "dimotiko_1",
  });
  assertEquals(result, "gl-existing");
  assertEquals(ops.length, 1);
  assertEquals(ops[0].action, "select");
});

Deno.test("resolveOrCreateGradeLevel: inserts Greek grade with taxonomy labels", async () => {
  let insertPayload: Record<string, unknown> | undefined;
  const { client } = createMockClient((op) => {
    if (op.action === "select" && !op.payload && !op.order) {
      // Initial lookup miss.
      return { data: null, error: null };
    }
    if (op.action === "insert") {
      insertPayload = op.payload;
      return { data: { id: "gl-new-greek" }, error: null };
    }
    throw new Error(`unexpected op: ${JSON.stringify(op)}`);
  });
  const result = await resolveOrCreateGradeLevel(client, {
    institutionId: "inst-1",
    code: "gymnasio_2",
  });
  assertEquals(result, "gl-new-greek");
  assert(insertPayload, "expected an insert payload");
  assertEquals(insertPayload!.institution_id, "inst-1");
  assertEquals(insertPayload!.code, "gymnasio_2");
  assertEquals(insertPayload!.label_el, "2η Γυμνασίου");
  assertEquals(insertPayload!.label_en, "2nd Grade Middle School");
  assertEquals(insertPayload!.school_level, "gymnasio");
  assertEquals(insertPayload!.ordinal, 8);
  assertEquals(insertPayload!.is_generic, false);
});

Deno.test("resolveOrCreateGradeLevel: trims whitespace before lookup and insert", async () => {
  let selectedCode: unknown;
  let insertPayload: Record<string, unknown> | undefined;
  const { client } = createMockClient((op) => {
    if (op.action === "select" && !op.payload && !op.order) {
      selectedCode = op.filters.code;
      return { data: null, error: null };
    }
    if (op.action === "insert") {
      insertPayload = op.payload;
      return { data: { id: "gl-trimmed" }, error: null };
    }
    throw new Error(`unexpected op: ${JSON.stringify(op)}`);
  });
  const result = await resolveOrCreateGradeLevel(client, {
    institutionId: "inst-1",
    code: "  lykeio_1  ",
  });
  assertEquals(result, "gl-trimmed");
  assertEquals(selectedCode, "lykeio_1");
  assertEquals(insertPayload!.code, "lykeio_1");
});

Deno.test("resolveOrCreateGradeLevel: inserts generic grade with is_generic=true and ordinal starting at 100", async () => {
  let insertPayload: Record<string, unknown> | undefined;
  const { client } = createMockClient((op) => {
    if (op.action === "select" && op.order?.column === "ordinal") {
      // No existing generic rows.
      return { data: null, error: null };
    }
    if (op.action === "select" && !op.payload) {
      // Initial lookup miss.
      return { data: null, error: null };
    }
    if (op.action === "insert") {
      insertPayload = op.payload;
      return { data: { id: "gl-generic" }, error: null };
    }
    throw new Error(`unexpected op: ${JSON.stringify(op)}`);
  });
  const result = await resolveOrCreateGradeLevel(client, {
    institutionId: "inst-1",
    code: "General",
  });
  assertEquals(result, "gl-generic");
  assertEquals(insertPayload!.code, "General");
  assertEquals(insertPayload!.label_el, "General");
  assertEquals(insertPayload!.label_en, "General");
  assertEquals(insertPayload!.school_level, null);
  assertEquals(insertPayload!.ordinal, 100);
  assertEquals(insertPayload!.is_generic, true);
});

Deno.test("resolveOrCreateGradeLevel: next generic ordinal increments past existing max", async () => {
  let insertPayload: Record<string, unknown> | undefined;
  const { client } = createMockClient((op) => {
    if (op.action === "select" && op.order?.column === "ordinal") {
      return { data: { ordinal: 103 }, error: null };
    }
    if (op.action === "select" && !op.payload) {
      return { data: null, error: null };
    }
    if (op.action === "insert") {
      insertPayload = op.payload;
      return { data: { id: "gl-generic-104" }, error: null };
    }
    throw new Error(`unexpected op: ${JSON.stringify(op)}`);
  });
  await resolveOrCreateGradeLevel(client, {
    institutionId: "inst-1",
    code: "Advanced",
  });
  assertEquals(insertPayload!.ordinal, 104);
});

Deno.test("resolveOrCreateGradeLevel: re-selects on unique-violation race", async () => {
  let selectCalls = 0;
  const { client } = createMockClient((op) => {
    if (op.action === "select" && !op.payload && !op.order) {
      selectCalls += 1;
      if (selectCalls === 1) return { data: null, error: null }; // initial miss
      return { data: { id: "gl-raced-winner" }, error: null }; // post-conflict re-select
    }
    if (op.action === "insert") {
      return {
        data: null,
        error: { code: "23505", message: "duplicate key value violates unique constraint" },
      };
    }
    throw new Error(`unexpected op: ${JSON.stringify(op)}`);
  });
  const result = await resolveOrCreateGradeLevel(client, {
    institutionId: "inst-1",
    code: "dimotiko_1",
  });
  assertEquals(result, "gl-raced-winner");
  assertEquals(selectCalls, 2);
});

Deno.test("resolveOrCreateGradeLevel: rethrows non-conflict insert errors", async () => {
  const { client } = createMockClient((op) => {
    if (op.action === "select") return { data: null, error: null };
    if (op.action === "insert") {
      return { data: null, error: { code: "42501", message: "permission denied" } };
    }
    throw new Error("unexpected");
  });
  let thrown: unknown = null;
  try {
    await resolveOrCreateGradeLevel(client, {
      institutionId: "inst-1",
      code: "dimotiko_1",
    });
  } catch (e) {
    thrown = e;
  }
  assert(thrown, "expected throw");
});
