import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export interface GroupAudience {
  group_id: string;
  offering_id: string;
  name: string;
  /** The description as it went into the prompt — trimmed and length-clamped. */
  description: string | null;
  hint: string;
}

/**
 * Upper bound on the description copied into the prompt. The column is
 * unbounded free text and the group editor sets no maxLength, so a pasted wall
 * of text would otherwise crowd out the source material — or blow the request
 * limit and fail the generation outright. A group description that says what
 * to practise fits in a sentence or two; 1000 characters is generous for that
 * and cheap next to the chapter content it shares the prompt with.
 */
const MAX_DESCRIPTION_CHARS = 1000;

/** Truncate on a word boundary where one is close to the limit. */
function clampDescription(text: string): string {
  if (text.length <= MAX_DESCRIPTION_CHARS) return text;
  const cut = text.slice(0, MAX_DESCRIPTION_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  const body = lastSpace > MAX_DESCRIPTION_CHARS - 100 ? cut.slice(0, lastSpace) : cut;
  return `${body.trimEnd()}…`;
}

/**
 * Build the audience hint for a target student group: the instructor's own
 * name + description for the group, and an instruction to aim the questions at
 * the weakness that description names.
 *
 * The description is the whole signal on purpose. This used to aggregate a
 * mastery snapshot (group MCQ accuracy, weakest/strongest competencies) across
 * every member, which cost four queries per generation to say something the
 * instructor had usually already written — in their own words, and about the
 * thing they actually wanted practised.
 *
 * Returns null when the group does not exist or does not belong to the course.
 * Callers treat null as "ignore the target": no hint, and no
 * `generated_for_group_id` stamped onto the questions.
 */
export async function buildGroupAudienceHint(
  supabase: SupabaseClient,
  courseId: string,
  groupId: string,
): Promise<GroupAudience | null> {
  const { data: group, error: groupErr } = await supabase
    .from("offering_groups")
    .select("id, name, description, offering_id, offerings!inner(course_id)")
    .eq("id", groupId)
    .maybeSingle();

  if (groupErr || !group) return null;
  // deno-lint-ignore no-explicit-any
  const offeringCourseId = (group as any).offerings?.course_id as string | undefined;
  if (offeringCourseId !== courseId) return null;

  const stored = ((group.description as string | null) ?? "").trim();
  const description = stored ? clampDescription(stored) : "";

  const lines: string[] = [`Target audience: student group "${group.name}".`];
  if (description) {
    lines.push(`The instructor describes this group as: ${description}`);
    lines.push(
      "Wherever the material allows it, aim each question at the weakness that description names — " +
        "practise it directly rather than working around it. Where a question cannot reach that " +
        "weakness without leaving the material, stay with the material: never invent content to fit " +
        "the description.",
    );
  } else {
    lines.push(
      "No description was written for this group, so there is no stated weakness to target — " +
        "generate normally from the material.",
    );
  }

  return {
    group_id: group.id as string,
    offering_id: group.offering_id as string,
    name: group.name as string,
    description: description || null,
    hint: lines.join("\n"),
  };
}
