import { describe, it, expect, vi } from "vitest";
import {
  deriveGradeOptions,
  filterGradeOptionsBySchoolLevels,
  findGradeLevelIdByCode,
  getGradeLabelFromRows,
  getGradeLevelGroupsById,
  ensureGradeLevel,
  type GradeLevelRow,
} from "@/lib/grade-levels";

function makeRows(): GradeLevelRow[] {
  return [
    {
      id: "id-generic-2",
      institution_id: "inst-1",
      code: "General",
      label_el: "General",
      label_en: "General",
      ordinal: 101,
      school_level: null,
      is_generic: true,
    },
    {
      id: "id-dimotiko-1",
      institution_id: "inst-1",
      code: "dimotiko_1",
      label_el: "1η Δημοτικού",
      label_en: "1st Grade Primary",
      ordinal: 1,
      school_level: "dimotiko",
      is_generic: false,
    },
    {
      id: "id-generic-1",
      institution_id: "inst-1",
      code: "Beginners",
      label_el: "Beginners",
      label_en: "Beginners",
      ordinal: 100,
      school_level: null,
      is_generic: true,
    },
  ];
}

describe("deriveGradeOptions", () => {
  it("sorts by ordinal so Greek grades come before generics", () => {
    const options = deriveGradeOptions(makeRows());
    expect(options.map((o) => o.value)).toEqual([
      "dimotiko_1",
      "Beginners",
      "General",
    ]);
  });

  it("carries through labelEl/labelEn/id/isGeneric", () => {
    const options = deriveGradeOptions(makeRows());
    const dimotiko = options.find((o) => o.value === "dimotiko_1");
    expect(dimotiko).toMatchObject({
      id: "id-dimotiko-1",
      labelEl: "1η Δημοτικού",
      labelEn: "1st Grade Primary",
      schoolLevel: "dimotiko",
      isGeneric: false,
    });
    const generic = options.find((o) => o.value === "General");
    expect(generic?.isGeneric).toBe(true);
    expect(generic?.schoolLevel).toBeNull();
  });

  it("handles null/undefined rows", () => {
    expect(deriveGradeOptions(null)).toEqual([]);
    expect(deriveGradeOptions(undefined)).toEqual([]);
  });
});

describe("findGradeLevelIdByCode", () => {
  it("returns the id when the code exists", () => {
    expect(findGradeLevelIdByCode(makeRows(), "General")).toBe("id-generic-2");
    expect(findGradeLevelIdByCode(makeRows(), "dimotiko_1")).toBe("id-dimotiko-1");
  });

  it("returns null for unknown/empty codes", () => {
    expect(findGradeLevelIdByCode(makeRows(), "gymnasio_1")).toBeNull();
    expect(findGradeLevelIdByCode(makeRows(), null)).toBeNull();
    expect(findGradeLevelIdByCode(makeRows(), "")).toBeNull();
  });
});

describe("getGradeLabelFromRows", () => {
  it("returns the row's label for a matching code (el and en)", () => {
    expect(getGradeLabelFromRows(makeRows(), "dimotiko_1", "el")).toBe("1η Δημοτικού");
    expect(getGradeLabelFromRows(makeRows(), "dimotiko_1", "en")).toBe("1st Grade Primary");
  });

  it("returns the generic label from the row (not the fixed taxonomy)", () => {
    expect(getGradeLabelFromRows(makeRows(), "General", "el")).toBe("General");
    expect(getGradeLabelFromRows(makeRows(), "Beginners", "en")).toBe("Beginners");
  });

  it("falls back to the fixed Greek taxonomy when the row isn't fetched yet", () => {
    // gymnasio_2 is a Greek code — the fixed map answers even with empty rows.
    expect(getGradeLabelFromRows([], "gymnasio_2", "el")).toBe("2η Γυμνασίου");
  });

  it("returns the code itself for unknown/generic codes with no row", () => {
    expect(getGradeLabelFromRows([], "General", "el")).toBe("General");
  });

  it("returns empty string for null/undefined code", () => {
    expect(getGradeLabelFromRows(makeRows(), null, "el")).toBe("");
    expect(getGradeLabelFromRows(makeRows(), undefined, "en")).toBe("");
  });
});

