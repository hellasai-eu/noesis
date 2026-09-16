import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export interface EnsureIndividualGroupResult {
  group_id: string;
  created: boolean;
}

/**
 * Resolve (or lazily create) the hidden singleton offering_groups row that
 * represents a single targeted student inside an offering. The student is
 * also added to offering_group_members on creation so the existing
 * group-aware RLS / visibility / assignment paths apply uniformly.
 *
 * Idempotent: safe to call repeatedly for the same (offering, student) pair.
 * Tolerates a parallel race by re-SELECTing on unique-violation.
 */
export async function ensureIndividualGroup(
  supabase: SupabaseClient,
  offeringId: string,
  studentUserId: string,
): Promise<EnsureIndividualGroupResult> {
  // deno-lint-ignore no-explicit-any
  const sb = supabase as any;

  const { data: existing, error: selErr } = await sb
    .from("offering_groups")
    .select("id")
    .eq("offering_id", offeringId)
    .eq("owner_user_id", studentUserId)
    .eq("is_individual", true)
    .maybeSingle();

  if (selErr) throw selErr;
  if (existing?.id) {
    return { group_id: existing.id as string, created: false };
  }

  const { data: inserted, error: insErr } = await sb
    .from("offering_groups")
    .insert({
      offering_id: offeringId,
      name: `_individual_${studentUserId}`,
      is_individual: true,
      owner_user_id: studentUserId,
    })
    .select("id")
    .maybeSingle();

  // On unique-violation race (23505), re-SELECT and return the winner.
  if (insErr) {
    const code = (insErr as { code?: string }).code;
    if (code === "23505") {
      const { data: again, error: reErr } = await sb
        .from("offering_groups")
        .select("id")
        .eq("offering_id", offeringId)
        .eq("owner_user_id", studentUserId)
        .eq("is_individual", true)
        .maybeSingle();
      if (reErr) throw reErr;
      if (!again?.id) throw insErr;
      return { group_id: again.id as string, created: false };
    }
    throw insErr;
  }

  if (!inserted?.id) {
    throw new Error("Failed to create individual offering group");
  }

  const groupId = inserted.id as string;

  // Add the student to the group (idempotent: ignore duplicate-key races).
  const { error: memErr } = await sb
    .from("offering_group_members")
    .insert({ group_id: groupId, user_id: studentUserId });
  if (memErr) {
    const code = (memErr as { code?: string }).code;
    if (code !== "23505") throw memErr;
  }

  return { group_id: groupId, created: true };
}
