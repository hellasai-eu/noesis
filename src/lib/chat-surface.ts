/**
 * Which tutoring surface students actually get.
 *
 * Streaming is the only one they see. The buffered path is deliberately left in
 * the tree — the `chat` edge function, `runChatTurn`, and the inline chat in
 * `StudentOpenQuestions` / `StudentStudySession` — so pulling streaming is a
 * one-line revert rather than an archaeology exercise. Both surfaces read and
 * write the same `chat_sessions` row, so a student mid-conversation would carry
 * on where they left off either way.
 *
 * **Flipping this back does not undo everything.** The pause interval is now
 * shared (`TURNS_BEFORE_REVIEW`), and it is the server that decides it, so the
 * buffered path pauses on the same schedule. That is intentional: a student
 * should not meet review at a different point because of which renderer they
 * were served.
 *
 * **What it does change is moderation.** On streaming, a flagged tutor reply
 * has been read by the time it can be screened, so the session is annotated,
 * paused and reported rather than the reply being withheld (#1198). The
 * buffered path screens before the first byte and withholds outright. Shipping
 * streaming as the default is an accepted trade, not an oversight; if that
 * trade ever looks wrong, this is the switch.
 */
export const USE_STREAMING_CHAT = true;
