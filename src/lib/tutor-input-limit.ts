/**
 * The per-message character cap the tutor enforces.
 *
 * Mirrors `INPUT_CHAR_LIMIT` in `supabase/functions/_shared/chat-turn.ts`,
 * which both tutoring surfaces share. Change it here and there together; the
 * server's copy is the one that actually protects the prompt budget, this one
 * exists so a student is told before they send rather than after.
 *
 * Until this constant existed nothing on the client knew the cap. A student
 * who wrote a long answer had it accepted by the box, written to the
 * transcript, and then rejected with a 400 — leaving their message sitting in
 * the conversation with no reply after it.
 */
export const TUTOR_INPUT_CHAR_LIMIT = 4096;
