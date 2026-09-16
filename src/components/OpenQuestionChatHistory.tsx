import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
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
import {
  MessageSquareText,
  Loader2,
  Search,
  User,
  AlertTriangle,
  GraduationCap,
  CheckCircle,
  XCircle,
  Trash2,
  Play,
} from "lucide-react";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { format } from "date-fns";
import { toast } from "sonner";
import { formatQuestionText } from "@/lib/latex-utils";
import { RichContent } from "@/components/chat";

interface ChatSession {
  id: string;
  /**
   * The `chat_sessions` row this card is built from. Both surfaces are one
   * table now, so every mutation below keys on this instead of branching on
   * `type` and re-deriving a progress row per surface.
   */
  sessionId: string;
  openQuestionId: string;
  questionText: string;
  userId: string;
  userName: string;
  userEmail: string;
  messages: {
    id: string;
    role: string;
    content: string;
    flaggedOffensive: boolean;
    createdAt: string;
    senderUserId?: string | null;
    senderName?: string;
  }[];
  isPaused: boolean;
  lastMessageAt: string;
  type: "question" | "study-session";
  studySessionStatus?: "in_progress" | "completed" | "paused";
  questionStatus?: "not_started" | "in_progress" | "completed" | "paused";
}

interface OpenQuestionChatHistoryProps {
  courseId: string;
  offeringId?: string;
}

/**
 * Moderation records are stored as a JSON envelope, not prose. The input-side
 * flag has always written one — role `system` for open questions, `moderation`
 * for study sessions — and #1198 added the output-side twin carrying the tutor
 * reply that was withheld from the student.
 *
 * Before this, an open-question record rendered as raw JSON in the transcript
 * and a study-session record was filtered out entirely, so a paused session
 * showed no reason for the pause. Parsing the envelope is what makes it
 * reviewable. The two writers predate each other and disagree on field names,
 * so both shapes are read here rather than one being rewritten in place.
 */
interface ModerationRecord {
  side: "student" | "assistant";
  categories: string[];
  /** The message that was blocked — the student's, or the withheld reply. */
  text: string | null;
}

const parseModerationRecord = (content: string): ModerationRecord | null => {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const result = parsed.result as { flaggedCategories?: unknown } | undefined;
  const rawCategories = parsed.flaggedCategories ?? result?.flaggedCategories;

  return {
    side: parsed.side === "assistant" ? "assistant" : "student",
    categories: Array.isArray(rawCategories) ? (rawCategories as string[]) : [],
    text:
      typeof parsed.withheld_text === "string"
        ? parsed.withheld_text
        : typeof parsed.original_message === "string"
        ? parsed.original_message
        : null,
  };
};

