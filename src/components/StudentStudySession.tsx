import { useState, useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Loader2, GraduationCap, BookOpen, CheckCircle, PlayCircle, MessageSquare } from "lucide-react";
import { ChatWidget, useChatStreaming, useChatMessages, parseSSEStream, ChatMessage, RichContent, formatMessageTime, StreamingChatPanel, ChatAttachments } from "@/components/chat";
import type { ChatAttachment } from "@/components/chat";
import { USE_STREAMING_CHAT } from "@/lib/chat-surface";
import aiTutorImage from "@/assets/ai-tutor.png";
import { TUTOR_INPUT_CHAR_LIMIT } from "@/lib/tutor-input-limit";
import { MODERATION_APPROVED } from "@/lib/material-moderation";
import { ensureChatSession } from "@/lib/chat-session";

/**
 * How long to wait for the tutor's response headers before giving up.
 *
 * The function fetches progress, session, course and competency rows, runs an
 * input moderation call, and only then blocks on the LLM — a healthy request
 * has been measured at ~9s to first byte, so this leaves generous headroom for
 * a cold isolate. Past it the request is treated as dead and the student is
 * told to retry, rather than watching the typing indicator forever.
 */
const TUTOR_RESPONSE_TIMEOUT_MS = 120_000;

/** 30 days, matching what the instructor's own picker signs its previews for. */
const ATTACHMENT_URL_TTL_SECONDS = 2592000;

/**
 * An instructor-attached image, as stored on `study_sessions.reference_images`.
 *
 * Only the two pointers are read. The row also carries the `name` and the
 * signed `url` that were current when the instructor picked the image, and
 * both are deliberately ignored: the name can be stale and the URL has
 * expired. `imageId` is the `course_materials` row; `storagePath` is its
 * object path, which is all the oldest entries have to identify it by.
 */
interface ReferenceImage {
  imageId?: string;
  storagePath?: string;
}

interface StudySession {
  id: string;
  title: string;
  /**
   * Deliberately absent: `study_sessions.topic`.
   *
   * It is the objective the tutor is given, written about the student rather
   * than to them, and the edge function reads it from the row itself. Nothing
   * student-facing shows it, so nothing student-facing fetches it.
   */
  student_notes: string | null;
  reference_images: ReferenceImage[] | null;
}

interface Progress {
  id: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
}

interface SessionProgress {
  study_session_id: string;
  status: string;
  message_count: number;
}

interface StudentStudySessionProps {
  courseId: string;
  onBack: () => void;
  offeringId?: string; // Filter by offering for students
  /**
   * When set, this session is opened as soon as the list loads — the student
   * desktop deep-links straight into a tutor chat instead of the list.
   */
  initialSessionId?: string;
}

