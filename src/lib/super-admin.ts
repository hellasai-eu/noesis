import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Pure loader: is this user a platform super admin?
 *
 * Throws on RPC failure instead of coercing to `false` — callers gate real
 * navigation on this answer (a super admin has no `user_institutions` row, so
 * a false negative bounces them off pages they own), and only a thrown error
 * lets React Query retry and surface the failure.
 */
export async function loadIsSuperAdmin(
  supabase: SupabaseClient,
  userId: string,
): Promise<boolean> {
  const { data, error } = await supabase.rpc("is_super_admin", { _user_id: userId });
  if (error) throw error;
  return !!data;
}
