import { supabase } from "@/integrations/supabase/client";
import type { TablesInsert } from "@/integrations/supabase/types";

/**
 * Find the `chat_sessions` row for a (student, subject), creating it on first
 * contact.
 *
 * Both tutoring surfaces share one row per (student, subject), and
 * `chat_sessions_unique_open_question` / `chat_sessions_unique_study_session`
 * hold them to it. Every client that opened a conversation used to read the row
 * and insert one when the read came back empty — with nothing between the two
 * steps, so any reason the read missed a row that exists turned the insert into
 * a duplicate key, and the student was shown the constraint's name where the
 * tutor's answer belonged.
 *
 * The read can miss for reasons that have nothing to do with the student: it is
 * issued while the panel is still mounting, a token refresh can fail it, and a
 * second tab or a retried turn can create the row in between. None of those is
 * a lost session — the row the insert collided with is the row we wanted — so
 * the collision is resolved by re-reading it rather than by failing the turn.
 *
 * This is the client-side mirror of `resolveSession` in
 * `supabase/functions/_shared/chat-turn.ts`, which has answered a 23505 the
 * same way since the tables were unified.
 */

const UNIQUE_VIOLATION = "23505";

export type ChatSubjectColumn = "study_session_id" | "open_question_id";

export interface EnsureChatSessionArgs {
  subjectColumn: ChatSubjectColumn;
  subjectId: string;
  userId: string;
  courseId: string;
  /**
   * The section this work belongs to, where the caller knows it. The
   * open-question surfaces deliberately leave it unset: only the edge
   * function's authorisation check knows which offering published a question,
   * and it scopes the row on the first turn.
   */
  offeringId?: string | null;
  /** Columns to return. `id` is all most callers need. */
  columns?: string;
}

export interface EnsureChatSessionResult<T> {
  session: T;
  /** False when the row was already there — read back, or raced with. */
  created: boolean;
}

/**
 * Resolve the session, or throw the error that stopped us.
 *
 * Throws rather than returning an error object because every caller does the
 * same thing with a failure: abandon the turn and show the message. A failed
 * *read* is thrown too — the alternative is to treat "we could not tell" as
 * "there is none" and insert over the top of a live conversation, which is the
 * bug this exists to close.
 */
export async function ensureChatSession<T = { id: string }>(
  args: EnsureChatSessionArgs,
): Promise<EnsureChatSessionResult<T>> {
  const { subjectColumn, subjectId, userId, courseId, offeringId = null, columns = "id" } = args;

  const read = async () =>
    await supabase
      .from("chat_sessions")
      .select(columns)
      .eq("user_id", userId)
      .eq(subjectColumn, subjectId)
      .maybeSingle();

  const { data: existing, error: readError } = await read();
  if (readError) throw readError;
  if (existing) return { session: existing as T, created: false };

  // Spread rather than `{ [subjectColumn]: subjectId, ... }`: a computed key
  // widens the whole literal to an index signature, which postgrest-js now
  // rejects because it can no longer check the column names.
  const subject: TablesInsert<"chat_sessions"> =
    subjectColumn === "study_session_id"
      ? { study_session_id: subjectId, user_id: userId, course_id: courseId }
      : { open_question_id: subjectId, user_id: userId, course_id: courseId };

  const { data: created, error: insertError } = await supabase
    .from("chat_sessions")
    .insert({
      ...subject,
      offering_id: offeringId,
      status: "in_progress",
      started_at: new Date().toISOString(),
    })
    .select(columns)
    .single();

  if (created) return { session: created as T, created: true };

  if ((insertError as { code?: string } | null)?.code === UNIQUE_VIOLATION) {
    const { data: raced } = await read();
    // The constraint says the row exists; only a second failed read gets us
    // here, and then the insert error is still the truer account of the turn.
    if (raced) return { session: raced as T, created: false };
  }

  throw insertError ?? new Error("Failed to open a chat session");
}
