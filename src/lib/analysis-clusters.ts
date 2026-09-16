/**
 * The student clusters an AI analysis produces, and the one way they are turned
 * into real offering groups.
 *
 * Both `quiz_analyses.clusters` and `study_guide_analyses.clusters` hold the
 * same JSON shape, written by `analyze-quiz` / `analyze-study-guide`. Until an
 * instructor acts on them they are just a reading — rows in a JSONB column that
 * nothing else in the app can target. {@link createGroupsFromClusters} is the
 * step that makes them real: it writes `offering_groups` +
 * `offering_group_members`, after which the groups behave like any other group
 * (assignable content, group-scoped analytics, the Student Groups panel).
 *
 * The naming rule lives here rather than at each call site because the name is
 * what makes a created group findable later. "Confuses mitosis and meiosis" is
 * a fine label inside the panel that produced it; in a class's group list, next
 * to twenty other groups from a term's worth of quizzes and guides, it says
 * nothing about where it came from. {@link followupGroupName} postfixes the
 * source so it does.
 */
import { supabase } from "@/integrations/supabase/client";

/**
 * One AI-proposed group of students who share a conceptual struggle.
 *
 * A `type` rather than an `interface` on purpose: this is written straight into
 * a JSONB column, and the generated `Json` type demands an index signature.
 * TypeScript gives type aliases of object literals an implicit one; interfaces
 * get none, because declaration merging could invalidate it later. Declaring it
 * as an interface makes `update({ clusters })` fail to typecheck.
 */
export type AnalysisCluster = {
  label: string;
  rationale: string;
  summary: string;
  member_user_ids: string[];
  /**
   * Set once this cluster has been turned into a real offering group, so a
   * later visit (or another surface) does not create it a second time. The
   * analyzers never write these; they are stamped by the clusters section
   * after a create and carried through saves like the rest of the shape.
   */
  created_group_id?: string;
  created_group_name?: string;
};

/** `offering_groups.name` is unbounded in the schema; this keeps rows sane. */
const MAX_GROUP_NAME = 200;

/**
 * How many " (2)", " (3)" … suffixes to try before giving up on a collision.
 * The table has UNIQUE(offering_id, name), and re-running an analysis against
 * the same quiz or guide legitimately produces the same labels again.
 */
const MAX_NAME_ATTEMPTS = 25;

/**
 * The name a cluster gets when it becomes a real group.
 *
 * Mirrors the postfix `enqueue-followup-practice` has always used, so a group
 * created from the analysis panel and one created by the follow-up-practice
 * flow read as the same kind of thing in the group list.
 */
export function followupGroupName(label: string, sourceTitle: string): string {
  const cleanLabel = label.trim() || "Group";
  const cleanSource = sourceTitle.trim();
  const name = cleanSource ? `${cleanLabel} — ${cleanSource} follow ups` : cleanLabel;
  return name.length > MAX_GROUP_NAME ? name.slice(0, MAX_GROUP_NAME).trimEnd() : name;
}

export interface CreateGroupsResult {
  /** Ids of the groups created, in the order the clusters were given. */
  groupIds: string[];
  /** The final names, which may carry a numeric suffix after a collision. */
  names: string[];
}

interface CreateGroupsInput {
  offeringId: string;
  /** Quiz or study-guide title — the postfix is derived from it. */
  sourceTitle: string;
  /** Only clusters with members are written; empty ones are skipped. */
  clusters: AnalysisCluster[];
  /**
   * Stamped on both tables so the group list shows who made it. Resolved from
   * the session when omitted — the caller is a dialog, not an auth surface,
   * and both columns are nullable, so a session we cannot read costs
   * attribution rather than the operation.
   */
  createdBy?: string | null;
}