const OpenQuestionChatHistory = ({ courseId, offeringId }: OpenQuestionChatHistoryProps) => {
  const { user, profile } = useAuth();
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [instructorMessageDrafts, setInstructorMessageDrafts] = useState<Record<string, string>>({});
  const [sendingInstructorMessage, setSendingInstructorMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterPaused, setFilterPaused] = useState<string>("all");
  const [filterType, setFilterType] = useState<string>("all");
  const [questions, setQuestions] = useState<{ id: string; question: string; type: string }[]>([]);
  const [selectedQuestion, setSelectedQuestion] = useState<string>("all");
  const [unpausingSession, setUnpausingSession] = useState<string | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [sessionToDelete, setSessionToDelete] = useState<ChatSession | null>(null);
  const [deletingSession, setDeletingSession] = useState(false);
  const [deletingMessageId, setDeletingMessageId] = useState<string | null>(null);
  const [togglingComplete, setTogglingComplete] = useState<string | null>(null);

  useEffect(() => {
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch on courseId/offeringId change
  }, [courseId, offeringId]);

  const fetchData = async () => {
    try {
      // Fetch all open questions for this course from the unified table (#582).
      const { data: questionsData, error: questionsError } = await supabase
        .from("questions")
        .select("id, question")
        .eq("course_id", courseId)
        .eq("type", "open")
        .order("created_at", { ascending: false });

      if (questionsError) throw questionsError;
      
      // Also fetch study sessions
      const { data: studySessionsListData } = await supabase
        .from("study_sessions")
        .select("id, title")
        .eq("course_id", courseId)
        .order("created_at", { ascending: false });

      // Combine questions and study sessions for the filter dropdown
      const allQuestions = [
        ...(questionsData || []).map((q: any) => ({ id: q.id, question: q.question, type: "question" })),
        ...(studySessionsListData || []).map((s: any) => ({ id: s.id, question: `📚 ${s.title}`, type: "study-session" })),
      ];
      setQuestions(allQuestions);

      // Get valid user IDs based on class filter or course tags
      const validUserIds: Set<string> = new Set();

      if (offeringId) {
        // Get students enrolled in the class for this offering
        const { data: offeringData } = await supabase
          .from("offerings")
          .select("class_id")
          .eq("id", offeringId)
          .single();

        if (offeringData?.class_id) {
          const { data: enrollmentData } = await supabase
            .from("class_enrollments")
            .select("user_id")
            .eq("class_id", offeringData.class_id)
            .eq("role", "student");

          enrollmentData?.forEach(e => validUserIds.add(e.user_id));
        }
      } else {
        // No specific class filter — get all students enrolled in classes that offer this course
        const { data: offeringsData } = await supabase
          .from("offerings")
          .select("class_id")
          .eq("course_id", courseId);

        const classIds = [...new Set((offeringsData || []).map(o => o.class_id))];

        if (classIds.length > 0) {
          const { data: enrollmentData } = await supabase
            .from("class_enrollments")
            .select("user_id")
            .in("class_id", classIds)
            .eq("role", "student");

          enrollmentData?.forEach(e => validUserIds.add(e.user_id));
        }
      }

      // One query serves both surfaces: `chat_sessions` carries the subject,
      // the status and the offering, and `chat_messages` hangs off it. The two
      // separate fetch-and-merge paths this replaces existed only because the
      // tables were mirrored.
      const { data: sessionRows, error: sessionsError } = await supabase
        .from("chat_sessions")
        .select("id, user_id, study_session_id, open_question_id, status, created_at")
        .eq("course_id", courseId);

      if (sessionsError) throw sessionsError;

      const visibleSessions = (sessionRows || []).filter((row) => validUserIds.has(row.user_id));

      const { data: messageRows, error: messagesError } = visibleSessions.length
        ? await supabase
            .from("chat_messages")
            .select("id, session_id, role, content, flagged_offensive, created_at, sender_user_id")
            .in("session_id", visibleSessions.map((row) => row.id))
            .order("created_at", { ascending: true })
        : { data: [], error: null };

      if (messagesError) throw messagesError;

      const userIds = [...new Set(visibleSessions.map((row) => row.user_id))];

      // Fetch user profiles
      const userProfiles: Record<string, { name: string; email: string }> = {};
      if (userIds.length > 0) {
        const { data: profiles } = await supabase
          .from("profiles")
          .select("user_id, full_name, email")
          .in("user_id", userIds);

        (profiles || []).forEach((p: any) => {
          userProfiles[p.user_id] = {
            name: p.full_name || "Unknown",
            email: p.email || "",
          };
        });
      }

      const questionLookup: Record<string, string> = {};
      (questionsData || []).forEach((q: any) => {
        questionLookup[q.id] = q.question;
      });

      const { data: studySessionsData } = await supabase
        .from("study_sessions")
        .select("id, title")
        .eq("course_id", courseId);

      const studySessionLookup: Record<string, string> = {};
      (studySessionsData || []).forEach((s: any) => {
        studySessionLookup[s.id] = s.title;
      });

      // Moderation rows are kept: they are the only record of *why* a session
      // is paused, and since #1198 they can hold a tutor reply that was
      // withheld from the student. They render as a review card, not a bubble.
      const VISIBLE_ROLES = new Set(["user", "assistant", "instructor", "moderation"]);
      const messagesBySession: Record<string, any[]> = {};
      (messageRows || []).forEach((m: any) => {
        if (!VISIBLE_ROLES.has(m.role)) return;
        (messagesBySession[m.session_id] ||= []).push(m);
      });

      const sessionsMap: Record<string, ChatSession> = {};
      visibleSessions.forEach((row) => {
        const messages = messagesBySession[row.id] || [];
        const isQuestion = !!row.open_question_id;
        // A session with no transcript is not a chat: `submit-open-answer`
        // creates a completion row without any turns for written single-mode
        // submissions (reviewed in the Question Answers table), and an
        // untouched interactive session has nothing to review. The one
        // exception is a paused session — pausing is the instructor's cue to
        // act, and a failed moderation-record write can leave one with no
        // visible messages; hiding it would hide the only unpause control.
        if (messages.length === 0 && row.status !== "paused") return;

        const subjectId = (isQuestion ? row.open_question_id : row.study_session_id) as string;
        const key = `${isQuestion ? "q" : "s"}-${subjectId}-${row.user_id}`;
        const isPaused = row.status === "paused";

        sessionsMap[key] = {
          id: key,
          sessionId: row.id,
          openQuestionId: subjectId,
          questionText: isQuestion
            ? questionLookup[subjectId] || "Unknown question"
            : `📚 Tutoring Session: ${studySessionLookup[subjectId] || "Unknown"}`,
          userId: row.user_id,
          userName: userProfiles[row.user_id]?.name || "Unknown",
          userEmail: userProfiles[row.user_id]?.email || "",
          messages: messages.map((m: any) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            // A withheld reply is `role='moderation'` on both surfaces now, so
            // the role alone no longer has to stand in for the flag.
            flaggedOffensive: !!m.flagged_offensive || m.role === "moderation",
            createdAt: m.created_at,
            senderUserId: m.sender_user_id ?? null,
          })),
          isPaused,
          lastMessageAt: messages[messages.length - 1]?.created_at || row.created_at,
          type: isQuestion ? "question" : "study-session",
          ...(isQuestion
            ? { questionStatus: row.status as ChatSession["questionStatus"] }
            : {
                studySessionStatus:
                  row.status === "completed" ? "completed" : isPaused ? "paused" : "in_progress",
              }),
        };
      });

      // Resolve instructor sender names for any instructor-authored messages
      const senderUserIds = new Set<string>();
      Object.values(sessionsMap).forEach((session) => {
        session.messages.forEach((m) => {
          if (m.role === "instructor" && m.senderUserId) {
            senderUserIds.add(m.senderUserId);
          }
        });
      });
      const senderNameById: Record<string, string> = {};
      const unknownSenderIds = [...senderUserIds].filter((id) => !userProfiles[id]);
      if (unknownSenderIds.length > 0) {
        const { data: senderProfiles } = await supabase
          .from("profiles")
          .select("user_id, full_name")
          .in("user_id", unknownSenderIds);
        (senderProfiles || []).forEach((p: any) => {
          if (p.full_name) senderNameById[p.user_id] = p.full_name;
        });
      }
      senderUserIds.forEach((id) => {
        const profileName = userProfiles[id]?.name;
        if (profileName && profileName !== "Unknown" && !senderNameById[id]) {
          senderNameById[id] = profileName;
        }
      });
      Object.values(sessionsMap).forEach((session) => {
        session.messages = session.messages.map((m) =>
          m.role === "instructor" && m.senderUserId
            ? { ...m, senderName: senderNameById[m.senderUserId] }
            : m
        );
      });

      // Convert to array and sort: paused first, then by last message
      const sessionsArray = Object.values(sessionsMap).sort((a, b) => {
        if (a.isPaused && !b.isPaused) return -1;
        if (!a.isPaused && b.isPaused) return 1;
        return new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime();
      });

      setSessions(sessionsArray);
    } catch (error: any) {
      console.error("Error fetching chat history:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleUnpauseSession = async (session: ChatSession) => {
    setUnpausingSession(session.id);
    try {
      // One session row, whichever surface it belongs to.
      const { data: updateData, error } = await supabase
        .from("chat_sessions")
        .update({ status: "in_progress" })
        .eq("id", session.sessionId)
        .select();

      if (error) {
        console.error("RLS or DB error:", error);
        throw new Error(`Database error: ${error.message || error.code}`);
      }
      // A write RLS refuses is not an error — it matches no rows and reports
      // success — so the zero-row case has to be read as the refusal it is.
      // Warning to the console and toasting "Session unpaused" is how an
      // instructor came to believe they had released a session that is still
      // paused, and to find it paused again on the next reload.
      if (!updateData || updateData.length === 0) {
        throw new Error(
          "You do not have permission to unpause this session. It may belong to a section you are not assigned to — ask an administrator.",
        );
      }

      // Clear the flag from the student's own turns. The withheld-reply record
      // is left flagged: it is the review trail, not something to unflag.
      await supabase
        .from("chat_messages")
        .update({ flagged_offensive: false })
        .eq("session_id", session.sessionId)
        .eq("flagged_offensive", true)
        .neq("role", "moderation");

      setSessions((prev) =>
        prev.map((s) =>
          s.id === session.id
            ? {
                ...s,
                isPaused: false,
                questionStatus: s.type === "question" ? "in_progress" : s.questionStatus,
                studySessionStatus:
                  s.type === "study-session" ? "in_progress" : s.studySessionStatus,
                messages: s.messages.map((m) =>
                  m.role === "moderation" ? m : { ...m, flaggedOffensive: false },
                ),
              }
            : s,
        ),
      );

      toast.success("Session unpaused");
    } catch (error: any) {
      console.error("Error unpausing session:", error);
      toast.error(error.message || "Failed to unpause session");
    } finally {
      setUnpausingSession(null);
    }
  };

  const handleToggleComplete = async (session: ChatSession) => {
    if (session.type !== "question") return;

    setTogglingComplete(session.id);
    try {
      const newStatus = session.questionStatus === "completed" ? "in_progress" : "completed";

      // The session row always exists here — the card was built from one — so
      // the create-if-missing branch this replaces had nothing to create.
      const { data: updated, error } = await supabase
        .from("chat_sessions")
        .update({
          status: newStatus,
          completed_at: newStatus === "completed" ? new Date().toISOString() : null,
        })
        .eq("id", session.sessionId)
        .select("id");

      if (error) throw error;
      // As on the unpause: a refusal arrives as zero rows, not as an error.
      if (!updated || updated.length === 0) {
        throw new Error(
          "You do not have permission to change this session. It may belong to a section you are not assigned to.",
        );
      }

      setSessions((prev) =>
        prev.map((s) =>
          s.id === session.id
            ? { ...s, questionStatus: newStatus as ChatSession["questionStatus"] }
            : s,
        ),
      );

      toast.success(newStatus === "completed" ? "Marked as complete" : "Marked as incomplete");
    } catch (error: any) {
      console.error("Error toggling complete status:", error);
      toast.error(error.message || "Failed to update status");
    } finally {
      setTogglingComplete(null);
    }
  };

  const handleDeleteSession = async () => {
    if (!sessionToDelete) return;

    setDeletingSession(true);
    try {
      // Messages, state and history all cascade from the session row, so the
      // per-surface delete sequences this replaces are one statement now.
      const { data: deleted, error } = await supabase
        .from("chat_sessions")
        .delete()
        .eq("id", sessionToDelete.sessionId)
        .select("id");

      if (error) throw error;
      // Same refusal shape as the unpause above: RLS declines by matching no
      // rows, so without this the card disappears from the list, the toast says
      // it was deleted, and the transcript is still there after a reload.
      if (!deleted || deleted.length === 0) {
        throw new Error(
          "You do not have permission to delete this chat history. It may belong to a section you are not assigned to.",
        );
      }

      // The grade is not part of the conversation and does not cascade.
      if (sessionToDelete.type === "question") {
        await supabase
          .from("open_question_grades")
          .delete()
          .eq("open_question_id", sessionToDelete.openQuestionId)
          .eq("user_id", sessionToDelete.userId)
          .eq("course_id", courseId);
      }

      setSessions((prev) => prev.filter((s) => s.id !== sessionToDelete.id));
      toast.success("Chat history deleted");
    } catch (error: any) {
      console.error("Error deleting session:", error);
      toast.error(error.message || "Failed to delete chat history");
    } finally {
      setDeletingSession(false);
      setDeleteDialogOpen(false);
      setSessionToDelete(null);
    }
  };

  const handleSendInstructorMessage = async (session: ChatSession) => {
    if (!user) {
      toast.error("You must be signed in to send a message");
      return;
    }
    const draft = (instructorMessageDrafts[session.id] || "").trim();
    if (!draft) return;

    setSendingInstructorMessage(session.id);
    try {
      const createdAt = new Date().toISOString();

      // RLS still checks that this instructor may write into this student's
      // thread — and now checks it section-scoped on both surfaces.
      const { data, error } = await supabase
        .from("chat_messages")
        .insert({
          session_id: session.sessionId,
          role: "instructor",
          content: draft,
          flagged_offensive: false,
          sender_user_id: user.id,
        })
        .select("id, created_at")
        .single();
      if (error) throw error;
      const insertedId: string | null = data.id;

      const senderName = profile?.full_name || undefined;
      setSessions((prev) =>
        prev.map((s) =>
          s.id === session.id
            ? {
                ...s,
                lastMessageAt: createdAt,
                messages: [
                  ...s.messages,
                  {
                    id: insertedId || `tmp-${createdAt}`,
                    role: "instructor",
                    content: draft,
                    flaggedOffensive: false,
                    createdAt,
                    senderUserId: user.id,
                    senderName,
                  },
                ],
              }
            : s
        )
      );
      setInstructorMessageDrafts((prev) => ({ ...prev, [session.id]: "" }));
      toast.success("Message sent to student");
    } catch (error: any) {
      console.error("Error sending instructor message:", error);
      toast.error(error.message || "Failed to send message");
    } finally {
      setSendingInstructorMessage(null);
    }
  };

  const handleDeleteMessage = async (session: ChatSession, messageId: string) => {
    setDeletingMessageId(messageId);
    try {
      // One table, so the surface no longer decides where a message lives.
      const { error } = await supabase.from("chat_messages").delete().eq("id", messageId);
      if (error) throw error;

      // Update local state - remove the message
      setSessions(prev => prev.map(s => {
        if (s.id !== session.id) return s;
        const updatedMessages = s.messages.filter(m => m.id !== messageId);
        // If no messages left, remove the session entirely
        if (updatedMessages.length === 0) {
          return null;
        }
        return {
          ...s,
          messages: updatedMessages,
        };
      }).filter(Boolean) as ChatSession[]);

      toast.success("Message deleted");
    } catch (error: any) {
      console.error("Error deleting message:", error);
      toast.error("Failed to delete message");
    } finally {
      setDeletingMessageId(null);
    }
  };

  const filteredSessions = sessions.filter((session) => {
    // Search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      const matchesUser = session.userName.toLowerCase().includes(query) ||
                         session.userEmail.toLowerCase().includes(query);
      const matchesContent = session.messages.some(m => 
        m.content.toLowerCase().includes(query)
      );
      if (!matchesUser && !matchesContent) return false;
    }

    // Type filter
    if (filterType === "questions" && session.type !== "question") return false;
    if (filterType === "study-sessions" && session.type !== "study-session") return false;

    // Paused filter
    if (filterPaused === "paused" && !session.isPaused) return false;
    if (filterPaused === "clean" && session.isPaused) return false;

    // Question filter
    if (selectedQuestion !== "all" && session.openQuestionId !== selectedQuestion) return false;

    return true;
  });

  const pausedCount = sessions.filter((s) => s.isPaused).length;

  if (loading) {
    return (
      <Card>
        <CardContent className="py-12">
          <div className="flex items-center justify-center">
            <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <MessageSquareText className="w-5 h-5" />
              Student Chat History
            </CardTitle>
            <CardDescription>
              View student interactions with the AI tutor
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {pausedCount > 0 && (
              <Badge variant="destructive" className="text-sm">
                <AlertTriangle className="w-3 h-3 mr-1" />
                {pausedCount} paused
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {/* Filters */}
        <div className="flex flex-wrap gap-3 mb-6">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search by student or content..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>
          <Select value={filterType} onValueChange={setFilterType}>
            <SelectTrigger className="w-[150px]">
              <SelectValue placeholder="Chat type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Chats</SelectItem>
              <SelectItem value="questions">AI Questions</SelectItem>
              <SelectItem value="study-sessions">Tutoring Sessions</SelectItem>
            </SelectContent>
          </Select>
          <Select value={selectedQuestion} onValueChange={setSelectedQuestion}>
            <SelectTrigger className="w-[200px]">
              <SelectValue placeholder="Filter by topic" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Topics</SelectItem>
              {questions.map((q) => (
                <SelectItem key={q.id} value={q.id}>
                  {q.question.slice(0, 50)}...
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={filterPaused} onValueChange={setFilterPaused}>
            <SelectTrigger className={`w-[160px] ${filterPaused === "paused" ? "border-destructive bg-destructive/10 text-destructive" : pausedCount > 0 && filterPaused === "all" ? "border-destructive/50" : ""}`}>
              <div className="flex items-center gap-2">
                {pausedCount > 0 && filterPaused !== "clean" && (
                  <AlertTriangle className="w-3.5 h-3.5 text-destructive" />
                )}
                <SelectValue placeholder="Filter content" />
              </div>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Content</SelectItem>
              <SelectItem value="paused" className="text-destructive">
                <span className="flex items-center gap-2">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  Paused Only ({pausedCount})
                </span>
              </SelectItem>
              <SelectItem value="clean">Clean Only</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {filteredSessions.length === 0 ? (
          <div className="py-12 text-center">
            <MessageSquareText className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
            <p className="text-muted-foreground">No chat sessions found</p>
          </div>
        ) : (
          <Accordion type="multiple" className="space-y-2">
            {filteredSessions.map((session) => (
              <AccordionItem
                key={session.id}
                value={session.id}
                className="border rounded-lg px-4 overflow-hidden"
              >
                <AccordionTrigger className="hover:no-underline py-4 min-w-0 overflow-hidden">
                  <div className="flex items-center gap-3 flex-1 text-left min-w-0 overflow-hidden">
                    <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center flex-shrink-0">
                      <User className="w-5 h-5 text-muted-foreground" />
                    </div>
                    <div className="flex-1 min-w-0 overflow-hidden">
                                      <div className="flex items-center gap-2 overflow-hidden">
                                        <span className="font-medium truncate">{session.userName}</span>
                                        {session.type === "study-session" && (
                                          <>
                                            <Badge variant="secondary" className="text-xs flex-shrink-0">
                                              📚 Tutoring Session
                                            </Badge>
                                            <Badge
                                              variant="outline"
                                              className={`text-xs flex-shrink-0 ${
                                                session.studySessionStatus === "completed"
                                                  ? "bg-green-100 text-green-800 border-green-300 dark:bg-green-900 dark:text-green-300 dark:border-green-700"
                                                  : session.studySessionStatus === "paused"
                                                    ? "bg-red-100 text-red-800 border-red-300 dark:bg-red-900 dark:text-red-300 dark:border-red-700"
                                                    : "bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-900 dark:text-amber-300 dark:border-amber-700"
                                              }`}
                                            >
                                              {session.studySessionStatus === "completed"
                                                ? "✓ Completed"
                                                : session.studySessionStatus === "paused"
                                                  ? "⚠️ Paused"
                                                  : "⏳ In Progress"}
                                            </Badge>
                                          </>
                                        )}
                                        {session.type === "question" && (
                                          <Badge variant="secondary" className="text-xs flex-shrink-0">
                                            💬 AI Question
                                          </Badge>
                                        )}
                                        {session.type === "question" && session.questionStatus === "completed" && (
                                          <Badge
                                            variant="outline"
                                            className="text-xs flex-shrink-0 bg-green-100 text-green-800 border-green-300 dark:bg-green-900 dark:text-green-300 dark:border-green-700"
                                          >
                                            <CheckCircle className="w-3 h-3 mr-1" />
                                            Complete
                                          </Badge>
                                        )}
                                        {session.type === "question" && session.isPaused && (
                                          <Badge variant="destructive" className="text-xs flex-shrink-0">
                                            <AlertTriangle className="w-3 h-3 mr-1" />
                                            ⚠️ Paused
                                          </Badge>
                                        )}
                                      </div>
                      <p
                        className="text-sm text-muted-foreground truncate"
                        dangerouslySetInnerHTML={{ __html: formatQuestionText(session.questionText).replace(/<[^>]*>/g, ' ').substring(0, 100) }}
                      />
                    </div>
                    <div className="text-right text-sm text-muted-foreground flex-shrink-0 whitespace-nowrap">
                      <p>
                        {session.messages.length} message{session.messages.length === 1 ? "" : "s"}
                      </p>
                      <p>{format(new Date(session.lastMessageAt), "MMM d, HH:mm")}</p>
                    </div>
                  </div>
                </AccordionTrigger>
                <AccordionContent>
                  <div className="pt-2 pb-4 space-y-3">
                    <div className="bg-muted/50 rounded-lg p-3 mb-4">
                      <p className="text-xs font-medium text-muted-foreground mb-1">Question:</p>
                      <div
                        className="text-sm prose prose-sm max-w-none dark:prose-invert"
                        dangerouslySetInnerHTML={{ __html: formatQuestionText(session.questionText) }}
                      />
                    </div>
                    
                    {/* Session Actions - Unflag, Toggle Complete, and Delete */}
                    <div className="flex items-center gap-2 mb-4">
                      {session.type === "question" && (
                        <Button
                          size="sm"
                          variant="outline"
                          className={session.questionStatus === "completed" 
                            ? "text-amber-600 hover:text-amber-700 hover:bg-amber-50" 
                            : "text-green-600 hover:text-green-700 hover:bg-green-50"}
                          onClick={() => handleToggleComplete(session)}
                          disabled={togglingComplete === session.id}
                        >
                          {togglingComplete === session.id ? (
                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          ) : session.questionStatus === "completed" ? (
                            <XCircle className="w-4 h-4 mr-2" />
                          ) : (
                            <CheckCircle className="w-4 h-4 mr-2" />
                          )}
                          {session.questionStatus === "completed" ? "Mark Incomplete" : "Mark Complete"}
                        </Button>
                      )}
                      {session.isPaused && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-green-600 hover:text-green-700 hover:bg-green-50"
                          onClick={() => handleUnpauseSession(session)}
                          disabled={unpausingSession === session.id}
                        >
                          {unpausingSession === session.id ? (
                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          ) : (
                            <Play className="w-4 h-4 mr-2" />
                          )}
                          Unpause Session
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                        onClick={() => {
                          setSessionToDelete(session);
                          setDeleteDialogOpen(true);
                        }}
                      >
                        <Trash2 className="w-4 h-4 mr-2" />
                        Delete History
                      </Button>
                    </div>

                    <ScrollArea className="h-[300px]">
                      <div className="space-y-3">
                        {session.messages.map((msg, index) => {
                          const isInstructor = msg.role === "instructor";
                          const alignment = msg.role === "user"
                            ? "justify-end"
                            : "justify-start";

                          // Moderation records are not turns in the
                          // conversation — they are the record of one being
                          // blocked. Rendered full-width as a review card so
                          // the categories and the blocked text are legible.
                          if (msg.role === "system" || msg.role === "moderation") {
                            const record = parseModerationRecord(msg.content);
                            if (!record) return null;
                            return (
                              <div
                                key={msg.id}
                                className="rounded-lg border-2 border-destructive/60 bg-destructive/5 px-4 py-3"
                              >
                                <p className="text-xs font-medium text-destructive flex items-center gap-1">
                                  <AlertTriangle className="w-3 h-3" />
                                  {record.side === "assistant"
                                    ? "AI tutor reply withheld by moderation"
                                    : "Student message blocked by moderation"}
                                </p>
                                {record.categories.length > 0 && (
                                  <p className="text-xs text-muted-foreground mt-1">
                                    Categories: {record.categories.join(", ")}
                                  </p>
                                )}
                                {record.text && (
                                  <p className="text-sm mt-2 whitespace-pre-wrap break-words">
                                    {record.text}
                                  </p>
                                )}
                                <p className="text-xs opacity-70 mt-1">
                                  {format(new Date(msg.createdAt), "HH:mm")}
                                </p>
                              </div>
                            );
                          }

                          return (
                            <div
                              key={msg.id}
                              className={`group flex items-start gap-2 ${alignment}`}
                            >
                              {msg.role === "user" && (
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive flex-shrink-0 mt-2"
                                  onClick={() => handleDeleteMessage(session, msg.id)}
                                  disabled={deletingMessageId === msg.id}
                                >
                                  {deletingMessageId === msg.id ? (
                                    <Loader2 className="w-3 h-3 animate-spin" />
                                  ) : (
                                    <Trash2 className="w-3 h-3" />
                                  )}
                                </Button>
                              )}
                              <div className="flex flex-col gap-1 max-w-[80%]">
                                {isInstructor && (
                                  <span className="text-[11px] font-medium text-amber-700 dark:text-amber-300 flex items-center gap-1">
                                    <GraduationCap className="w-3 h-3" />
                                    {msg.senderName ? `${msg.senderName} · Instructor` : "Instructor"}
                                  </span>
                                )}
                                <div
                                  className={`rounded-2xl px-4 py-2.5 ${
                                    msg.role === "user"
                                      ? "bg-primary text-primary-foreground rounded-br-md"
                                      : isInstructor
                                      ? "bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-100 border border-amber-300 dark:border-amber-700 rounded-bl-md"
                                      : "bg-muted rounded-bl-md"
                                  } ${msg.flaggedOffensive ? "border-2 border-destructive" : ""}`}
                                >
                                  <RichContent
                                    content={msg.content}
                                    className="text-sm [&>p]:my-1 [&>br]:my-0"
                                  />
                                  <p className="text-xs opacity-70 mt-1">
                                    {format(new Date(msg.createdAt), "HH:mm")}
                                    {msg.flaggedOffensive && " ⚠️ Flagged"}
                                  </p>
                                </div>
                              </div>
                              {msg.role !== "user" && (
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive flex-shrink-0 mt-2"
                                  onClick={() => handleDeleteMessage(session, msg.id)}
                                  disabled={deletingMessageId === msg.id}
                                >
                                  {deletingMessageId === msg.id ? (
                                    <Loader2 className="w-3 h-3 animate-spin" />
                                  ) : (
                                    <Trash2 className="w-3 h-3" />
                                  )}
                                </Button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </ScrollArea>

                    {/* Instructor message composer */}
                    <div className="mt-4 border-t pt-4 space-y-2">
                      <Label htmlFor={`instructor-msg-${session.id}`} className="text-xs font-medium flex items-center gap-1.5">
                        <GraduationCap className="w-3.5 h-3.5 text-amber-600" />
                        Send message to student
                      </Label>
                      <Textarea
                        id={`instructor-msg-${session.id}`}
                        value={instructorMessageDrafts[session.id] || ""}
                        onChange={(e) =>
                          setInstructorMessageDrafts((prev) => ({
                            ...prev,
                            [session.id]: e.target.value,
                          }))
                        }
                        placeholder="Type a message to this student. They'll see it in their chat alongside AI tutor responses."
                        rows={2}
                        disabled={sendingInstructorMessage === session.id}
                      />
                      <div className="flex justify-end">
                        <Button
                          size="sm"
                          onClick={() => handleSendInstructorMessage(session)}
                          disabled={
                            sendingInstructorMessage === session.id ||
                            !(instructorMessageDrafts[session.id] || "").trim()
                          }
                        >
                          {sendingInstructorMessage === session.id ? (
                            <>
                              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                              Sending...
                            </>
                          ) : (
                            <>
                              <MessageSquareText className="w-4 h-4 mr-2" />
                              Send Message
                            </>
                          )}
                        </Button>
                      </div>
                    </div>
                  </div>
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        )}
      </CardContent>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Chat History</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this chat history for{" "}
              <span className="font-semibold">{sessionToDelete?.userName}</span>?
              This will permanently remove all messages and cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletingSession}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteSession}
              disabled={deletingSession}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deletingSession ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Deleting...
                </>
              ) : (
                "Delete"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
};

export default OpenQuestionChatHistory;