/**
 * Erasure of the user data that a foreign key cannot reach (issue #932).
 *
 * Migration 20260726000000 put an `ON DELETE CASCADE` / `SET NULL` foreign key
 * on every column that holds a user id, so `auth.admin.deleteUser` clears those
 * on its own. Three kinds of personal data are outside that net:
 *
 *   1. Rows keyed by the subject's EMAIL, with no user id at all —
 *      `invitations` (email + invited name), `super_admins`, and the
 *      `bug_reports.reporter_email` copy kept alongside `reporter_id`.
 *   2. A user id buried inside JSON — `flagged_content.data` holds the id of
 *      whoever triggered moderation plus an excerpt of the flagged content.
 *   3. Storage objects — screenshots the user attached to a bug report, and
 *      anything else under a `<user id>/` prefix.
 *
 * (1) and (2) are done by `public.erase_user_unlinked_data()` rather than here:
 * emails are stored as typed while the auth record is lowercased, and SQL is
 * where a case-insensitive match can be made without PostgREST's escape-less
 * `ilike` pattern turning an underscore in an address into a wildcard. That
 * function also returns the screenshot paths, since storage is unreachable from
 * SQL. (3) is done below.
 *
 * All of it must run BEFORE the auth user is deleted: the bug-report lookup
 * keys off `reporter_id`, which the new foreign key nulls out on deletion.
 *
 * Failures never abort the deletion — an admin acting on an erasure request
 * must not be blocked by a storage hiccup — but every one is returned as a
 * warning so the gap is visible instead of silent.
 * `public.user_data_footprint()` is the authoritative after-the-fact check.
 */

/** Buckets whose objects are laid out as `<user id>/<file>`. */
const USER_PREFIXED_BUCKETS = ["bug-reports", "graded-tests"] as const;

/** Page size for storage listings. */
const LIST_PAGE = 100;

/** Guard against an unbounded walk if a bucket ever nests deeply. */
const MAX_LIST_DEPTH = 3;

export interface ErasureWarning {
  /**
   * Table, bucket or step that failed — a fixed name, never a value. Only this
   * half reaches the audit record, which must not re-introduce the personal
   * data the deletion just erased.
   */
  source: string;
  /** Why it failed. May quote database detail, so it stays out of the audit. */
  message: string;
}

export interface ErasureResult {
  /** Storage objects removed across all buckets. */
  storageRemoved: number;
  /** Non-fatal failures. An empty array means every step landed. */
  warnings: ErasureWarning[];
}

interface EraseOptions {
  userId: string;
  /** The subject's email, or null if it could not be resolved. */
  email: string | null;
}

/**
 * A row still carrying a typed name that matches the erased subject's.
 * Returned to the admin for review — never auto-cleared, because a typed name
 * is not a key and the match may be a same-named other student (the
 * `student_evaluations` rows always belong to another live account, since
 * `user_id` cascades). See migration 20260913080000; the erasure procedure
 * itself is the operator's private compliance record.
 */
export interface NameReviewCandidate {
  source: string;
  rowId: string;
  studentName: string;
  /** Set when the row is attached to a (different, live) account. */
  linkedUserId: string | null;
  courseId: string;
  createdAt: string;
}

// The service-role Supabase client. Typed loosely for the same reason
// `export-data/handler.ts` does: the generated database types are not
// available to edge functions.
// deno-lint-ignore no-explicit-any
type AdminClient = any;

/**
 * Every object path under `prefix` in `bucket`.
 *
 * `list()` returns entries relative to the prefix and marks folders with a null
 * `id`, so subfolders are walked rather than deleted by name.
 */
async function listAll(
  supabaseAdmin: AdminClient,
  bucket: string,
  prefix: string,
  depth = 0,
): Promise<string[]> {
  if (depth >= MAX_LIST_DEPTH) return [];

  const paths: string[] = [];
  let offset = 0;

  for (;;) {
    const { data, error } = await supabaseAdmin.storage
      .from(bucket)
      .list(prefix, { limit: LIST_PAGE, offset });

    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;

    for (const entry of data as Array<{ name: string; id: string | null }>) {
      const path = `${prefix}/${entry.name}`;
      if (entry.id === null) {
        paths.push(...(await listAll(supabaseAdmin, bucket, path, depth + 1)));
      } else {
        paths.push(path);
      }
    }

    if (data.length < LIST_PAGE) break;
    offset += LIST_PAGE;
  }

  return paths;
}

