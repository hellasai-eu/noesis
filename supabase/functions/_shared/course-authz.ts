import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { checkActiveMembership, checkInstitutionAdmin } from "./institution-authz.ts";
import {
  AAL2_REQUIRED_CODE,
  AAL2_REQUIRED_MESSAGE,
  callerMfaSatisfied,
} from "./require-aal2.ts";

/**
 * Caller gates for the handlers that act on a course, its files, or a named
 * student's record within it (#1135).
 *
 * `detect-chapters`, `extract-images-from-pdf`, `generate-pdf-thumbnail` and
 * `split-chapters` each took `{filePath, bucketName}` from the request body,
 * established no caller identity, and read or wrote that object with the
 * service-role key. Any anonymous request therefore reached any institution's
 * storage.
 *
 * The rule these need is not "is this caller an admin somewhere" but "does this
 * caller have business with *this file*". So the course is resolved FROM THE
 * OBJECT — via the `course_materials` row that owns the path — and never from a
 * body-supplied `courseId`, which is whatever the caller types. Authorizing
 * against a course they legitimately manage while reading a file from one they
 * do not is exactly the hole being closed.
 *
 * Two levels, because the four handlers are not the same kind of operation:
 *
 * - **Reader** — previewing a material and rendering its thumbnail are things
 *   an enrolled student does. `extract-images-from-pdf` and
 *   `generate-pdf-thumbnail` are reachable from the material preview, which is
 *   not manager-gated in `CoursePage`.
 * - **Manager** — detecting and splitting chapters are authoring actions that
 *   mint new storage objects and rewrite a material's structure. Students have
 *   no business there regardless of what the UI happens to render.
 *
 * Both are built on `institution-authz.ts` rather than a direct
 * `user_institutions.role` read, so a suspended member is excluded (#1082).
 * Note that `study-guide-context.ts`'s `isAuthorizedCourseManager` predates
 * that module and still reads the column directly; it is not reused here.
 */

export type AuthzResult =
  | {
    ok: true;
    courseId: string;
    institutionId: string;
    /**
     * How the caller qualified. Section restrictions bind assigned
     * instructors; an institution admin (or super-admin) is unrestricted, so
     * the two cannot be collapsed.
     */
    via?: "admin" | "instructor";
  }
  | { ok: false; status: number; error: string };

/**
 * Buckets these handlers are allowed to touch.
 *
 * An allow-list rather than a check on the path, because `bucketName` is
 * caller-supplied: without this, a resolved course would authorize reads of a
 * same-named path in an unrelated bucket.
 */
const ALLOWED_BUCKETS = new Set(["course-materials"]);

/**
 * Resolve a storage object to the course that owns it.
 *
 * The lookup is by `course_materials.file_url`, which is the exact value every
 * call site passes as `filePath` (`MaterialUploadDialog` writes
 * `${courseId}/${timestamp}-${name}` to both). Resolving through a real row —
 * rather than parsing the course id out of the path — means a caller cannot
 * reach an arbitrary object by naming a plausible prefix, and makes path
 * traversal moot: `../` simply matches no row.
 */
export async function resolveCourseForStorageObject(
  // deno-lint-ignore no-explicit-any
  supabase: SupabaseClient | any,
  bucketName: string,
  filePath: string,
): Promise<{ ok: true; courseId: string } | { ok: false; status: number; error: string }> {
  if (!bucketName || !filePath) {
    return { ok: false, status: 400, error: "filePath and bucketName are required" };
  }

  if (!ALLOWED_BUCKETS.has(bucketName)) {
    return { ok: false, status: 403, error: "Not authorized for this bucket" };
  }

  const { data: material, error } = await supabase
    .from("course_materials")
    .select("course_id")
    .eq("file_url", filePath)
    .maybeSingle();

  if (error) {
    return { ok: false, status: 500, error: "Failed to resolve the material" };
  }
  if (!material) {
    return { ok: false, status: 404, error: "Material not found" };
  }

  return { ok: true, courseId: (material as { course_id: string }).course_id };
}

/**
 * Resolve a `course_materials` row to the course that owns it.
 *
 * For the handlers that take a `materialId` and generate from it. The row is
 * the authority; a body-supplied `courseId` alongside it is not.
 */
export async function resolveCourseForMaterial(
  // deno-lint-ignore no-explicit-any
  supabase: SupabaseClient | any,
  materialId: string,
): Promise<{ ok: true; courseId: string } | { ok: false; status: number; error: string }> {
  if (!materialId) {
    return { ok: false, status: 400, error: "materialId is required" };
  }

  const { data, error } = await supabase
    .from("course_materials")
    .select("course_id")
    .eq("id", materialId)
    .maybeSingle();

  if (error) return { ok: false, status: 500, error: "Failed to resolve the material" };
  if (!data) return { ok: false, status: 404, error: "Material not found" };

  return { ok: true, courseId: (data as { course_id: string }).course_id };
}

/**
 * Resolve a `material_chapters` row to the course that owns it.
 *
 * Two hops, because `material_chapters` carries only `material_id` — there is
 * no `course_id` on the chapter itself
 * (20260402…/material_chapters schema). The handlers that take a `chapterId`
 * and generate a summary, cheat sheet or flashcard set from it need this to
 * know whose content they are about to spend credit on.
 */
