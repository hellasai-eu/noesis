/**
 * #1100 — InlineGradeSelector: the cascade behind a one-click grade change.
 *
 * The control looks like a dropdown, but each change rewrites the user's
 * enrolment or teaching graph. Three rules live only here:
 *
 *  - STUDENT: changing a grade drops the class enrolments that no longer match
 *    it, and clearing the grade drops all of them. Matching is FK identity on
 *    `grade_level_id` — the denormalized TEXT column went away in #799, so a
 *    comparison against the code string would silently match nothing and strand
 *    the student in every class they were in.
 *  - INSTRUCTOR, unchecking a grade: this is the sharp one. Removing a grade
 *    unassigns the instructor from courses offered in that grade's classes —
 *    but ONLY from courses that no remaining grade still covers. Skip that
 *    check and you rip an instructor off a course they still teach, from a
 *    click that was meant to narrow their scope by one year.
 *  - INSTRUCTOR, checking a grade: a duplicate (23505) is not an error. It
 *    means the DB already agreed and only the local state was behind, so the UI
 *    syncs instead of showing a failure.
 *
 * `useInstitutionGradeLevels` is mocked, but over the REAL `@/lib/grade-levels`
 * helpers on a fixture row set — the code↔id mapping is exactly what the
 * cascade keys on, so faking it would fake the thing under test.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

type Filter = { op: string; col: string; val: unknown };
type Write = { table: string; values?: Record<string, unknown>; filters: Filter[] };

const db = vi.hoisted(() => ({
  gradeRows: [] as Array<Record<string, unknown>>,
  /** class_enrollments rows in the joined shape the component selects. */
  enrollments: [] as Array<{
    class_id: string;
    classes: { id: string; grade_level_id: string; name: string; institution_id: string };
  }>,
  classes: [] as Array<{ id: string; institution_id: string; grade_level_id: string }>,
  offerings: [] as Array<{ class_id: string; course_id: string }>,
  courses: [] as Array<{ id: string; title: string }>,
  /** Per-(table, mode) failures, e.g. `user_institutions:update`. */
  errors: {} as Record<string, { message?: string; code?: string } | undefined>,
  inserts: [] as Array<{ table: string; values: Record<string, unknown> }>,
  updates: [] as Write[],
  deletes: [] as Write[],
  selects: [] as Array<{ table: string; filters: Filter[] }>,
}));

vi.mock("@/integrations/supabase/client", () => {
  const buildChain = (table: string) => {
    const filters: Filter[] = [];
    let mode: "select" | "update" | "delete" | "insert" = "select";
    let values: Record<string, unknown> = {};
    const chain: Record<string, unknown> = {};

    const push = (op: string) => (col: string, val: unknown) => {
      filters.push({ op, col, val });
      return chain;
    };
    chain.select = () => {
      mode = "select";
      return chain;
    };
    chain.update = (v: Record<string, unknown>) => {
      mode = "update";
      values = v;
      return chain;
    };
    chain.delete = () => {
      mode = "delete";
      return chain;
    };
    chain.insert = (v: Record<string, unknown>) => {
      mode = "insert";
      values = v;
      return chain;
    };
    chain.order = () => chain;
    chain.eq = push("eq");
    chain.in = push("in");

    const find = (op: string, col: string) => filters.find((f) => f.op === op && f.col === col);

    chain.then = (resolve: (v: unknown) => unknown) => {
      const failure = db.errors[`${table}:${mode}`];
      if (failure) return Promise.resolve(resolve({ data: null, error: failure }));

      if (mode === "insert") {
        db.inserts.push({ table, values });
        return Promise.resolve(resolve({ data: null, error: null }));
      }
      if (mode === "update") {
        db.updates.push({ table, values, filters });
        return Promise.resolve(resolve({ data: null, error: null }));
      }
      if (mode === "delete") {
        db.deletes.push({ table, filters });
        return Promise.resolve(resolve({ data: null, error: null }));
      }

      db.selects.push({ table, filters });

      if (table === "class_enrollments") {
        const inst = find("eq", "classes.institution_id");
        const rows = db.enrollments.filter(
          (e) => !inst || e.classes.institution_id === inst.val,
        );
        return Promise.resolve(resolve({ data: rows.map((r) => ({ ...r })), error: null }));
      }

      if (table === "classes") {
        const inst = find("eq", "institution_id");
        const oneGrade = find("eq", "grade_level_id");
        const manyGrades = find("in", "grade_level_id");
        const rows = db.classes.filter((c) => {
          if (inst && c.institution_id !== inst.val) return false;
          if (oneGrade && c.grade_level_id !== oneGrade.val) return false;
          if (manyGrades && !(manyGrades.val as string[]).includes(c.grade_level_id)) return false;
          return true;
        });
        return Promise.resolve(resolve({ data: rows.map((c) => ({ id: c.id })), error: null }));
      }

      if (table === "offerings") {
        const many = find("in", "class_id");
        const rows = db.offerings.filter(
          (o) => !many || (many.val as string[]).includes(o.class_id),
        );
        return Promise.resolve(
          resolve({ data: rows.map((o) => ({ course_id: o.course_id })), error: null }),
        );
      }

      if (table === "courses") {
        const many = find("in", "id");
        const rows = db.courses.filter((c) => !many || (many.val as string[]).includes(c.id));
        return Promise.resolve(resolve({ data: rows.map((c) => ({ ...c })), error: null }));
      }

      return Promise.resolve(resolve({ data: [], error: null }));
    };
    return chain;
  };

  return { supabase: { from: vi.fn((table: string) => buildChain(table)) } };
});

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: toastMocks }));

