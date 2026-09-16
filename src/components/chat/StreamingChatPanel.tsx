import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { ChatWidget, useChatMessages, useChatStreaming, parseSSEStream } from "@/components/chat";
import { TUTOR_INPUT_CHAR_LIMIT } from "@/lib/tutor-input-limit";
import { ensureChatSession } from "@/lib/chat-session";
import { TUTOR_TURNS_BEFORE_REVIEW } from "@/lib/tutor-turns-before-review";
import { formatQuestionText } from "@/lib/latex-utils";
import aiTutorImage from "@/assets/ai-tutor.png";

export interface StreamingChatPanelProps {
  kind: "study_session" | "open_question";
  /** The study session id, or the open question id. */
  subjectId: string;
  courseId: string;
  onBack: () => void;
  /** Shown above the conversation, e.g. the session title or question text. */
  heading?: string;
  /**
   * What the instructor wrote *for the student*, under the heading.
   *
   * A study session's notes, and only those. Its `topic` is deliberately not
   * shown anywhere: it is the objective the tutor is given — "have the student
   * explain how…" — written about the student rather than to them, and putting
   * it on screen both spoiled the session and read as if the student were being
   * handed someone else's brief.
   *
   * A node rather than a string because the notes are authored HTML, so the
   * caller renders them the same way every other surface does.
   */
  notes?: ReactNode;
  /** Beside the tutor avatar, e.g. "Open question" / the session title. */
  title?: string;
  /** Under the title, e.g. "Socratic learning" / the session topic. */
  subtitle?: string;
  /**
   * Controls on the right of the header — difficulty, mark-as-complete.
   *
   * Supplied by the caller rather than built here: what a student can do to an
   * open question is not what they can do to a study session, and this panel
   * knowing the difference would put both surfaces' rules back in one file
   * after `chat-turn.ts` spent a refactor getting them out of one.
   */
  headerActions?: ReactNode;
  /**
   * Rendered above the question, for a question that has a diagram.
   *
   * Not optional in practice: an open question whose statement lives in its
   * figure is unanswerable without it, and losing it is a silent failure — the
   * text still renders, so the screen looks fine.
   */
  diagram?: ReactNode;
  /** Facts under the question: created, started, message count. */
  meta?: ReactNode;
  /**
   * Files the student can open alongside the conversation — the instructor's
   * reference images on a study session.
   *
   * Rendered above the transcript rather than inside it: they belong to the
   * session, not to any one turn, and the tutor is not told they exist.
   */
  attachments?: ReactNode;
  /**
   * Composer placeholder for the ordinary case.
   *
   * The caller's, because it is surface copy — "Type your response..." on a
   * study session, "Share your thoughts or ask for a hint..." on an open
   * question — and a student should not find the prompt reworded because they
   * were served a different renderer. The paused wording is this panel's, since
   * only it knows the session is paused.
   */
  placeholder?: string;
  /**
   * Ask the tutor to open the conversation when the transcript is empty.
   *
   * A study session is a topic the instructor set, not a question the student
   * brought, so an empty screen with a composer gives them nothing to react to:
   * the objective the instructor wrote is on screen, but what the session will
   * actually do with it is not. The server already accepts an opening turn
   * (`start`), and it builds it from that same objective.
   */
  openWithTutorTurn?: boolean;
  /**
   * Refuse new turns for a reason only the caller knows — a completed open
   * question, say.
   *
   * OR-ed with this panel's own `paused`, never replacing it. The buffered view
   * gated on `isFlagged || isCompleted`; serving this renderer instead dropped
   * the second half, so a student could keep tutoring a question they had
   * already finished and the server would persist every turn of it.
   */
  disabled?: boolean;
}

/**
 * The tutoring surface students get, for both open questions and study
 * sessions.
 *
 * Talks to `/functions/v1/chat-stream`, which emits the same SSE frames the
 * buffered `/chat` endpoint does — so `parseSSEStream` is reused unchanged and
 * the only difference the client sees is that text arrives as the model writes
 * it rather than being animated out of a finished string.
 *
 * The buffered path is still in the tree behind `USE_STREAMING_CHAT`; both
 * share one `chat_sessions` row per (student, subject), so flipping that switch
 * continues the same conversation rather than starting a parallel one.
 *
 * The header and the facts under the question are the caller's — `title`,
 * `subtitle`, `headerActions`, `meta`. A student must not lose "mark as
 * complete", or the created/started/message-count line, by being served this
 * renderer instead of the other one.
 *
 * ## The moderation banner is not decoration
 *
 * On the ordinary page a flagged reply is withheld and never rendered (#1198).
 * Streaming makes that impossible: the pupil has read the text by the time it
 * can be screened. The banner is the only signal they get that what they just
 * read was withdrawn for review. It must stay visible.
 *
 * It arrives over Realtime, not over the stream. The server terminates the
 * stream once the turn is persisted and screens the reply behind `waitUntil`,
 * so that a Moderation round-trip no longer stalls a reply the pupil has
 * already finished reading. By the time a verdict exists there is no stream
 * left to carry it, so the pause on `chat_sessions` is the carrier — and it
 * names its own cause in `pause_reason`.
 *
 * That single fact is load-bearing. An earlier draft correlated a
 * `role='moderation'` message against `chat_sessions.status`, and because
 * those two rows commit separately, every interleaving of the writes, the
 * reads and the events was its own bug — five review rounds of them. Anything
 * that reintroduces a second source for this state reintroduces that whole
 * class; see 20260903140000.
 */
