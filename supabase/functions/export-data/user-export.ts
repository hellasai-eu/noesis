/**
 * Per-user GDPR data export (Art. 15 / 20).
 *
 * Produces a single JSON document containing every row of personal data held
 * about one data subject, grouped by the institution the data belongs to, so
 * that a requesting school can be handed only its own section.
 *
 * Super-admin only — the authorization check lives in `handler.ts`. This module
 * assumes the caller is already authorized and does no permission work itself.
 */

export type Row = Record<string, unknown>;

export interface FetchOpts {
  table: string;
  column: string;
  /** Match a single value (`eq`) or any of a set (`in`). */
  op: "eq" | "in";
  value?: string;
  values?: string[];
  /** PostgREST select string. Defaults to `*`. */
  columns?: string;
}

export interface FetchResult {
  data: Row[];
  error?: string;
}

/** Minimal data-access surface, so the export logic is testable without Supabase. */
export interface ExportDb {
  fetch(opts: FetchOpts): Promise<FetchResult>;
  /** auth.users metadata for the subject, or null if unavailable. */
  getAuthUser(userId: string): Promise<Row | null>;
}

/**
 * One step from a row towards an institution: read `column` off the current
 * row, look up that id in `table`, and continue from there. The final hop's
 * table must expose `institution_id`.
 */
interface Hop {
  column: string;
  table: string;
}

/** Which of the subject's identifiers selects rows from a table. */
type MatchValue = "userId" | "email";

interface Match {
  column: string;
  value: MatchValue;
}

interface RootSpec {
  table: string;
  /** OR-ed: a row is the subject's if it matches any of these. */
  match: Match[];
  /**
   * Hops from a row to its owning institution. An empty array means the row
   * carries `institution_id` itself; `null` means the table is account-level
   * and has no institution at all.
   */
  hops: Hop[] | null;
  /** Restrict the exported columns (used for authorship attribution). */
  columns?: string;
}

interface ChildSpec {
  table: string;
  /** A `RootSpec.table` whose already-fetched rows are the parents. */
  parentTable: string;
  /** Column on the child pointing at `parent.id`. */
  fkColumn: string;
  columns?: string;
}

const COURSE_HOPS: Hop[] = [{ column: "course_id", table: "courses" }];
const CLASS_HOPS: Hop[] = [{ column: "class_id", table: "classes" }];
const OFFERING_HOPS: Hop[] = [
  { column: "offering_id", table: "offerings" },
  { column: "class_id", table: "classes" },
];

const USER = (column: string): Match => ({ column, value: "userId" });
const EMAIL = (column: string): Match => ({ column, value: "email" });

/**
 * Tables that reference a user but are deliberately withheld from the per-user
 * export. Part of the export's contract, not a test detail: every entry is a
 * decision to leave rows out of a subject access request, and both the coverage
 * guard and the erasure test read this list so the decision is stated once.
 *
 * Adding an entry needs a written reason here.
 */
export const NOT_SUBJECT_DATA: ReadonlySet<string> = new Set([
  // The audit trail of administrative actions on personal data (20260725064858).
  //
  // Its `actor_user_id` / `target_user_id` are bare uuids with no foreign key
  // to auth.users ON PURPOSE, so the record of a deletion survives the deletion
  // — an FK would reject `delete-user`'s audit row, which is written *after*
  // the auth user is gone. `user_reference_map()` omits it for the same reason
  // (the DELIBERATELY NOT ERASED note in 20260726000000).
  //
  // Withheld because the subject of a row is a non-identifying uuid, `metadata`
  // is PII-free by the convention `_shared/audit.ts` enforces, and
  // `actor_email` identifies the acting ADMIN — handing it to the person they
  // acted on would disclose a third party. Revisit if `audit_logs` ever starts
  // carrying content rather than references.
  "audit_logs",
]);