export function StudentStudySession({ courseId, onBack, offeringId, initialSessionId }: StudentStudySessionProps) {
  const { t } = useTranslation("study");
  // See StudentOpenQuestions: the over-length toast is shared copy, so it comes
  // from `common` rather than being duplicated per surface.
  const { t: tCommon } = useTranslation("common");
  // `t` changes identity when the language changes, but these callbacks
  // outlive the render that created them — a subscription handler or a
  // memoised action. Reading the latest one through a ref keeps their
  // notifications in the current language without re-running the effect
  // (which would resubscribe the channel or refetch the data).
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);
  // Guards the desktop deep-link so a refetch doesn't re-open the session
  // the student just backed out of. Reset when the link (or the course)
  // changes: this component can stay mounted across a course→course
  // navigation, and a consumed guard must not swallow the next link.
  const autoOpenedRef = useRef(false);
  useEffect(() => {
    autoOpenedRef.current = false;
  }, [courseId, initialSessionId]);
  // Monotonic token for session opens: the student's latest choice wins, so a
  // slower open (the deep-link auto-open racing a manual click) must not
  // overwrite the newer conversation when it finally resolves.
  const startSeqRef = useRef(0);
  const [sessions, setSessions] = useState<StudySession[]>([]);
  const [sessionProgressMap, setSessionProgressMap] = useState<Map<string, SessionProgress>>(new Map());
  const [selectedSession, setSelectedSession] = useState<StudySession | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [messages, setMessages] = useChatMessages();
  const [loading, setLoading] = useState(true);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  // Distinguishes content-moderation pause (from response payload) vs
  // instructor-review pause. Status alone no longer tells the two apart.
  const [moderationPaused, setModerationPaused] = useState(false);
  // The streaming panel is the surface students get; everything below it is the
  // buffered path, kept behind `USE_STREAMING_CHAT`. Same session and the same
  // transcript either way — see `chat-surface.ts` for what the switch decides.

  const {
    displayedContent, 
    isTyping, 
    addToQueue, 
    beginTyping, 
    finishTyping, 
    resetTyping 
  } = useChatStreaming();

  useEffect(() => {
    fetchSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch on courseId change
  }, [courseId]);

  /**
   * The selected session's reference images, resolved against the material rows
   * they point at rather than trusted as stored.
   *
   * Two things make the stored entry unusable on its own. Its `url` was signed
   * when the instructor picked the image and has long since expired, so it
   * would render as a broken thumbnail. And the row is a snapshot: an image
   * approved at the moment it was attached can be rejected by a later
   * moderation pass, or the material deleted outright, and nothing rewrites the
   * sessions that reference it. Reading the current `course_materials` rows is
   * what makes a rejection actually take the image off the student's screen.
   *
   * A reference that matches no live approved material is dropped rather than
   * shown from its stale URL — including the legacy entries written before
   * `storagePath` existed, whose URL has expired anyway.
   */
  useEffect(() => {
    const images = selectedSession?.reference_images ?? [];
    if (images.length === 0) {
      setAttachments([]);
      return;
    }

    let cancelled = false;
    (async () => {
      const { data: approved } = await supabase
        .from("course_materials")
        .select("id, title, file_name, file_url")
        .eq("course_id", courseId)
        .eq("material_type", "images")
        // `is_moderated` only means moderation has RUN — it is true of a
        // rejected image too. The outcome lives in `moderation_status`.
        .eq("moderation_status", MODERATION_APPROVED);
      if (cancelled) return;

      const byId = new Map((approved ?? []).map((m) => [m.id, m]));
      const byPath = new Map((approved ?? []).map((m) => [m.file_url, m]));

      const live: typeof approved = [];
      for (const img of images) {
        const material =
          (img.imageId ? byId.get(img.imageId) : undefined) ??
          (img.storagePath ? byPath.get(img.storagePath) : undefined);
        // Two references to one material would otherwise duplicate the tile.
        if (material && !live.some((m) => m.id === material.id)) live.push(material);
      }

      const resolved = await Promise.all(
        live.map(async (material) => {
          const { data } = await supabase.storage
            .from("course-materials")
            .createSignedUrl(material.file_url, ATTACHMENT_URL_TTL_SECONDS);
          if (!data?.signedUrl) return null;
          return {
            id: material.id,
            // The material's own title, not the one copied into the session
            // row: a renamed image should read as its current name.
            name: material.title || material.file_name,
            url: data.signedUrl,
          };
        }),
      );

      if (!cancelled) setAttachments(resolved.filter((a): a is ChatAttachment => a !== null));
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedSession, courseId]);

  // Subscribe to real-time updates for study session progress status changes
  useEffect(() => {
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let isMounted = true;

    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user || !isMounted) return;

      channel = supabase
        .channel(`study-progress-updates-${courseId}-${user.id}`)
        .on(
          'postgres_changes',
          {
            event: 'UPDATE',
            schema: 'public',
            table: 'chat_sessions',
            filter: `user_id=eq.${user.id}`,
          },
          (payload) => {
            if (!isMounted) return;
            
            const updatedProgress = payload.new as any;
            const oldProgress = payload.old as any;

            // `chat_sessions` carries both surfaces now and the filter can only
            // narrow by user, so open-question rows arrive here too. They have
            // no `study_session_id`, and keying the map on that would file them
            // under `null`.
            if (!updatedProgress.study_session_id) return;

            // Only update if status actually changed
            if (updatedProgress.status !== oldProgress.status) {
              // Update sessionProgressMap
              setSessionProgressMap(prev => {
                const newMap = new Map(prev);
                const existing = newMap.get(updatedProgress.study_session_id);
                if (existing) {
                  newMap.set(updatedProgress.study_session_id, {
                    ...existing,
                    status: updatedProgress.status,
                  });
                } else {
                  // If progress entry doesn't exist in map yet, add it
                  newMap.set(updatedProgress.study_session_id, {
                    study_session_id: updatedProgress.study_session_id,
                    status: updatedProgress.status,
                    message_count: 0,
                  });
                }
                return newMap;
              });

              // Update progress state if this is the currently selected session
              if (selectedSession && updatedProgress.study_session_id === selectedSession.id) {
                setProgress(prev => prev ? { ...prev, status: updatedProgress.status } : null);

                // Show a toast notification when session is unpaused
                if (oldProgress.status === "paused" && updatedProgress.status === "in_progress") {
                  setModerationPaused(false);
                  toast.success(tRef.current("session.unpaused"));
                }
              }
            }
          }
        )
        .subscribe();
    });

    return () => {
      isMounted = false;
      if (channel) {
        supabase.removeChannel(channel);
      }
    };
  }, [courseId, selectedSession]);

  const fetchSessions = async () => {
    setLoading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      
      let sessionsData: StudySession[] = [];

      if (offeringId) {
        // Fetch only study sessions assigned to this offering
        const { data: offeringSessions, error: offeringError } = await supabase
          .from("offering_study_sessions")
          .select(`
            study_session_id,
            published_at,
            study_sessions!inner (
              id,
              title,
              student_notes,
              reference_images
            )
          `)
          .eq("offering_id", offeringId)
          .not("published_at", "is", null);

        if (offeringError) throw offeringError;
        
        sessionsData = (offeringSessions || []).map((os: any) => ({
          id: os.study_sessions.id,
          title: os.study_sessions.title,
          student_notes: os.study_sessions.student_notes,
          reference_images: (os.study_sessions.reference_images as ReferenceImage[] | null) || null,
        }));
      } else {
        // Fallback: no offering, show all published sessions
        const { data, error } = await supabase
          .from("study_sessions")
          .select("id, title, student_notes, reference_images")
          .eq("course_id", courseId)
          .eq("status", "ready")
          .order("created_at", { ascending: false });

        if (error) throw error;
        sessionsData = (data || []).map((row: any) => ({
          id: row.id,
          title: row.title,
          student_notes: row.student_notes,
          reference_images: (row.reference_images as ReferenceImage[] | null) || null,
        }));
      }

      setSessions(sessionsData);

      // Deep link from the student desktop: open the named session directly,
      // once, instead of showing the list first.
      if (initialSessionId && !autoOpenedRef.current) {
        const target = (sessionsData || []).find((s) => s.id === initialSessionId);
        if (target) {
          autoOpenedRef.current = true;
          void startSession(target);
        }
      }

      if (user && sessionsData && sessionsData.length > 0) {
        const sessionIds = sessionsData.map(s => s.id);
        
        const { data: progressData } = await supabase
          .from("chat_sessions")
          .select("id, study_session_id, status")
          .eq("user_id", user.id)
          .in("study_session_id", sessionIds);


        if (progressData && progressData.length > 0) {
          const progressIds = progressData.map(p => p.id);
          const { data: messageCounts } = await supabase
            .from("chat_messages")
            .select("session_id")
            .in("session_id", progressIds);

          const messageCountMap = new Map<string, number>();
          messageCounts?.forEach(m => {
            messageCountMap.set(m.session_id, (messageCountMap.get(m.session_id) || 0) + 1);
          });

          const progressMap = new Map<string, SessionProgress>();
          progressData.forEach(p => {
            progressMap.set(p.study_session_id, {
              study_session_id: p.study_session_id,
              status: p.status,
              message_count: messageCountMap.get(p.id) || 0,
            });
          });
          setSessionProgressMap(progressMap);
        }
      }
    } catch (error: any) {
      toast.error(error.message || t("session.loadFailed"));
    } finally {
      setLoading(false);
    }
  };

  const startSession = async (session: StudySession) => {
    const seq = ++startSeqRef.current;
    const superseded = () => seq !== startSeqRef.current;
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error(t("session.notAuthenticated"));

      const { data: sessionData } = await supabase
        .from("study_sessions")
        .select("extracted_content")
        .eq("id", session.id)
        .single();

      const extractedContent = sessionData?.extracted_content || "";
      const greekPattern = /[α-ωά-ώ]/i;
      const isGreek = greekPattern.test(extractedContent.substring(0, 500));

      // Deliberately NOT driven by the interface locale. The tutor greets the
      // student in the language of the *course material* -- a Greek textbook
      // gets a Greek tutor even if the student reads the app in English --
      // which is the AI-content-follows-the-material design. Folding this into
      // the UI locale would change tutoring behaviour, not translate a string.
      const welcomeMessageContent = isGreek
        ? `Καλώς ήρθες στη μελέτη με θέμα "${session.title}"! 🎓<br><br>Θα είμαι ο προσωπικός σου καθηγητής και θα σε καθοδηγήσω βήμα-βήμα σε αυτό το θέμα. Θα εξηγήσω τις έννοιες, θα κάνω ερωτήσεις για να ελέγξω την κατανόησή σου και θα προσαρμοστώ στο ρυθμό σου.<br><br><strong>Είσαι έτοιμος/η να ξεκινήσουμε;</strong>`
        : `Welcome to your tutoring session on "${session.title}"! 🎓<br><br>I'll be your personal tutor, guiding you through this topic step by step. I'll explain concepts, ask questions to check your understanding, and adapt to your pace.<br><br><strong>Are you ready to begin learning?</strong>`;

      // Read-or-create in one step. Two tabs on the same session — or a retried
      // open — otherwise raced here, and the loser was shown
      // `chat_sessions_unique_study_session` instead of their tutoring.
      const { session: existingProgress, created } = await ensureChatSession<Progress>({
        subjectColumn: "study_session_id",
        subjectId: session.id,
        userId: user.id,
        courseId,
        // The section this tutoring belongs to. Not a decoration: the write
        // policies on `chat_sessions` and `chat_messages` are section-scoped,
        // and a row naming no offering is one a section-restricted instructor
        // may never unpause, delete or post into — which is how every
        // study-tutor session used to be created. Safe to send from here
        // because the student's own INSERT policy runs it through
        // `student_may_attribute_to_offering`: a claim to an offering they
        // do not sit in is refused rather than believed. The edge function
        // repairs the row from its own authorisation check when this is
        // undefined (practice mode, and every session created before this).
        offeringId: offeringId ?? null,
        columns: "*",
      });

      const progressData: Progress = existingProgress;

      // Another open has superseded this one while it was in flight; its
      // chat row exists (read-or-create is idempotent) but its state must
      // not reach the screen.
      if (superseded()) return;

      // A session that was already there has a transcript to load; one opened
      // just now has nothing but the tutor's greeting.
      if (!created) {
        const { data: messagesData, error: messagesError } = await supabase
          .from("chat_messages")
          .select("id, role, content, sender_user_id, created_at")
          .eq("session_id", existingProgress.id)
          .order("created_at");

        if (messagesError) throw messagesError;

        const isPaused = existingProgress.status === "paused";

        const visibleRows = (messagesData || []).filter(
          (m: any) =>
            m.role === "user" ||
            m.role === "assistant" ||
            m.role === "instructor"
        );

        const instructorIds = Array.from(
          new Set(
            visibleRows
              .filter((m: any) => m.role === "instructor" && m.sender_user_id)
              .map((m: any) => m.sender_user_id as string)
          )
        );
        const nameById: Record<string, string> = {};
        if (instructorIds.length > 0) {
          const { data: profiles } = await supabase
            .from("profiles")
            .select("user_id, full_name")
            .in("user_id", instructorIds);
          (profiles || []).forEach((p: any) => {
            if (p.full_name) nameById[p.user_id] = p.full_name;
          });
        }

        const loadedMessages: ChatMessage[] = visibleRows.map((m: any) => ({
          id: m.id,
          role: m.role as "user" | "assistant" | "instructor",
          content: m.content,
          timestamp: m.created_at,
          senderName:
            m.role === "instructor" && m.sender_user_id
              ? nameById[m.sender_user_id]
              : undefined,
        }));

        // Re-checked after the transcript reads — more awaits, same race.
        if (superseded()) return;

        if (isPaused) {
          setSelectedSession(session);
          setProgress(progressData);
          setMessages(loadedMessages);
          // Default to instructor-review banner copy when loading a paused
          // session from history; the moderation copy only fires off a fresh
          // content_blocked response (see handleSendMessage).
          setModerationPaused(false);
          return;
        }

        if (loadedMessages.length === 0) {
          setMessages([{ role: "assistant", content: welcomeMessageContent }]);
        } else {
          setMessages(loadedMessages);
        }
      } else {
        setMessages([{ role: "assistant", content: welcomeMessageContent }]);
      }

      setSelectedSession(session);
      setProgress(progressData);
    } catch (error: any) {
      toast.error(error.message || t("session.startFailed"));
    }
  };

  /**
   * Asks the tutor to reply to whatever is already persisted for this session.
   *
   * Deliberately does NOT write the student's turn. The edge function builds its
   * prompt by reading `chat_messages` straight from the database, so a
   * retry needs only this call — re-sending the text would insert a second
   * identical user row. See `retryTutorReply`.
   */
  const requestTutorReply = async (replyTo: string | null = null) => {
    // The turn now names its subject, so the study session is as necessary as
    // the progress row. In practice they are set together, but sending an
    // undefined subject would surface as a 400 rather than as nothing happening.
    if (!progress || !selectedSession) return;

    // Add empty assistant message to show loading state
    setMessages(prev => [...prev, { role: "assistant", content: "" }]);
    beginTyping(40);

    try {
      // Get the user's session token for authentication
      const { data: { session: userSession } } = await supabase.auth.getSession();
      const authToken = userSession?.access_token || import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

      // Bound the wait for response headers. The tutor does several DB reads, a
      // moderation call and then blocks on the LLM before it can stream, so this
      // is generous — but without it a request that never answers leaves the
      // typing indicator spinning forever with nothing for the student to act on.
      const abortController = new AbortController();
      const headersTimer = setTimeout(
        () => abortController.abort(new DOMException(t("session.timedOut"), "TimeoutError")),
        TUTOR_RESPONSE_TIMEOUT_MS
      );

      let response: Response;
      try {
        response = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/chat`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${authToken}`,
            },
            // The turn is addressed by subject, not by session id: the
            // function keys the session on the authenticated caller, so a
            // session id in the body would be a claim rather than a credential.
            // Naming the turn rather than letting the server infer "the
            // latest user row". Both surfaces share one session, so two
            // requests in flight would otherwise resolve to the same message
            // and one student turn would go unanswered.
            body: JSON.stringify({
              kind: "study_session",
              subjectId: selectedSession.id,
              courseId,
              replyTo,
            }),
            signal: abortController.signal,
          }
        );
      } finally {
        clearTimeout(headersTimer);
      }

      if (!response.ok) {
        const errorData = await response.json();
        
        // Handle session already paused (403)
        if (response.status === 403 && errorData.error === "session_paused") {
          resetTyping();
          // Remove the empty assistant message and the user message
          setMessages(prev => prev.slice(0, -2));

          setMessages(prev => [...prev, {
            role: "assistant",
            content: `${t("session.pausedBanner")}\n\n${errorData.message || t("session.pausedChatNotice")}`,
          }]);

          setProgress(prev => prev ? { ...prev, status: "paused" } : null);
          setModerationPaused(false);

          if (selectedSession) {
            setSessionProgressMap(prev => {
              const newMap = new Map(prev);
              const existing = newMap.get(selectedSession.id);
              if (existing) {
                newMap.set(selectedSession.id, { ...existing, status: "paused" });
              }
              return newMap;
            });
          }

          toast.info(t("session.toastPaused"), {
            description: t("session.toastPausedDetail"),
            duration: 8000,
          });
          return;
        }

        // `message` first: `error` is a machine code (`message_too_long`), and
        // showing the student the slug hid the sentence telling them what to do.
        // The catalog string is the last resort, for a failure carrying neither.
        throw new Error(errorData.message || errorData.error || t("session.replyFailed"));
      }

      const contentType = response.headers.get("content-type") || "";

      if (contentType.includes("text/event-stream")) {
        // Streaming SSE response — feed chunks directly to the typing animation
        const result = await parseSSEStream(response, {
          onContent: (chunk) => addToQueue(chunk),
        });
        await finishTyping();

        const fullContent = result.content;

        // A stream that opens and closes without delivering a single token
        // leaves the placeholder empty. Nothing downstream can recover from
        // that, so fail loudly rather than leaving a blank bubble behind.
        if (!fullContent.trim()) {
          throw new Error(
            t("session.noReply")
          );
        }

        // The answer has landed and the edge function has already persisted its
        // row, so this is the moment the reload will agree with.
        const landedAt = new Date();

        // Re-stamp the placeholder: it was timed when the request went out, and
        // a long reply can land a minute or more later — the bubble should read
        // as the time the answer arrived.
        setMessages(prev => {
          const newMessages = [...prev];
          const lastIdx = newMessages.length - 1;
          if (newMessages[lastIdx]?.role === "assistant") {
            newMessages[lastIdx] = {
              ...newMessages[lastIdx],
              content: fullContent,
              timestamp: landedAt,
            };
          }
          return newMessages;
        });

        // Assistant message is persisted by the edge function (service role)
        // because RLS blocks students from inserting role='assistant'.
      } else {
        // JSON response (content_blocked, session_paused, or other 200-status errors)
        const tutorResponse = await response.json();

        if (tutorResponse.error === "content_blocked") {
          // `blockedSide: "assistant"` means the *tutor's* reply was flagged
          // and withheld (#1198), not the student's message. The student's
          // turn was accepted and persisted in that case, so only the empty
          // assistant placeholder is dropped — and the copy must not blame
          // them for text they did not write.
          const blockedTutorReply = tutorResponse.blockedSide === "assistant";
          resetTyping();
          setMessages(prev => prev.slice(0, blockedTutorReply ? -1 : -2));

          setMessages(prev => [...prev, {
            role: "assistant",
            content: `${t("session.moderationBanner")}\n\n${tutorResponse.message || t("session.moderationFlagged")}\n\n${t("session.moderationContactNote")}`,
          }]);

          setProgress(prev => prev ? { ...prev, status: "paused" } : null);
          setModerationPaused(true);

          if (selectedSession) {
            setSessionProgressMap(prev => {
              const newMap = new Map(prev);
              const existing = newMap.get(selectedSession.id);
              if (existing) {
                newMap.set(selectedSession.id, { ...existing, status: "paused" });
              }
              return newMap;
            });
          }

          toast.error(t("session.toastModerationPaused"), {
            description: blockedTutorReply
              ? t("session.moderationReplyWithheld")
              : t("session.moderationContactInstructor"),
            duration: 8000,
          });
          return;
        }

        if (tutorResponse.error === "session_paused") {
          resetTyping();
          setMessages(prev => prev.slice(0, -2));

          setMessages(prev => [...prev, {
            role: "assistant",
            content: `${t("session.pausedBanner")}\n\n${tutorResponse.message || t("session.pausedForReview")}`,
          }]);

          setProgress(prev => prev ? { ...prev, status: "paused" } : null);
          setModerationPaused(false);

          if (selectedSession) {
            setSessionProgressMap(prev => {
              const newMap = new Map(prev);
              const existing = newMap.get(selectedSession.id);
              if (existing) {
                newMap.set(selectedSession.id, { ...existing, status: "paused" });
              }
              return newMap;
            });
          }

          toast.info(t("session.toastPaused"), {
            description: t("session.toastPausedDetail"),
            duration: 8000,
          });
          return;
        }

        // Unknown JSON response — show a generic error rather than trying to stream undefined
        resetTyping();
        setMessages(prev => prev.slice(0, -1));
        toast.error(
          tutorResponse.message || tutorResponse.error || t("session.replyFailed"),
        );
      }

    } catch (error: any) {
      resetTyping();
      // Remove the empty assistant message on error
      setMessages(prev => prev.slice(0, -1));

      // The student's turn is already persisted, so anywhere a retry makes
      // sense it must re-ask the function rather than re-send the text — see
      // retryTutorReply.
      const isTimeout =
        error?.name === "TimeoutError" ||
        error?.name === "AbortError" ||
        error?.name === "SSEStallError";

      // A refusal is the one server-side failure asking again will not fix;
      // the student needs to rephrase instead.
      const isRetryableServerError =
        error?.name === "SSEStreamError" && error?.code !== "tutor_refused";

      if (isTimeout) {
        toast.error(t("session.noResponseTitle"), {
          description: t("session.noResponseDetail"),
          duration: 15000,
          action: { label: t("session.retry"), onClick: () => { void retryTutorReply(replyTo); } },
        });
      } else if (isRetryableServerError) {
        toast.error(error.message, {
          duration: 15000,
          action: { label: t("session.retry"), onClick: () => { void retryTutorReply(replyTo); } },
        });
      } else {
        toast.error(error.message || t("session.sendFailed"));
      }
    }
  };

  /**
   * Retries a tutor turn whose response we gave up waiting for.
   *
   * Aborting the fetch only detaches the client — the edge function keeps
   * running and may still persist its assistant message and state update. So
   * re-read the conversation first: if the reply landed after all, show it
   * instead of asking a second time. Only when nothing arrived do we re-invoke,
   * and never by re-inserting the student's turn, which is already in the table.
   */
  const retryTutorReply = async (turnId: string | null = null) => {
    if (!progress) return;

    const { data, error } = await supabase
      .from("chat_messages")
      .select("id, role, content, created_at, in_reply_to")
      .eq("session_id", progress.id)
      .order("created_at");

    // The turn this retry is *for* — carried across the failure by the caller,
    // not re-derived here.
    //
    // Deriving it would take the latest user row, so a message sent between the
    // failure and pressing Retry would be answered instead, leaving the turn
    // that actually failed unanswered forever. The fallback is only for callers
    // that never had an id to begin with, where "latest" is all there is.
    const pendingTurnId =
      turnId ?? [...(data ?? [])].reverse().find((m) => m.role === "user")?.id ?? null;

    if (!error && data && pendingTurnId) {
      // A reply to *this* turn, wherever it sits. Checking only the final row
      // misses it as soon as anything was appended afterwards.
      const answer = data.find(
        (m) => m.role === "assistant" && m.in_reply_to === pendingTurnId,
      );
      if (answer) {
        // The original request completed while we were not listening.
        setMessages(prev => [...prev, {
          role: "assistant",
          content: answer.content,
          timestamp: answer.created_at,
        }]);
        return;
      }
    }

    await requestTutorReply(pendingTurnId);
  };

  const handleSendMessage = async (messageText: string) => {
    if (!progress) return;

    // Same reason as the identical guard in StudentOpenQuestions: the turn is
    // persisted before the request goes out, so a message the handler rejects
    // with a 400 for length would sit in the transcript unanswered.
    if (messageText.length > TUTOR_INPUT_CHAR_LIMIT) {
      toast.error(
        tCommon("chat.tooLongToast", {
          length: messageText.length,
          max: TUTOR_INPUT_CHAR_LIMIT,
        }),
      );
      return;
    }

    setMessages(prev => [...prev, { role: "user", content: messageText }]);

    // Persist the student's turn first — the function reads the conversation
    // back out of the database rather than taking it from the request body.
    const { data: insertedTurn, error: insertError } = await supabase
      .from("chat_messages")
      .insert({
        session_id: progress.id,
        role: "user",
        content: messageText,
      })
      .select("id")
      .single();

    if (insertError) {
      // Nothing was saved, so drop the optimistic bubble rather than leaving a
      // turn on screen that the tutor will never see.
      setMessages(prev => prev.slice(0, -1));
      toast.error(insertError.message || t("session.sendFailed"));
      return;
    }

    await requestTutorReply(insertedTurn?.id ?? null);
  };

  const markAsCompleted = async () => {
    if (!progress) return;
    
    try {
      const { error } = await supabase
        .from("chat_sessions")
        .update({
          status: "completed",
          completed_at: new Date().toISOString(),
        })
        .eq("id", progress.id);

      if (error) throw error;

      setProgress({ ...progress, status: "completed", completed_at: new Date().toISOString() });
      
      if (selectedSession) {
        setSessionProgressMap(prev => {
          const newMap = new Map(prev);
          const existing = newMap.get(selectedSession.id);
          if (existing) {
            newMap.set(selectedSession.id, { ...existing, status: "completed" });
          }
          return newMap;
        });
      }
      
      toast.success(t("session.markedComplete"));
    } catch (error: any) {
      toast.error(error.message || t("session.markCompleteFailed"));
    }
  };

  const unmarkAsCompleted = async () => {
    if (!progress) return;
    
    try {
      const { error } = await supabase
        .from("chat_sessions")
        .update({
          status: "in_progress",
          completed_at: null,
        })
        .eq("id", progress.id);

      if (error) throw error;

      setProgress({ ...progress, status: "in_progress", completed_at: null });
      
      if (selectedSession) {
        setSessionProgressMap(prev => {
          const newMap = new Map(prev);
          const existing = newMap.get(selectedSession.id);
          if (existing) {
            newMap.set(selectedSession.id, { ...existing, status: "in_progress" });
          }
          return newMap;
        });
      }
      
      toast.success(t("session.reopened"));
    } catch (error: any) {
      toast.error(error.message || t("session.reopenFailed"));
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Session list view
  if (!selectedSession) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft className="w-4 h-4 mr-2" />
            {t("session.back")}
          </Button>
          <div>
            <h2 className="text-xl font-semibold">{t("session.title")}</h2>
            <p className="text-sm text-muted-foreground">
              {t("session.subtitle")}
            </p>
          </div>
        </div>

        {sessions.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12 text-center">
              <GraduationCap className="w-12 h-12 text-muted-foreground mb-4" />
              <h4 className="font-medium mb-2">{t("session.emptyTitle")}</h4>
              <p className="text-sm text-muted-foreground">
                {t("session.emptyBody")}
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {sessions.map((session) => {
              const sessionProgress = sessionProgressMap.get(session.id);
              const isCompleted = sessionProgress?.status === "completed";
              const isInProgress = sessionProgress?.status === "in_progress";
              const isPausedSession = sessionProgress?.status === "paused";
              const messageCount = sessionProgress?.message_count || 0;

              return (
                <Card
                  key={session.id}
                  className={`cursor-pointer hover:shadow-md transition-all ${isPausedSession ? 'border-destructive/50 bg-destructive/5' : 'hover:border-primary/50'}`}
                  onClick={() => startSession(session)}
                >
                  <CardHeader>
                    <div className="flex items-start justify-between gap-2">
                      <CardTitle className="text-base flex items-center gap-2">
                        <BookOpen className="w-5 h-5 text-primary" />
                        {session.title}
                      </CardTitle>
                      {isPausedSession && (
                        <Badge variant="destructive" className="gap-1 shrink-0">
                          {t("session.badgePaused")}
                        </Badge>
                      )}
                      {isCompleted && !isPausedSession && (
                        <Badge variant="default" className="gap-1 shrink-0">
                          <CheckCircle className="w-3 h-3" />
                          {t("session.badgeCompleted")}
                        </Badge>
                      )}
                      {isInProgress && !isCompleted && !isPausedSession && (
                        <Badge variant="secondary" className="gap-1 shrink-0">
                          <PlayCircle className="w-3 h-3" />
                          {t("session.badgeInProgress")}
                        </Badge>
                      )}
                    </div>
                    {session.student_notes && (
                      <div 
                        className="mt-2 text-sm text-muted-foreground prose prose-sm max-w-none dark:prose-invert [&_a]:text-primary [&_a]:underline"
                        dangerouslySetInnerHTML={{ __html: session.student_notes }}
                      />
                    )}
                  </CardHeader>
                  <CardContent className="flex items-center justify-between">
                    <Button variant="secondary" size="sm">
                      {isPausedSession
                        ? t("session.actionViewPaused")
                        : isInProgress
                          ? t("session.actionContinue")
                          : isCompleted
                            ? t("session.actionReview")
                            : t("session.actionStart")}
                    </Button>
                    {messageCount > 0 && (
                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                        <MessageSquare className="w-3 h-3" />
                        {t("session.messages", { count: messageCount })}
                      </span>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  // Chat view with custom message rendering
  const renderAssistantMessage = (msg: ChatMessage, index: number, isTypingMessage: boolean, displayContent: string) => {
    // Hidden while the reply is still streaming — the turn is not finished, so
    // any time shown there would be the moment it started, not the moment it
    // lands. The default renderers in ChatWidget do the same.
    const timeStr = isTypingMessage ? null : formatMessageTime(msg.timestamp);
    return (
      <div key={`assistant-${index}`} className="flex justify-start gap-3">
        <div className="flex-shrink-0 relative">
          <img 
            src={aiTutorImage} 
            alt={t("session.tutorAlt")}
            className={`w-10 h-10 rounded-full border-2 border-primary/20 bg-background shadow-sm ${isTypingMessage ? 'animate-pulse' : ''}`}
          />
        </div>
        <div className="relative flex flex-col gap-1">
          <div className="absolute -left-2 top-3 w-0 h-0 border-t-8 border-t-transparent border-b-8 border-b-transparent border-r-8 border-r-muted" />
          <div className="max-w-[80%] rounded-2xl px-4 py-3 bg-muted rounded-bl-md">
            <RichContent content={displayContent || ""} className="text-sm" />
            {isTypingMessage && (
              <span className="inline-block w-2 h-4 ml-0.5 bg-foreground/70 animate-pulse align-middle" />
            )}
          </div>
          {timeStr && (
            <span className="text-[10px] text-muted-foreground px-1">{timeStr}</span>
          )}
        </div>
      </div>
    );
  };

  const isPaused = progress?.status === "paused";

  /*
    Built once and handed to whichever surface renders the conversation, so the
    completion controls cannot go missing from one of them — which is exactly
    what happened while the streaming panel was a separate screen.

    The paused badge is not here: the panel derives its own from the session
    row it already subscribes to, and a second copy fed by this component's
    `progress` would be the two-sources-of-truth mistake again.
  */
  const sessionActions =
    progress?.status === "completed" ? (
      <>
        <Badge variant="default" className="gap-1">
          <CheckCircle className="w-3 h-3" />
          {t("session.badgeCompleted")}
        </Badge>
        <Button
          variant="ghost"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            unmarkAsCompleted();
          }}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          {t("session.reopen")}
        </Button>
      </>
    ) : (
      <Button
        variant="outline"
        size="sm"
        onClick={(e) => {
          e.stopPropagation();
          markAsCompleted();
        }}
        className="gap-1"
      >
        <CheckCircle className="w-4 h-4" />
        {t("session.markComplete")}
      </Button>
    );

  if (USE_STREAMING_CHAT) {
    return (
      <StreamingChatPanel
        kind="study_session"
        subjectId={selectedSession.id}
        courseId={courseId}
        heading={selectedSession.title}
        title={selectedSession.title}
        notes={
          selectedSession.student_notes ? (
            <div className="p-4 bg-muted/50 border rounded-lg">
              <div
                className="text-sm prose prose-sm max-w-none dark:prose-invert [&_a]:text-primary [&_a]:underline"
                dangerouslySetInnerHTML={{ __html: selectedSession.student_notes }}
              />
            </div>
          ) : undefined
        }
        headerActions={sessionActions}
        attachments={<ChatAttachments attachments={attachments} />}
        openWithTutorTurn
        placeholder={t("session.placeholder")}
        onBack={() => setSelectedSession(null)}
      />
    );
  }

  return (
    <div className="flex flex-col h-[calc(100vh-200px)] min-h-[500px]">
      {/* Header */}
      <div className="flex items-center gap-4 pb-4 border-b">
        <Button variant="ghost" size="sm" onClick={() => setSelectedSession(null)}>
          <ArrowLeft className="w-4 h-4 mr-2" />
          {t("session.back")}
        </Button>
        <div className="flex-1">
          <h3 className="font-semibold">{selectedSession.title}</h3>
        </div>
        {isPaused ? (
          <Badge variant="destructive" className="gap-1">
            {t("session.sessionPausedBadge")}
          </Badge>
        ) : (
          <div className="flex items-center gap-2">{sessionActions}</div>
        )}
      </div>

      {/* Paused session warning */}
      {isPaused && (
        <div className="my-4 p-4 bg-destructive/10 border border-destructive/30 rounded-lg">
          <p className="text-sm text-destructive font-medium">
            {moderationPaused
              ? t("session.pausedModeration")
              : t("session.pausedReview")}
          </p>
        </div>
      )}

      {/* Student notes banner */}
      {selectedSession.student_notes && (
        <div className="my-4 p-4 bg-muted/50 border rounded-lg">
          <div 
            className="text-sm prose prose-sm max-w-none dark:prose-invert [&_a]:text-primary [&_a]:underline"
            dangerouslySetInnerHTML={{ __html: selectedSession.student_notes }}
          />
        </div>
      )}

      <ChatAttachments attachments={attachments} className="my-4" />

      <ChatWidget
        messages={messages}
        onSendMessage={handleSendMessage}
        isTyping={isTyping}
        typingContent={displayedContent}
        placeholder={
          isPaused ? t("session.placeholderPaused") : t("session.placeholder")
        }
        inputType="textarea"
        showAvatar={false}
        renderAssistantMessage={renderAssistantMessage}
        className="flex-1 min-h-0"
        maxLength={TUTOR_INPUT_CHAR_LIMIT}
        disabled={isPaused}
      />
    </div>
  );
}