export async function resolveCourseForChapter(
  // deno-lint-ignore no-explicit-any
  supabase: SupabaseClient | any,
  chapterId: string,
): Promise<{ ok: true; courseId: string } | { ok: false; status: number; error: string }> {
  if (!chapterId) {
    return { ok: false, status: 400, error: "chapterId is required" };
  }

  const { data: chapter, error: chapterError } = await supabase
    .from("material_chapters")
    .select("material_id")
    .eq("id", chapterId)
    .maybeSingle();

  if (chapterError) return { ok: false, status: 500, error: "Failed to resolve the chapter" };
  if (!chapter) return { ok: false, status: 404, error: "Chapter not found" };

  return await resolveCourseForMaterial(
    supabase,
    (chapter as { material_id: string }).material_id,
  );
}

/** The institution a course belongs to. */
async function institutionForCourse(
  // deno-lint-ignore no-explicit-any
  supabase: SupabaseClient | any,
  courseId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("courses")
    .select("institution_id")
    .eq("id", courseId)
    .maybeSingle();
  return (data as { institution_id: string } | null)?.institution_id ?? null;
}

/**
 * May `userId` author against `courseId`?
 *
 * A non-suspended institution admin (or super-admin, which `is_institution_admin`
 * ORs in), or an assigned instructor whose membership is live.
 */
export async function authorizeCourseManager(
  // deno-lint-ignore no-explicit-any
  supabase: SupabaseClient | any,
  userId: string,
  courseId: string,
): Promise<AuthzResult> {
  const institutionId = await institutionForCourse(supabase, courseId);
  if (!institutionId) {
    return { ok: false, status: 404, error: "Course not found" };
  }

  // A check that could not be PERFORMED is not a check that said no (#1155):
  // answering 403 to a database fault reports a server problem as a permission
  // one, and names a legitimate admin as an intruder in the log.
  const admin = await checkInstitutionAdmin(supabase, userId, institutionId);
  if (!admin.ok) {
    return { ok: false, status: 500, error: "Failed to check authorization" };
  }
  if (admin.allowed) {
    return { ok: true, courseId, institutionId, via: "admin" };
  }

  // `course_instructors` carries no suspension column, so membership is checked
  // first and the assignment lookup is skipped when it fails.
  const membership = await checkActiveMembership(supabase, userId, institutionId);
  if (!membership.ok) {
    return { ok: false, status: 500, error: "Failed to check authorization" };
  }
  if (membership.allowed) {
    const { data: assigned, error: assignedError } = await supabase
      .from("course_instructors")
      .select("user_id")
      .eq("course_id", courseId)
      .eq("user_id", userId)
      .maybeSingle();
    if (assignedError) {
      return { ok: false, status: 500, error: "Failed to check authorization" };
    }
    if (assigned) return { ok: true, courseId, institutionId, via: "instructor" };
  }

  return { ok: false, status: 403, error: "Not authorized for this course" };
}

/**
 * May `userId` read `courseId`'s material?
 *
 * Every manager, plus any student enrolled in a class the course is offered to.
 * `courses` and `class_enrollments` have no direct relationship — they meet
 * through `offerings` (course ↔ class) — so this is two queries rather than an
 * embed, for the same reason `verify-question-enrollment.ts` is.
 */
export async function authorizeCourseReader(
  // deno-lint-ignore no-explicit-any
  supabase: SupabaseClient | any,
  userId: string,
  courseId: string,
): Promise<AuthzResult> {
  const asManager = await authorizeCourseManager(supabase, userId, courseId);
  if (asManager.ok) return asManager;

  // A 404 means the course itself is missing — nothing to fall back to.
  //
  // A 500 means the manager check could not be PERFORMED, and that must not
  // fall through either: the student path would then answer 403 for a fault,
  // re-creating one layer up the exact conflation this function was corrected
  // to remove (#1155). Only a genuine "not a manager" continues.
  if (asManager.status === 404 || asManager.status === 500) return asManager;

  // Suspension does not remove `class_enrollments` rows, so the enrolment
  // below is not on its own evidence that this person may still read anything.
  // Without this the student fallback reintroduces exactly the hole #1082
  // closed for admins: a suspended member keeps access through a stale row.
  const institutionId = await institutionForCourse(supabase, courseId);
  if (!institutionId) {
    return { ok: false, status: 404, error: "Course not found" };
  }
  const readerMembership = await checkActiveMembership(supabase, userId, institutionId);
  if (!readerMembership.ok) {
    return { ok: false, status: 500, error: "Failed to check authorization" };
  }
  if (!readerMembership.allowed) {
    return { ok: false, status: 403, error: "Not authorized for this course" };
  }

  if (await isEnrolledInCourse(supabase, userId, courseId)) {
    return { ok: true, courseId, institutionId };
  }

  return { ok: false, status: 403, error: "Not authorized for this course" };
}

