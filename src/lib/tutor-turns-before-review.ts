/**
 * How many transcript messages (student + tutor combined) a tutoring session
 * may hold before the server pauses it for instructor review.
 *
 * Mirrors `TURNS_BEFORE_REVIEW` in `supabase/functions/_shared/chat-turn.ts`.
 * Change it here and there together; the server's copy is the one that
 * actually pauses the session, this one exists so the student can see the
 * pause coming instead of hitting it unannounced.
 *
 * The server pauses when the transcript length reaches a multiple of this
 * value, so after an instructor unpauses, the next pause lands one full
 * interval later.
 */
export const TUTOR_TURNS_BEFORE_REVIEW = 80;