/**
 * The session row's pause, as the panel needs it.
 *
 * Both fields come from one row, so there is no interleaving to reason about:
 * a paused session always arrives already carrying the reason it was paused
 * for, whether that arrives by query or by Realtime payload.
 *
 * `pause_reason` is read through a cast because `types.ts` is generated from
 * the deployed schema and picks the column up on the next regeneration; the
 * column itself is added by 20260903140000. `last_instructor_message_at` is
 * read the same way, and is added by 20260906180000.
 */
type SessionPause = {
  status?: string | null;
  pause_reason?: string | null;
  /**
   * When a teacher last wrote into this session.
   *
   * A notification, not a fact: it says *that* an instructor message exists,
   * never what it said. The panel re-reads the transcript and renders what it
   * finds; nothing is ever reconstructed from this value. See 20260906180000
   * for why the signal rides the session row rather than the message table.
   */
  last_instructor_message_at?: string | null;
};

/** The columns both the transcript read and the live merge select. */
type TranscriptRow = {
  id: string;
  role: string;
  content: string;
  sender_user_id: string | null;
  created_at: string;
};

/**
 * Who wrote each instructor turn, so the bubble can be signed.
 *
 * A separate query on purpose: `chat_messages.sender_user_id` has no foreign
 * key to `profiles`, so a PostgREST embed does not resolve, and the buffered
 * page reads the names the same way.
 *
 * Missing names are not an error. A student may not be able to read the
 * teacher's profile row, and the message is still theirs — ChatWidget falls
 * back to the unnamed label rather than dropping the attribution.
 */
async function resolveInstructorNames(
  rows: TranscriptRow[],
): Promise<Record<string, string>> {
  const ids = Array.from(
    new Set(
      rows
        .filter((m) => m.role === "instructor" && m.sender_user_id)
        .map((m) => m.sender_user_id as string),
    ),
  );
  const nameById: Record<string, string> = {};
  if (ids.length === 0) return nameById;

  const { data: profiles } = await supabase
    .from("profiles")
    .select("user_id, full_name")
    .in("user_id", ids);
  (profiles ?? []).forEach((profile) => {
    if (profile.full_name) nameById[profile.user_id] = profile.full_name;
  });
  return nameById;
}

/** One transcript row as ChatWidget wants it. */
function toChatMessage(m: TranscriptRow, nameById: Record<string, string>) {
  return {
    id: m.id,
    // `instructor` is kept as itself rather than folded into `assistant`.
    // A teacher stepping into the session writes as themselves, and rendering
    // that in the tutor's bubble, under the tutor's avatar, attributes a
    // human's words to the model — the one thing a student reading a tutoring
    // transcript must never have to guess about.
    role: (m.role === "user" ? "user" : m.role === "instructor" ? "instructor" : "assistant") as
      | "user"
      | "assistant"
      | "instructor",
    content: m.content,
    timestamp: m.created_at,
    senderName:
      m.role === "instructor" && m.sender_user_id ? nameById[m.sender_user_id] : undefined,
  };
}

function moderationStateOf(
  session: SessionPause,
): { paused: boolean; withheld: boolean; completed: boolean } {
  const paused = session.status === "paused";
  const completed = session.status === "completed";
  // Named, not inferred. The reason distinguishes a withheld tutor reply from
  // the pupil's own flagged message, a history limit and a review interval —
  // and telling a child their tutor was flagged when it was their own message
  // that tripped the gate is the mistake this is written to make impossible.
  return {
    paused,
    completed,
    withheld: paused && session.pause_reason === "assistant_moderation",
  };
}

