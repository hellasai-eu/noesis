import { useState, useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  MessageSquareText,
  Loader2,
  ArrowLeft,
  Lightbulb,
  Eye,
  CheckCircle2,
  ListChecks,
  ChevronDown,
  ChevronUp,
  Calendar,
  Clock,
  BookOpen,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { useDateFnsLocale } from "@/i18n/formatters";
import { format } from "date-fns";
import aiTutorImage from "@/assets/ai-tutor.png";
import { ChatWidget, useChatStreaming, useChatMessages, parseSSEStream, StreamingChatPanel, type ChatMessage, type ChatWidgetHandle } from "@/components/chat";
import { USE_STREAMING_CHAT } from "@/lib/chat-surface";
import { AiDisclaimer } from "@/components/AiDisclaimer";
import { toTutorDecision, type TutorState } from "@/types/tutor-state";
import { useUserInstitution } from "@/hooks/useUserInstitution";
import { useAuth } from "@/hooks/useAuth";
import { useSocraticState } from "@/hooks/useSocraticState";
import { formatQuestionText } from "@/lib/latex-utils";
import {
  openAnsweringModeFromPayload,
  questionDiagramFromPayload,
  type OpenAnsweringMode,
} from "@/lib/question-payload";
import { QuestionDiagram } from "@/components/QuestionDiagram";
import { getDifficultyClass } from "@/lib/difficulty-color";
import { TUTOR_INPUT_CHAR_LIMIT } from "@/lib/tutor-input-limit";
import { ensureChatSession } from "@/lib/chat-session";
import { Textarea } from "@/components/ui/textarea";
import { Send } from "lucide-react";

interface OpenQuestion {
  id: string;
  question: string;
  difficulty: string;
  createdAt: string;
  hasStarted?: boolean;
  messageCount?: number;
  firstInteractionAt?: string;
  isCompleted?: boolean;
  // #596 — derived from payload.answering_mode. "interactive" (Socratic chat,
  // the default) or "single" (one-shot textarea + auto-grade).
  answeringMode: OpenAnsweringMode;
  diagram?: { source: string; alt?: string } | null;
}

interface SingleAnswerGrade {
  /** NULL until the instructor grades the submission (pending review). */
  grade: number | null;
  feedback: string;
  strengths: string[];
  areasForImprovement: string[];
  submittedAnswer: string;
}

interface StudentOpenQuestionsProps {
  courseId: string;
  offeringId?: string | null;
  // #613 — restricts the surface to a single answering mode. The student
  // navigation routes "Open Questions" (Practice) here with mode="single"
  // and "AI Interactive Questions" (Learn) with mode="interactive".
  mode: OpenAnsweringMode;
  onBack: () => void;
}

const StudentOpenQuestions = ({ courseId, offeringId, mode, onBack }: StudentOpenQuestionsProps) => {
  const { t } = useTranslation("study");
  // The over-length toast is the same sentence on both tutor surfaces, so it
  // lives in `common` beside the widget's own counter copy rather than being
  // written twice in this namespace.
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
  const dateFnsLocale = useDateFnsLocale();
  const { user } = useAuth();
  const { isAdmin, isInstructor } = useUserInstitution(user?.id);
  const canViewTutorState = isAdmin || isInstructor;

  const [questions, setQuestions] = useState<OpenQuestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedQuestion, setSelectedQuestion] = useState<OpenQuestion | null>(null);
  // The streaming panel is the surface students get; everything below it is the
  // buffered path, kept behind `USE_STREAMING_CHAT`. Same session and the same
  // transcript either way — see `chat-surface.ts` for what the switch decides.

  const [chatMessages, setChatMessages] = useChatMessages();
  const [loadingChat, setLoadingChat] = useState(false);
  const [completedExercises, setCompletedExercises] = useState<string[]>([]);
  const [progressOpen, setProgressOpen] = useState(true);
  const [markingComplete, setMarkingComplete] = useState(false);
  const [sending, setSending] = useState(false);
  const [isFlagged, setIsFlagged] = useState(false);
  const [hasDraft, setHasDraft] = useState(false);
  const [showCompleteConfirm, setShowCompleteConfirm] = useState(false);
  const chatWidgetRef = useRef<ChatWidgetHandle>(null);
  // Read by the Realtime handler, which outlives the render that created it.
  const selectedQuestionIdRef = useRef<string | null>(null);
  useEffect(() => {
    selectedQuestionIdRef.current = selectedQuestion?.id ?? null;
  }, [selectedQuestion]);

  // #596 — single-answer-mode local state.
  const [singleAnswerDraft, setSingleAnswerDraft] = useState("");
  const [singleAnswerSubmitting, setSingleAnswerSubmitting] = useState(false);
  const [singleAnswerGrade, setSingleAnswerGrade] = useState<SingleAnswerGrade | null>(null);
  const [singleAnswerLoadingExisting, setSingleAnswerLoadingExisting] = useState(false);

  const { displayedContent, isTyping, addToQueue, beginTyping, finishTyping, resetTyping } = useChatStreaming();

  // Use dedicated state management hook for tutor state
  const { state: tutorState, updateState: updateTutorState } = useSocraticState({
    userId: user?.id || null,
    openQuestionId: selectedQuestion?.id || null,
    courseId: courseId,
  });

  const isExercisePdf = selectedQuestion?.question?.includes("Κατέβασε το αρχείο ασκήσεων") || 
                        selectedQuestion?.question?.includes("exercise") ||
                        selectedQuestion?.question?.includes("ασκήσεων");

  useEffect(() => {
    if (!chatMessages.length) {
      setCompletedExercises([]);
      return;
    }

    const completed = new Set<string>();
    const completionPatterns = [
      /(?:άσκηση|exercise|ερώτηση|question)\s*(?:#|αρ\.|no\.?|number)?\s*(\d+)/gi,
      /(\d+)(?:η|st|nd|rd|th)?\s*(?:άσκηση|exercise|ερώτηση|question)/gi,
    ];
    const successIndicators = [
      /σωστά|correct|μπράβο|bravo|εξαιρετικά|excellent|τέλεια|perfect|ωραία|great|πολύ καλά|very good|συγχαρητήρια|congratulations|ολοκληρώσαμε|completed|λύσαμε|solved/i
    ];

    chatMessages.forEach((msg, index) => {
      if (msg.role === "assistant") {
        const hasSuccessIndicator = successIndicators.some(pattern => pattern.test(msg.content));
        if (hasSuccessIndicator) {
          const prevUserMsg = chatMessages[index - 1]?.content || "";
          const combinedText = msg.content + " " + prevUserMsg;
          completionPatterns.forEach(pattern => {
            let match;
            while ((match = pattern.exec(combinedText)) !== null) {
              completed.add(match[1]);
            }
          });
        }
      }
    });

    setCompletedExercises(Array.from(completed).sort((a, b) => parseInt(a) - parseInt(b)));
  }, [chatMessages]);

  useEffect(() => {
    fetchQuestions();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch on courseId/offeringId/mode change
  }, [courseId, offeringId, mode]);

  /**
   * The last `chat_sessions.status` this component saw, per question, and when.
   *
   * Realtime is the only thing that tells this screen a session changed, and
   * `payload.old` carries nothing but the primary key under the default replica
   * identity — so the transition has to be remembered here rather than read off
   * the event. An earlier version compared `payload.old.status`, which is
   * always undefined, so its unpause branch never ran at all.
   *
   * `seq` is what lets `fetchQuestions` tell whether a live event overtook its
   * reads while they were in flight. Entries stamped after a read began are
   * newer than anything that read returned, and win — the same rule
   * `StreamingChatPanel` follows when it reconciles a pause against Realtime.
   */
  const statusSeq = useRef(0);
  const lastSessionStatus = useRef<Record<string, { status: string; seq: number }>>({});

  // Subscribe to real-time updates for open question session status changes.
  //
  // This is how a question the *tutor* finished lands on this screen. The
  // server marks the session complete when it decides STOP (`completeOnStop`
  // in `chat-turn.ts`) and the streaming panel is the only other thing that
  // hears about it — it disables its own composer, but the list badge and the
  // mark-complete button are rendered here, so without this they went on
  // claiming an answered question was still open.
  useEffect(() => {
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let isMounted = true;

    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user || !isMounted) return;

      channel = supabase
        .channel(`open-question-progress-updates-${courseId}-${user.id}`)
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

            const row = payload.new as { open_question_id?: string | null; status?: string | null };
            // The filter can only be `user_id` — one row per (student, subject),
            // with no course column to narrow on — so this student's study
            // sessions arrive here too.
            const questionId = row.open_question_id;
            if (!questionId || !row.status) return;

            const previous = lastSessionStatus.current[questionId]?.status;
            statusSeq.current += 1;
            lastSessionStatus.current[questionId] = {
              status: row.status,
              seq: statusSeq.current,
            };
            if (previous === row.status) return;

            const isCompleted = row.status === 'completed';

            setQuestions(prev =>
              prev.map(q => (q.id === questionId ? { ...q, isCompleted } : q)),
            );
            setSelectedQuestion(prev =>
              prev && prev.id === questionId ? { ...prev, isCompleted } : prev,
            );

            // Only the open question on screen has a flagged state or gets a
            // toast; the rest just have their badge corrected above.
            if (selectedQuestionIdRef.current !== questionId) return;

            setIsFlagged(row.status === 'paused');
            if (previous === 'paused' && row.status === 'in_progress') {
              toast.success(tRef.current("openQuestions.unpaused"));
            } else if (isCompleted && mode === "interactive") {
              // The tutor closed the question. Said once, on the transition —
              // the student may well be reading the reply that closed it.
              //
              // Interactive only, because only there does completion mean the
              // answer was right. Single-answer mode completes the session on
              // *submission*, before any grade exists — `submit-open-answer`
              // writes the row — so "Correct!" would be a claim this screen
              // has no basis for, on top of the submission's own toast.
              toast.success(tRef.current("openQuestions.correctCompleted"), { duration: 3000 });
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
    // Deliberately not keyed on `selectedQuestion`: it changes every time the
    // student opens a question, and resubscribing drops events in the gap.
    // The handler reads the current selection through a ref instead. `mode` is
    // a dependency because the handler branches on it, and it is constant for
    // the life of a mounted list — resubscribing on it costs nothing.
  }, [courseId, mode]);

  /**
   * Record a status this screen is about to write, so the resulting Realtime
   * frame is not announced back to the student as news.
   *
   * Returns the undo. A write that fails must release its claim, or a later
   * genuine transition to that same status is discarded as a duplicate and the
   * badge stays stale until a reload.
   */
  const claimSessionStatus = (questionId: string, status: string) => {
    const previous = lastSessionStatus.current[questionId];
    statusSeq.current += 1;
    // Captured, not re-read. The counter is global — every question's events
    // advance it — so comparing the release against `statusSeq.current` would
    // abandon the rollback whenever *any other* question happened to change
    // while this write was failing, which is precisely when the stale claim
    // then swallows the real transition.
    const claimed = statusSeq.current;
    lastSessionStatus.current[questionId] = { status, seq: claimed };
    return () => {
      // Only if this claim is still the newest thing recorded for *this*
      // question: a live event that landed while the write was failing is the
      // truth, not what we assumed we were about to write.
      if (lastSessionStatus.current[questionId]?.seq !== claimed) return;
      if (previous) lastSessionStatus.current[questionId] = previous;
      else delete lastSessionStatus.current[questionId];
    };
  };

  const fetchQuestions = async () => {
    // Stamped before the first read. Anything the Realtime handler records
    // after this point is newer than what these queries return, and must not
    // be undone by them — see `lastSessionStatus`.
    const readAt = statusSeq.current;

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      let questionsData: any[] = [];

      if (offeringId) {
        // After #582 every open-question assignment lives in
        // `offering_questions`, keyed by `question_id`. Filter to open-type
        // questions in the follow-up `questions` fetch.
        const { data: assignments, error: assignError } = await supabase
          .from("offering_questions")
          .select("question_id")
          .eq("offering_id", offeringId)
          .not("published_at", "is", null);

        if (assignError) throw assignError;

        const assignedIds = (assignments || []).map((a: any) => a.question_id);
        if (assignedIds.length === 0) {
          questionsData = [];
        } else {
          // Chunk to stay well under PostgREST's ~8 KB URL limit
          // (100 UUIDs × 37 chars ≈ 3.7 KB per request).
          const CHUNK = 100;
          const chunks: string[][] = [];
          for (let i = 0; i < assignedIds.length; i += CHUNK) {
            chunks.push(assignedIds.slice(i, i + CHUNK));
          }
          const results = await Promise.all(
            chunks.map(ids =>
              supabase
                .from("questions")
                .select("id, question, difficulty, created_at, hidden, payload")
                .eq("type", "open")
                .in("id", ids)
            )
          );
          for (const { data, error } of results) {
            if (error) throw error;
            questionsData.push(...(data || []).filter((q: any) => !q.hidden));
          }
        }
      } else {
        // Fallback: no offering, show all visible questions (for admins/instructors).
        // Reads the unified `questions` table filtered by `type='open'` (#580).
        const { data, error } = await supabase
          .from("questions")
          .select("id, question, difficulty, created_at, payload")
          .eq("course_id", courseId)
          .eq("type", "open")
          .eq("hidden", false)
          .order("created_at", { ascending: false });

        if (error) throw error;
        questionsData = data || [];
      }

      // Sessions carry the status; their messages carry the counts. Both
      // surfaces share the tables now, so open-question rows are selected by
      // the subject column rather than by which table they live in.
      const { data: sessionRows, error: sessionsError } = await supabase
        .from("chat_sessions")
        .select("id, open_question_id, status")
        .eq("user_id", user.id)
        .eq("course_id", courseId)
        .not("open_question_id", "is", null);

      if (sessionsError) throw sessionsError;

      const sessionsByQuestion = new Map<string, string>();
      (sessionRows || []).forEach((row) => {
        if (row.open_question_id) sessionsByQuestion.set(row.id, row.open_question_id);
      });

      const { data: chatsData, error: chatsError } = sessionsByQuestion.size
        ? await supabase
            .from("chat_messages")
            .select("session_id, created_at")
            .in("session_id", [...sessionsByQuestion.keys()])
            .order("created_at", { ascending: true })
        : { data: [], error: null };

      if (chatsError) throw chatsError;

      const progressData = (sessionRows || []).map((row) => ({
        open_question_id: row.open_question_id as string,
        status: row.status,
      }));

      const messageCountMap = new Map<string, number>();
      const firstInteractionMap = new Map<string, string>();
      (chatsData || []).forEach(c => {
        // A message names its session, not its question — resolve it back.
        const questionId = sessionsByQuestion.get(c.session_id);
        if (!questionId) return;
        messageCountMap.set(questionId, (messageCountMap.get(questionId) || 0) + 1);
        if (!firstInteractionMap.has(questionId)) {
          firstInteractionMap.set(questionId, c.created_at);
        }
      });

      const completionMap = new Map<string, boolean>();
      (progressData || []).forEach(p => {
        // A live event for this question landed while the reads were in
        // flight. It is newer than what they returned, so it stands and this
        // row is discarded — otherwise opening the list at the moment the
        // tutor closes a question would show it closed and then quietly
        // reopen it.
        if ((lastSessionStatus.current[p.open_question_id]?.seq ?? 0) > readAt) return;

        completionMap.set(p.open_question_id, p.status === 'completed');
        // Seed the Realtime handler's baseline, so the first event it sees is
        // compared against what is on screen rather than against nothing. A
        // question already complete when the list loaded must not announce
        // itself as newly complete on the next unrelated update.
        lastSessionStatus.current[p.open_question_id] = { status: p.status, seq: readAt };
      });

      // Those same overtaking events, applied. A session created *during* the
      // reads has no row in `progressData` at all, so this is the only place
      // its status can come from.
      Object.entries(lastSessionStatus.current).forEach(([questionId, seen]) => {
        if (seen.seq > readAt) completionMap.set(questionId, seen.status === 'completed');
      });

      const questionsWithStatus: OpenQuestion[] = (questionsData || [])
        .map(q => ({
          id: q.id,
          question: q.question,
          difficulty: q.difficulty,
          createdAt: q.created_at,
          hasStarted: messageCountMap.has(q.id),
          messageCount: messageCountMap.get(q.id) || 0,
          firstInteractionAt: firstInteractionMap.get(q.id),
          isCompleted: completionMap.get(q.id) || false,
          answeringMode: openAnsweringModeFromPayload(q.payload ?? null),
          diagram: questionDiagramFromPayload(q.payload ?? null),
        }))
        // #613 — restrict to the surface's mode so single-answer and
        // interactive (Socratic) questions live in separate, clearly-
        // labeled lists. The filter is the only thing that differentiates
        // the two student-side views.
        .filter(q => q.answeringMode === mode);

      setQuestions(questionsWithStatus);
    } catch (error: any) {
      console.error("Error fetching open questions:", error);
      toast.error(t("openQuestions.loadFailed"));
    } finally {
      setLoading(false);
    }
  };

  const loadChatHistory = async (questionId: string) => {
    setLoadingChat(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      // The session carries the status and owns the transcript.
      const { data: sessionRow } = await supabase
        .from("chat_sessions")
        .select("id, status")
        .eq("open_question_id", questionId)
        .eq("user_id", user.id)
        .maybeSingle();

      // Set paused state based on backend status
      if (sessionRow?.status === 'paused') {
        setIsFlagged(true);
      }

      const { data, error } = sessionRow
        ? await supabase
            .from("chat_messages")
            .select("id, role, content, flagged_offensive, sender_user_id, created_at")
            .eq("session_id", sessionRow.id)
            .order("created_at", { ascending: true })
        : { data: [], error: null };

      if (error) throw error;

      const rows = (data || []).filter(
        (msg: any) =>
          msg.role === "user" ||
          msg.role === "assistant" ||
          msg.role === "instructor"
      );

      const instructorIds = Array.from(
        new Set(
          rows
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

      const messages: ChatMessage[] = rows.map((msg: any) => ({
        id: msg.id,
        role: msg.role as "user" | "assistant" | "instructor",
        content: msg.content,
        flaggedOffensive: msg.flagged_offensive,
        timestamp: msg.created_at,
        senderName:
          msg.role === "instructor" && msg.sender_user_id
            ? nameById[msg.sender_user_id]
            : undefined,
        // Tutor state is now managed separately via chat_session_state
        tutorState: null,
      }));

      setChatMessages(messages);
    } catch (error: any) {
      console.error("Error loading chat history:", error);
    } finally {
      setLoadingChat(false);
    }
  };

  const selectQuestion = async (question: OpenQuestion) => {
    // Reset both branches so transitioning between questions is clean.
    setSelectedQuestion(question);
    setChatMessages([]);
    setIsFlagged(false);
    setSingleAnswerDraft("");
    setSingleAnswerGrade(null);
    resetTyping();

    if (question.answeringMode === "single") {
      // No chat history to load — fetch the (possibly existing) one-shot
      // grade so we can render the read-only "submitted" state.
      setSingleAnswerLoadingExisting(true);
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
          const { data: grade } = await supabase
            .from("open_question_grades")
            .select("grade, feedback, strengths, areas_for_improvement, submitted_answer")
            .eq("open_question_id", question.id)
            .eq("user_id", user.id)
            .maybeSingle();
          if (grade) {
            setSingleAnswerGrade({
              grade: grade.grade ?? null,
              feedback: grade.feedback ?? "",
              strengths: grade.strengths ?? [],
              areasForImprovement: grade.areas_for_improvement ?? [],
              submittedAnswer: grade.submitted_answer ?? "",
            });
          }
        }
      } catch (err) {
        console.error("Failed to load existing single-mode grade:", err);
      } finally {
        setSingleAnswerLoadingExisting(false);
      }
      return;
    }

    // Interactive (Socratic) — unchanged.
    setLoadingChat(true);
    await loadChatHistory(question.id);
  };

  const submitSingleAnswer = async () => {
    if (!selectedQuestion || singleAnswerSubmitting) return;
    const trimmed = singleAnswerDraft.trim();
    if (!trimmed) {
      toast.error(t("openQuestions.writeBeforeSubmitting"));
      return;
    }

    setSingleAnswerSubmitting(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const accessToken = session?.access_token;
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/submit-open-answer`;
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken || import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
        },
        body: JSON.stringify({
          questionId: selectedQuestion.id,
          courseId,
          studentAnswer: trimmed,
        }),
      });

      const json = await resp.json().catch(() => ({}));

      if (!resp.ok || json.error) {
        if (json.error === "already_submitted") {
          toast.info(json.message || t("openQuestions.alreadySubmitted"));
          // Refresh from the server so the read-only view appears.
          await selectQuestion(selectedQuestion);
          return;
        }
        if (json.error === "content_blocked") {
          toast.error(json.message || t("openQuestions.moderationFlagged"));
          setIsFlagged(true);
          return;
        }
        throw new Error(json.message || json.error || t("openQuestions.submitFailed"));
      }

      // `submit-open-answer` marked the session complete on the way through,
      // so claim the status the Realtime frame is about to report. No release
      // path: this runs only once the server has answered, so the write it
      // stands for has already happened. The answer is now pending instructor
      // review — no grade or feedback exists yet.
      claimSessionStatus(selectedQuestion.id, 'completed');
      setSingleAnswerGrade({
        grade: null,
        feedback: "",
        strengths: [],
        areasForImprovement: [],
        submittedAnswer: trimmed,
      });
      setSelectedQuestion(prev => prev ? { ...prev, isCompleted: true } : null);
      setQuestions(prev =>
        prev.map(q =>
          q.id === selectedQuestion.id ? { ...q, isCompleted: true } : q
        )
      );
      toast.success(t("openQuestions.answerSubmitted"), { duration: 3000 });
    } catch (error: any) {
      console.error("Single-answer submit error:", error);
      toast.error(error?.message || t("openQuestions.submitFailed"));
    } finally {
      setSingleAnswerSubmitting(false);
    }
  };

  const generateWelcomeMessage = async (question: OpenQuestion) => {
    setSending(true);
    beginTyping(35);

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error(t("openQuestions.notAuthenticated"));

      // Get the user's session token for authentication
      const { data: { session } } = await supabase.auth.getSession();
      const accessToken = session?.access_token;

      setChatMessages([{ role: "assistant", content: "" }]);

      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/chat`;
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken || import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
        },
        body: JSON.stringify({
          kind: "open_question",
          subjectId: question.id,
          courseId,
          start: true,
        }),
      });

      if (!resp.ok) {
        const json = await resp.json().catch(() => ({}));
        throw new Error(json.message || json.error || t("openQuestions.replyFailed"));
      }

      const contentType = resp.headers.get("content-type") || "";

      if (contentType.includes("text/event-stream")) {
        // Streaming SSE response
        let metadata: { state?: { decision?: string; evaluator?: Record<string, unknown> } } | undefined;
        const result = await parseSSEStream(resp, {
          onContent: (chunk) => addToQueue(chunk),
          onMetadata: (meta) => { metadata = meta as typeof metadata; },
        });
        await finishTyping();

        const fullResponse = result.content;
        const responseTutorState: TutorState = {
          decision: toTutorDecision(metadata?.state?.decision),
        };

        setChatMessages([{ role: "assistant", content: fullResponse, tutorState: responseTutorState }]);
        // Assistant turn is persisted server-side by the `chat` turn; RLS
        // forbids clients from inserting role='assistant'.
      } else {
        // JSON fallback (content_blocked or errors)
        const response = await resp.json();

        if (response.error === "content_blocked") {
          setIsFlagged(true);
          setChatMessages([{
            role: "assistant",
            content: response.message || t("openQuestions.moderationContentFlagged"),
            flaggedOffensive: true
          }]);
          return;
        }

        const fullResponse = response.assistant_text;
        addToQueue(fullResponse);
        await finishTyping();
        setChatMessages([{ role: "assistant", content: fullResponse }]);
      }
    } catch (error: any) {
      console.error("Error generating welcome:", error);
      toast.error(t("openQuestions.tutorUnreachable"));
      setChatMessages([]);
      resetTyping();
    } finally {
      setSending(false);
    }
  };

  // Only generate welcome message if question has no previous messages (messageCount === 0)
  // and we've finished loading and still have no messages.
  // #596 — skipped entirely for single-answer mode, which never uses chat.
  //
  // #1313 — and skipped entirely under `USE_STREAMING_CHAT`, which is the only
  // surface students get. This is the BUFFERED path's opening turn: it posts to
  // `chat`, and it writes the reply into `chatMessages`, which the streaming
  // panel below never reads. Left ungated it fired a real, billed model call on
  // every un-started question whose answer was then thrown away — while the
  // panel, which owns the opening turn under streaming, showed nothing.
  useEffect(() => {
    if (
      !USE_STREAMING_CHAT &&
      selectedQuestion &&
      selectedQuestion.answeringMode !== "single" &&
      !loadingChat &&
      chatMessages.length === 0 &&
      !sending &&
      selectedQuestion.messageCount === 0
    ) {
      generateWelcomeMessage(selectedQuestion);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- generate welcome only when question selected and no messages
  }, [selectedQuestion, loadingChat, chatMessages.length]);

  const sendMessage = async (userMessage: string) => {
    if (!selectedQuestion || sending || isFlagged) return;

    // Checked here as well as in the box, because the order of what follows is
    // unforgiving: the turn is written to `chat_messages` *before* the
    // request goes out, so a message the handler then rejects with a 400 is
    // already in the transcript — visible to the student, with no reply after
    // it, and replayed to the model on every later turn. Refusing it up front
    // is the only point at which that is still avoidable.
    if (userMessage.length > TUTOR_INPUT_CHAR_LIMIT) {
      toast.error(
        tCommon("chat.tooLongToast", {
          length: userMessage.length,
          max: TUTOR_INPUT_CHAR_LIMIT,
        }),
      );
      return;
    }

    setSending(true);
    beginTyping(35);

    const newUserMessage: ChatMessage = { role: "user", content: userMessage };
    const currentMessages = [...chatMessages, newUserMessage];
    setChatMessages(currentMessages);

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error(t("openQuestions.notAuthenticated"));

      // The turn is persisted before the request, because the function reads
      // the conversation back out of the database rather than taking it from
      // the body — which is what makes a retry idempotent.
      //
      // `offering_id` is deliberately left unset: only the function's
      // authorisation check knows which offering published this question, and
      // it scopes the row on the first turn. Until then the session is
      // course-scoped, which is what the legacy rows were anyway.
      const { session: turnSession } = await ensureChatSession({
        subjectColumn: "open_question_id",
        subjectId: selectedQuestion.id,
        userId: user.id,
        courseId,
      });
      const turnSessionId = turnSession.id;

      const { data: insertedTurn, error: turnInsertError } = await supabase
        .from("chat_messages")
        .insert({
          session_id: turnSessionId,
          role: "user",
          content: userMessage,
        })
        .select("id")
        .single();

      // Nothing was saved, so there is no turn to answer. Carrying on would
      // send `replyTo: null` and let the server fall back to inferring the
      // latest persisted row — answering an older or concurrently inserted
      // message while the one just typed exists nowhere, which is precisely
      // what naming the turn exists to prevent.
      if (turnInsertError || !insertedTurn) {
        throw turnInsertError ?? new Error(t("openQuestions.replyFailed"));
      }

      setChatMessages(prev => [...prev, { role: "assistant", content: "" }]);

      // Get the user's session token for authentication
      const { data: { session } } = await supabase.auth.getSession();
      const accessToken = session?.access_token;

      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/chat`;

      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken || import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
        },
        // Naming the turn rather than letting the server infer "the latest
        // user row". Both surfaces share one session, so two requests in
        // flight would otherwise resolve to the same message and one student
        // turn would go unanswered.
        body: JSON.stringify({
          kind: "open_question",
          subjectId: selectedQuestion.id,
          courseId,
          replyTo: insertedTurn?.id ?? null,
        }),
      });

      if (!resp.ok) {
        const json = await resp.json().catch(() => ({}));

        // Handle session already paused (403)
        if (resp.status === 403 && json.error === "session_paused") {
          resetTyping();
          setChatMessages(prev => prev.slice(0, -1));
          setChatMessages(prev => [...prev, {
            role: "assistant",
            content: `${t("openQuestions.pausedBanner")}\n\n${json.message || t("openQuestions.pausedChatNotice")}`,
          }]);
          setIsFlagged(true);
          toast.info(t("openQuestions.toastPaused"), {
            description: t("openQuestions.toastPausedDetail"),
            duration: 8000,
          });
          return;
        }

        // `message` first, `error` second. `error` is a machine code —
        // `message_too_long`, `socratic_empty_response` — and putting it in a
        // toast showed the student a slug where the handler had written them a
        // sentence saying what to do about it. The catalog string is the last
        // resort, for a failure that carried neither.
        throw new Error(json.message || json.error || t("openQuestions.replyFailed"));
      }

      const contentType = resp.headers.get("content-type") || "";

      if (contentType.includes("text/event-stream")) {
        // Streaming SSE response
        let metadata: { state?: { decision?: string; evaluator?: { stop?: boolean; judgement?: string } } } | undefined;
        const result = await parseSSEStream(resp, {
          onContent: (chunk) => addToQueue(chunk),
          onMetadata: (meta) => { metadata = meta as typeof metadata; },
        });
        await finishTyping();

        const fullResponse = result.content;
        const responseTutorState: TutorState = {
          decision: toTutorDecision(metadata?.state?.decision),
        };

        setChatMessages(prev => {
          const updated = [...prev];
          updated[updated.length - 1] = { role: "assistant", content: fullResponse, tutorState: responseTutorState };
          return updated;
        });
        // Assistant turn is persisted server-side by the `chat` turn; RLS
        // forbids clients from inserting role='assistant'.

        // If evaluator says stop (CORRECT answer), mark the question as complete.
        //
        // Redundant since the server does this itself (`completeOnStop`), and
        // kept because this path is the v1 fallback: it is the only one whose
        // reply still carries `evaluator.stop`, and the write is the same
        // idempotent one. The status is claimed first so the resulting Realtime
        // frame does not toast on top of the toast below.
        if (metadata?.state?.evaluator?.stop === true) {
          const release = claimSessionStatus(selectedQuestion.id, 'completed');
          const { error: completeError } = await supabase
            .from("chat_sessions")
            .update({
              status: "completed",
              completed_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq("open_question_id", selectedQuestion.id)
            .eq("user_id", user.id);
          // The server's own write is the one that matters; this is only the
          // duplicate. Releasing the claim on failure leaves the Realtime
          // frame from *that* write free to update the screen.
          if (completeError) release();

          setSelectedQuestion(prev => prev ? { ...prev, isCompleted: true } : null);
          setQuestions(prev =>
            prev.map(q =>
              q.id === selectedQuestion.id ? { ...q, isCompleted: true } : q
            )
          );
          toast.success(t("openQuestions.correctCompleted"), { duration: 3000 });
        }
      } else {
        // JSON fallback (content_blocked, session_paused, or errors)
        const response = await resp.json();

        if (response.error === "content_blocked") {
          resetTyping();
          setChatMessages(prev => prev.slice(0, -1));
          setChatMessages(prev => [...prev, {
            role: "assistant",
            content: response.message || "⚠️ Your message was flagged by our content moderation system. This session has been paused.",
            flaggedOffensive: true
          }]);
          setIsFlagged(true);
          setSelectedQuestion(prev => prev ? { ...prev, isCompleted: false } : null);
          // `blockedSide: "assistant"` means the tutor's own reply was flagged
          // and withheld (#1198) — the student wrote nothing wrong, so the
          // toast must not tell them they did.
          toast.error(t("openQuestions.toastModerationPaused"), {
            description: response.blockedSide === "assistant"
              ? t("openQuestions.moderationReplyWithheld")
              : t("openQuestions.moderationContactInstructor"),
            duration: 8000,
          });
          return;
        }

        if (response.error === "session_paused") {
          resetTyping();
          setChatMessages(prev => prev.slice(0, -1));
          setChatMessages(prev => [...prev, {
            role: "assistant",
            content: `${t("openQuestions.pausedBanner")}\n\n${response.message || t("openQuestions.pausedForReview")}`,
          }]);
          setIsFlagged(true);
          toast.info(t("openQuestions.toastPaused"), {
            description: t("openQuestions.toastPausedDetail"),
            duration: 8000,
          });
          return;
        }

        // Unknown JSON error
        resetTyping();
        setChatMessages(prev => prev.slice(0, -1));
        toast.error(
          response.message || response.error || t("openQuestions.replyFailed"),
        );
      }
    } catch (error: any) {
      console.error("Chat error:", error);
      toast.error(error.message || t("openQuestions.sendFailed"));
      resetTyping();
      setChatMessages(prev => prev.slice(0, -1));
    } finally {
      setSending(false);
    }
  };

  const getDifficultyColor = getDifficultyClass;

  const handleToggleCompletionClick = () => {
    if (!selectedQuestion || markingComplete) return;
    // Only the "in_progress -> completed" transition is destructive (disables
    // input). Reopening is reversible, so skip confirmation in that direction.
    if (!selectedQuestion.isCompleted && hasDraft) {
      setShowCompleteConfirm(true);
      return;
    }
    toggleCompletion();
  };

  const toggleCompletion = async () => {
    if (!selectedQuestion || markingComplete) return;

    setMarkingComplete(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error(t("openQuestions.notAuthenticated"));

      const newStatus = selectedQuestion.isCompleted ? 'in_progress' : 'completed';

      // Claimed before the write, not after: this row's UPDATE comes back over
      // Realtime, and the frame can beat the response we are awaiting. Without
      // this the student's own click would be announced back to them a second
      // time, as if the tutor had closed the question.
      const release = claimSessionStatus(selectedQuestion.id, newStatus);

      const { error } = await supabase
        .from("chat_sessions")
        .update({
          status: newStatus,
          completed_at: newStatus === 'completed' ? new Date().toISOString() : null,
          updated_at: new Date().toISOString(),
        })
        .eq("open_question_id", selectedQuestion.id)
        .eq("user_id", user.id);

      if (error) {
        // Nothing was written, so the claim was a lie. Released, or the tutor
        // closing this question later would be read as an echo of a click that
        // never landed.
        release();
        throw error;
      }

      setSelectedQuestion(prev => prev ? { ...prev, isCompleted: !prev.isCompleted } : null);
      setQuestions(prev => prev.map(q => 
        q.id === selectedQuestion.id ? { ...q, isCompleted: !q.isCompleted } : q
      ));

      toast.success(newStatus === 'completed' ? 'Marked as completed!' : 'Reopened for study');
    } catch (error: any) {
      console.error("Error updating completion:", error);
      toast.error(t("openQuestions.statusUpdateFailed"));
    } finally {
      setMarkingComplete(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (selectedQuestion && selectedQuestion.answeringMode === "single") {
    const SOFT_CHAR_HINT = 1500;
    const draftLength = singleAnswerDraft.length;
    const showSubmitted = singleAnswerGrade !== null;

    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between border-b pb-3">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => setSelectedQuestion(null)}>
              <ArrowLeft className="w-5 h-5" />
            </Button>
            <div>
              <h3 className="font-semibold text-sm">{t("openQuestions.singleTitle")}</h3>
              <p className="text-xs text-muted-foreground">
                {t("openQuestions.singleSubtitle")}
              </p>
            </div>
          </div>
          <Badge className={getDifficultyColor(selectedQuestion.difficulty)}>
            {selectedQuestion.difficulty}
          </Badge>
        </div>

        <Card>
          <CardContent className="p-4">
            {selectedQuestion.diagram?.source && (
              <QuestionDiagram
                source={selectedQuestion.diagram.source}
                alt={selectedQuestion.diagram.alt ?? null}
              />
            )}
            <div className="flex items-start gap-3">
              <BookOpen className="w-5 h-5 text-primary mt-0.5 flex-shrink-0" />
              <div
                className="text-sm text-foreground prose prose-sm max-w-none"
                dangerouslySetInnerHTML={{ __html: formatQuestionText(selectedQuestion.question) }}
              />
            </div>
          </CardContent>
        </Card>

        {singleAnswerLoadingExisting ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : showSubmitted ? (
          <Card>
            <CardContent className="p-4 space-y-4">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-5 h-5 text-green-600" />
                <span className="font-medium">{t("openQuestions.submitted")}</span>
                {singleAnswerGrade!.grade !== null ? (
                  <Badge variant="outline" className="ml-auto bg-green-500/10 text-green-700 border-green-500/20">
                    {t("openQuestions.gradeOutOf", { grade: singleAnswerGrade!.grade })}
                  </Badge>
                ) : (
                  <Badge variant="outline" className="ml-auto bg-amber-500/10 text-amber-700 border-amber-500/20">
                    {t("openQuestions.pendingReview")}
                  </Badge>
                )}
              </div>
              {singleAnswerGrade!.grade === null ? (
                /* Recorded, ungraded: the instructor reviews and grades it.
                   Nothing model-authored is shown, so no AI disclaimer. */
                <p className="text-sm text-muted-foreground">
                  {t("openQuestions.pendingReviewNote")}
                </p>
              ) : (
                /* Grade + feedback written by the instructor (legacy rows may
                   still carry model output from the retired AI grader). */
                <AiDisclaimer source="model-or-teacher" assessment />
              )}
              <div>
                <Label className="text-muted-foreground text-xs">{t("openQuestions.yourAnswer")}</Label>
                <div className="mt-1 p-3 bg-muted rounded-md text-sm whitespace-pre-wrap">
                  {singleAnswerGrade!.submittedAnswer || t("openQuestions.answerUnavailable")}
                </div>
              </div>
              {singleAnswerGrade!.feedback && (
                <div>
                  <Label className="text-muted-foreground text-xs">{t("openQuestions.feedback")}</Label>
                  <div className="mt-1 p-3 bg-muted rounded-md text-sm">
                    {singleAnswerGrade!.feedback}
                  </div>
                </div>
              )}
              {singleAnswerGrade!.strengths.length > 0 && (
                <div>
                  <Label className="text-muted-foreground text-xs">{t("openQuestions.strengths")}</Label>
                  <ul className="mt-1 list-disc list-inside text-sm space-y-1">
                    {singleAnswerGrade!.strengths.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </div>
              )}
              {singleAnswerGrade!.areasForImprovement.length > 0 && (
                <div>
                  <Label className="text-muted-foreground text-xs">{t("openQuestions.areasForImprovement")}</Label>
                  <ul className="mt-1 list-disc list-inside text-sm space-y-1">
                    {singleAnswerGrade!.areasForImprovement.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </div>
              )}
              <p className="text-xs text-muted-foreground italic">
                {t("openQuestions.oneSubmissionNote")}
              </p>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="p-4 space-y-3">
              <Label htmlFor="single-answer-textarea" className="text-sm font-medium">
                {t("openQuestions.yourAnswer")}
              </Label>
              <Textarea
                id="single-answer-textarea"
                value={singleAnswerDraft}
                onChange={(e) => setSingleAnswerDraft(e.target.value)}
                placeholder={t("openQuestions.placeholder")}
                rows={8}
                disabled={singleAnswerSubmitting || isFlagged}
                className="resize-y"
              />
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span className={draftLength > SOFT_CHAR_HINT ? "text-amber-600" : undefined}>
                  {t("openQuestions.characterCount", { count: draftLength })}
                  {draftLength > SOFT_CHAR_HINT
                    ? t("openQuestions.beMoreConcise")
                    : ""}
                </span>
                <Button
                  size="sm"
                  onClick={submitSingleAnswer}
                  disabled={singleAnswerSubmitting || isFlagged || draftLength === 0}
                  className="gap-2"
                >
                  {singleAnswerSubmitting ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Send className="w-4 h-4" />
                  )}
                  {singleAnswerSubmitting
                    ? t("openQuestions.submitting")
                    : t("openQuestions.submit")}
                </Button>
              </div>
              {isFlagged && (
                <p className="text-xs text-destructive">
                  {t("openQuestions.moderationPausedNote")}
                </p>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    );
  }

  /*
    The controls and the facts, built once and given to whichever surface
    renders the conversation. Defined here rather than inside each branch so
    the two cannot drift — the streaming panel losing "mark as complete", and
    the created/started/message-count line with it, is exactly what happened
    when it was built as a separate screen.
  */
  const questionActions = selectedQuestion && (
    <>
      <Badge className={getDifficultyColor(selectedQuestion.difficulty)}>
        {selectedQuestion.difficulty}
      </Badge>
      <Button
        variant="outline"
        size="sm"
        onClick={handleToggleCompletionClick}
        disabled={markingComplete}
        className={selectedQuestion.isCompleted ? "gap-1.5 text-green-600 border-green-500/30 hover:bg-green-500/10" : "gap-1.5"}
      >
        {markingComplete ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
        {selectedQuestion.isCompleted
          ? t("openQuestions.completed")
          : t("openQuestions.markComplete")}
      </Button>
    </>
  );

  const questionMeta = selectedQuestion && (
    <>
      <div className="flex items-center gap-1.5">
        <Calendar className="w-3.5 h-3.5" />
        <span>
          {t("openQuestions.created", {
            date: format(new Date(selectedQuestion.createdAt), "d MMM yyyy", {
              locale: dateFnsLocale,
            }),
          })}
        </span>
      </div>
      {selectedQuestion.firstInteractionAt && (
        <div className="flex items-center gap-1.5">
          <Clock className="w-3.5 h-3.5" />
          <span>
            {t("openQuestions.started", {
              date: format(
                new Date(selectedQuestion.firstInteractionAt),
                "d MMM yyyy, HH:mm",
                { locale: dateFnsLocale },
              ),
            })}
          </span>
        </div>
      )}
      {selectedQuestion.messageCount && selectedQuestion.messageCount > 0 && (
        <div className="flex items-center gap-1.5">
          <MessageSquareText className="w-3.5 h-3.5" />
          <span>{t("openQuestions.messages", { count: selectedQuestion.messageCount })}</span>
        </div>
      )}
    </>
  );

  // Only interactive questions reach here — single-answer mode returns above.
  //
  // #1313 — `openWithTutorTurn` asks the panel for the Socratic opening turn,
  // the same way StudentStudySession does. Without it the panel waited for the
  // student to speak first, so an un-started question opened to an empty
  // transcript and no greeting. The panel's own guards keep it from firing on a
  // completed question or over an existing transcript.
  if (selectedQuestion && USE_STREAMING_CHAT) {
    return (
      <StreamingChatPanel
        kind="open_question"
        subjectId={selectedQuestion.id}
        courseId={courseId}
        heading={selectedQuestion.question}
        title={t("openQuestions.openQuestion")}
        subtitle={t("openQuestions.socraticMode")}
        headerActions={questionActions}
        diagram={
          selectedQuestion.diagram?.source ? (
            <QuestionDiagram
              source={selectedQuestion.diagram.source}
              alt={selectedQuestion.diagram.alt ?? null}
            />
          ) : null
        }
        meta={questionMeta}
        openWithTutorTurn
        placeholder={
          selectedQuestion.isCompleted
            ? t("openQuestions.placeholderComplete")
            : t("openQuestions.placeholderChat")
        }
        disabled={selectedQuestion.isCompleted}
        onBack={() => setSelectedQuestion(null)}
      />
    );
  }

  if (selectedQuestion) {
    const emptyState = (
      <div className="text-center py-8">
        <Lightbulb className="w-12 h-12 mx-auto text-amber-500 mb-3" />
        <h3 className="font-medium mb-1">{t("openQuestions.readyToLearn")}</h3>
        <p className="text-sm text-muted-foreground max-w-sm mx-auto">
          {t("openQuestions.readyToLearnBody")}
        </p>
      </div>
    );

    return (
      /* The 160px is this screen's chrome, not a guess: the sticky nav (~57px,
         73px on the branches whose nav holds a button) plus the `py-8` of the
         `<main>` that wraps this panel, with a few px of slack. Taller than
         that and the transcript would push past the fold; shorter — the old
         `max-h-[700px]` — and a tall viewport left a screenful of dead space
         below the composer. `min-h` keeps it usable on short viewports, where
         the page simply scrolls; the panel is in normal flow above a
         `min-h-screen` page, so it can never ride over the global footer. */
      <div className="flex flex-col h-[calc(100vh-160px)] min-h-[500px]">
        {/* Header */}
        <div className="pb-4 border-b bg-gradient-to-r from-primary/5 to-transparent -mx-4 px-4 pt-4 -mt-4">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <Button variant="ghost" size="icon" onClick={() => setSelectedQuestion(null)}>
                <ArrowLeft className="w-5 h-5" />
              </Button>
              <div className="flex items-center gap-2">
                <img src={aiTutorImage} alt={t("openQuestions.tutorAlt")} className="w-8 h-8 rounded-full border-2 border-primary/20" />
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold text-sm">{t("openQuestions.openQuestion")}</h3>
                    {isFlagged && <Badge variant="destructive" className="text-xs">{t("openQuestions.sessionPausedBadge")}</Badge>}
                  </div>
                  <p className="text-xs text-muted-foreground">{t("openQuestions.socraticMode")}</p>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">{questionActions}</div>
          </div>

          <div className="bg-background/80 backdrop-blur-sm rounded-lg p-4 border shadow-sm">
            {selectedQuestion.diagram?.source && (
              <QuestionDiagram
                source={selectedQuestion.diagram.source}
                alt={selectedQuestion.diagram.alt ?? null}
              />
            )}
            <div className="flex items-start gap-3">
              <BookOpen className="w-5 h-5 text-primary mt-0.5 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm text-foreground prose prose-sm max-w-none max-h-48 overflow-y-auto" dangerouslySetInnerHTML={{ __html: formatQuestionText(selectedQuestion.question) }} />
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-4 mt-3 text-xs text-muted-foreground">
            {questionMeta}
          </div>
        </div>

        {isExercisePdf && (
          <Collapsible open={progressOpen} onOpenChange={setProgressOpen} className="border-b">
            <CollapsibleTrigger asChild>
              <Button variant="ghost" className="w-full flex items-center justify-between py-2 px-3 h-auto">
                <div className="flex items-center gap-2">
                  <ListChecks className="w-4 h-4 text-primary" />
                  <span className="text-sm font-medium">{t("openQuestions.exerciseProgress")}</span>
                  {completedExercises.length > 0 && (
                    <Badge variant="secondary" className="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                      {t("openQuestions.exercisesCompleted", { count: completedExercises.length })}
                    </Badge>
                  )}
                </div>
                {progressOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="px-3 pb-3">
              {completedExercises.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t("openQuestions.noExercisesYet")}
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {completedExercises.map((exercise) => (
                    <Badge key={exercise} className="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 flex items-center gap-1">
                      <CheckCircle2 className="w-3 h-3" />
                      {t("openQuestions.exerciseBadge", { number: exercise })}
                    </Badge>
                  ))}
                </div>
              )}
            </CollapsibleContent>
          </Collapsible>
        )}

        {loadingChat ? (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <ChatWidget
            ref={chatWidgetRef}
            messages={chatMessages}
            onSendMessage={sendMessage}
            isLoading={sending}
            isTyping={isTyping}
            typingContent={displayedContent}
            placeholder={
              selectedQuestion.isCompleted
                ? t("openQuestions.placeholderComplete")
                : isFlagged
                  ? t("openQuestions.placeholderPaused")
                  : t("openQuestions.placeholderChat")
            }
            showAvatar={true}
            avatarSrc={aiTutorImage}
            emptyState={emptyState}
            inputType="textarea"
            footerHint={
              selectedQuestion.isCompleted
                ? t("openQuestions.footerComplete")
                : isFlagged
                  ? undefined
                  : t("openQuestions.footerTip")
            }
            className="flex-1"
            enableMarkdown={true}
            maxLength={TUTOR_INPUT_CHAR_LIMIT}
            disabled={isFlagged || selectedQuestion.isCompleted}
            showTutorState={canViewTutorState}
            onDraftChange={setHasDraft}
          />
        )}

        <AlertDialog open={showCompleteConfirm} onOpenChange={setShowCompleteConfirm}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("openQuestions.discardTitle")}</AlertDialogTitle>
              <AlertDialogDescription>
                {t("openQuestions.discardBody")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("openQuestions.keepTyping")}</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  setShowCompleteConfirm(false);
                  chatWidgetRef.current?.clearInput();
                  toggleCompletion();
                }}
              >
                {t("openQuestions.confirmMarkComplete")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    );
  }

  const headerTitle =
    mode === "single"
      ? t("openQuestions.headerTitleSingle")
      : t("openQuestions.headerTitleInteractive");
  const headerSubtitle =
    mode === "single"
      ? t("openQuestions.headerSubtitleSingle")
      : t("openQuestions.headerSubtitleInteractive");
  const emptyStateText =
    mode === "single"
      ? t("openQuestions.emptySingle")
      : t("openQuestions.emptyInteractive");

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <Button variant="ghost" size="icon" onClick={onBack}>
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <div>
          <h2 className="text-xl font-display font-bold">{headerTitle}</h2>
          <p className="text-sm text-muted-foreground">{headerSubtitle}</p>
        </div>
      </div>

      {questions.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <MessageSquareText className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
            <p className="text-muted-foreground">{emptyStateText}</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[100px]">{t("openQuestions.colDifficulty")}</TableHead>
                  <TableHead>{t("openQuestions.colQuestion")}</TableHead>
                  <TableHead className="w-[100px] text-center">{t("openQuestions.colMessages")}</TableHead>
                  <TableHead className="w-[100px] text-center">{t("openQuestions.colStatus")}</TableHead>
                  <TableHead className="w-[100px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {questions.map((question) => (
                  <TableRow key={question.id} className="cursor-pointer hover:bg-muted/50">
                    <TableCell>
                      <Badge className={getDifficultyColor(question.difficulty)}>{question.difficulty}</Badge>
                    </TableCell>
                    <TableCell className="text-sm">
                      <div className="prose prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: formatQuestionText(question.question) }} />
                    </TableCell>
                    <TableCell className="text-center">
                      {question.messageCount && question.messageCount > 0 ? (
                        <Badge variant="secondary" className="font-mono">{question.messageCount}</Badge>
                      ) : (
                        <span className="text-muted-foreground text-sm">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-center">
                      {question.isCompleted ? (
                        <Badge variant="outline" className="bg-green-500/10 text-green-600 border-green-500/20">
                          <CheckCircle2 className="w-3 h-3 mr-1" />
                          {t("openQuestions.badgeCompleted")}
                        </Badge>
                      ) : question.hasStarted ? (
                        <Badge variant="outline" className="bg-blue-500/10 text-blue-600 border-blue-500/20">
                          <Eye className="w-3 h-3 mr-1" />
                          {t("openQuestions.badgeStarted")}
                        </Badge>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <Button size="sm" variant="outline" onClick={() => selectQuestion(question)}>
                        {question.isCompleted
                          ? t("openQuestions.actionView")
                          : question.hasStarted
                            ? t("openQuestions.actionContinue")
                            : t("openQuestions.actionStart")}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
};

export default StudentOpenQuestions;
