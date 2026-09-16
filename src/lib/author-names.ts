/**
 * Shared resolution of `created_by` UUIDs to a display name for the Author
 * columns (questions, quizzes, tests).
 *
 * Two failure modes used to surface as a bare "Unknown":
 *
 *  1. `profiles.full_name` is NULL. `handle_new_user` only fills it from the
 *     signup metadata (`raw_user_meta_data ->> 'full_name'`), so an account
 *     created by invitation or by an admin has no name at all — while `email`
 *     is written for every account. Falling back to the email keeps the column
 *     informative instead of anonymising every such author.
 *
 *  2. RLS hid the profile row. `profiles` is SELECT-able only for yourself,
 *     by admins of your institution, and by instructors for students they
 *     teach — so one instructor cannot resolve another instructor's name.
 *     Those ids are simply absent from the returned map; callers keep their
 *     own "Unknown" fallback for them.
 */
import { supabase } from "@/integrations/supabase/client";

export async function fetchAuthorNames(
  userIds: (string | null | undefined)[],
): Promise<Record<string, string>> {
  const ids = Array.from(new Set(userIds.filter((id): id is string => !!id)));
  if (ids.length === 0) return {};

  const { data, error } = await supabase
    .from("profiles")
    .select("user_id, full_name, email")
    .in("user_id", ids);

  if (error) {
    console.error("Failed to resolve author names", error);
    return {};
  }

  const names: Record<string, string> = {};
  for (const p of data ?? []) {
    const row = p as { user_id: string; full_name: string | null; email: string | null };
    const label = row.full_name?.trim() || row.email?.trim();
    if (label) names[row.user_id] = label;
  }
  return names;
}