/**
 * Tables holding personal data about a subject. Adding a personal-data table to
 * the schema means adding it here too, or it silently drops out of exports.
 *
 * `supabase/tests/rls/__tests__/export-coverage.test.ts` enforces that: it fails
 * when a table appears in neither this list nor `CHILD_SPECS` while carrying a
 * foreign key to `auth.users`, or being named by `public.user_reference_map()`
 * — the erasure registry, which knows about references the catalogue cannot
 * see (a user id inside jsonb, or a table keyed by email). That guard was added
 * after the `study_guide_*` tables (#977/#978) landed and silently dropped out
 * of exports (issue #947).
 *
 * So a new personal-data table needs an entry here AND in the registry
 * (20260726000000). The guard fails if the two disagree.
 */
export const ROOT_SPECS: RootSpec[] = [
  // --- Account-level: no institution attribution possible ---
  { table: "profiles", match: [USER("user_id")], hops: null },
  { table: "login_history", match: [USER("user_id")], hops: null },
  { table: "notifications", match: [USER("user_id")], hops: null },
  { table: "super_admins", match: [EMAIL("email")], hops: null },
  { table: "system_config", match: [USER("updated_by")], hops: null, columns: "id,key,updated_by,updated_at" },
  // The moderation payload embeds the user id inside `data` jsonb rather than
  // in a column of its own, so there is no foreign key and the catalogue scan
  // cannot see it — `user_reference_map()` is what flags it as personal data.
  // The row holds an excerpt of the subject's own content, so it is squarely
  // within a subject access request.
  { table: "flagged_content", match: [USER("data->>user_id")], hops: null },

  // --- Institution carried on the row itself ---
  { table: "user_institutions", match: [USER("user_id")], hops: [] },
  { table: "ai_usage_logs", match: [USER("user_id")], hops: [] },
  { table: "ai_rate_limit_events", match: [USER("user_id")], hops: [] },
  // Matched on the address as well as the id: an attempt against the subject's
  // email that resolved to no account carries no user_id, and it is still
  // their personal data (their address, plus the attempting IP).
  { table: "failed_login_attempts", match: [USER("user_id"), EMAIL("email_attempted")], hops: [] },
  {
    table: "student_admin_notes",
    match: [USER("student_user_id"), USER("created_by"), USER("updated_by")],
    hops: [],
  },
  { table: "student_admin_notes_audit", match: [USER("student_user_id")], hops: [] },
  // The GDPR rights-request register (20260913090000): rows ABOUT the subject
  // only. Deliberately NOT matched on created_by / closed_by — a register row
  // names its data subject (`subject_label`, `details`), so handing an admin's
  // export every request they processed would disclose third parties, the
  // same reasoning that withholds audit_logs above. The admin's role in a row
  // is administrative metadata, not their personal data. `subject_label` rows
  // with no account link are reachable only through the institution's own
  // register page, since no subject key selects them.
  { table: "rights_requests", match: [USER("subject_user_id")], hops: [] },
  { table: "invitations", match: [EMAIL("email"), USER("invited_by")], hops: [] },
  { table: "bug_reports", match: [USER("reporter_id"), EMAIL("reporter_email")], hops: [] },
  { table: "jobs", match: [USER("created_by")], hops: [], columns: "id,type,status,institution_id,course_id,created_by,created_at,ended_at" },

  // --- Institution reached through the course ---
  { table: "course_instructors", match: [USER("user_id")], hops: COURSE_HOPS },
  { table: "course_instructor_sections", match: [USER("user_id")], hops: COURSE_HOPS },
  { table: "course_evaluators", match: [USER("user_id")], hops: COURSE_HOPS },
  { table: "quiz_sessions", match: [USER("user_id")], hops: COURSE_HOPS },
  { table: "quiz_answers", match: [USER("user_id")], hops: COURSE_HOPS },
  { table: "open_question_grades", match: [USER("user_id")], hops: COURSE_HOPS },
  // AI-drafted review notes about the subject's answer. Instructor-only in
  // the app, but model output about a person is that person's data.
  { table: "open_answer_ai_drafts", match: [USER("user_id")], hops: COURSE_HOPS },
  { table: "open_question_progress", match: [USER("user_id")], hops: COURSE_HOPS },
  { table: "open_question_chats", match: [USER("user_id"), USER("sender_user_id")], hops: COURSE_HOPS },
  { table: "socratic_session_state", match: [USER("user_id")], hops: COURSE_HOPS },
  { table: "study_tutor_session_state", match: [USER("user_id")], hops: COURSE_HOPS },
  { table: "textbook_chat_messages", match: [USER("user_id")], hops: COURSE_HOPS },
  { table: "copilot_sessions", match: [USER("user_id")], hops: COURSE_HOPS },
  // `course_id` here is an unconstrained uuid — this is a log table, so a
  // deleted course must not cascade into it. It is the one hop below that no
  // foreign key backs, so orphaned rows resolve to `unattributed` by design.
  { table: "agent_interaction_logs", match: [USER("user_id")], hops: COURSE_HOPS },
  { table: "student_evaluations", match: [USER("user_id")], hops: COURSE_HOPS },
  { table: "evaluation_timeline_cache", match: [USER("user_id")], hops: COURSE_HOPS },
  { table: "student_study_progress", match: [USER("user_id")], hops: COURSE_HOPS },
  // The unified tutoring session. The legacy progress/chat/state tables above
  // and below stay listed until they are dropped: they still hold the
  // pre-migration rows, and an export that skipped them would under-report.
  { table: "chat_sessions", match: [USER("user_id")], hops: COURSE_HOPS },
  { table: "flashcard_sessions", match: [USER("user_id")], hops: COURSE_HOPS },
  { table: "flashcard_reviews", match: [USER("user_id")], hops: COURSE_HOPS },
  {
    table: "graded_tests",
    match: [USER("student_id"), USER("created_by"), USER("graded_by")],
    hops: COURSE_HOPS,
  },
  { table: "course_chapter_progress", match: [USER("completed_by")], hops: COURSE_HOPS },
  { table: "admin_notifications", match: [USER("student_id")], hops: COURSE_HOPS },
  { table: "class_announcements", match: [USER("author_id")], hops: COURSE_HOPS },
  { table: "course_notes", match: [USER("author_id")], hops: COURSE_HOPS },
  // The subject's own evaluation work: their ratings and free-text comments on
  // generated questions. `question_evaluations` also carries `session_id`, but
  // `evaluator_id` is on the row itself, so it is collected directly rather
  // than as a child of the session.
  { table: "question_evaluation_sessions", match: [USER("evaluator_id")], hops: COURSE_HOPS },
  { table: "open_question_mode_changes", match: [USER("changed_by")], hops: COURSE_HOPS },

  // --- Institution reached through the class / offering ---
  { table: "class_enrollments", match: [USER("user_id")], hops: CLASS_HOPS },
  { table: "offering_groups", match: [USER("owner_user_id"), USER("created_by")], hops: OFFERING_HOPS },
  {
    table: "offering_group_members",
    match: [USER("user_id"), USER("added_by")],
    hops: [{ column: "group_id", table: "offering_groups" }, ...OFFERING_HOPS],
  },

  // --- Institution reached through the offering ---
  { table: "study_guide_progress", match: [USER("user_id")], hops: OFFERING_HOPS },
  { table: "study_guide_answers", match: [USER("user_id")], hops: OFFERING_HOPS },

  // --- Multi-hop lookups ---
  {
    table: "question_evaluations",
    match: [USER("evaluator_id")],
    hops: [{ column: "question_id", table: "questions" }, ...COURSE_HOPS],
  },
  {
    table: "announcement_reads",
    match: [USER("user_id")],
    hops: [{ column: "announcement_id", table: "class_announcements" }, ...COURSE_HOPS],
  },
  {
    table: "question_votes",
    match: [USER("user_id")],
    hops: [{ column: "question_id", table: "questions" }, ...COURSE_HOPS],
  },

  // --- Authorship attribution only: identifiers and titles, not the content ---
  {
    table: "courses",
    match: [USER("created_by")],
    hops: [],
    columns: "id,title,institution_id,created_by,created_at",
  },
  {
    table: "classes",
    match: [USER("created_by")],
    hops: [],
    columns: "id,name,section_name,institution_id,created_by,created_at",
  },
  {
    table: "questions",
    match: [USER("created_by")],
    hops: COURSE_HOPS,
    columns: "id,course_id,type,created_by,created_at",
  },
  {
    table: "quizzes",
    match: [USER("created_by")],
    hops: COURSE_HOPS,
    columns: "id,title,course_id,created_by,created_at",
  },
  {
    table: "tests",
    match: [USER("created_by")],
    hops: COURSE_HOPS,
    columns: "id,title,course_id,created_by,created_at",
  },
  {
    table: "study_sessions",
    match: [USER("created_by")],
    hops: COURSE_HOPS,
    columns: "id,title,course_id,created_by,created_at",
  },
  {
    table: "course_materials",
    match: [USER("uploaded_by")],
    hops: COURSE_HOPS,
    columns: "id,title,file_name,file_url,course_id,uploaded_by,created_at",
  },
  {
    table: "course_exercise_pdfs",
    match: [USER("uploaded_by")],
    hops: COURSE_HOPS,
    columns: "id,title,file_name,file_url,course_id,uploaded_by,created_at",
  },
  {
    table: "study_guides",
    match: [USER("created_by")],
    hops: COURSE_HOPS,
    columns: "id,title,course_id,created_by,created_at",
  },
];