describe("getGradeLevelGroupsById", () => {
  const rows = makeRows();

  const classes = [
    { id: "c-general-1", grade_level_id: "id-generic-2", section_name: "1", category: null },
    { id: "c-dim1-a", grade_level_id: "id-dimotiko-1", section_name: "Α", category: null },
    { id: "c-dim1-b", grade_level_id: "id-dimotiko-1", section_name: "Β", category: null },
    // FK-less class — must be dropped from the grouping (caller shows it separately)
    { id: "c-orphan", grade_level_id: null, section_name: "Α", category: null },
  ];

  it("groups classes by grade_level_id (FK identity) and labels from rows", () => {
    const groups = getGradeLevelGroupsById(classes, rows);
    const ids = groups.map((g) => g.gradeLevelId);
    // Greek grade (ordinal 1) before generic (ordinal 101), FK-less dropped.
    expect(ids).toEqual(["id-dimotiko-1", "id-generic-2"]);
    const dim = groups.find((g) => g.gradeLevelId === "id-dimotiko-1");
    expect(dim?.label).toBe("1η Δημοτικού");
    expect(dim?.classes).toHaveLength(2);
    const generic = groups.find((g) => g.gradeLevelId === "id-generic-2");
    expect(generic?.label).toBe("General");
    expect(generic?.classes).toHaveLength(1);
  });

  it("respects language when picking labels", () => {
    const groups = getGradeLevelGroupsById(classes, rows, "en");
    const dim = groups.find((g) => g.gradeLevelId === "id-dimotiko-1");
    expect(dim?.label).toBe("1st Grade Primary");
  });

  it("orders groups by ordinal, then label as tiebreaker", () => {
    const rowsSameOrdinal: GradeLevelRow[] = [
      { id: "a", institution_id: "i", code: "AA", label_el: "AA", label_en: "AA", ordinal: 100, school_level: null, is_generic: true },
      { id: "b", institution_id: "i", code: "BB", label_el: "BB", label_en: "BB", ordinal: 100, school_level: null, is_generic: true },
    ];
    const clsSameOrdinal = [
      { id: "c-b", grade_level_id: "b", section_name: "1", category: null },
      { id: "c-a", grade_level_id: "a", section_name: "1", category: null },
    ];
    const groups = getGradeLevelGroupsById(clsSameOrdinal, rowsSameOrdinal);
    expect(groups.map((g) => g.gradeLevelId)).toEqual(["a", "b"]);
  });

  it("returns an empty label when a grade_level_id has no matching row", () => {
    const groups = getGradeLevelGroupsById(
      [{ id: "x", grade_level_id: "missing-id", section_name: "Α", category: null }],
      [],
    );
    // Post-#799: the TEXT column is gone, so with no matching row we can't
    // resolve a label. Renderers show the group with an empty label until
    // the grade_levels rows finish loading.
    expect(groups[0].label).toBe("");
  });
});