/**
 * Deletes the personal data that `auth.admin.deleteUser` will not cascade.
 * Call before deleting the auth user.
 */
export async function eraseUnlinkedUserData(
  supabaseAdmin: AdminClient,
  { userId, email }: EraseOptions,
): Promise<ErasureResult> {
  const warnings: ErasureWarning[] = [];
  let storageRemoved = 0;

  const warn = (source: string, reason: unknown) => {
    warnings.push({
      source,
      message: reason instanceof Error ? reason.message : String(reason),
    });
  };

  // ── Email-keyed rows, moderation payloads, bug-report anonymisation ───────
  let screenshotPaths: string[] = [];
  try {
    const { data, error } = await supabaseAdmin.rpc("erase_user_unlinked_data", {
      _user_id: userId,
      _email: email,
    });
    if (error) throw new Error(error.message);

    const result = (data ?? {}) as { screenshot_paths?: string[]; email_checked?: boolean };
    screenshotPaths = result.screenshot_paths ?? [];

    // No email means `invitations` and `super_admins` were skipped entirely.
    // That is an incomplete erasure and has to be reported as one.
    if (result.email_checked === false) {
      warn("email", "unavailable — email-keyed rows were not checked");
    }
  } catch (e) {
    warn("erase_user_unlinked_data", e);
  }

  // ── Storage ──────────────────────────────────────────────────────────────
  // The `<user id>/` prefix is the upload convention (see BugReportDialog), so
  // it catches objects whose row was already deleted. The paths returned above
  // are added in case a report was ever written with a different layout.
  for (const bucket of USER_PREFIXED_BUCKETS) {
    try {
      const listed = await listAll(supabaseAdmin, bucket, userId);
      const owned = bucket === "bug-reports"
        ? screenshotPaths.filter((p) => !p.startsWith(`${userId}/`))
        : [];
      const paths = [...new Set([...listed, ...owned])];
      if (paths.length === 0) continue;

      const { error } = await supabaseAdmin.storage.from(bucket).remove(paths);
      if (error) throw new Error(error.message);
      storageRemoved += paths.length;
    } catch (e) {
      warn(`storage:${bucket}`, e);
    }
  }

  return { storageRemoved, warnings };
}

/**
 * The instructor-typed names that survived the erasure (issue: the "manual
 * step" in the written erasure procedure was a sentence with no tooling, so an
 * erasure could be confirmed complete while `graded_tests.student_name` /
 * `student_evaluations.student_name` still carried the subject's name).
 *
 * Call AFTER `auth.admin.deleteUser`: rows keyed to the subject's id have
 * cascaded by then, so everything returned is a genuine leftover to review.
 * A failure is reported as a warning, exactly like the other erasure steps —
 * the admin must know the sweep did not run, or they will report a complete
 * erasure on the strength of a check that never happened.
 */
export async function findNameReviewCandidates(
  supabaseAdmin: AdminClient,
  fullName: string | null,
): Promise<{ candidates: NameReviewCandidate[]; warnings: ErasureWarning[] }> {
  if (!fullName || fullName.trim().length === 0) {
    return {
      candidates: [],
      warnings: [{
        source: "name",
        message: "unavailable — free-text name columns were not checked",
      }],
    };
  }

  const { data, error } = await supabaseAdmin.rpc("find_erasure_name_matches", {
    _name: fullName,
  });
  if (error) {
    // A degenerate profile name ("Γ. Π.") yields no searchable token, and the
    // function reports that as an error (22023) rather than an empty result —
    // an empty result would read as "searched, found nothing". Same warning
    // source as a missing name: either way these columns were not checked.
    const unusable = error.message.includes("no usable tokens");
    return {
      candidates: [],
      warnings: [{
        source: unusable ? "name" : "find_erasure_name_matches",
        message: unusable
          ? "profile name too degenerate to search — free-text name columns were not checked"
          : error.message,
      }],
    };
  }

  type MatchRow = {
    source_table: string;
    row_id: string;
    student_name: string;
    linked_user_id: string | null;
    course_id: string;
    created_at: string;
  };
  const candidates = ((data ?? []) as MatchRow[]).map((m) => ({
    source: m.source_table,
    rowId: m.row_id,
    studentName: m.student_name,
    linkedUserId: m.linked_user_id,
    courseId: m.course_id,
    createdAt: m.created_at,
  }));
  return { candidates, warnings: [] };
}