/**
 * The hook is replaced, but its lookups run through the real grade-levels
 * helpers — the code↔id mapping is precisely what the cascade depends on.
 */
vi.mock("@/hooks/useInstitutionGradeLevels", async () => {
  const lib = await vi.importActual<typeof import("@/lib/grade-levels")>("@/lib/grade-levels");
  return {
    useInstitutionGradeLevels: () => {
      const rows = db.gradeRows as never;
      return {
        rows,
        options: lib.deriveGradeOptions(rows),
        loading: false,
        findIdByCode: (code: string | null | undefined) =>
          lib.findGradeLevelIdByCode(rows, code),
        findCodeById: (id: string | null | undefined) => lib.findGradeCodeById(rows, id),
        getLabel: (code: string | null | undefined, lang: string) =>
          lib.getGradeLabelFromRows(rows, code, lang),
        getLabelById: () => "",
      };
    },
  };
});

import { InlineGradeSelector } from "@/components/InlineGradeSelector";

const USER = "user-1";
const INST = "inst-1";
const USER_INST = "ui-1";

function gradeRow(n: number) {
  return {
    id: `gl-${n}`,
    institution_id: INST,
    code: `dimotiko_${n}`,
    label_el: `${n}η Δημοτικού`,
    label_en: `Grade ${n}`,
    ordinal: n,
    school_level: "dimotiko",
    is_generic: false,
  };
}

function seedClass(id: string, gradeId: string, name = `Class ${id}`) {
  db.classes.push({ id, institution_id: INST, grade_level_id: gradeId });
  return { id, gradeId, name };
}

/** `gradeId` may be null — an ungraded class is a real row shape. */
function seedEnrollment(classId: string, gradeId: string | null, name: string) {
  db.enrollments.push({
    class_id: classId,
    classes: {
      id: classId,
      grade_level_id: gradeId as string,
      name,
      institution_id: INST,
    },
  });
}

function renderSelector(
  props: Partial<React.ComponentProps<typeof InlineGradeSelector>> = {},
) {
  const onGradeChange = vi.fn();
  render(
    <InlineGradeSelector
      userId={USER}
      institutionId={INST}
      userInstitutionId={USER_INST}
      role="student"
      onGradeChange={onGradeChange}
      {...props}
    />,
  );
  return { onGradeChange };
}

/** The delete recorded against `table`, or undefined. */
function deleteOn(table: string) {
  return db.deletes.find((d) => d.table === table);
}

/**
 * The popover checkbox for one grade code. Rows are only distinguishable by
 * their label, and several may be ticked at once, so "the first checked box"
 * is not good enough.
 */
