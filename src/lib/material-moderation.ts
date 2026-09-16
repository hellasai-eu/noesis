/**
 * Image moderation state for a `course_materials` row.
 *
 * This used to be encoded by writing the sentinels `"moderated"` / `"rejected"`
 * into `openai_file_id`, which meant a moderated image looked to every other
 * reader like a material with a real OpenAI file behind it — deleting one sent
 * `file_id=moderated` to OpenAI and failed. The state has its own column now;
 * `openai_file_id` holds an OpenAI file id or nothing.
 *
 * `is_moderated` still exists and still means "moderation has run" — it is true
 * for an approved and a rejected image alike, so it must never be used to mean
 * "approved". Use `MODERATION_APPROVED` for that.
 */
export type ModerationStatus = "pending" | "approved" | "rejected";

export const MODERATION_PENDING = "pending" satisfies ModerationStatus;
export const MODERATION_APPROVED = "approved" satisfies ModerationStatus;
export const MODERATION_REJECTED = "rejected" satisfies ModerationStatus;

/**
 * Narrow the raw column value to `ModerationStatus`.
 *
 * A CHECK constraint keeps the column to these three values, so the fallback is
 * only reached by a row written before the constraint existed — which is
 * unmoderated by definition.
 */
export const asModerationStatus = (value: string | null | undefined): ModerationStatus =>
  value === MODERATION_APPROVED || value === MODERATION_REJECTED ? value : MODERATION_PENDING;

/**
 * The shape `moderate-study-image` returns. Its schema constrains `decision` to
 * "ALLOW" | "REJECT", but the field is typed loosely here because this crosses
 * an edge-function boundary and `moderationPatch` is deliberately fail-closed:
 * only a literal "ALLOW" approves an image.
 */
export interface ModerationResult {
  decision?: string | null;
  description?: string | null;
  reason_category?: string | null;
  notes?: string | null;
}

export interface ModerationPatch {
  /** "Moderation has run" — true for an approved and a rejected image alike. */
  is_moderated: true;
  moderation_status: ModerationStatus;
  ai_description: string | null;
  /**
   * The uploader-visible description, overwritten with what moderation saw.
   *
   * Present only when moderation actually produced a description — a rejection
   * returns an empty one, and blanking the uploader's own text in that case
   * would destroy information without putting anything in its place.
   */
  description?: string;
}

/**
 * Build the `course_materials` patch that records a moderation outcome.
 *
 * Built in one place so the set of columns moderation may touch stays fixed:
 * the outcome goes to `moderation_status`, and never to `openai_file_id`.
 *
 * An approval also overwrites `description` with the moderator's own account of
 * the image, so the description shown next to an approved image is the one
 * derived from what is actually in it rather than whatever the uploader typed.
 */
export const moderationPatch = (result: ModerationResult): ModerationPatch => {
  if (result.decision !== "ALLOW") {
    return {
      is_moderated: true,
      moderation_status: MODERATION_REJECTED,
      ai_description: `REJECTED: ${result.reason_category}${result.notes ? ` - ${result.notes}` : ""}`,
    };
  }

  const description = result.description?.trim() || null;

  return {
    is_moderated: true,
    moderation_status: MODERATION_APPROVED,
    ai_description: description,
    ...(description ? { description } : {}),
  };
};
