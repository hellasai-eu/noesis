import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * Institution authorization primitives for service-role handlers (#1082).
 *
 * Every edge function runs on the service-role key, so RLS does not apply and
 * each handler has to re-state the access rule itself. Six of them had written
 * that rule as a direct read of `user_institutions.role`:
 *
 *   .from("user_institutions").select("role") … role === "admin"
 *
 * which silently ignores `is_suspended`. The database's own boundary does not:
 *
 *   -- migrations/20260323000000_add_is_suspended.sql:19-32
 *   CREATE OR REPLACE FUNCTION public.is_institution_admin(...)
 *     SELECT EXISTS (
 *       SELECT 1 FROM public.user_institutions
 *       WHERE user_id = _user_id AND institution_id = _institution_id
 *         AND role = 'admin' AND NOT is_suspended
 *     ) OR is_super_admin(_user_id)
 *
 * and that migration's comment is explicit that placing the check there is what
 * makes it "cascade to all dependent policies". Reading the column directly is
 * precisely how a caller opts out of the cascade — so a suspended administrator
 * kept full access through every one of those six functions.
 *
 * These helpers exist so the rule is stated once. `verify-question-enrollment`
 * is here for the same reason: the check had been inlined twice and the two
 * copies drifted.
 */

/**
 * The answer to an authorization question, or the admission that it could not
 * be answered (#1155).
 *
 * These helpers used to return `boolean` and discard the query error, so a
 * database, PostgREST or network fault came back as `false` — indistinguishable
 * from "this person is not authorized". That failed *closed*, so it was never a
 * hole. What it produced was a lie: callers answered 403 "Not authorized" to
 * what was actually a 500, and logged a real admin as a non-admin. During an
 * incident that sends whoever is reading the logs after a permissions problem
 * that does not exist.
 *
 * Throwing was the cheaper fix and is deliberately not used: not every handler
 * has a `catch` that maps to 500, and `withLogging` inspects the message for
 * "auth"/"unauthorized"/"token" and records an auth failure at 401 — which
 * would have re-created the exact confusion this closes, one layer up.
 */
// The rename from `isX` to `checkX` is not cosmetic. Changing these from
// `boolean` to an object while keeping their names would have left every
// `if (await isInstitutionAdmin(...))` compiling — and always true, because an
// object is truthy. That is a silent grant of access, invisible to the type
// checker. Renaming makes the compiler enumerate the call sites instead.
export type AuthzCheck =
  | { ok: true; allowed: boolean }
  | { ok: false; error: string };

/** Shorthand for the common "allowed, and the check succeeded" case. */
export const allowed = (value: boolean): AuthzCheck => ({ ok: true, allowed: value });

/**
 * A non-suspended admin of `institutionId`, or a super-admin.
 *
 * Super-admins are deliberately included: `is_institution_admin` ORs in
 * `is_super_admin`, which is global and carries no institution membership to
 * suspend. Callers therefore do not need a separate super-admin branch — and
 * should drop theirs rather than keep a redundant second round-trip.
 */
export async function checkInstitutionAdmin(
  // deno-lint-ignore no-explicit-any
  supabase: SupabaseClient | any,
  userId: string,
  institutionId: string,
): Promise<AuthzCheck> {
  const { data, error } = await supabase.rpc("is_institution_admin", {
    _user_id: userId,
    _institution_id: institutionId,
  });
  if (error) return { ok: false, error: error.message };
  return allowed(data === true);
}

/**
 * Does `userId` hold a membership of `institutionId` that is not suspended?
 *
 * The gate for anything keyed off a table that has no suspension column of its
 * own — `course_instructors` being the one that matters here.
 */
export async function checkActiveMembership(
  // deno-lint-ignore no-explicit-any
  supabase: SupabaseClient | any,
  userId: string,
  institutionId: string,
): Promise<AuthzCheck> {
  const { data, error } = await supabase
    .from("user_institutions")
    .select("is_suspended")
    .eq("user_id", userId)
    .eq("institution_id", institutionId)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  return allowed(!!data && (data as { is_suspended: boolean }).is_suspended !== true);
}

/**
 * An assigned instructor of `courseId` whose institution membership is live.
 *
 * `course_instructors` carries no suspension column
 * (20260331000000_course_instructors_and_academic_period.sql:6-9), so a
 * suspended user keeps every course assignment they had. Checking the
 * assignment alone therefore re-opens exactly the hole this module closes,
 * which is why membership is verified FIRST and the assignment lookup is
 * skipped entirely when it fails.
 */
export async function checkActiveCourseInstructor(
  // deno-lint-ignore no-explicit-any
  supabase: SupabaseClient | any,
  userId: string,
  courseId: string,
  institutionId: string,
): Promise<AuthzCheck> {
  const membership = await checkActiveMembership(supabase, userId, institutionId);
  if (!membership.ok) return membership;
  if (!membership.allowed) return allowed(false);

  const { data, error } = await supabase
    .from("course_instructors")
    .select("user_id")
    .eq("course_id", courseId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  return allowed(!!data);
}