function checkboxFor(code: string) {
  const row = db.gradeRows.find((r) => r.code === code) as { label_el: string } | undefined;
  if (!row) throw new Error(`no fixture grade row for "${code}"`);
  const label = screen
    .getAllByText(new RegExp(row.label_el))
    .map((n) => n.closest("label"))
    .find((l): l is HTMLLabelElement => !!l?.querySelector('[role="checkbox"]'));
  const box = label?.querySelector('[role="checkbox"]');
  if (!box) throw new Error(`no checkbox for "${code}"`);
  return box as Element;
}

beforeAll(() => {
  // Radix Select/Popover/Checkbox all need the pointer shims.
  if (!Element.prototype.hasPointerCapture) {
    (Element.prototype as unknown as { hasPointerCapture: () => boolean }).hasPointerCapture =
      () => false;
  }
  if (!Element.prototype.setPointerCapture) {
    (Element.prototype as unknown as { setPointerCapture: () => void }).setPointerCapture =
      () => {};
  }
  if (!Element.prototype.releasePointerCapture) {
    (
      Element.prototype as unknown as { releasePointerCapture: () => void }
    ).releasePointerCapture = () => {};
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  db.gradeRows = [gradeRow(1), gradeRow(2), gradeRow(3)];
  db.enrollments = [];
  db.classes = [];
  db.offerings = [];
  db.courses = [];
  db.errors = {};
  db.inserts = [];
  db.updates = [];
  db.deletes = [];
  db.selects = [];
});

describe("InlineGradeSelector — which grades are offered", () => {
  it("offers only the grades the institution's classes actually use", async () => {
    const user = userEvent.setup();
    renderSelector({ availableGradeLevelIds: ["gl-1", "gl-3"] });

    await user.click(screen.getByRole("combobox"));

    expect(await screen.findByRole("option", { name: /1η Δημοτικού/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /3η Δημοτικού/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /2η Δημοτικού/ })).not.toBeInTheDocument();
  });

  it("offers the whole taxonomy when no in-use set is supplied", async () => {
    const user = userEvent.setup();
    renderSelector();

    await user.click(screen.getByRole("combobox"));

    expect(await screen.findByRole("option", { name: /2η Δημοτικού/ })).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(4); // 3 grades + "No grade"
  });

  it("keeps a stale current grade visible so an admin can clear it (#805)", async () => {
    const user = userEvent.setup();
    // The student sits in a grade the institution no longer runs classes for.
    renderSelector({ availableGradeLevelIds: ["gl-1"], currentGradeLevel: "dimotiko_3" });

    await user.click(screen.getByRole("combobox"));

    expect(await screen.findByRole("option", { name: /3η Δημοτικού/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /2η Δημοτικού/ })).not.toBeInTheDocument();
  });
});

describe("InlineGradeSelector — student", () => {
  async function pickGrade(name: RegExp) {
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name }));
    return user;
  }

  it("writes the grade as an FK id against this user and institution", async () => {
    renderSelector();
    await pickGrade(/2η Δημοτικού/);

    await waitFor(() => expect(db.updates).toHaveLength(1));
    expect(db.updates[0]).toEqual({
      table: "user_institutions",
      values: { grade_level_id: "gl-2" },
      filters: [
        { op: "eq", col: "user_id", val: USER },
        { op: "eq", col: "institution_id", val: INST },
      ],
    });
  });

  it("drops enrolments in other grades and keeps the matching one", async () => {
    seedEnrollment("cls-a", "gl-1", "Alpha");
    seedEnrollment("cls-b", "gl-2", "Beta");
    seedEnrollment("cls-c", "gl-3", "Gamma");

    const { onGradeChange } = renderSelector();
    await pickGrade(/2η Δημοτικού/);

    await waitFor(() => expect(deleteOn("class_enrollments")).toBeDefined());
    const del = deleteOn("class_enrollments")!;
    expect(del.filters).toEqual([
      { op: "eq", col: "user_id", val: USER },
      { op: "in", col: "class_id", val: ["cls-a", "cls-c"] },
    ]);
    expect(onGradeChange).toHaveBeenCalledWith(["dimotiko_2"], ["cls-a", "cls-c"]);
    expect(toastMocks.success).toHaveBeenCalledWith("Grade updated. Removed from Alpha, Gamma.");
  });

  it("leaves the student enrolled when every class already matches", async () => {
    seedEnrollment("cls-b", "gl-2", "Beta");

    const { onGradeChange } = renderSelector();
    await pickGrade(/2η Δημοτικού/);

    await waitFor(() => expect(toastMocks.success).toHaveBeenCalledWith("Grade updated"));
    expect(deleteOn("class_enrollments")).toBeUndefined();
    expect(onGradeChange).toHaveBeenCalledWith(["dimotiko_2"], []);
  });

  it("clearing the grade writes null and drops every enrolment", async () => {
    seedEnrollment("cls-a", "gl-1", "Alpha");
    seedEnrollment("cls-b", "gl-2", "Beta");
    // An ungraded class too: "no grade" must not accidentally *match* a class
    // with no grade and leave the student enrolled in it.
    seedEnrollment("cls-c", null, "Gamma");

    const { onGradeChange } = renderSelector({ currentGradeLevel: "dimotiko_1" });
    await pickGrade(/No grade/);

    await waitFor(() => expect(db.updates).toHaveLength(1));
    expect(db.updates[0].values).toEqual({ grade_level_id: null });
    expect(deleteOn("class_enrollments")!.filters).toContainEqual({
      op: "in",
      col: "class_id",
      val: ["cls-a", "cls-b", "cls-c"],
    });
    expect(onGradeChange).toHaveBeenCalledWith([], ["cls-a", "cls-b", "cls-c"]);
  });

  it("looks at this institution's enrolments only", async () => {
    renderSelector();
    await pickGrade(/2η Δημοτικού/);

    await waitFor(() =>
      expect(db.selects.some((s) => s.table === "class_enrollments")).toBe(true),
    );
    const sel = db.selects.find((s) => s.table === "class_enrollments")!;
    expect(sel.filters).toEqual(
      expect.arrayContaining([
        { op: "eq", col: "user_id", val: USER },
        { op: "eq", col: "classes.institution_id", val: INST },
      ]),
    );
  });

  it("touches no enrolment when the grade write itself fails", async () => {
    seedEnrollment("cls-a", "gl-1", "Alpha");
    db.errors["user_institutions:update"] = { message: "denied" };

    const { onGradeChange } = renderSelector();
    await pickGrade(/2η Δημοτικού/);

    await waitFor(() => expect(toastMocks.error).toHaveBeenCalledWith("denied"));
    expect(db.deletes).toHaveLength(0);
    expect(onGradeChange).not.toHaveBeenCalled();
  });

  it("reports a failed enrolment cleanup rather than claiming success", async () => {
    seedEnrollment("cls-a", "gl-1", "Alpha");
    db.errors["class_enrollments:delete"] = { message: "delete denied" };

    const { onGradeChange } = renderSelector();
    await pickGrade(/2η Δημοτικού/);

    await waitFor(() => expect(toastMocks.error).toHaveBeenCalledWith("delete denied"));
    expect(toastMocks.success).not.toHaveBeenCalled();
    expect(onGradeChange).not.toHaveBeenCalled();
  });
});