/** Tables reachable only through a parent row; they inherit the parent's institution. */
export const CHILD_SPECS: ChildSpec[] = [
  { table: "quiz_session_questions", parentTable: "quiz_sessions", fkColumn: "session_id" },
  { table: "evaluation_competency_scores", parentTable: "student_evaluations", fkColumn: "evaluation_id" },
  { table: "graded_test_questions", parentTable: "graded_tests", fkColumn: "graded_test_id" },
  { table: "study_session_messages", parentTable: "student_study_progress", fkColumn: "progress_id" },
  { table: "socratic_state_history", parentTable: "socratic_session_state", fkColumn: "session_state_id" },
  { table: "study_tutor_state_history", parentTable: "study_tutor_session_state", fkColumn: "session_state_id" },
  { table: "chat_messages", parentTable: "chat_sessions", fkColumn: "session_id" },
  { table: "chat_session_state", parentTable: "chat_sessions", fkColumn: "session_id" },
  { table: "chat_state_history", parentTable: "chat_sessions", fkColumn: "session_id" },
  { table: "user_institution_grades", parentTable: "user_institutions", fkColumn: "user_institution_id" },
  { table: "invitation_courses", parentTable: "invitations", fkColumn: "invitation_id" },
];

export interface UserExport {
  export_metadata: {
    format_version: number;
    subject: Row;
    exported_at: string;
    exported_by: string;
    institutions: Row[];
    row_counts: Record<string, number>;
    notes: string[];
  };
  account: Record<string, Row[]>;
  by_institution: Array<{ institution: Row; data: Record<string, Row[]> }>;
  unattributed: Record<string, Row[]>;
  errors?: Record<string, string>;
}