export function StreamingChatPanel({
  kind,
  subjectId,
  courseId,
  onBack,
  heading,
  notes,
  title,
  subtitle,
  headerActions,
  diagram,
  meta,
  attachments,
  placeholder,
  openWithTutorTurn = false,
  disabled = false,
}: StreamingChatPanelProps) {
  const { t } = useTranslation("study");
  const [messages, setMessages] = useChatMessages();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [paused, setPaused] = useState(false);
  const [flagNotice, setFlagNotice] = useState<string | null>(null);
  /** Non-fatal server notices: the turn was not saved, or already answered. */
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * Set when the student's turn was saved but the reply did not arrive.
   *
   * Retrying must ask for the missing reply, never re-send the message: the
   * server reads the student's turn from the transcript, so a second insert
   * would duplicate it there and in every future model context. The buffered
   * page solves this the same way (`retryTutorReply`).
   */
  const [awaitingReply, setAwaitingReply] = useState(false);
  /** The turn a failed request was asking about, so Retry names the same one. */
  const [pendingTurnId, setPendingTurnId] = useState<string | null>(null);
  /**
   * Finished, according to the session row.
   *
   * Not a latch on the refusal, and not the caller's `disabled` prop — both go
   * stale. This is read from `chat_sessions.status` on load, on reconcile and
   * on every Realtime update, which is the same single-source rule the pause
   * follows. Reopening the question anywhere clears it without this component
   * needing to hear about it directly.
   */
  const [completed, setCompleted] = useState(false);
  /**
   * Null until the transcript has been read; then, whether it held anything.
   *
   * Three-valued on purpose: "no messages yet" and "not looked yet" are the
   * same empty array, and asking the tutor to open a conversation on the second
   * one would put a welcome in front of a student mid-session.
   */
  const [transcriptEmpty, setTranscriptEmpty] = useState<boolean | null>(null);
  const {
    displayedContent,
    isTyping,
    addToQueue,
    beginTyping,
    finishTyping,
    settleTyping,
    resetTyping,
  } = useChatStreaming();

  const subjectColumn = kind === "study_session" ? "study_session_id" : "open_question_id";
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  /**
   * The newest instructor-message signal this panel has already acted on.
   *
   * Compared against `chat_sessions.last_instructor_message_at`, which the
   * database stamps when a teacher writes (20260906180000). Holding the value
   * rather than a boolean is what makes the merge safe to run from three
   * places — the load, the reconcile and the live event — without any of them
   * needing to know whether the others got there first.
   */
  const lastInstructorSignal = useRef<string | null>(null);
  /**
   * A signal that arrived mid-turn, waiting for the turn to end.
   *
   * The streaming path addresses the reply by position — it overwrites the
   * *last* message with the finished text, and drops it on an unsaved turn —
   * so a message appended underneath the placeholder would be silently
   * overwritten or popped. Rather than teach that code to find its own turn,
   * the merge waits: a teacher's message is not urgent to the millisecond, and
   * a turn is over in seconds.
   */
  const pendingInstructorSignal = useRef<string | null>(null);
  /**
   * Instructor messages already on screen, by id.
   *
   * Kept beside the list rather than derived from it inside a `setMessages`
   * updater: an updater that reads the previous list to decide what to add has
   * to do the deciding *inside* the updater, and React may run that more than
   * once per commit. Dedup belongs somewhere it can run exactly once.
   */
  const renderedInstructorIds = useRef<Set<string>>(new Set());
  /** `sending`, readable from the Realtime callback, which closes over stale state. */
  const sendingRef = useRef(false);
  /** Numbers the optimistic bubbles, so each send can name its own. */
  const optimisticTurns = useRef(0);

  // Load the shared transcript. `moderation` rows are excluded here for the
  // same reason the server excludes them from the model's input: they hold
  // withheld text and a JSON envelope, neither of which is conversation.
  const loadTranscript = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const { data: session, error: sessionError } = await supabase
      .from("chat_sessions")
      .select("*")
      .eq(subjectColumn, subjectId)
      .eq("user_id", user.id)
      .maybeSingle();

    // A read that failed says nothing about whether a session exists, and the
    // two are not interchangeable here: `transcriptEmpty === true` is what lets
    // the tutor open a study session, and it used to be claimed on the strength
    // of a read that may never have run. Left as `null` — "not read yet" — the
    // opening turn holds, and `send` resolves the session against the database
    // rather than against this.
    if (sessionError) return;

    if (!session) {
      setTranscriptEmpty(true);
      return;
    }
    setSessionId(session.id);

    // The pause and its reason come off the one row, so a flag the panel was
    // not mounted for reads back exactly as it would have arrived live.
    const { paused: isPaused, withheld, completed: isComplete } = moderationStateOf(
      session as SessionPause,
    );
    setPaused(isPaused);
    setCompleted(isComplete);
    setFlagNotice(withheld ? t("session.moderationReplyWithheld") : null);

    const { data: rows } = await supabase
      .from("chat_messages")
      .select("id, role, content, sender_user_id, created_at")
      .eq("session_id", session.id)
      .in("role", ["user", "assistant", "instructor"])
      .order("created_at", { ascending: true });

    const nameById = await resolveInstructorNames((rows ?? []) as TranscriptRow[]);

    setMessages(((rows ?? []) as TranscriptRow[]).map((m) => toChatMessage(m, nameById)));
    setTranscriptEmpty((rows ?? []).length === 0);
    // Everything up to here is now on screen, so a signal for any of it would
    // only re-read what was just read. Both of these are what the live merge
    // compares against — and both are *replaced*, not added to, because this
    // runs again when the student picks a different session.
    renderedInstructorIds.current = new Set(
      (rows ?? []).filter((m) => m.role === "instructor").map((m) => m.id),
    );
    lastInstructorSignal.current =
      (session as SessionPause).last_instructor_message_at ?? null;
  }, [subjectColumn, subjectId, setMessages, t]);

  useEffect(() => {
    // Cleared first: `loadTranscript` is rebuilt when the subject changes, and
    // carrying the previous conversation's answer over would let the opening
    // turn below fire against a session nobody has read yet.
    setTranscriptEmpty(null);
    loadTranscript();
  }, [loadTranscript]);

  /**
   * Put whatever a teacher has written into the conversation on screen.
   *
   * Reads the instructor rows and appends the ones not already rendered, keyed
   * by message id. Idempotent by construction, which is what lets the load,
   * the reconcile and the live event all call it without coordinating.
   *
   * Never call this directly — go through `mergeInstructorMessages`, which
   * serialises it. Concurrently, two runs produce a state neither can read: the
   * first claims rows it has not rendered yet, and the second cannot tell those
   * from rows already on screen, so it reports success for work that may still
   * fail.
   *
   * Appended at the end rather than slotted by timestamp. These rows arrive
   * out-of-band and are by definition the newest thing in the conversation;
   * the only message without a timestamp to sort against is the streaming
   * placeholder, and the queue above keeps this from running while one exists.
   */
  const readAndMergeInstructorMessages = useCallback(async (id: string): Promise<boolean> => {
    const { data: rows, error } = await supabase
      .from("chat_messages")
      .select("id, role, content, sender_user_id, created_at")
      .eq("session_id", id)
      .eq("role", "instructor")
      .order("created_at", { ascending: true });

    // A read that failed is not a read that found nothing, and the caller has
    // to be able to tell them apart — see `applyInstructorSignal`.
    if (error) return false;
    if (!rows?.length) return true;
    if (!mounted.current) return false;

    const fresh = (rows as TranscriptRow[]).filter(
      (m) => !renderedInstructorIds.current.has(m.id),
    );
    if (fresh.length === 0) return true;

    // Claimed *before* the await, not after: the append below is what a later
    // run must not repeat, and it is decided here.
    fresh.forEach((m) => renderedInstructorIds.current.add(m.id));

    try {
      const nameById = await resolveInstructorNames(fresh);
      if (!mounted.current) return false;

      setMessages((prev) => [...prev, ...fresh.map((m) => toChatMessage(m, nameById))]);
      // A session that had nothing in it now has something, so the tutor's
      // opening turn must not fire over the top of it.
      setTranscriptEmpty(false);
      return true;
    } catch {
      // Nothing was rendered, so the claim has to go back: left in place it
      // would make every later merge skip these rows as already on screen,
      // and the message would be lost until a reload.
      fresh.forEach((m) => renderedInstructorIds.current.delete(m.id));
      return false;
    }
  }, [setMessages]);

  /**
   * One merge at a time, whatever asks for one.
   *
   * Three callers can fire in the same tick — the live event, the reconcile
   * that runs when the channel connects, and the flush at the end of a turn —
   * and run concurrently they interleave in a way no single run can report on:
   * the second sees rows the first has claimed but not yet rendered, finds
   * nothing fresh, and answers "done" for an append that has not happened. If
   * the first then fails and releases them, that answer has already been used
   * to mark the signal handled, and the message is lost until a newer one
   * arrives — the exact failure the success/failure return exists to prevent.
   *
   * Queueing rather than dropping, because a later caller may be the one with
   * something new to merge. A queued run costs one query and finds nothing
   * when the run ahead of it has already done the work.
   */
  const mergeInFlight = useRef<Promise<boolean> | null>(null);
  const mergeInstructorMessages = useCallback(
    (id: string): Promise<boolean> => {
      const run = (mergeInFlight.current ?? Promise.resolve(true))
        // The predecessor's outcome is its own caller's business, and a
        // rejection there must not cancel this run.
        .catch(() => false)
        .then(() => readAndMergeInstructorMessages(id));
      mergeInFlight.current = run;
      void run.catch(() => {}).finally(() => {
        if (mergeInFlight.current === run) mergeInFlight.current = null;
      });
      return run;
    },
    [readAndMergeInstructorMessages],
  );

  /**
   * Merge, and only then treat the signal as spent.
   *
   * The order matters. Recording it first means a transiently failed read
   * consumes the signal: the same timestamp arriving again — on a reconnect, or
   * on the next update to the row — is dismissed as already handled, and the
   * teacher's message stays invisible until a *newer* message supersedes it or
   * the pupil reloads. Leaving the value behind on failure costs one redundant
   * query the next time something happens, and buys the retry.
   */
  const applyInstructorSignal = useCallback(
    async (id: string, signal: string) => {
      if (await mergeInstructorMessages(id)) lastInstructorSignal.current = signal;
    },
    [mergeInstructorMessages],
  );

  /**
   * Act on a signal, unless a turn is in flight.
   *
   * Takes the timestamp rather than reading it, because the three callers see
   * it in different shapes — a Realtime payload, a row the reconcile read, the
   * row the transcript load read.
   */
  const onInstructorSignal = useCallback(
    (id: string, signal: string | null | undefined) => {
      if (!signal || signal === lastInstructorSignal.current) return;
      if (sendingRef.current) {
        // The value, not a flag: the flush has to know which signal it is
        // acting on to be able to record it.
        pendingInstructorSignal.current = signal;
        return;
      }
      void applyInstructorSignal(id, signal);
    },
    [applyInstructorSignal],
  );

  // Flush a signal that arrived mid-turn, now that the turn is over.
  useEffect(() => {
    sendingRef.current = sending;
    const pending = pendingInstructorSignal.current;
    if (sending || !pending || !sessionId) return;
    // Cleared before the attempt rather than after it. A failure leaves
    // `lastInstructorSignal` untouched, so the retry comes from the next event
    // carrying the same timestamp — holding it here as well would merely queue
    // a second attempt behind an unrelated state change.
    pendingInstructorSignal.current = null;
    void applyInstructorSignal(sessionId, pending);
  }, [sending, sessionId, applyInstructorSignal]);


  /**
   * Counts moderation state applied from a live Realtime event.
   *
   * The reconcile below reads the database and writes the result some
   * milliseconds later. Anything that arrives on the channel in that gap is
   * *newer* than what those reads returned, so applying the snapshot on top
   * would undo it — clearing a banner for a flag the reads were issued too
   * early to see. This counter is how the snapshot knows it has been overtaken.
   */
  const liveModerationEvents = useRef(0);

  /**
   * Re-derive the pause and the banner from the database.
   *
   * Deliberately touches neither the transcript nor any in-flight turn: it runs
   * once the Realtime channel connects, which can be mid-send, and clobbering
   * the messages there would drop the turn the pupil is watching.
   *
   * Discards its own result if a live event landed while it was reading. It
   * cannot merely decline to *clear* state, because clearing is half its job:
   * a release that happened before the channel connected is exactly what it
   * exists to notice. So it is authoritative, but only over the past it
   * actually read.
   */
  const reconcileModeration = useCallback(async (id: string) => {
    const readAt = liveModerationEvents.current;

    const { data: session } = await supabase
      .from("chat_sessions")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (!session) return;

    // Outside the overtaken-by-a-live-event check below, and deliberately so.
    // That check exists because the *moderation* snapshot can be stale — it
    // describes a single mutable state. This does not: it names a message that
    // exists, and the merge it triggers is idempotent, so acting on a signal a
    // live event has already handled costs one query that finds nothing new.
    // Skipping it would instead lose a teacher's message written in the gap
    // between the transcript read and the subscription attaching.
    onInstructorSignal(id, (session as SessionPause).last_instructor_message_at);

    if (liveModerationEvents.current !== readAt) return;

    const { paused: isPaused, withheld, completed: isComplete } = moderationStateOf(
      session as SessionPause,
    );
    setPaused(isPaused);
    setCompleted(isComplete);
    setFlagNotice(withheld ? t("session.moderationReplyWithheld") : null);
  }, [t, onInstructorSignal]);

  /**
   * The pause, live.
   *
   * One subscription on the session row. Screening runs after the stream has
   * closed, so a verdict arrives with no stream to announce it on — this UPDATE
   * is the announcement, and it carries both the pause and the reason for it,
   * so nothing has to be correlated against a second row that commits at a
   * different moment. It also reaches a pupil who has navigated elsewhere in
   * the SPA, which the in-band frame never did.
   *
   * Only `new` is read, so the default replica identity carries everything
   * this needs.
   */
  useEffect(() => {
    if (!sessionId) return;

    const channel = supabase
      .channel(`chat-moderation-${sessionId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "chat_sessions",
          filter: `id=eq.${sessionId}`,
        },
        (payload) => {
          const row = payload.new as SessionPause;
          // Ahead of the `status` guard below, which belongs to the pause and
          // not to this. A teacher's message must reach the pupil whatever the
          // payload says about the session's state.
          onInstructorSignal(sessionId, row.last_instructor_message_at);
          if (!row.status) return;
          liveModerationEvents.current += 1;
          const { paused: isPaused, withheld, completed: isComplete } = moderationStateOf(row);
          setPaused(isPaused);
          setCompleted(isComplete);
          // Both directions, from the same payload. A release ends the banner;
          // a pause for some other reason gets the generic copy rather than a
          // claim about the tutor that this event does not make.
          setFlagNotice(withheld ? t("session.moderationReplyWithheld") : null);
        },
      )
      // Read *after* the channel is listening, never before.
      //
      // The transcript load runs before this effect, so a verdict landing in
      // between is in neither: the reads happened too early to see it, and the
      // subscription attached too late — Realtime does not replay. The pupil
      // would be left with the flagged reply, no banner, and a composer still
      // enabled, until they reloaded again. Reconciling here is what makes the
      // two mechanisms overlap instead of leaving a seam.
      .subscribe((channelStatus) => {
        if (channelStatus !== "SUBSCRIBED") return;
        void reconcileModeration(sessionId);
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [sessionId, t, reconcileModeration, onInstructorSignal]);

  /**
   * The subject an opening turn has already been asked for.
   *
   * Keyed by subject rather than a boolean: one panel serves whichever session
   * the student picks, so a flag set on the first would suppress the opening on
   * every one after it. It is not a substitute for the server's own guard —
   * `persist_chat_turn` declines a second opening — only a way to avoid asking
   * for one this panel already knows it requested.
   */
  const openingRequestedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!openWithTutorTurn) return;
    // `null` is "not read yet"; only a transcript read and found empty qualifies.
    if (transcriptEmpty !== true) return;
    if (paused || completed || disabled || sending) return;
    if (openingRequestedFor.current === subjectId) return;

    openingRequestedFor.current = subjectId;
    void requestReply(null, { start: true });
    // `requestReply` is redefined every render and is deliberately not a
    // dependency: including it would re-run this on every render, and the guard
    // above is what decides when the opening is asked for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openWithTutorTurn, transcriptEmpty, paused, completed, disabled, sending, subjectId]);

  const send = async (text: string) => {
    const trimmed = text.trim();
    // Checked here as well as on the composer, which `disabled` only hides.
    if (!trimmed || sending || paused || disabled || completed) return;

    setSending(true);
    setFlagNotice(null);
    setNotice(null);

    // Named, so that dropping it later drops *it*. Everything below is a
    // round-trip, and a teacher's message merging in the meantime — or the
    // transcript load landing — leaves the bubble somewhere other than the end
    // of the list; removing the tail would then take a real message off the
    // screen. An id rather than the object itself because `useChatMessages`
    // stamps a timestamp onto a message that has none, which copies it.
    const pendingId = `pending-${(optimisticTurns.current += 1)}`;
    const dropPendingTurn = () =>
      setMessages((prev) => prev.filter((m) => m.id !== pendingId));

    setMessages((prev) => [...prev, { id: pendingId, role: "user", content: trimmed }]);

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error(t("session.notAuthenticated", "You are not signed in."));

      // The server reads the student's turn from the transcript rather than the
      // request body — that is what makes a retry idempotent — so it is written
      // first. The session is created here only if this is the very first turn;
      // the edge function scopes it to the right offering on arrival.
      let id = sessionId;
      if (!id) {
        const { session, created } = await ensureChatSession({
          subjectColumn,
          subjectId,
          userId: user.id,
          courseId,
        }).catch((error) => {
          // No session means the turn was never written, so the bubble goes
          // with it — the same reason the message insert below drops it.
          dropPendingTurn();
          throw error;
        });
        id = session.id;
        setSessionId(id);
        // The row was already there, so the transcript this panel read as empty
        // was not: the read missed it, or another tab opened the conversation.
        // Saying so keeps the tutor's opening turn from firing over a
        // conversation that has already started.
        if (!created) setTranscriptEmpty(false);
      }

      const { data: inserted, error: insertError } = await supabase
        .from("chat_messages")
        .insert({
          session_id: id,
          role: "user",
          content: trimmed,
        })
        .select("id")
        .single();
      if (insertError) {
        // Nothing was saved, so drop the optimistic bubble rather than leaving
        // a turn on screen the tutor will never see.
        dropPendingTurn();
        throw insertError;
      }

      await requestReply(inserted?.id ?? null);
    } catch (error) {
      resetTyping();
      toast.error((error as Error).message || t("session.sendFailed"));
    } finally {
      setSending(false);
    }
  };

  /**
   * Ask for the reply to whatever is already persisted. Deliberately does not
   * write anything — see `awaitingReply`.
   *
   * Re-reads the transcript first. The generation is a *background* response,
   * so it survives the client losing the stream and persists on its own: by
   * the time a pupil hits Retry the reply may already be saved. Asking again
   * would generate and persist a second assistant turn for the same message,
   * duplicating it in the transcript and in every future model context. This
   * is the same check the buffered page makes in `retryTutorReply`.
   */
  const requestReply = async (
    replyTo: string | null = pendingTurnId,
    { start = false }: { start?: boolean } = {},
  ) => {
    setSending(true);
    // The reply as it actually streamed, accumulated here rather than taken
    // from the parser's return value because `text_done` needs it while the
    // stream is still open. Function-scoped so the catch can see it too: a
    // bubble holding exactly this text is this turn's own, settled early, and
    // unconfirmed if the stream then died.
    let streamedText = "";
    try {
      if (sessionId) {
        const { data: rows } = await supabase
          .from("chat_messages")
          .select("role, content, created_at, in_reply_to")
          .eq("session_id", sessionId)
          .in("role", ["user", "assistant"])
          .order("created_at", { ascending: true });

        // Only a reply to *this* turn counts, and it can sit anywhere in the
        // transcript — the session is shared, so rows may have been appended
        // after it. Looking only at the final row misses the reply and streams
        // a second one that the database then refuses to save, leaving the
        // pupil with an answer that is replaced on reload.
        const last = replyTo
          ? rows?.find((m) => m.role === "assistant" && m.in_reply_to === replyTo)
          : (rows?.[rows.length - 1]?.role === "assistant" ? rows[rows.length - 1] : undefined);

        if (last) {
          // It landed after all. Show it rather than asking for another.
          setMessages((prev) => {
            const next = prev[prev.length - 1]?.content === "" ? prev.slice(0, -1) : [...prev];
            return [...next, { role: "assistant", content: last.content, timestamp: last.created_at }];
          });
          setAwaitingReply(false);
          resetTyping();
          return;
        }
      }

      setMessages((prev) => {
        // Only add a placeholder if the last message is not already one.
        const last = prev[prev.length - 1];
        if (last?.role === "assistant" && last.content === "") return prev;
        return [...prev, { role: "assistant", content: "" }];
      });
      beginTyping(0);

      const { data: { session } } = await supabase.auth.getSession();
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/chat-stream`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session?.access_token ?? ""}`,
          },
          // Naming the turn rather than letting the server infer "the latest
        // user row": two sends in flight would otherwise both resolve to the
        // second, and the first would never be answered.
        body: JSON.stringify({ kind, subjectId, courseId, replyTo, ...(start ? { start: true } : {}) }),
        },
      );

      if (!response.ok || !response.headers.get("content-type")?.includes("text/event-stream")) {
        const json = await response.json().catch(() => ({}));
        // Before touching the list: the typing state outlives a refusal
        // otherwise, and ChatWidget renders the last assistant message as the
        // typing target — so an empty queue hides whatever reply was already
        // there. The refusal would appear to delete the previous answer.
        resetTyping();
        setMessages((prev) => prev.slice(0, -1));
        if (json.error === "session_paused" || json.paused) {
          setPaused(true);
          toast.error(json.message ?? t("session.paused", "This session is paused."));
          return;
        }
        if (json.error === "session_completed") {
          // The turn stays. The server refuses it but leaves the row — see
          // `prepareTurn` for why nothing deletes it — so the bubble stays too,
          // showing what the transcript actually holds.
          setCompleted(true);
          setAwaitingReply(false);
          setPendingTurnId(null);
          toast.error(json.message ?? t("session.completed", "This question is already complete."));
          return;
        }
        if (!start) {
          setAwaitingReply(true);
          setPendingTurnId(replyTo);
        }
        throw new Error(json.message || json.error || t("session.sendFailed"));
      }

      // Set from within the callbacks below, which run before the promise
      // settles, so the success path can see what the stream reported.
      let noticeNeedsRetry = false;

      // No `onModerationFlag` here: the stream ends at `[DONE]`, which the
      // server now sends before screening, so a verdict can never arrive on it.
      // The Realtime subscription above is what raises the banner.
      const result = await parseSSEStream(response, {
        onContent: (chunk) => {
          streamedText += chunk;
          addToQueue(chunk);
        },
        // The text is finished; only the turn's paperwork (state tail, verdict,
        // persist) is still on the wire. Settle the bubble now — flush the
        // animation, drop the cursor, put the text on the message itself — so a
        // finished reply does not sit blinking for the length of that tail.
        // Everything after `[DONE]` below is unchanged and idempotent on top of
        // this: the final swap writes the same content, and a
        // `turn_not_recorded` notice still pops the settled bubble.
        onTextDone: () => {
          if (!mounted.current) return;
          settleTyping();
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last?.role !== "assistant") return prev;
            const next = [...prev];
            next[next.length - 1] = { ...last, content: streamedText };
            return next;
          });
        },
        onNotice: (n) => {
          setNotice(n.message ?? null);
          // `turn_not_recorded` means the reply on screen was never saved, so
          // the turn is still owed one. Since the notice is non-fatal the
          // stream completes normally, and without this the success path below
          // would clear `awaitingReply` and the Retry control would never
          // appear — leaving the pupil told to try again with nothing to press.
          if (n.code === "turn_not_recorded") {
            noticeNeedsRetry = true;
          }
        },
      });

      finishTyping();
      // A delivered-but-unsaved turn is not a completed one — except on an
      // opening turn, which answers no student message: Retry would ask the
      // server for a reply to a turn that does not exist, and it would refuse.
      // The student types instead, which is the same conversation either way.
      setAwaitingReply(!start && noticeNeedsRetry);
      setPendingTurnId(!start && noticeNeedsRetry ? replyTo : null);
      if (!mounted.current) return;
      setMessages((prev) => {
        const next = [...prev];
        if (noticeNeedsRetry) {
          // The server could not save this reply, so it does not exist. Keeping
          // it on screen would leave the pupil with a stale answer sitting
          // beside the regenerated one after a retry, only one of which
          // survives a reload. Dropping it matches what the notice says.
          next.pop();
          return next;
        }
        next[next.length - 1] = { role: "assistant", content: result.content };
        return next;
      });
    } catch (error) {
      resetTyping();
      if (!start) {
        setAwaitingReply(true);
        setPendingTurnId(replyTo);
      }
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role !== "assistant") return prev;
        // Two shapes of this turn's own bubble: the empty placeholder, and one
        // `text_done` settled with the streamed text before the stream died.
        // Both are unconfirmed — the failure landed before `[DONE]`, so whether
        // the turn was recorded is unknown — and both come down, for the same
        // reason the placeholder always has: Retry re-reads the transcript and
        // re-renders the reply if it was saved, whereas a bubble left standing
        // would sit beside that re-render as a duplicate.
        return last.content === "" || (streamedText !== "" && last.content === streamedText)
          ? prev.slice(0, -1)
          : prev;
      });
      toast.error((error as Error).message || t("session.sendFailed"));
    } finally {
      setSending(false);
    }
  };

  // What the server counts when it decides to pause: user and assistant rows
  // only — instructor turns are excluded from its history query — and the
  // empty bubble a streaming reply types into is not a persisted row at all.
  const messageCount = messages.filter(
    (m) => m.role !== "instructor" && !(m.role === "assistant" && m.content === ""),
  ).length;
  // The pause fires at every multiple of the interval, so this stays correct
  // after an unpause: the next one is a full interval past the last.
  const messagesUntilPause =
    TUTOR_TURNS_BEFORE_REVIEW - (messageCount % TUTOR_TURNS_BEFORE_REVIEW);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Button variant="ghost" size="icon" onClick={onBack} aria-label={t("session.back", "Back")}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <img
            src={aiTutorImage}
            alt=""
            aria-hidden="true"
            className="w-8 h-8 rounded-full border-2 border-primary/20"
          />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {title && <h3 className="font-semibold text-sm truncate">{title}</h3>}
              {paused && (
                <Badge variant="destructive" className="text-xs">
                  {t("session.sessionPausedBadge")}
                </Badge>
              )}
            </div>
            {subtitle && <p className="text-xs text-muted-foreground truncate">{subtitle}</p>}
          </div>
        </div>
        {headerActions && <div className="flex items-center gap-2">{headerActions}</div>}
      </div>

      {/*
        Only a question is rendered, and the distinction matters.

        An open question's text is authored in LaTeX and markdown, so a plain
        `{heading}` printed `$$ f(x)=x^3 \quad \text{και} ... $$` at the student
        verbatim — while the replies below it, which go through ChatWidget's
        renderer, showed the same maths correctly. `formatQuestionText` is what
        the non-streaming question view already uses, and it ends in DOMPurify,
        so this adds no injection surface.

        A study session's *title* is not authored content: every other surface
        prints it literally (`StudentStudySession`), so formatting it here would
        turn a `**` or an `^2` in a title into emphasis or a superscript on this
        screen alone.

        The question uses a div rather than an h2 because the formatted output
        can contain <p> elements, which are not valid inside a heading;
        `role`/`aria-level` keep it a heading for assistive tech.
      */}
      {diagram}

      {heading &&
        (kind === "open_question" ? (
          <div
            role="heading"
            aria-level={2}
            className="text-lg font-medium prose prose-lg max-w-none dark:prose-invert"
            dangerouslySetInnerHTML={{ __html: formatQuestionText(heading) }}
          />
        ) : (
          <h2 className="text-lg font-medium">{heading}</h2>
        ))}

      {notes}

      {meta && (
        <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
          {meta}
        </div>
      )}

      {attachments}

      {flagNotice && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>{flagNotice}</AlertDescription>
        </Alert>
      )}

      {notice && (
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}

      {awaitingReply && !paused && (
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription className="flex items-center justify-between gap-4">
            <span>
              {t(
                "session.replyMissing",
                "Your message was saved but the tutor did not reply.",
              )}
            </span>
            <Button size="sm" variant="outline" disabled={sending} onClick={() => requestReply()}>
              {t("session.retry", "Retry")}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {paused && !flagNotice && (
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            {t("session.pausedForReview", "This session is paused for instructor review.")}
          </AlertDescription>
        </Alert>
      )}

      <ChatWidget
        messages={messages}
        onSendMessage={send}
        isLoading={sending}
        isTyping={isTyping}
        typingContent={displayedContent}
        disabled={paused || disabled || completed}
        enableMarkdown
        inputType="textarea"
        maxLength={TUTOR_INPUT_CHAR_LIMIT}
        placeholder={
          paused
            ? t("session.placeholderPaused")
            : placeholder ?? t("session.askAnything", "Ask anything…")
        }
      />

      {messageCount > 0 && (
        <p className="text-xs text-muted-foreground text-right">
          {t("session.messages", { count: messageCount })}
          {/* No countdown on a session that cannot take a turn: at the pause
              boundary the modulo reads a full interval, and "80 left" beside
              the paused banner would contradict it. */}
          {!paused && !completed && !disabled && (
            <>
              {" · "}
              {t("session.messagesUntilPause", { count: messagesUntilPause })}
            </>
          )}
        </p>
      )}
    </div>
  );
}