describe("InlineGradeSelector — instructor badges", () => {
  it("invites a grade when the instructor has none", () => {
    renderSelector({ role: "instructor", currentGradeLevels: [] });

    expect(screen.getByText("Set grades...")).toBeInTheDocument();
  });

  it("badges each assigned grade in the institution's own order", () => {
    renderSelector({ role: "instructor", currentGradeLevels: ["dimotiko_3", "dimotiko_1"] });

    const badges = screen.getAllByText(/η Δημοτικού/);
    expect(badges.map((b) => b.textContent)).toEqual(["1η Δημοτικού", "3η Δημοτικού"]);
  });

  it("still labels a grade the institution no longer runs classes for", async () => {
    const user = userEvent.setup();
    renderSelector({
      role: "instructor",
      availableGradeLevelIds: ["gl-1"],
      currentGradeLevels: ["dimotiko_1", "dimotiko_3"],
    });

    // The out-of-scope grade keeps its real label rather than the raw code.
    expect(screen.getByText("3η Δημοτικού")).toBeInTheDocument();
    expect(screen.queryByText("dimotiko_3")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button"));
    const stale = await screen.findByTitle(
      "This grade is no longer in the institution's class list",
    );
    expect(stale).toHaveTextContent("3η Δημοτικού");
  });
});

describe("InlineGradeSelector — instructor, adding a grade", () => {
  async function checkGrade(code: string, props: Record<string, unknown> = {}) {
    const user = userEvent.setup();
    const rendered = renderSelector({ role: "instructor", currentGradeLevels: [], ...props });
    await user.click(screen.getByRole("button"));
    await screen.findAllByRole("checkbox");
    await user.click(checkboxFor(code));
    return { user, ...rendered };
  }

  it("inserts the grade against the user's institution membership", async () => {
    const { onGradeChange } = await checkGrade("dimotiko_2");

    await waitFor(() => expect(db.inserts).toHaveLength(1));
    expect(db.inserts[0]).toEqual({
      table: "user_institution_grades",
      values: { user_institution_id: USER_INST, grade_level_id: "gl-2" },
    });
    expect(onGradeChange).toHaveBeenCalledWith(["dimotiko_2"]);
  });

  it("appends to the grades the instructor already has", async () => {
    const { onGradeChange } = await checkGrade("dimotiko_2", {
      currentGradeLevels: ["dimotiko_1"],
    });

    await waitFor(() => expect(onGradeChange).toHaveBeenCalled());
    expect(onGradeChange).toHaveBeenCalledWith(["dimotiko_1", "dimotiko_2"]);
  });

  it("treats a duplicate as the UI being behind, not as a failure", async () => {
    db.errors["user_institution_grades:insert"] = { code: "23505", message: "duplicate key" };

    const { onGradeChange } = await checkGrade("dimotiko_2", {
      currentGradeLevels: ["dimotiko_1"],
    });

    await waitFor(() =>
      expect(onGradeChange).toHaveBeenCalledWith(["dimotiko_1", "dimotiko_2"]),
    );
    expect(toastMocks.error).not.toHaveBeenCalled();
  });

  it("surfaces any other insert failure", async () => {
    db.errors["user_institution_grades:insert"] = { code: "42501", message: "not permitted" };

    const { onGradeChange } = await checkGrade("dimotiko_2");

    await waitFor(() => expect(toastMocks.error).toHaveBeenCalledWith("not permitted"));
    expect(onGradeChange).not.toHaveBeenCalled();
  });

  it("refuses a grade with no row rather than writing a null FK", async () => {
    // A defensive guard: `grade_level_id` is NOT NULL, so a code that maps to
    // no row must fail loudly rather than reach the insert. Reproduced by
    // emptying the rows the rendered options were derived from — in place, so
    // the lookup the component captured sees the change.
    const user = userEvent.setup();
    const { onGradeChange } = renderSelector({
      role: "instructor",
      currentGradeLevels: [],
    });
    await user.click(screen.getByRole("button"));
    await screen.findAllByRole("checkbox");
    const box = checkboxFor("dimotiko_1");
    db.gradeRows.length = 0;
    await user.click(box);

    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith(
        'Grade level "dimotiko_1" is not registered for this institution',
      ),
    );
    expect(db.inserts).toHaveLength(0);
    expect(onGradeChange).not.toHaveBeenCalled();
  });
});