const NOTES = [
  "`account` holds records that belong to the person rather than to any single institution (profile, login history, notifications).",
  "`by_institution` groups every other record under the institution whose courses, classes or offerings it belongs to. A school acting as data controller should be given only its own entry.",
  "`unattributed` holds records whose institution could not be derived — usually because the parent course, class or offering has since been deleted. They are included so the export stays complete. If `errors` is present and non-empty, check it before treating an institution section as complete: a failed lookup sends records here too.",
  "Uploaded files (PDFs, screenshots) are referenced by storage path or URL only; binary contents are not included.",
  "Records where the subject is the author rather than the topic (courses, quizzes, questions, materials) are limited to identifiers, titles and timestamps.",
];

/** Distinct, non-empty string values of `column` across `rows`. */
function idsOf(rows: Row[], column: string): string[] {
  const set = new Set<string>();
  for (const row of rows) {
    const value = row[column];
    if (typeof value === "string" && value) set.add(value);
  }
  return [...set];
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Batch size for `IN (...)` filters, to keep PostgREST URLs within limits. */
const IN_CHUNK = 100;

/**
 * Resolves rows to institution ids by walking `hops`, batching each level and
 * memoising lookups so that the shared `courses` and `classes` hops are fetched
 * once across the whole export rather than once per table.
 */
class InstitutionResolver {
  private cache = new Map<string, Map<string, string | null>>();

  /**
   * @param onError Reports a failed hop query. A read failure and a deleted
   * parent both leave rows unattributed, so the failure has to be surfaced or
   * an operator cannot tell an incomplete export from a complete one.
   */
  constructor(
    private db: ExportDb,
    private onError: (table: string, message: string) => void
  ) {}

  /** Returns institution ids positionally aligned with `rows`. */
  async resolve(rows: Row[], hops: Hop[]): Promise<(string | null)[]> {
    if (rows.length === 0) return [];
    if (hops.length === 0) {
      return rows.map((row) => (typeof row.institution_id === "string" ? row.institution_id : null));
    }

    let keys: (string | null)[] = rows.map((row) =>
      typeof row[hops[0].column] === "string" ? (row[hops[0].column] as string) : null
    );

    for (let i = 0; i < hops.length; i++) {
      const nextColumn = i + 1 < hops.length ? hops[i + 1].column : "institution_id";
      const lookup = await this.lookup(hops[i].table, nextColumn, keys);
      keys = keys.map((key) => (key === null ? null : lookup.get(key) ?? null));
    }

    return keys;
  }

  /** Map of `id` → `column` for `table`, fetching only ids not already cached. */
  private async lookup(
    table: string,
    column: string,
    keys: (string | null)[]
  ): Promise<Map<string, string | null>> {
    const cacheKey = `${table}:${column}`;
    let cached = this.cache.get(cacheKey);
    if (!cached) {
      cached = new Map<string, string | null>();
      this.cache.set(cacheKey, cached);
    }

    const missing = [...new Set(keys.filter((k): k is string => k !== null && !cached!.has(k)))];
    for (const batch of chunk(missing, IN_CHUNK)) {
      const { data, error } = await this.db.fetch({
        table,
        column: "id",
        op: "in",
        values: batch,
        columns: `id,${column}`,
      });
      // A failed hop leaves rows unattributed rather than aborting the export,
      // but it is reported so the gap is visible rather than silent.
      if (error) {
        this.onError(table, error);
        continue;
      }
      for (const row of data) {
        if (typeof row.id === "string") {
          cached.set(row.id, typeof row[column] === "string" ? (row[column] as string) : null);
        }
      }
    }

    return cached;
  }
}

/** Stable identity for de-duplicating rows collected via several match rules. */
function rowKey(row: Row): string {
  return typeof row.id === "string" ? row.id : JSON.stringify(row);
}

export interface BuildUserExportOptions {
  userId: string;
  /** Email of the person running the export, recorded in the document. */
  exportedBy: string;
  /** Fixed timestamp for the document; defaults to now. */
  exportedAt?: string;
}

export async function buildUserExport(
  db: ExportDb,
  { userId, exportedBy, exportedAt }: BuildUserExportOptions
): Promise<UserExport> {
  const errors: Record<string, string> = {};
  // Keyed separately from the table's own read error: `courses` is both a
  // hop target and an exported table, and the two failures mean different things.
  const resolver = new InstitutionResolver(db, (table, message) => {
    errors[`${table} (institution lookup)`] ??= message;
  });

  const authUser = await db.getAuthUser(userId);
  const { data: profileRows } = await db.fetch({
    table: "profiles",
    column: "user_id",
    op: "eq",
    value: userId,
  });
  const profile = profileRows[0] ?? {};
  const subjectEmail =
    (typeof profile.email === "string" && profile.email) ||
    (typeof authUser?.email === "string" && authUser.email) ||
    null;

  const account: Record<string, Row[]> = {};
  const byInstitution = new Map<string, Record<string, Row[]>>();
  const unattributed: Record<string, Row[]> = {};
  const rowCounts: Record<string, number> = {};
  /** Root rows kept for child-table lookups: parent id → institution id. */
  const parentIndex = new Map<string, Map<string, string | null>>();

  const place = (institutionId: string | null, table: string, row: Row) => {
    if (institutionId === null) {
      (unattributed[table] ??= []).push(row);
      return;
    }
    let bucket = byInstitution.get(institutionId);
    if (!bucket) {
      bucket = {};
      byInstitution.set(institutionId, bucket);
    }
    (bucket[table] ??= []).push(row);
  };

  /** All of the subject's rows in `table`, de-duplicated across match rules. */
  const collect = async (
    table: string,
    match: Match[],
    columns: string | undefined
  ): Promise<Row[] | null> => {
    const seen = new Map<string, Row>();
    let anySucceeded = false;

    for (const rule of match) {
      const value = rule.value === "userId" ? userId : subjectEmail;
      // No known email means the email-keyed rules simply have nothing to match.
      if (!value) continue;

      const { data, error } = await db.fetch({ table, column: rule.column, op: "eq", value, columns });
      if (error) {
        // Record the first failure but keep trying the other identifiers, so a
        // dropped column does not hide rows the remaining rules would find.
        errors[table] ??= error;
        continue;
      }
      anySucceeded = true;
      for (const row of data) seen.set(rowKey(row), row);
    }

    if (!anySucceeded && errors[table]) return null;
    return [...seen.values()];
  };

  for (const spec of ROOT_SPECS) {
    const rows = await collect(spec.table, spec.match, spec.columns);
    if (rows === null || rows.length === 0) continue;
    rowCounts[spec.table] = rows.length;

    if (spec.hops === null) {
      account[spec.table] = rows;
      continue;
    }

    const institutionIds = await resolver.resolve(rows, spec.hops);
    const index = new Map<string, string | null>();
    rows.forEach((row, i) => {
      place(institutionIds[i], spec.table, row);
      if (typeof row.id === "string") index.set(row.id, institutionIds[i]);
    });
    parentIndex.set(spec.table, index);
  }

  for (const spec of CHILD_SPECS) {
    const index = parentIndex.get(spec.parentTable);
    if (!index || index.size === 0) continue;

    const rows: Row[] = [];
    let failed = false;
    for (const batch of chunk([...index.keys()], IN_CHUNK)) {
      const { data, error } = await db.fetch({
        table: spec.table,
        column: spec.fkColumn,
        op: "in",
        values: batch,
        columns: spec.columns,
      });
      if (error) {
        errors[spec.table] ??= error;
        failed = true;
        break;
      }
      rows.push(...data);
    }
    if (failed || rows.length === 0) continue;

    rowCounts[spec.table] = rows.length;
    for (const row of rows) {
      const parentId = row[spec.fkColumn];
      place(typeof parentId === "string" ? index.get(parentId) ?? null : null, spec.table, row);
    }
  }

  // Name every institution the export touches, including ones the subject is no
  // longer a member of but still has records under.
  const institutionIds = [...byInstitution.keys()];
  const institutions = new Map<string, Row>();
  for (const batch of chunk(institutionIds, IN_CHUNK)) {
    const { data, error } = await db.fetch({
      table: "institutions",
      column: "id",
      op: "in",
      values: batch,
      columns: "id,name,slug,country",
    });
    if (error) {
      errors.institutions ??= error;
      continue;
    }
    for (const row of data) {
      if (typeof row.id === "string") institutions.set(row.id, row);
    }
  }

  return {
    export_metadata: {
      format_version: 1,
      subject: {
        user_id: userId,
        email: subjectEmail,
        full_name: profile.full_name ?? null,
        auth_created_at: authUser?.created_at ?? null,
        auth_last_sign_in_at: authUser?.last_sign_in_at ?? null,
      },
      exported_at: exportedAt ?? new Date().toISOString(),
      exported_by: exportedBy,
      institutions: institutionIds.map((id) => institutions.get(id) ?? { id, name: null }),
      row_counts: rowCounts,
      notes: NOTES,
    },
    account,
    by_institution: institutionIds.map((id) => ({
      institution: institutions.get(id) ?? { id, name: null },
      data: byInstitution.get(id)!,
    })),
    unattributed,
    ...(Object.keys(errors).length > 0 ? { errors } : {}),
  };
}