/**
 * Is `userId` a student on `courseId`?
 *
 * `courses` and `class_enrollments` have no direct relationship — they meet
 * through `offerings` (course ↔ class) — so this is two queries rather than an
 * embed, for the same reason `verify-question-enrollment.ts` is.
 *
 * Deliberately a pure enrolment question, with no liveness requirement of its
 * own. `authorizeCourseReader` adds `hasActiveMembership` because a suspended
 * *caller* must lose access; `authorizeStudentRecord` does not, because a
 * suspended student is still a student on the course and an instructor should
 * still be able to grade work they already submitted.
 */
export async function isEnrolledInCourse(
  // deno-lint-ignore no-explicit-any
  supabase: SupabaseClient | any,
  userId: string,
  courseId: string,
): Promise<boolean> {
  return (await enrolledClassIdsForCourse(supabase, userId, courseId)).length > 0;
}

/**
 * Which of the course's offering classes is `userId` enrolled in?
 *
 * The section check needs the class, not just a yes/no: an instructor
 * restricted to section B may act on a student in B and not on one in C, and
 * both are "enrolled on the course".
 */
export async function enrolledClassIdsForCourse(
  // deno-lint-ignore no-explicit-any
  supabase: SupabaseClient | any,
  userId: string,
  courseId: string,
): Promise<string[]> {
  const { data: offeringRows } = await supabase
    .from("offerings")
    .select("class_id")
    .eq("course_id", courseId);

  const classIds = ((offeringRows ?? []) as Array<{ class_id: string }>)
    .map((o) => o.class_id)
    .filter(Boolean);

  if (classIds.length === 0) return [];

  const { data: enrollments } = await supabase
    .from("class_enrollments")
    .select("class_id")
    .eq("user_id", userId)
    .in("class_id", classIds);

  return ((enrollments ?? []) as Array<{ class_id: string }>)
    .map((e) => e.class_id)
    .filter(Boolean);
}

/**
 * May `callerId` read or write `subjectUserId`'s record on `courseId`?
 *
 * Two conditions, and the second is the one that is easy to forget:
 *
 * 1. The caller manages the course.
 * 2. The subject is actually a student on it.
 *
 * Without (2), an instructor of a course they legitimately manage could name
 * any user id in the body and have an AI evaluation, competency verdict or
 * grade written onto that person's record — including a student of another
 * institution. `generate-student-evaluation` (and `grade-interaction`, until
 * AI grading was removed) took `{courseId, userId}` from the body and
 * checked neither.
 */
export async function authorizeStudentRecord(
  // deno-lint-ignore no-explicit-any
  supabase: SupabaseClient | any,
  callerId: string,
  subjectUserId: string,
  courseId: string,
): Promise<AuthzResult> {
  const asManager = await authorizeCourseManager(supabase, callerId, courseId);
  if (!asManager.ok) return asManager;

  const subjectClassIds = await enrolledClassIdsForCourse(supabase, subjectUserId, courseId);
  if (subjectClassIds.length === 0) {
    return { ok: false, status: 403, error: "That user is not a student on this course" };
  }

  // Section scope. `course_instructor_sections` restricts an instructor to
  // named sections of a course — no rows means unrestricted, which is what
  // `instructor_can_access_section` encodes
  // (20260402000000_add_course_instructor_sections.sql:22-42).
  //
  // RLS enforces this for browser traffic, but these handlers run on the
  // service-role key, so the policy is never evaluated. Without this check a
  // section-restricted instructor could write a grade or an AI evaluation onto
  // a student in a section they do not teach — the restriction would hold
  // everywhere except here. Admins are unrestricted by design, hence `via`.
  if (asManager.via === "instructor") {
    let reachable = false;
    for (const classId of subjectClassIds) {
      const { data } = await supabase.rpc("instructor_can_access_section", {
        _course_id: courseId,
        _class_id: classId,
        _user_id: callerId,
      });
      if (data === true) {
        reachable = true;
        break;
      }
    }
    if (!reachable) {
      return {
        ok: false,
        status: 403,
        error: "That student is in a section you do not teach",
      };
    }
  }

  return asManager;
}

/**
 * Resolve the caller from the bearer token.
 *
 * Returns the user id, or the status to reply with. The token is the only
 * acceptable source: a body-supplied `userId` is forgeable, and every one of
 * these handlers runs `verify_jwt = false`, so nothing upstream has checked it.
 */
export async function callerFromRequest(
  req: Request,
  // deno-lint-ignore no-explicit-any
  supabaseAdmin: SupabaseClient | any,
): Promise<
  { ok: true; userId: string } | {
    ok: false;
    status: number;
    error: string;
    code?: string;
  }
> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }

  const token = authHeader.replace("Bearer ", "");
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  const user = data?.user;

  if (error || !user) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }

  // RLS's aal2 enforcement never runs for these handlers (service-role
  // client), so the assurance check has to live on the resolver itself.
  if (!callerMfaSatisfied(user, token)) {
    return {
      ok: false,
      status: 403,
      error: AAL2_REQUIRED_MESSAGE,
      code: AAL2_REQUIRED_CODE,
    };
  }

  return { ok: true, userId: user.id };
}