describe("InlineGradeSelector — instructor, removing a grade", () => {
  /** Opens the popover and unticks the row for `code` specifically. */
  async function uncheckGrade(code: string, props: Record<string, unknown> = {}) {
    const user = userEvent.setup();
    const rendered = renderSelector({
      role: "instructor",
      currentGradeLevels: [code],
      ...props,
    });
    await user.click(screen.getByRole("button"));
    await screen.findAllByRole("checkbox");
    await user.click(checkboxFor(code));
    return { user, ...rendered };
  }

  it("removes the grade row by FK identity", async () => {
    const { onGradeChange } = await uncheckGrade("dimotiko_2");

    await waitFor(() => expect(deleteOn("user_institution_grades")).toBeDefined());
    expect(deleteOn("user_institution_grades")!.filters).toEqual([
      { op: "eq", col: "user_institution_id", val: USER_INST },
      { op: "eq", col: "grade_level_id", val: "gl-2" },
    ]);
    expect(onGradeChange).toHaveBeenCalledWith([], undefined, []);
  });

  it("unassigns the instructor from courses only that grade offered", async () => {
    seedClass("cls-2", "gl-2");
    db.offerings.push({ class_id: "cls-2", course_id: "crs-maths" });
    db.courses.push({ id: "crs-maths", title: "Maths" });

    const { onGradeChange } = await uncheckGrade("dimotiko_2");

    await waitFor(() => expect(deleteOn("course_instructors")).toBeDefined());
    expect(deleteOn("course_instructors")!.filters).toEqual([
      { op: "eq", col: "user_id", val: USER },
      { op: "in", col: "course_id", val: ["crs-maths"] },
    ]);
    expect(onGradeChange).toHaveBeenCalledWith([], undefined, ["crs-maths"]);
    expect(toastMocks.success).toHaveBeenCalledWith(
      "Grade removed. Unassigned from Maths.",
    );
  });

  it("keeps a course that a grade the instructor still holds also offers", async () => {
    // The same course runs in both grades; only grade 2 is being dropped.
    seedClass("cls-2", "gl-2");
    seedClass("cls-1", "gl-1");
    db.offerings.push({ class_id: "cls-2", course_id: "crs-shared" });
    db.offerings.push({ class_id: "cls-1", course_id: "crs-shared" });
    db.courses.push({ id: "crs-shared", title: "Shared" });

    const { onGradeChange } = await uncheckGrade("dimotiko_2", {
      currentGradeLevels: ["dimotiko_1", "dimotiko_2"],
    });

    await waitFor(() => expect(toastMocks.success).toHaveBeenCalledWith("Grade removed."));
    expect(deleteOn("course_instructors")).toBeUndefined();
    expect(onGradeChange).toHaveBeenCalledWith(["dimotiko_1"], undefined, []);
  });

  it("still drops the courses the remaining grades do not cover", async () => {
    seedClass("cls-2", "gl-2");
    seedClass("cls-1", "gl-1");
    db.offerings.push({ class_id: "cls-2", course_id: "crs-shared" });
    db.offerings.push({ class_id: "cls-2", course_id: "crs-only-2" });
    db.offerings.push({ class_id: "cls-1", course_id: "crs-shared" });
    db.courses.push({ id: "crs-shared", title: "Shared" });
    db.courses.push({ id: "crs-only-2", title: "Only Two" });

    await uncheckGrade("dimotiko_2", { currentGradeLevels: ["dimotiko_1", "dimotiko_2"] });

    await waitFor(() => expect(deleteOn("course_instructors")).toBeDefined());
    expect(deleteOn("course_instructors")!.filters).toContainEqual({
      op: "in",
      col: "course_id",
      val: ["crs-only-2"],
    });
  });

  it("clears the section restrictions tied to that grade's classes", async () => {
    seedClass("cls-2a", "gl-2");
    seedClass("cls-2b", "gl-2");

    await uncheckGrade("dimotiko_2");

    await waitFor(() => expect(deleteOn("course_instructor_sections")).toBeDefined());
    expect(deleteOn("course_instructor_sections")!.filters).toEqual([
      { op: "eq", col: "user_id", val: USER },
      { op: "in", col: "class_id", val: ["cls-2a", "cls-2b"] },
    ]);
  });

  it("does no course surgery for a grade with no classes", async () => {
    const { onGradeChange } = await uncheckGrade("dimotiko_2");

    await waitFor(() => expect(toastMocks.success).toHaveBeenCalledWith("Grade removed."));
    expect(deleteOn("course_instructor_sections")).toBeUndefined();
    expect(deleteOn("course_instructors")).toBeUndefined();
    expect(onGradeChange).toHaveBeenCalledWith([], undefined, []);
  });

  it("reports a failed removal instead of reporting success", async () => {
    db.errors["user_institution_grades:delete"] = { message: "remove denied" };

    const { onGradeChange } = await uncheckGrade("dimotiko_2");

    await waitFor(() => expect(toastMocks.error).toHaveBeenCalledWith("remove denied"));
    expect(toastMocks.success).not.toHaveBeenCalled();
    expect(onGradeChange).not.toHaveBeenCalled();
  });
});