/** The signed-in user's id, or null when the session cannot be read. */
async function currentUserId(): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getUser();
    return data?.user?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Insert one group, retrying with a numeric suffix on a name collision.
 *
 * Mirrors `createGroupWithUniqueName` in `enqueue-followup-practice`. A
 * collision is the expected case, not the exceptional one: an instructor who
 * regenerates an analysis and creates groups a second time gets the same
 * labels back, and failing the whole operation over that would be useless.
 */
async function insertGroupWithUniqueName(
  offeringId: string,
  baseName: string,
  description: string | null,
  createdBy: string | null,
): Promise<{ id: string; name: string }> {
  for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt++) {
    const suffix = attempt === 0 ? "" : ` (${attempt + 1})`;
    // Trim the base, not the suffix — a truncated "… follow ups (3)" still
    // reads correctly, while "… follow up" plus a lost suffix would collide.
    const name = baseName.length + suffix.length > MAX_GROUP_NAME
      ? `${baseName.slice(0, MAX_GROUP_NAME - suffix.length).trimEnd()}${suffix}`
      : `${baseName}${suffix}`;

    const { data, error } = await supabase
      .from("offering_groups")
      .insert({ offering_id: offeringId, name, description, created_by: createdBy })
      .select("id")
      .single();

    if (!error && data) return { id: data.id as string, name };
    // 23505 = unique_violation → the name is taken; try the next suffix.
    if (error && error.code !== "23505") throw error;
  }
  throw new Error(`Could not find a free name for "${baseName}"`);
}

/**
 * Create one offering group per non-empty cluster.
 *
 * This is NOT atomic. Each insert is its own request — PostgREST gives no
 * client-side transaction — so a failure part-way through is cleaned up by
 * compensating deletes rather than rolled back by the database. That is the
 * same trade `AutoClusterDialog` already makes for the same operation; making
 * it genuinely atomic means moving creation into a SECURITY DEFINER function,
 * which is a larger change than this path warrants today.
 *
 * What the compensation must not do is fail silently. A half-created set is
 * worse than none precisely because the instructor cannot tell which groups
 * are whole — so when cleanup itself fails, that is folded into the error they
 * see, naming the groups left behind. The original failure still leads, since
 * it is the one that explains what went wrong.
 */
export async function createGroupsFromClusters({
  offeringId,
  sourceTitle,
  clusters,
  createdBy,
}: CreateGroupsInput): Promise<CreateGroupsResult> {
  const usable = clusters.filter((c) => c.member_user_ids.length > 0);
  if (usable.length === 0) {
    throw new Error("None of these groups have students in them.");
  }
  const author = createdBy !== undefined ? createdBy : await currentUserId();

  const groupIds: string[] = [];
  const names: string[] = [];
  try {
    for (const cluster of usable) {
      const { id, name } = await insertGroupWithUniqueName(
        offeringId,
        followupGroupName(cluster.label, sourceTitle),
        cluster.summary?.trim() || cluster.rationale?.trim() || null,
        author,
      );
      groupIds.push(id);
      names.push(name);

      const { error: memberError } = await supabase
        .from("offering_group_members")
        .insert(
          cluster.member_user_ids.map((userId) => ({
            group_id: id,
            user_id: userId,
            added_by: author,
          })),
        );
      if (memberError) throw memberError;
    }
  } catch (error) {
    if (groupIds.length > 0) {
      // Members are removed first so that a failure to delete the groups still
      // leaves no student inside a half-built one.
      const { error: memberCleanupError } = await supabase
        .from("offering_group_members")
        .delete()
        .in("group_id", groupIds);
      const { error: groupCleanupError } = await supabase
        .from("offering_groups")
        .delete()
        .in("id", groupIds);

      if (memberCleanupError || groupCleanupError) {
        const original = (error as Error)?.message || String(error);
        throw new Error(
          `${original} — and cleaning up afterwards also failed, so ${groupIds.length} ` +
            `partially-created ${groupIds.length === 1 ? "group" : "groups"} may still exist. ` +
            `Check Student Groups for "${names.join('", "')}".`,
        );
      }
    }
    throw error;
  }

  return { groupIds, names };
}