describe("ensureGradeLevel", () => {
  function makeSupabaseMock(opts: {
    existingId?: string | null;
    maxGenericOrdinal?: number | null;
    insertedId?: string;
    onUpsert?: (row: unknown) => void;
  }) {
    const upsertRow = vi.fn();
    return {
      spies: { upsertRow },
      client: {
        from: (table: string) => {
          if (table !== "grade_levels") throw new Error(`unexpected table ${table}`);
          // The two SELECTs used by ensureGradeLevel differ in the chain
          // segment following the second `.eq(...)`:
          //   existing lookup: `.eq(code, ...).maybeSingle()`
          //   max-ordinal lookup: `.eq(is_generic, true).order(...).limit(1).maybeSingle()`
          // Return a builder whose second `.eq()` exposes both shapes.
          const existingResult = () =>
            Promise.resolve({
              data: opts.existingId ? { id: opts.existingId } : null,
              error: null,
            });
          const maxResult = () =>
            Promise.resolve({
              data:
                opts.maxGenericOrdinal != null
                  ? { ordinal: opts.maxGenericOrdinal }
                  : null,
              error: null,
            });
          const fetchAfterUpsert = () =>
            Promise.resolve({
              data: { id: opts.insertedId ?? "new-id" },
              error: null,
            });
          const secondEq = {
            maybeSingle: existingResult,
            // Used by the post-upsert fetch: .select("id").eq(...).eq(...).single()
            single: fetchAfterUpsert,
            order: () => ({
              limit: () => ({
                maybeSingle: maxResult,
              }),
            }),
          };
          return {
            select: () => ({
              eq: () => ({
                eq: () => secondEq,
              }),
            }),
            upsert: (row: unknown) => {
              upsertRow(row);
              opts.onUpsert?.(row);
              // ignoreDuplicates: no chained select — just resolves with { error }
              return Promise.resolve({ error: null });
            },
          };
        },
      },
    };
  }

  it("returns the id of the existing row without inserting", async () => {
    const { client, spies } = makeSupabaseMock({ existingId: "existing-id" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const id = await ensureGradeLevel(client as any, "inst-1", "dimotiko_1");
    expect(id).toBe("existing-id");
    expect(spies.upsertRow).not.toHaveBeenCalled();
  });

  it("inserts a Greek grade with taxonomy labels + ordinal", async () => {
    const { client, spies } = makeSupabaseMock({
      existingId: null,
      insertedId: "new-greek-id",
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const id = await ensureGradeLevel(client as any, "inst-1", "gymnasio_2");
    expect(id).toBe("new-greek-id");
    expect(spies.upsertRow).toHaveBeenCalledWith(
      expect.objectContaining({
        institution_id: "inst-1",
        code: "gymnasio_2",
        label_el: "2η Γυμνασίου",
        label_en: "2nd Grade Middle School",
        school_level: "gymnasio",
        is_generic: false,
        ordinal: 8,
      }),
    );
  });

  it("inserts a generic grade with next per-institution ordinal starting at 100", async () => {
    const { client, spies } = makeSupabaseMock({
      existingId: null,
      maxGenericOrdinal: null,
      insertedId: "new-generic-id",
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ensureGradeLevel(client as any, "inst-1", "Advanced");
    expect(spies.upsertRow).toHaveBeenCalledWith(
      expect.objectContaining({
        institution_id: "inst-1",
        code: "Advanced",
        label_el: "Advanced",
        label_en: "Advanced",
        school_level: null,
        is_generic: true,
        ordinal: 100,
      }),
    );
  });

  it("increments generic ordinal when other generics exist", async () => {
    const { client, spies } = makeSupabaseMock({
      existingId: null,
      maxGenericOrdinal: 102,
      insertedId: "new-generic-id",
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ensureGradeLevel(client as any, "inst-1", "Level 4");
    expect(spies.upsertRow).toHaveBeenCalledWith(
      expect.objectContaining({ code: "Level 4", ordinal: 103, is_generic: true }),
    );
  });
});

describe("filterGradeOptionsBySchoolLevels", () => {
  const allLevelRows: GradeLevelRow[] = [
    {
      id: "id-dimotiko-6",
      institution_id: "inst-1",
      code: "dimotiko_6",
      label_el: "6η Δημοτικού",
      label_en: "6th Grade Primary",
      ordinal: 6,
      school_level: "dimotiko",
      is_generic: false,
    },
    {
      id: "id-gymnasio-1",
      institution_id: "inst-1",
      code: "gymnasio_1",
      label_el: "1η Γυμνασίου",
      label_en: "1st Grade Middle School",
      ordinal: 7,
      school_level: "gymnasio",
      is_generic: false,
    },
    {
      id: "id-lykeio-1",
      institution_id: "inst-1",
      code: "lykeio_1",
      label_el: "1η Λυκείου",
      label_en: "1st Grade High School",
      ordinal: 10,
      school_level: "lykeio",
      is_generic: false,
    },
    {
      id: "id-generic",
      institution_id: "inst-1",
      code: "General",
      label_el: "General",
      label_en: "General",
      ordinal: 100,
      school_level: null,
      is_generic: true,
    },
  ];

  it("keeps only options whose school level the institution offers", () => {
    const options = deriveGradeOptions(allLevelRows);
    const filtered = filterGradeOptionsBySchoolLevels(options, ["lykeio"]);
    expect(filtered.map((o) => o.value)).toEqual(["lykeio_1"]);
  });

  it("drops generic (null school level) options when levels are set", () => {
    const options = deriveGradeOptions(allLevelRows);
    const filtered = filterGradeOptionsBySchoolLevels(options, ["gymnasio"]);
    expect(filtered.map((o) => o.value)).toEqual(["gymnasio_1"]);
  });

  it("returns the full list when school levels is empty", () => {
    const options = deriveGradeOptions(allLevelRows);
    expect(filterGradeOptionsBySchoolLevels(options, [])).toBe(options);
  });

  it("returns the full list when school levels is null/undefined", () => {
    const options = deriveGradeOptions(allLevelRows);
    expect(filterGradeOptionsBySchoolLevels(options, null)).toBe(options);
    expect(filterGradeOptionsBySchoolLevels(options, undefined)).toBe(options);
  });

  it("falls back to the full list when filtering would empty the dropdown", () => {
    const genericOnly = deriveGradeOptions([allLevelRows[3]]);
    const filtered = filterGradeOptionsBySchoolLevels(genericOnly, ["lykeio"]);
    expect(filtered).toBe(genericOnly);
  });
});
