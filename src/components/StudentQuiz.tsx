import { useState, useEffect, useMemo } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { formatExplanation } from "@/lib/utils";
import { processLatexContent } from "@/lib/latex-utils";
import { getDifficultyClass } from "@/lib/difficulty-color";
import {
  mcqOptionsFromPayload,
  mcqIsMultiCorrectFromPayload,
  questionDiagramFromPayload,
  classificationCategoriesFromPayload,
  classificationItemsFromPayload,
  orderingItemsFromPayload,
  fillGapsStemFromPayload,
  fillGapsSkeletonFromStem,
  type ClassificationCategory,
  type ClassificationItem,
} from "@/lib/question-payload";
import { QuestionDiagram } from "@/components/QuestionDiagram";
import {
  type NonMcqAnswer,
  emptyNonMcqAnswer,
  isNonMcqComplete,
  isNonMcqType,
  nonMcqSubmission,
} from "@/lib/quiz-non-mcq";
import {
  SubmitQuizAnswersError,
  submitQuizAnswers,
  type QuizAnswerVerdict,
} from "@/lib/submit-quiz-answers";
import { renderQuestionStem } from "@/lib/question-stem";
import { fillGapsOrdinalsInStem, type QuestionType } from "@/types/question";
import type { Json } from "@/integrations/supabase/types";
import "katex/dist/katex.min.css";
import {
  McqField,
  OpenField,
  FillGapsField,
  OrderingField,
  ClassificationField,
} from "@/components/question-fields";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
  ArrowLeft,
  Loader2, 
  CheckCircle,
  XCircle,
  ArrowRight,
  Trophy,
  Target,
  BookOpen,
  RefreshCcw,
  Clock,
  AlertTriangle,
  ThumbsUp,
  ThumbsDown,
  SkipForward,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";

// Seconds between the timer hitting zero and forced auto-submit. Gives the
// student a final chance to save in-progress changes before their attempt is
// closed. Matches the 30s figure quoted to students in the grace dialog.
const GRACE_PERIOD_SECONDS = 30;

interface Question {
  id: string;
  // Unified question type (#582). The quiz flow renders MCQ natively and
  // delegates the answer surface for the other four types (#820 —
  // classification; #829 — ordering, fill_gaps, open).
  type: QuestionType;
  question: string;
  options: string[];
  // Whether more than one option is correct (#592), from the student-facing
  // `payload` rather than the key (#1011). It is the only thing about the
  // answer this surface knows before the student submits, and all it says is
  // how many to pick — not which.
  multiCorrect: boolean;
  // ---------------------------------------------------------------------
  // Everything below this line is ANSWER KEY, and is empty until the server
  // sends it back with the recorded verdict (#1011). None of it is fetched
  // with the question any more: it used to arrive at quiz start and sit in
  // the browser, unrendered, for as long as the student took to answer.
  //
  // `orderingItems` is the exception, and not by choice — an ordering
  // question's canonical order IS its `payload.items`, so it cannot be
  // withheld without withholding the question (#1117). It is populated from
  // the start, like it always was.
  // ---------------------------------------------------------------------
  // Multi-correct (#592). Single-correct items hold a 1-element array.
  correctIndices: number[];
  // Classification (#610/#820). Populated only for `type === "classification"`.
  // `categories`/`items` are the student-facing buckets and cards;
  // `classificationAssignments` (item_id → category_id) is the answer key.
  categories?: ClassificationCategory[];
  items?: ClassificationItem[];
  classificationAssignments?: Record<string, string>;
  // Ordering (#606/#829). Canonical (correct) order; the renderer shuffles.
  orderingItems?: string[];
  // Fill the gaps (#604/#829). `fillGapsStem` carries the `{{1}}`-style
  // placeholders; `fillGapsGaps` is the per-gap acceptable-answer key in
  // ordinal order — before reveal it is the ordinal SKELETON read off the
  // stem, which is what sizes the draft and places the inputs.
  fillGapsStem?: string;
  fillGapsGaps?: { ordinal: number; acceptable: string[] }[];
  // Justifies the key, so it gives the answer away as readily (#1011).
  // Empty until reveal.
  explanation: string;
  difficulty: "easy" | "medium" | "hard";
  isUserGenerated?: boolean;
  competencyIds: string[];
  // #627 — optional SVG figure rendered above the stem.
  diagram?: { source: string; alt?: string } | null;
}

// #833 — a resumed snapshot is unrenderable when its resolved shape lacks the
// data its `type` needs. The classic case is a snapshot frozen before non-MCQ
// support (#820 classification, #829 ordering/fill_gaps/open): it has no
// `type`, so it defaults to "mcq" with empty options and paints a blank card
// that can't be answered. Detecting this lets the loader self-heal from the
// live question.
function isRenderableQuestion(q: Question): boolean {
  switch (q.type) {
    case "classification":
      return (q.categories?.length ?? 0) > 0 && (q.items?.length ?? 0) > 0;
    case "ordering":
      return (q.orderingItems?.length ?? 0) > 0;
    case "fill_gaps":
      // The stem's `{{N}}` placeholders, not the key: the gaps are the
      // skeleton read off the stem until the answer is submitted (#1011), so
      // an unanswered fill-gaps question would otherwise look unrenderable and
      // send every one of them through the self-heal path.
      return !!q.fillGapsStem && fillGapsOrdinalsInStem(q.fillGapsStem).length > 0;
    case "open":
      // Open questions carry no options/items — the stem alone is renderable.
      return true;
    case "mcq":
    default:
      return (q.options?.length ?? 0) > 0;
  }
}

// #833 — rebuild a Question from a live `questions` row (unified #582
// payload jsonb). Used to self-heal stale snapshots by re-fetching current
// data; competency ids are preserved from the frozen snapshot. The key is not
// re-fetched with it (#1011) — the rebuilt question is answerable, and becomes
// reviewable when the verdict comes back.
function mapLiveQuestionToQuestion(q: any, competencyIds: string[]): Question {
  const stem = fillGapsStemFromPayload(q.payload);
  return {
    id: q.id,
    type: (q.type ?? "mcq") as QuestionType,
    question: q.question,
    options: mcqOptionsFromPayload(q.payload),
    multiCorrect: mcqIsMultiCorrectFromPayload(q.payload),
    categories: classificationCategoriesFromPayload(q.payload),
    items: classificationItemsFromPayload(q.payload),
    orderingItems: orderingItemsFromPayload(q.payload),
    fillGapsStem: stem,
    fillGapsGaps: fillGapsSkeletonFromStem(stem),
    difficulty: q.difficulty as "easy" | "medium" | "hard",
    isUserGenerated: q.is_user_generated || false,
    competencyIds,
    diagram: questionDiagramFromPayload(q.payload),
    // Key material — not fetched, filled in from the verdict on submit.
    correctIndices: [],
    classificationAssignments: undefined,
    explanation: "",
  };
}

interface DbQuestion {
  id: string;
  type: QuestionType;
  question: string;
  // Unified shape (#582): the student-facing half only. `answer_key` and
  // `explanation` are no longer selected on this surface (#1011) — they come
  // back from `submit-quiz-answers` once there is an answer on record.
  payload: Json;
  difficulty: string;
  is_user_generated?: boolean;
  competency_id?: string | null;
}

interface PracticeFilters {
  chapterId?: string;
  competencyId?: string;
  source?: 'all' | 'curated' | 'peer';
}

interface StudentQuizProps {
  courseId: string;
  courseTitle: string;
  quizId?: string;
  quizTitle?: string;
  timeLimitMinutes?: number | null;
  showAnswersEnabled?: boolean;
  showDifficulty?: boolean;
  practiceFilters?: PracticeFilters;
  studentQuestionsEnabled?: boolean;
  offeringId?: string | null;
  // ISO timestamp of the instructor's "Mark as done" action on this assignment.
  // When set we refuse to create a fresh session and route the student to the
  // closed-assignment screen. RLS rejects new INSERTs even if this gate is bypassed.
  assignmentClosedAt?: string | null;
  onBack: () => void;
  onComplete: () => void;
  onNavigateToGenerator?: () => void;
}

// #827 — shape of the deferred-mode draft blob stored in
// `quiz_sessions.draft_answers`. `mcq` holds selected option indices per
// question; `nonMcq` holds the per-type answer objects. Selections only — this
// side of the app holds no correctness at all: the server grades what is sent
// to it at final submit (#1094).
interface DraftAnswersPayload {
  v: 1;
  mcq: Record<string, number[]>;
  nonMcq: Record<string, NonMcqAnswer>;
}

// Decode `quiz_sessions.draft_answers` back into the in-memory pending maps.
// Defensive against malformed / stale payloads: entries for unknown questions,
// wrong-typed values, or a non-MCQ `kind` that no longer matches the question
// type are skipped (the question simply resumes as unanswered).
function parseDraftAnswers(
  raw: Json | null | undefined,
  questions: Question[],
): { mcq: Record<string, number[]>; nonMcq: Record<string, NonMcqAnswer> } {
  const mcq: Record<string, number[]> = {};
  const nonMcq: Record<string, NonMcqAnswer> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { mcq, nonMcq };
  const byId = new Map(questions.map((q) => [q.id, q]));
  const obj = raw as Record<string, unknown>;

  const rawMcq = obj.mcq;
  if (rawMcq && typeof rawMcq === "object" && !Array.isArray(rawMcq)) {
    for (const [qid, val] of Object.entries(rawMcq as Record<string, unknown>)) {
      const q = byId.get(qid);
      if (q && !isNonMcqType(q.type) && Array.isArray(val)) {
        const nums = val.filter((v): v is number => typeof v === "number");
        if (nums.length > 0) mcq[qid] = nums;
      }
    }
  }

  const rawNonMcq = obj.nonMcq;
  if (rawNonMcq && typeof rawNonMcq === "object" && !Array.isArray(rawNonMcq)) {
    for (const [qid, val] of Object.entries(rawNonMcq as Record<string, unknown>)) {
      const q = byId.get(qid);
      if (
        q &&
        isNonMcqType(q.type) &&
        val &&
        typeof val === "object" &&
        (val as { kind?: string }).kind === q.type
      ) {
        const answer = val as NonMcqAnswer;
        // `touched` (#1043) must survive the round-trip as a real boolean: a
        // draft written before it existed has none, and must resume behind the
        // gate rather than as a silently-answered shuffle.
        nonMcq[qid] =
          answer.kind === "ordering"
            ? { ...answer, touched: answer.touched === true }
            : answer;
      }
    }
  }
  return { mcq, nonMcq };
}

// Whether a question already carries a stored deferred draft in the given
// pending maps. Used to pick the resume cursor (the first question without one).
function questionHasDraft(
  q: Question,
  mcq: Record<string, number[]>,
  nonMcq: Record<string, NonMcqAnswer>,
): boolean {
  return isNonMcqType(q.type)
    ? isNonMcqComplete(q, nonMcq[q.id])
    : mcq[q.id] !== undefined;
}

// Debounce for the deferred-mode draft autosave. Long enough that typing in a
// fill-gaps input doesn't fire a write per keystroke, short enough that a quick
// leave still captures the last selection.
const DRAFT_AUTOSAVE_DEBOUNCE_MS = 600;

const StudentQuiz = ({ courseId, courseTitle, quizId, quizTitle, timeLimitMinutes, showAnswersEnabled = true, showDifficulty = true, practiceFilters, studentQuestionsEnabled, offeringId, assignmentClosedAt = null, onBack, onComplete, onNavigateToGenerator }: StudentQuizProps) => {
  const { t } = useTranslation("quiz");
  const { user } = useAuth();
  const [questions, setQuestions] = useState<Question[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  // Multi-correct (#592): the student's selected option indices. Empty array
  // = no selection yet. Replaces the legacy single `selectedAnswer: number`.
  const [selectedAnswers, setSelectedAnswers] = useState<number[]>([]);
  const [showResult, setShowResult] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [sessionStats, setSessionStats] = useState({ correct: 0, wrong: 0 });
  // Per-gap verdicts the server returned for fill-gaps answers, by question id.
  // The server's fill-gaps grading is exact-match plus an LLM equivalence pass
  // (#784), so re-deriving the marks here would contradict it — a gap shown red
  // under an answer that was recorded correct.
  const [serverPerGap, setServerPerGap] = useState<Record<string, boolean[]>>({});
  const [quizComplete, setQuizComplete] = useState(false);
  const [includeAnswered, setIncludeAnswered] = useState(false);
  const [showSetup, setShowSetup] = useState(false); // Never show setup screen
  const [timeRemaining, setTimeRemaining] = useState<number | null>(null);
  const [timerStarted, setTimerStarted] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [quizAbandoned, setQuizAbandoned] = useState(false);
  const [showExitDialog, setShowExitDialog] = useState(false);
  const [userVotes, setUserVotes] = useState<Record<string, 'up' | 'down'>>({});
  const [votingQuestionId, setVotingQuestionId] = useState<string | null>(null);
  const [skippedQuestionIds, setSkippedQuestionIds] = useState<Set<string>>(new Set());
  const [answeredInSession, setAnsweredInSession] = useState<Set<string>>(new Set());
  const [previousAnswers, setPreviousAnswers] = useState<Map<string, { isCorrect: boolean }>>(new Map()); // Most recent prior answer per question (before this session)
  // Deferred submission mode: per-question selected option indices.
  const [pendingAnswers, setPendingAnswers] = useState<Record<string, number[]>>({});
  // Non-MCQ answers (#820 classification, #829 ordering/fill_gaps/open). The
  // current question's live draft plus the deferred-mode per-question map,
  // mirroring selectedAnswers / pendingAnswers for the MCQ path. `null` when
  // the current question is MCQ.
  const [nonMcqDraft, setNonMcqDraft] = useState<NonMcqAnswer | null>(null);
  const [pendingNonMcq, setPendingNonMcq] = useState<Record<string, NonMcqAnswer>>({});
  const [showSubmitConfirm, setShowSubmitConfirm] = useState(false);
  // Pre-start confirmation for timed quizzes (only for fresh attempts, not resumes).
  const [awaitingTimedStart, setAwaitingTimedStart] = useState(false);
  const [startingTimedQuiz, setStartingTimedQuiz] = useState(false);
  // Grace period triggered when the countdown hits zero mid-quiz: student gets a
  // short window (GRACE_PERIOD_SECONDS) before we auto-submit whatever they have.
  const [graceRemaining, setGraceRemaining] = useState<number | null>(null);
  const [autoSubmitting, setAutoSubmitting] = useState(false);
  const [timeExpiredLocked, setTimeExpiredLocked] = useState(false);
  const [closedNoAttempt, setClosedNoAttempt] = useState(false);

  const handleExitQuiz = async () => {
    // For timed quizzes, mark session as abandoned
    if (quizId && sessionId && timeLimitMinutes) {
      await supabase
        .from("quiz_sessions")
        .update({ status: 'abandoned' })
        .eq("id", sessionId);
    }
    onBack();
  };

  const handleVote = async (questionId: string, voteType: 'up' | 'down') => {
    if (!user) return;
    
    setVotingQuestionId(questionId);
    const currentVote = userVotes[questionId];
    
    try {
      if (currentVote === voteType) {
        // Remove vote
        await supabase
          .from("question_votes")
          .delete()
          .eq("user_id", user.id)
          .eq("question_id", questionId);
        
        setUserVotes(prev => {
          const { [questionId]: _, ...rest } = prev;
          return rest;
        });
      } else {
        // Upsert vote
        await supabase
          .from("question_votes")
          .upsert({
            user_id: user.id,
            question_id: questionId,
            vote_type: voteType,
          }, { onConflict: 'user_id,question_id' });
        
        setUserVotes(prev => ({ ...prev, [questionId]: voteType }));
      }
      
      toast.success(
        currentVote === voteType ? t("toast.voteRemoved") : t("toast.voteThanks"),
      );
    } catch (error) {
      console.error("Error voting:", error);
      toast.error(t("toast.voteFailed"));
    } finally {
      setVotingQuestionId(null);
    }
  };

  // Helper function to load questions from snapshots
  const loadQuestionsFromSnapshots = async (sessionId: string): Promise<Question[] | null> => {
    const { data: snapshots, error } = await supabase
      .from("quiz_session_questions")
      .select("*")
      .eq("session_id", sessionId)
      .order("order_num", { ascending: true });

    if (error || !snapshots || snapshots.length === 0) {
      return null; // No snapshots found - fall back to live questions
    }

    const mapped: Question[] = snapshots.map((sq: any) => {
      const snapshot = sq.question_snapshot as {
        id: string;
        // Unified type (#820). Snapshots written before #820 have no `type`;
        // default to "mcq" so legacy in-flight sessions keep grading.
        type?: QuestionType;
        question: string;
        options: string[];
        // Whether more than one option is correct (#592). Snapshots written
        // before #1011 carry the key itself instead — `correct_answers`, or
        // just `correct_answer` on a pre-#592 build. Both are still read, but
        // only for this one bit: a session in flight across the deploy keeps
        // its "Select all that apply." hint, and nothing else about the key is
        // taken from a snapshot any more.
        multi_correct?: boolean;
        correct_answers?: number[];
        correct_answer?: number;
        // Classification (#820) — frozen buckets/cards.
        categories?: ClassificationCategory[];
        items?: ClassificationItem[];
        // Ordering / fill_gaps (#829) — canonical order (#1117 — still the
        // question's own presentation data) + the cloze stem.
        ordering_items?: string[];
        fill_gaps_stem?: string;
        difficulty: string;
        is_user_generated: boolean;
        competency_ids: string[];
        // #627 — snapshot the diagram so a resumed quiz renders the same
        // figure even if the live question's `payload.diagram` was edited.
        diagram?: { source: string; alt?: string } | null;
      };
      const multiCorrect = snapshot.multi_correct === true ||
        (Array.isArray(snapshot.correct_answers) && snapshot.correct_answers.length > 1);
      const stem = snapshot.fill_gaps_stem ?? "";
      return {
        id: snapshot.id,
        type: snapshot.type ?? "mcq",
        question: snapshot.question,
        options: snapshot.options,
        multiCorrect,
        categories: snapshot.categories,
        items: snapshot.items,
        orderingItems: snapshot.ordering_items,
        fillGapsStem: snapshot.fill_gaps_stem,
        fillGapsGaps: fillGapsSkeletonFromStem(stem),
        difficulty: snapshot.difficulty as "easy" | "medium" | "hard",
        isUserGenerated: snapshot.is_user_generated || false,
        competencyIds: snapshot.competency_ids || [],
        diagram: snapshot.diagram ?? null,
        // Key material — never read from a snapshot now, even where an older
        // one still holds it. It arrives with the verdict.
        correctIndices: [],
        classificationAssignments: undefined,
        explanation: "",
      };
    });

    // #833 — self-heal legacy/typeless snapshots. A snapshot frozen before
    // non-MCQ support (#820/#829) has no `type`, so it resolves to "mcq" with
    // empty options and renders as an unanswerable blank card. Re-fetch the
    // live question by id for any unrenderable snapshot and rebuild from
    // current data (competency ids stay frozen from the snapshot).
    const staleQuestionIds = mapped
      .map((q, i) => ({ q, questionId: snapshots[i].question_id as string | null }))
      .filter(({ q, questionId }) => questionId && !isRenderableQuestion(q))
      .map(({ questionId }) => questionId as string);

    if (staleQuestionIds.length > 0) {
      const { data: liveQuestions, error: liveError } = await supabase
        .from("questions")
        .select("id, type, question, payload, difficulty, is_user_generated")
        .in("id", staleQuestionIds);

      if (liveError) {
        console.error("[#833] Failed to re-fetch live questions for stale snapshots:", liveError);
      }

      const liveById = new Map((liveQuestions || []).map((lq: any) => [lq.id, lq]));

      return mapped.map((q, i) => {
        if (isRenderableQuestion(q)) return q;
        const questionId = snapshots[i].question_id as string | null;
        const live = questionId ? liveById.get(questionId) : undefined;
        if (!live) return q; // Live question gone — leave as-is (render fallback).
        const rebuilt = mapLiveQuestionToQuestion(live, q.competencyIds);
        return isRenderableQuestion(rebuilt) ? rebuilt : q;
      });
    }

    return mapped;
  };

  // Helper function to save question snapshots
  const saveQuestionSnapshots = async (
    sessionId: string,
    questions: Array<{
      id: string;
      type: QuestionType;
      question: string;
      options: string[];
      // Whether more than one option is correct (#592) — the hint, not the
      // key (#1011).
      multi_correct: boolean;
      // Classification (#820) — frozen buckets/cards.
      categories?: ClassificationCategory[];
      items?: ClassificationItem[];
      // Ordering / fill_gaps (#829) — canonical order (#1117) + cloze stem.
      ordering_items?: string[];
      fill_gaps_stem?: string;
      difficulty: string;
      is_user_generated: boolean;
      diagram?: { source: string; alt?: string } | null;
    }>,
    competencyMap: Map<string, string[]>
  ) => {
    // The snapshot freezes what the student is being ASKED, so a question the
    // instructor edits mid-attempt does not change under them. It used to
    // freeze the answer alongside it — `correct_answers`, the classification
    // assignments, the canonical order and every acceptable gap filler — into
    // a row the student owns and can read, which handed the whole quiz's key
    // over at quiz start no matter what the page requested (#1185).
    //
    // Nothing needed it there. The verdict is decided by `submit-quiz-answers`
    // from the LIVE `questions.answer_key` and would reject a snapshot that
    // disagreed (`stale_answer_key`), so the copy was never authoritative; and
    // the review that follows a submit is painted from what that call returns.
    const snapshots = questions.map((q, index) => ({
      session_id: sessionId,
      question_id: q.id,
      order_num: index + 1,
      question_snapshot: {
        id: q.id,
        type: q.type,
        question: q.question,
        options: q.options,
        multi_correct: q.multi_correct,
        categories: q.categories,
        items: q.items,
        ordering_items: q.ordering_items,
        fill_gaps_stem: q.fill_gaps_stem,
        diagram: q.diagram ?? null,
        difficulty: q.difficulty,
        is_user_generated: q.is_user_generated,
        competency_ids: competencyMap.get(q.id) || [],
        // JSON-serialisable at runtime, but the compiler cannot prove it: the
        // interfaces behind `categories` / `items` / `ordering_items` have no
        // index signature, so they are not structurally `Json`. Asserted once
        // here, at the write boundary, rather than reshaping the domain types
        // to satisfy a storage format.
      } as unknown as Json,
    }));

    const { error } = await supabase
      .from("quiz_session_questions")
      .insert(snapshots);

    if (error) {
      console.error("Error saving question snapshots:", error);
      throw error;
    }
  };

  const fetchQuizQuestions = async () => {
    if (!user || !quizId) return;

    setLoading(true);
    try {
      let currentSessionId: string | null = null;
      let isResuming = false;

      const statusRank = (s: string) =>
        s === "completed" ? 4 : s === "expired" ? 3 : s === "in_progress" ? 2 : 1;

      // For timed quizzes, check if there's an existing session
      if (timeLimitMinutes && timeLimitMinutes > 0) {
        let timedSessionQuery = supabase
          .from("quiz_sessions")
          .select("*")
          .eq("user_id", user.id)
          .eq("quiz_id", quizId)
          .eq("course_id", courseId);
        if (offeringId) timedSessionQuery = timedSessionQuery.eq("offering_id", offeringId);
        const { data: timedSessions } = await timedSessionQuery;
        const existingSession = (timedSessions || []).reduce<typeof timedSessions[0] | null>(
          (best, s) => !best || statusRank(s.status) > statusRank(best.status) ? s : best,
          null,
        );

        if (existingSession) {
          // Session exists - check status
          if (existingSession.status === 'completed') {
            setQuizComplete(true);
            setLoading(false);
            return;
          }

          // Calculate if time has expired
          const startedAt = new Date(existingSession.started_at).getTime();
          const timeLimitMs = timeLimitMinutes * 60 * 1000;
          const now = Date.now();
          const elapsed = now - startedAt;

          if (existingSession.status === 'abandoned') {
            // Abandoned quizzes cannot be resumed - show completion screen
            setQuizComplete(true);
            setLoading(false);
            return;
          }

          if (elapsed >= timeLimitMs) {
            // Time expired - but allow user to still view and submit their answers
            // Set timer to 0 to indicate expired, but don't auto-complete
            setTimeRemaining(0);
            setSessionId(existingSession.id);
            currentSessionId = existingSession.id;
            isResuming = true;
            // Continue to load questions so user can review and submit
          } else {
            // Resume with remaining time
            const remainingSeconds = Math.floor((timeLimitMs - elapsed) / 1000);
            setTimeRemaining(remainingSeconds);
            setSessionId(existingSession.id);
            currentSessionId = existingSession.id;
            isResuming = true;
          }
        } else {
          // No prior attempt — but if the instructor has closed this
          // assignment, refuse to start one. Show the closed screen instead.
          if (assignmentClosedAt) {
            setClosedNoAttempt(true);
            setLoading(false);
            return;
          }
          // Fresh attempt — hold off on creating the session until the student
          // acknowledges the pre-start warning. The insert happens in
          // handleConfirmStartTimedQuiz once they click "I'm ready".
          setAwaitingTimedStart(true);
          setLoading(false);
          return;
        }
      } else {
        // Non-timed quiz - pick the highest-priority session by status to match
        // StudentCourse.tsx: completed > expired > in_progress > abandoned.
        // Ordering by recency alone would return an abandoned session started
        // after a completed one, incorrectly allowing a retake.
        let nonTimedSessionQuery = supabase
          .from("quiz_sessions")
          .select("*")
          .eq("user_id", user.id)
          .eq("quiz_id", quizId)
          .eq("course_id", courseId);
        if (offeringId) nonTimedSessionQuery = nonTimedSessionQuery.eq("offering_id", offeringId);
        const { data: existingSessions } = await nonTimedSessionQuery;

        const existingSession = (existingSessions || []).reduce<(typeof existingSessions)[0] | null>(
          (best, session) =>
            !best || statusRank(session.status) > statusRank(best.status) ? session : best,
          null
        );

        if (existingSession?.status === 'completed' || existingSession?.status === 'expired') {
          setQuizComplete(true);
          setLoading(false);
          return;
        }

        if (existingSession?.status === 'in_progress') {
          setSessionId(existingSession.id);
          currentSessionId = existingSession.id;
          isResuming = true;
        } else {
          // No session, or only an abandoned one. Block fresh attempts when
          // the assignment is closed.
          if (assignmentClosedAt) {
            setClosedNoAttempt(true);
            setLoading(false);
            return;
          }
          const { data: newSession, error: sessionError } = await supabase
            .from("quiz_sessions")
            .insert({
              user_id: user.id,
              quiz_id: quizId,
              course_id: courseId,
              offering_id: offeringId ?? null,
              status: 'in_progress',
            })
            .select()
            .single();

          if (sessionError) throw sessionError;
          setSessionId(newSession.id);
          currentSessionId = newSession.id;
        }
      }

      // If resuming, try to load from snapshots first
      if (isResuming && currentSessionId) {
        const snapshotQuestions = await loadQuestionsFromSnapshots(currentSessionId);
        if (snapshotQuestions && snapshotQuestions.length > 0) {
          setQuestions(snapshotQuestions);

          // For deferred mode (showAnswersEnabled = false), unsubmitted
          // selections are auto-saved to `quiz_sessions.draft_answers` (#827),
          // NOT to `quiz_answers` (which stays empty until final submit). Hydrate
          // the pending maps from that column so Resume restores every prior
          // selection — MCQ and the non-MCQ types alike.
          if (!showAnswersEnabled) {
            const { data: sessionRow } = await supabase
              .from("quiz_sessions")
              .select("draft_answers")
              .eq("id", currentSessionId)
              .maybeSingle();
            const { mcq: loadedAnswers, nonMcq: loadedNonMcq } = parseDraftAnswers(
              sessionRow?.draft_answers,
              snapshotQuestions,
            );
            setPendingAnswers(loadedAnswers);
            setPendingNonMcq(loadedNonMcq);

            // Land on the first unanswered question (mirroring immediate-mode
            // resume below); fall back to the start when everything is drafted
            // so the student can review before submitting. Re-answering stays
            // allowed in deferred mode.
            let resumeIndex = snapshotQuestions.findIndex(
              (q) => !questionHasDraft(q, loadedAnswers, loadedNonMcq),
            );
            if (resumeIndex < 0) resumeIndex = 0;
            setCurrentIndex(resumeIndex);
            const resumeQuestion = snapshotQuestions[resumeIndex];
            if (
              resumeQuestion &&
              !isNonMcqType(resumeQuestion.type) &&
              loadedAnswers[resumeQuestion.id] !== undefined
            ) {
              setSelectedAnswers(loadedAnswers[resumeQuestion.id]);
            }
            // Seed the resumed question's live draft from its stored answer (or a
            // fresh empty draft) so non-MCQ surfaces render on resume.
            setNonMcqDraft(draftFor(resumeQuestion, loadedNonMcq));
            setLoading(false);
            return;
          }

          // Restore currentIndex based on unique questions answered in this session
          // (immediate mode only — deferred mode answers `quiz_answers` at final
          // submit, so this query would be wasted before the early return above).
          const { data: sessionAnswers } = await supabase
            .from("quiz_answers")
            .select("question_id")
            .eq("session_id", currentSessionId);

          // Count unique question IDs (in case same question was answered multiple times)
          const uniqueAnsweredIds = new Set(sessionAnswers?.map(a => a.question_id) || []);
          const answeredCount = uniqueAnsweredIds.size;

          // Restore answeredInSession state to prevent duplicate submissions (immediate mode)
          setAnsweredInSession(uniqueAnsweredIds);

          // Find the index of the first unanswered question
          let resumeIndex = 0;
          for (let i = 0; i < snapshotQuestions.length; i++) {
            if (!uniqueAnsweredIds.has(snapshotQuestions[i].id)) {
              resumeIndex = i;
              break;
            }
            // If we've checked all questions and all are answered
            if (i === snapshotQuestions.length - 1) {
              resumeIndex = snapshotQuestions.length; // Will trigger completion
            }
          }

          if (resumeIndex > 0 && resumeIndex < snapshotQuestions.length) {
            setCurrentIndex(resumeIndex);
            // Seed the live draft for the (non-MCQ) question we resume on so
            // ordering shows a shuffled list / fill_gaps shows its blanks.
            setNonMcqDraft(draftFor(snapshotQuestions[resumeIndex], {}));
          } else if (resumeIndex >= snapshotQuestions.length || answeredCount >= snapshotQuestions.length) {
            // All questions answered - show completion
            setQuizComplete(true);
          } else {
            setNonMcqDraft(draftFor(snapshotQuestions[0], {}));
          }

          setLoading(false);
          return;
        }
        // If no snapshots found, fall through to load live questions (backward compatibility)
      }

      // Fetch questions from the pre-defined quiz. Reads the STUDENT-FACING
      // half of the unified columns (#582): `payload` only. `answer_key` and
      // `explanation` are deliberately not requested — they used to arrive
      // here, with the whole quiz, before a single question was answered
      // (#1011).
      const { data: quizQuestions, error } = await supabase
        .from("quiz_questions")
        .select(`
          order_num,
          questions:question_id (
            id,
            type,
            question,
            payload,
            difficulty,
            is_user_generated,
            validation_status
          )
        `)
        .eq("quiz_id", quizId)
        .order("order_num", { ascending: true });
      
      // Filter out invalid questions from predefined quizzes
      const filteredQuizQuestions = quizQuestions?.filter(
        (qq: any) => qq.questions?.validation_status !== "INCORRECT"
      ) || [];

      if (error) throw error;

      // Fetch competencies for all questions from junction table
      const questionIds = filteredQuizQuestions
        .filter((qq: any) => qq.questions)
        .map((qq: any) => qq.questions.id);

      const { data: questionCompetencies } = await supabase
        .from("question_competencies")
        .select("question_id, competency_id")
        .in("question_id", questionIds);

      // Build a map of question_id -> competency_ids[]
      const competencyMap = new Map<string, string[]>();
      (questionCompetencies || []).forEach((qc: any) => {
        if (!competencyMap.has(qc.question_id)) {
          competencyMap.set(qc.question_id, []);
        }
        competencyMap.get(qc.question_id)!.push(qc.competency_id);
      });

      // Save snapshots for new sessions. Snapshots are a frozen runtime
      // shape (separate from the live table columns) and dual-write a
      // `correct_answer` alongside `correct_answers` so older builds reading
      // an in-flight snapshot keep grading single-correct items.
      if (currentSessionId && !isResuming && filteredQuizQuestions.length > 0) {
        const questionsToSnapshot = filteredQuizQuestions
          .filter((qq: any) => qq.questions)
          .map((qq: any) => ({
            id: qq.questions.id,
            type: (qq.questions.type ?? "mcq") as QuestionType,
            question: qq.questions.question,
            options: mcqOptionsFromPayload(qq.questions.payload),
            multi_correct: mcqIsMultiCorrectFromPayload(qq.questions.payload),
            categories: classificationCategoriesFromPayload(qq.questions.payload),
            items: classificationItemsFromPayload(qq.questions.payload),
            ordering_items: orderingItemsFromPayload(qq.questions.payload),
            fill_gaps_stem: fillGapsStemFromPayload(qq.questions.payload),
            difficulty: qq.questions.difficulty,
            is_user_generated: qq.questions.is_user_generated || false,
            diagram: questionDiagramFromPayload(qq.questions.payload),
          }));

        await saveQuestionSnapshots(currentSessionId, questionsToSnapshot, competencyMap);
      }

      const mappedQuestions: Question[] = filteredQuizQuestions
        .filter((qq: any) => qq.questions)
        .map((qq: any) => ({
          id: qq.questions.id,
          type: (qq.questions.type ?? "mcq") as QuestionType,
          question: qq.questions.question,
          options: mcqOptionsFromPayload(qq.questions.payload),
          multiCorrect: mcqIsMultiCorrectFromPayload(qq.questions.payload),
          categories: classificationCategoriesFromPayload(qq.questions.payload),
          items: classificationItemsFromPayload(qq.questions.payload),
          orderingItems: orderingItemsFromPayload(qq.questions.payload),
          fillGapsStem: fillGapsStemFromPayload(qq.questions.payload),
          fillGapsGaps: fillGapsSkeletonFromStem(fillGapsStemFromPayload(qq.questions.payload)),
          difficulty: qq.questions.difficulty as "easy" | "medium" | "hard",
          isUserGenerated: qq.questions.is_user_generated || false,
          competencyIds: competencyMap.get(qq.questions.id) || [],
          diagram: questionDiagramFromPayload(qq.questions.payload),
          correctIndices: [],
          classificationAssignments: undefined,
          explanation: "",
        }));

      setQuestions(mappedQuestions);
      // Seed the live draft for the first question when it's a non-MCQ type
      // (fresh attempt starts at index 0).
      setNonMcqDraft(draftFor(mappedQuestions[0], {}));
    } catch (error: any) {
      console.error("Error fetching quiz questions:", error);
      toast.error(t("toast.loadQuizFailed"));
    } finally {
      setLoading(false);
    }
  };

  // Called when the student confirms the pre-start warning for a timed quiz.
  // Creates the quiz_sessions row (which fixes `started_at`) and then re-runs
  // fetchQuizQuestions so the normal resume branch picks up the new session.
  const handleConfirmStartTimedQuiz = async () => {
    if (!user || !quizId || !timeLimitMinutes || timeLimitMinutes <= 0) return;
    if (assignmentClosedAt) {
      setAwaitingTimedStart(false);
      setClosedNoAttempt(true);
      return;
    }
    setStartingTimedQuiz(true);
    try {
      const { error: sessionError } = await supabase
        .from("quiz_sessions")
        .insert({
          user_id: user.id,
          quiz_id: quizId,
          course_id: courseId,
          offering_id: offeringId ?? null,
          status: 'in_progress',
        });

      if (sessionError) throw sessionError;

      setAwaitingTimedStart(false);
      await fetchQuizQuestions();
    } catch (error: any) {
      console.error("Error starting timed quiz:", error);
      toast.error(t("toast.startFailed"));
    } finally {
      setStartingTimedQuiz(false);
    }
  };

  const fetchRandomQuestions = async () => {
    if (!user) return;

    setLoading(true);
    try {
      // Build base query. Reads the STUDENT-FACING half of the unified columns
      // (#582): `payload` only. Restrict to MCQ rows so the open-question rows
      // (absorbed in #577) don't leak into practice mode.
      //
      // This is a whole-course list, so requesting `answer_key` here handed
      // over every answer in the course the moment practice opened — the
      // widest of the three surfaces #1011 covers, and the one where the page
      // needs the least.
      let query = supabase
        .from("questions")
        .select("id, question, payload, difficulty, is_user_generated, validation_status, upvotes, downvotes")
        .eq("course_id", courseId)
        .eq("type", "mcq")
        .eq("hidden", false)
        .neq("validation_status", "INCORRECT");

      // Apply source filter
      if (practiceFilters?.source === 'curated') {
        query = query.eq("is_user_generated", false);
      } else if (practiceFilters?.source === 'peer') {
        query = query.eq("is_user_generated", true);
      }

      // Restrict to questions assigned to the student's section (offering).
      // Without this, students see questions assigned to other sections.
      if (offeringId) {
        const { data: oqData } = await supabase
          .from("offering_questions")
          .select("question_id")
          .eq("offering_id", offeringId)
          .not("published_at", "is", null)
          .limit(10000);

        const offeringQuestionIds = (oqData || []).map(oq => oq.question_id);
        if (offeringQuestionIds.length === 0) {
          setQuestions([]);
          setLoading(false);
          return;
        }
        query = query.in("id", offeringQuestionIds);
      }

      // If competency filter is set, we need to filter by question IDs
      let competencyQuestionIds: string[] | null = null;
      if (practiceFilters?.competencyId) {
        const { data: qcData } = await supabase
          .from("question_competencies")
          .select("question_id")
          .eq("competency_id", practiceFilters.competencyId);
        
        competencyQuestionIds = (qcData || []).map(qc => qc.question_id);
        if (competencyQuestionIds.length === 0) {
          setQuestions([]);
          setLoading(false);
          return;
        }
        query = query.in("id", competencyQuestionIds);
      }

      // If chapter filter is set, get competencies for that chapter first
      if (practiceFilters?.chapterId && !practiceFilters?.competencyId) {
        // Get competencies linked to this chapter
        const { data: chapterCompData } = await supabase
          .from("competency_chapters")
          .select("competency_id")
          .eq("chapter_id", practiceFilters.chapterId);
        
        const chapterCompetencyIds = (chapterCompData || []).map(cc => cc.competency_id);
        
        if (chapterCompetencyIds.length > 0) {
          // Get questions for these competencies
          const { data: qcData } = await supabase
            .from("question_competencies")
            .select("question_id")
            .in("competency_id", chapterCompetencyIds);
          
          const chapterQuestionIds = (qcData || []).map(qc => qc.question_id);
          if (chapterQuestionIds.length > 0) {
            query = query.in("id", chapterQuestionIds);
          }
        }
      }

      const { data, error } = await query;

      if (error) throw error;

      // Intentionally includes answers from formal quizzes so the new/seen signal is
      // accurate across all contexts — a question the student answered in a graded quiz
      // counts as "seen" in practice mode.
      // `answered_at`, not `created_at`: `quiz_answers` has no such column, so
      // this select was rejected by PostgREST and `answeredData` came back null
      // every time — the "Previously answered" hints never appeared in practice
      // mode. Nothing caught it because the type check was not running.
      const { data: answeredData } = await supabase
        .from("quiz_answers")
        .select("question_id, is_correct, answered_at")
        .eq("user_id", user.id)
        .eq("course_id", courseId)
        .order("answered_at", { ascending: false });

      const priorAnswers = new Map<string, { isCorrect: boolean }>();
      (answeredData || []).forEach(a => {
        if (!priorAnswers.has(a.question_id)) {
          priorAnswers.set(a.question_id, { isCorrect: !!a.is_correct });
        }
      });
      setPreviousAnswers(priorAnswers);

      // Separate questions into unanswered and previously answered
      const allQuestions = data || [];
      const unansweredQuestions = allQuestions.filter(q => !priorAnswers.has(q.id));
      const previouslyAnsweredQuestions = allQuestions.filter(q => priorAnswers.has(q.id));

      // Shuffle each group independently
      const shuffledUnanswered = [...unansweredQuestions].sort(() => Math.random() - 0.5);
      const shuffledAnswered = [...previouslyAnsweredQuestions].sort(() => Math.random() - 0.5);

      // Combine: new questions first, seen questions last
      const orderedData = [...shuffledUnanswered, ...shuffledAnswered];

      // Fetch competencies for all questions from junction table
      const questionIds = orderedData.map((q: any) => q.id);
      const { data: questionCompetencies } = await supabase
        .from("question_competencies")
        .select("question_id, competency_id")
        .in("question_id", questionIds.length > 0 ? questionIds : ['']);

      // Build a map of question_id -> competency_ids[]
      const competencyMap = new Map<string, string[]>();
      (questionCompetencies || []).forEach((qc: any) => {
        if (!competencyMap.has(qc.question_id)) {
          competencyMap.set(qc.question_id, []);
        }
        competencyMap.get(qc.question_id)!.push(qc.competency_id);
      });

      const typedData = orderedData as unknown as DbQuestion[];
      const mappedQuestions: Question[] = typedData.map(q => ({
        id: q.id,
        // Practice mode is restricted to MCQ rows by the query above.
        type: "mcq",
        question: q.question,
        options: mcqOptionsFromPayload(q.payload),
        multiCorrect: mcqIsMultiCorrectFromPayload(q.payload),
        difficulty: q.difficulty as "easy" | "medium" | "hard",
        isUserGenerated: q.is_user_generated || false,
        competencyIds: competencyMap.get(q.id) || [],
        diagram: questionDiagramFromPayload(q.payload),
        correctIndices: [],
        explanation: "",
      }));

      setQuestions(mappedQuestions);
    } catch (error: any) {
      console.error("Error fetching questions:", error);
      toast.error(t("toast.loadQuestionsFailed"));
    } finally {
      setLoading(false);
    }
  };

  // Auto-start for pre-defined quizzes
  useEffect(() => {
    if (quizId && user) {
      fetchQuizQuestions();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch quiz questions on mount
  }, [quizId, user]);

  // Auto-start for practice mode (no quizId)
  useEffect(() => {
    if (!quizId && user) {
      setSessionId(crypto.randomUUID());
      fetchRandomQuestions();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch random questions on mount
  }, [user, quizId]);

  // Handle time expiration — show a blocking warning and start a short grace
  // period. autoSubmitOnTimeUp will fire when graceRemaining hits zero (or when
  // the student clicks "Submit now" inside the grace dialog).
  const handleTimeUp = () => {
    if (!quizId || !sessionId) return;
    setGraceRemaining((prev) => (prev === null ? GRACE_PERIOD_SECONDS : prev));
  };

  // Force-finalise the attempt when the grace period expires. Unlike the manual
  // submit path this does not require every question to be answered — it saves
  // whatever the student has and closes the session.
  const autoSubmitOnTimeUp = async () => {
    if (!user || !quizId || !sessionId) return;
    if (autoSubmitting || quizComplete) return;
    setAutoSubmitting(true);
    setTimeExpiredLocked(true);
    try {
      const { data: liveSession } = await supabase
        .from("quiz_sessions")
        .select("status")
        .eq("id", sessionId)
        .maybeSingle();
      if (liveSession?.status === 'completed' || liveSession?.status === 'expired') {
        setQuizComplete(true);
        return;
      }

      let finalized = false;

      if (isDeferredMode) {
        // Deferred mode: no answers have been persisted yet — flush what we have.
        const finalAnswers: Record<string, number[]> = { ...pendingAnswers };
        const finalNonMcq: Record<string, NonMcqAnswer> = { ...pendingNonMcq };
        const currentQuestion = questions[currentIndex];
        if (currentQuestion && isNonMcqType(currentQuestion.type)) {
          if (nonMcqDraft) finalNonMcq[currentQuestion.id] = nonMcqDraft;
        } else if (selectedAnswers.length > 0 && currentQuestion) {
          finalAnswers[currentQuestion.id] = selectedAnswers;
        }

        // Persist whatever partial answers exist. Unanswered questions are
        // simply omitted (auto-submit does not require completeness).
        const answersToSubmit = questions
          .filter((q) =>
            isNonMcqType(q.type)
              ? finalNonMcq[q.id] !== undefined
              : finalAnswers[q.id] !== undefined,
          )
          .map((q) => ({
            questionId: q.id,
            submission: isNonMcqType(q.type)
              ? nonMcqSubmission(finalNonMcq[q.id])
              : { selected_indices: finalAnswers[q.id] },
          }));

        if (answersToSubmit.length > 0) {
          // One call: the answers are graded, stored and the session closed in
          // a single transaction, so time-up can't leave a finished attempt
          // looking unfinished (#1094).
          const result = await submitQuizAnswers({
            courseId,
            quizId,
            offeringId: offeringId ?? null,
            sessionId,
            answers: answersToSubmit,
            finalizeSession: true,
          });
          finalized = true;
          setSessionStats({
            correct: result.correctCount,
            wrong: result.totalCount - result.correctCount,
          });
        }
      }

      // Nothing was submitted (immediate mode, or time ran out before a single
      // answer) — the session still has to close.
      if (!finalized) {
        const { error: sessionError } = await supabase
          .from("quiz_sessions")
          .update({ status: 'completed', completed_at: new Date().toISOString(), draft_answers: null })
          .eq("id", sessionId);
        if (sessionError) throw sessionError;
      }

      setQuizComplete(true);
    } catch (error: any) {
      console.error("Error auto-submitting quiz:", error);
      toast.error(t("toast.autoSubmitFailed"));
    } finally {
      setAutoSubmitting(false);
    }
  };

  // Timer effect
  useEffect(() => {
    if (!timerStarted || timeRemaining === null || timeRemaining <= 0 || quizComplete) return;

    const interval = setInterval(() => {
      setTimeRemaining((prev) => {
        if (prev === null || prev <= 1) {
          clearInterval(interval);
          // Time's up - trigger completion
          handleTimeUp();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- timer interval with handleTimeUp callback
  }, [timerStarted, timeRemaining, quizComplete]);

  // Start timer when questions are loaded for timed quizzes
  useEffect(() => {
    if (quizId && questions.length > 0 && !loading && timeLimitMinutes && !timerStarted) {
      setTimerStarted(true);
    }
  }, [quizId, questions, loading, timeLimitMinutes, timerStarted]);

  // Grace-period countdown: runs once handleTimeUp sets graceRemaining. When it
  // reaches zero we force-submit the attempt.
  useEffect(() => {
    if (graceRemaining === null || quizComplete) return;
    if (graceRemaining <= 0) {
      autoSubmitOnTimeUp();
      return;
    }
    const id = setTimeout(() => {
      setGraceRemaining((prev) => (prev === null ? null : prev - 1));
    }, 1000);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- autoSubmitOnTimeUp is stable per session
  }, [graceRemaining, quizComplete]);

  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const startQuiz = () => {
    // Generate a session ID for self-quizzes
    setSessionId(crypto.randomUUID());
    setShowSetup(false);
    fetchRandomQuestions();
  };

  const handleSelectAnswer = (index: number) => {
    if (submitting || timeExpiredLocked) return;
    // Multi-correct (#592): toggle membership of the option in the
    // selection set. Allow selection even if showResult is true (for
    // already-answered questions when going back); the submit path checks
    // answeredInSession to avoid double-counting.
    setSelectedAnswers((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return [...next].sort((a, b) => a - b);
    });
    setShowResult(false);
  };

  // Non-MCQ edits (#820 classification, #829 ordering/fill_gaps/open). Each
  // updater mutates the live `nonMcqDraft` for the matching kind; edits stay
  // possible until the answer is submitted (immediate mode) or the quiz is
  // submitted (deferred mode).
  const updateNonMcqDraft = (updater: (prev: NonMcqAnswer) => NonMcqAnswer) => {
    if (submitting || timeExpiredLocked) return;
    setNonMcqDraft((prev) => (prev ? updater(prev) : prev));
    setShowResult(false);
  };

  const handleClassificationSelect = (itemId: string, categoryId: string) =>
    updateNonMcqDraft((d) =>
      d.kind === "classification"
        ? { ...d, placements: { ...d.placements, [itemId]: categoryId } }
        : d,
    );

  // A drag — or the field's "Keep this order" confirm, which re-emits the
  // current order — is the student settling on one, so it also flips `touched`
  // and lets the question past the answered gate (#1043).
  const handleOrderingChange = (order: string[]) =>
    updateNonMcqDraft((d) => (d.kind === "ordering" ? { ...d, order, touched: true } : d));

  const handleFillGapChange = (index: number, value: string) =>
    updateNonMcqDraft((d) => {
      if (d.kind !== "fill_gaps") return d;
      const inputs = [...d.inputs];
      inputs[index] = value;
      return { ...d, inputs };
    });

  const handleOpenChange = (text: string) =>
    updateNonMcqDraft((d) => (d.kind === "open" ? { ...d, text } : d));

  // Check if we're in deferred submission mode (no immediate answers shown for formal quizzes)
  const isDeferredMode = quizId && !showAnswersEnabled;

  // #827 — Auto-save deferred-mode drafts. Debounce-persist the student's
  // in-progress selections to `quiz_sessions.draft_answers` so leaving (navigate
  // away / close tab / reload) and Resuming restores everything. We merge the
  // persisted pending maps with the live draft for the on-screen question so the
  // latest selection is captured without navigating first. Selections only — no
  // grading is computed or stored here, so nothing leaks correctness before
  // final submit. Best-effort: a failed write never interrupts the quiz.
  useEffect(() => {
    if (!isDeferredMode || !sessionId || loading || quizComplete) return;

    const mcq: Record<string, number[]> = { ...pendingAnswers };
    const nonMcq: Record<string, NonMcqAnswer> = { ...pendingNonMcq };
    const current = questions[currentIndex];
    if (current) {
      if (isNonMcqType(current.type)) {
        if (nonMcqDraft) nonMcq[current.id] = nonMcqDraft;
      } else if (selectedAnswers.length > 0) {
        mcq[current.id] = selectedAnswers;
      }
    }

    const payload: DraftAnswersPayload = { v: 1, mcq, nonMcq };
    const handle = setTimeout(() => {
      void (async () => {
        const { error } = await supabase
          .from("quiz_sessions")
          .update({ draft_answers: payload as unknown as Json })
          .eq("id", sessionId);
        if (error) console.error("Error auto-saving quiz draft:", error);
      })();
    }, DRAFT_AUTOSAVE_DEBOUNCE_MS);

    return () => clearTimeout(handle);
  }, [
    isDeferredMode,
    sessionId,
    loading,
    quizComplete,
    questions,
    currentIndex,
    selectedAnswers,
    nonMcqDraft,
    pendingAnswers,
    pendingNonMcq,
  ]);

  // Whether the current question has a submittable answer, per type. MCQ needs
  // at least one selected option; the non-MCQ types delegate to
  // `isNonMcqComplete` (all cards placed / every gap filled / non-empty text).
  const currentAnswerReady = (() => {
    const q = questions[currentIndex];
    if (!q) return false;
    return isNonMcqType(q.type)
      ? isNonMcqComplete(q, nonMcqDraft ?? undefined)
      : selectedAnswers.length > 0;
  })();

  const handleSubmitAnswer = async () => {
    if (!user) return;

    const currentQuestion = questions[currentIndex];
    const nonMcq = isNonMcqType(currentQuestion.type);
    if (!currentAnswerReady) return;
    // currentAnswerReady guarantees a live draft for non-MCQ questions.
    const draft = nonMcqDraft;

    // In deferred mode, just store the answer locally and move to next question
    if (isDeferredMode) {
      if (nonMcq) {
        setPendingNonMcq(prev => ({ ...prev, [currentQuestion.id]: draft! }));
      } else {
        setPendingAnswers(prev => ({ ...prev, [currentQuestion.id]: selectedAnswers }));
      }
      // Auto-advance to next question or show completion option. The next
      // question's non-MCQ draft is hydrated by the draft-sync effect; only
      // the MCQ selection needs loading here.
      if (currentIndex < questions.length - 1) {
        setCurrentIndex(prev => prev + 1);
        const nextQuestion = questions[currentIndex + 1];
        setSelectedAnswers(pendingAnswers[nextQuestion.id] ?? []);
        setNonMcqDraft(draftFor(nextQuestion, pendingNonMcq));
      }
      return;
    }

    // If already answered in this session, just show result without storing
    if (answeredInSession.has(currentQuestion.id)) {
      setShowResult(true);
      return;
    }

    // A quiz answer belongs to an attempt. Both the timed and non-timed paths
    // create the `quiz_sessions` row before the first question renders, so
    // this cannot be reached in practice — but recording a quiz answer with an
    // invented session id would be an attempt nothing counts, and the server
    // refuses it, so fail here where the message can say so.
    if (quizId && !sessionId) {
      toast.error(t("toast.attemptUnidentified"));
      return;
    }

    setSubmitting(true);

    try {
      // The server grades and stores the answer (#1094). MCQ sends
      // `submission.selected_indices` (#592); the non-MCQ types send their
      // per-type shape via `nonMcqSubmission` (#820/#829). The legacy
      // `selected_answer` column is derived server-side.
      const result = await submitQuizAnswers({
        courseId,
        quizId: quizId || null,
        offeringId: offeringId ?? null,
        // The invented id is for practice only, where the session is just a
        // grouping key for one run and no attempt is being tracked. A quiz
        // always has a real `quiz_sessions` row by the time a question can be
        // answered — both the timed and non-timed paths insert one — and the
        // guard above means we never reach here without it.
        sessionId: sessionId || crypto.randomUUID(),
        answers: [
          {
            questionId: currentQuestion.id,
            submission: nonMcq
              ? nonMcqSubmission(draft!)
              : { selected_indices: selectedAnswers },
          },
        ],
      });
      const verdict = result.results[0];
      const isCorrect = verdict?.isCorrect ?? false;
      if (verdict?.perGap) {
        setServerPerGap(prev => ({ ...prev, [currentQuestion.id]: verdict.perGap! }));
      }
      applyReveals(result.results);

      setSessionStats(prev => ({
        correct: prev.correct + (isCorrect ? 1 : 0),
        wrong: prev.wrong + (isCorrect ? 0 : 1),
      }));

      setAnsweredInSession(prev => new Set(prev).add(currentQuestion.id));
      setShowResult(true);
    } catch (error: any) {
      console.error("Error saving answer:", error);
      toast.error(t("toast.saveAnswerFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  /**
   * Fold the key material the server returned for answers it just recorded
   * into the questions on screen (#1011).
   *
   * The questions were loaded WITHOUT their key — it is not fetched with the
   * question any more — so this is the only thing that makes the red/green
   * reveal, the expected-answer lists and the explanation renderable. A
   * verdict with no `reveal` is the deliberate case, not a failure: a quiz
   * whose instructor has not released answers gets none, and the fields stay
   * empty, which is exactly what `showAnswersEnabled` already asks the
   * renderers to paint.
   */
  const applyReveals = (verdicts: QuizAnswerVerdict[]) => {
    const revealById = new Map(
      verdicts.filter((v) => v.reveal).map((v) => [v.questionId, v.reveal!]),
    );
    if (revealById.size === 0) return;
    setQuestions((prev) =>
      prev.map((q) => {
        const reveal = revealById.get(q.id);
        if (!reveal) return q;
        return {
          ...q,
          explanation: reveal.explanation ?? "",
          ...(reveal.correctIndices ? { correctIndices: reveal.correctIndices } : {}),
          ...(reveal.fillGapsGaps ? { fillGapsGaps: reveal.fillGapsGaps } : {}),
          ...(reveal.classificationAssignments
            ? { classificationAssignments: reveal.classificationAssignments }
            : {}),
          ...(reveal.orderingCanonical ? { orderingItems: reveal.orderingCanonical } : {}),
        };
      }),
    );
  };

  // The live draft a question should show: its stored deferred answer if one
  // exists, otherwise a fresh empty answer (ordering seeds its shuffle here).
  // Returns null for MCQ, whose selection lives in `selectedAnswers`.
  const draftFor = (
    question: Question | undefined,
    pending: Record<string, NonMcqAnswer>,
  ): NonMcqAnswer | null => {
    if (!question || !isNonMcqType(question.type)) return null;
    return pending[question.id] ?? emptyNonMcqAnswer(question, user?.id ?? "");
  };

  const handleNext = async () => {
    if (currentIndex < questions.length - 1) {
      const next = questions[currentIndex + 1];
      setCurrentIndex(prev => prev + 1);
      setSelectedAnswers([]);
      setNonMcqDraft(draftFor(next, pendingNonMcq));
      setShowResult(false);
    } else {
      setQuizComplete(true);
      
      // Mark session as completed
      if (quizId && sessionId) {
        await supabase
          .from("quiz_sessions")
          .update({ status: 'completed', completed_at: new Date().toISOString() })
          .eq("id", sessionId);
      }
    }
  };

  const handleSkip = () => {
    if (currentIndex < questions.length - 1) {
      // Track the skipped question to show it again later
      const currentQuestion = questions[currentIndex];
      const next = questions[currentIndex + 1];
      setSkippedQuestionIds(prev => new Set(prev).add(currentQuestion.id));
      setCurrentIndex(prev => prev + 1);
      setSelectedAnswers([]);
      setNonMcqDraft(draftFor(next, pendingNonMcq));
      setShowResult(false);
    } else {
      // At the end - just complete the quiz
      setQuizComplete(true);
    }
  };

  // Persist the current question's in-progress answer into the deferred-mode
  // pending maps, keyed by type. Called before every navigation so a card
  // placement / option pick / typed gap survives moving between questions.
  const stashCurrentDraft = () => {
    const currentQuestion = questions[currentIndex];
    if (!currentQuestion) return;
    if (isNonMcqType(currentQuestion.type)) {
      if (nonMcqDraft) {
        setPendingNonMcq(prev => ({ ...prev, [currentQuestion.id]: nonMcqDraft }));
      }
    } else if (selectedAnswers.length > 0) {
      setPendingAnswers(prev => ({ ...prev, [currentQuestion.id]: selectedAnswers }));
    }
  };

  // Load a target question's stored answer into the live draft state.
  const loadDraftFor = (question: Question | undefined) => {
    if (!question) return;
    if (isNonMcqType(question.type)) {
      setNonMcqDraft(draftFor(question, pendingNonMcq));
      setSelectedAnswers([]);
    } else {
      setSelectedAnswers(pendingAnswers[question.id] ?? []);
      setNonMcqDraft(null);
    }
  };

  // Navigation for deferred mode
  const handlePrevQuestion = () => {
    if (currentIndex > 0) {
      stashCurrentDraft();
      setCurrentIndex(prev => prev - 1);
      loadDraftFor(questions[currentIndex - 1]);
    }
  };

  const handleNextQuestion = () => {
    if (currentIndex < questions.length - 1) {
      stashCurrentDraft();
      setCurrentIndex(prev => prev + 1);
      loadDraftFor(questions[currentIndex + 1]);
    }
  };

  const handleGoToQuestion = (index: number) => {
    stashCurrentDraft();
    setCurrentIndex(index);
    loadDraftFor(questions[index]);
  };

  // Submit all pending answers at once (for deferred mode)
  const handleSubmitQuiz = async () => {
    if (!user || !quizId || !sessionId) return;

    // Save current answer if present (per type)
    const finalAnswers: Record<string, number[]> = { ...pendingAnswers };
    const finalNonMcq: Record<string, NonMcqAnswer> = { ...pendingNonMcq };
    const currentQuestion = questions[currentIndex];
    if (currentQuestion && isNonMcqType(currentQuestion.type)) {
      if (nonMcqDraft && isNonMcqComplete(currentQuestion, nonMcqDraft)) {
        finalNonMcq[currentQuestion.id] = nonMcqDraft;
      }
    } else if (selectedAnswers.length > 0 && currentQuestion) {
      finalAnswers[currentQuestion.id] = selectedAnswers;
    }

    // Check if all questions are answered
    const unansweredCount = questions.filter(q =>
      isNonMcqType(q.type)
        ? !isNonMcqComplete(q, finalNonMcq[q.id])
        : finalAnswers[q.id] === undefined,
    ).length;
    if (unansweredCount > 0) {
      toast.error(t("toast.answerAll", { count: unansweredCount }));
      return;
    }

    setSubmitting(true);
    try {
      // Re-check session status: the instructor may have force-completed the
      // attempt in the background, in which case what they finalised is the
      // attempt of record and this submit must not add to it. The server
      // refuses a closed assignment on its own; this is what turns that into a
      // sentence the student can read.
      const { data: liveSession } = await supabase
        .from("quiz_sessions")
        .select("status")
        .eq("id", sessionId)
        .maybeSingle();
      if (liveSession?.status === 'completed' || liveSession?.status === 'expired') {
        toast.error(t("toast.finalisedByInstructor"));
        setQuizComplete(true);
        return;
      }

      // Send every answer at once. MCQ sends `submission.selected_indices`
      // (#592); the non-MCQ types send their per-type shape via
      // `nonMcqSubmission` (#820/#829). Grading happens on the server, which
      // also closes the session in the same transaction — so a submit either
      // records the whole attempt and completes it, or does neither (#1094).
      //
      // Nothing is deleted first any more. The old delete-then-reinsert never
      // deleted anything (students have no DELETE policy on quiz_answers); the
      // server now skips questions this session already answered instead, which
      // is what that code was reaching for.
      const answersToSubmit = questions.map(q => ({
        questionId: q.id,
        submission: isNonMcqType(q.type)
          ? nonMcqSubmission(finalNonMcq[q.id] ?? emptyNonMcqAnswer(q, user.id))
          : { selected_indices: finalAnswers[q.id] ?? [] },
      }));

      const result = await submitQuizAnswers({
        courseId,
        quizId,
        offeringId: offeringId ?? null,
        sessionId,
        answers: answersToSubmit,
        finalizeSession: true,
      });

      applyReveals(result.results);
      setSessionStats({
        correct: result.correctCount,
        wrong: result.totalCount - result.correctCount,
      });
      setQuizComplete(true);
      toast.success(t("toast.submitSuccess"));
    } catch (error) {
      console.error("Error submitting quiz:", error);
      toast.error(
        error instanceof SubmitQuizAnswersError && error.code === "question_changed"
          ? t("toast.questionChanged")
          : t("toast.submitQuizFailed"),
      );
    } finally {
      setSubmitting(false);
      setShowSubmitConfirm(false);
    }
  };

  // Whether a question counts as answered in deferred mode, honoring the live
  // draft for the question currently on screen and the pending maps otherwise.
  const isDeferredAnswered = (q: Question): boolean => {
    const isCurrent = q.id === questions[currentIndex]?.id;
    if (isNonMcqType(q.type)) {
      return isCurrent
        ? isNonMcqComplete(q, nonMcqDraft ?? undefined)
        : isNonMcqComplete(q, pendingNonMcq[q.id]);
    }
    return pendingAnswers[q.id] !== undefined || (isCurrent && selectedAnswers.length > 0);
  };

  // Count answered questions in deferred mode
  const answeredCount = isDeferredMode
    ? questions.filter(isDeferredAnswered).length
    : answeredInSession.size;

  const getDifficultyColor = getDifficultyClass;

  if (showSetup) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-primary/5 via-background to-secondary/10">
        <nav className="border-b border-border bg-card/80 backdrop-blur-sm">
          <div className="container mx-auto px-6 py-4">
            <Button variant="ghost" onClick={onBack}>
              <ArrowLeft className="w-4 h-4 mr-2" />
              {t("nav.backToCourse")}
            </Button>
          </div>
        </nav>
        <main className="container mx-auto px-6 py-16">
          <Card className="max-w-md mx-auto">
            <CardHeader className="text-center">
              <div className="w-16 h-16 rounded-full bg-gradient-to-br from-primary/20 to-secondary/20 flex items-center justify-center mx-auto mb-4">
                <Target className="w-8 h-8 text-primary" />
              </div>
              <CardTitle>{t("setup.title")}</CardTitle>
              <CardDescription>{quizTitle || courseTitle}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="flex items-center justify-between p-4 rounded-lg bg-muted/50 border">
                <div className="flex items-center gap-3">
                  <RefreshCcw className="w-5 h-5 text-muted-foreground" />
                  <div>
                    <Label htmlFor="include-answered" className="font-medium">{t("setup.includeAnswered")}</Label>
                    <p className="text-xs text-muted-foreground">{t("setup.includeAnsweredHint")}</p>
                  </div>
                </div>
                <Switch
                  id="include-answered"
                  checked={includeAnswered}
                  onCheckedChange={setIncludeAnswered}
                />
              </div>
              <Button className="w-full" size="lg" onClick={startQuiz}>
                {t("setup.start")}
                <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
            </CardContent>
          </Card>
        </main>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary/5 via-background to-secondary/10">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  // Instructor closed this assignment before the student started. We refuse to
  // create a session and surface a friendly message instead of an RLS error.
  if (closedNoAttempt) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-primary/5 via-background to-secondary/10">
        <nav className="border-b border-border bg-card/80 backdrop-blur-sm">
          <div className="container mx-auto px-6 py-4">
            <Button variant="ghost" onClick={onBack}>
              <ArrowLeft className="w-4 h-4 mr-2" />
              {t("nav.backToCourse")}
            </Button>
          </div>
        </nav>
        <main className="container mx-auto px-6 py-16">
          <Card className="max-w-md mx-auto text-center" data-testid="quiz-closed-screen">
            <CardContent className="pt-8 pb-8 space-y-4">
              <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mx-auto">
                <AlertTriangle className="w-8 h-8 text-muted-foreground" />
              </div>
              <h2 className="text-2xl font-bold">{t("closed.title")}</h2>
              <p className="text-muted-foreground">{t("closed.body")}</p>
              <Button className="w-full" onClick={onBack}>
                {t("nav.backToCourse")}
              </Button>
            </CardContent>
          </Card>
        </main>
      </div>
    );
  }

  // Pre-start warning for timed quizzes — we don't create the quiz_sessions
  // row (which sets started_at) until the student clicks through.
  if (awaitingTimedStart && timeLimitMinutes && timeLimitMinutes > 0) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-primary/5 via-background to-secondary/10">
        <nav className="border-b border-border bg-card/80 backdrop-blur-sm">
          <div className="container mx-auto px-6 py-4">
            <Button variant="ghost" onClick={onBack} disabled={startingTimedQuiz}>
              <ArrowLeft className="w-4 h-4 mr-2" />
              {t("nav.backToCourse")}
            </Button>
          </div>
        </nav>
        <main className="container mx-auto px-6 py-16">
          <Card className="max-w-lg mx-auto">
            <CardHeader className="text-center">
              <div className="w-16 h-16 rounded-full bg-amber-500/10 flex items-center justify-center mx-auto mb-4">
                <Clock className="w-8 h-8 text-amber-600" />
              </div>
              <CardTitle className="text-2xl">{t("timedStart.title")}</CardTitle>
              <CardDescription>{quizTitle || courseTitle}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <Alert className="border-amber-500/30 bg-amber-500/5">
                <AlertTriangle className="h-4 w-4 text-amber-600" />
                <AlertDescription className="text-sm text-left">
                  <Trans
                    i18nKey="quiz:timedStart.warning"
                    values={{ count: timeLimitMinutes }}
                    components={{ 1: <strong />, 2: <strong /> }}
                  />
                </AlertDescription>
              </Alert>
              <div className="flex flex-col-reverse sm:flex-row gap-3">
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={onBack}
                  disabled={startingTimedQuiz}
                >
                  {t("timedStart.cancel")}
                </Button>
                <Button
                  className="flex-1"
                  onClick={handleConfirmStartTimedQuiz}
                  disabled={startingTimedQuiz}
                  data-testid="confirm-start-timed-quiz"
                >
                  {startingTimedQuiz ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      {t("timedStart.starting")}
                    </>
                  ) : (
                    <>
                      {t("timedStart.confirm")}
                      <ArrowRight className="w-4 h-4 ml-2" />
                    </>
                  )}
                </Button>
              </div>
            </CardContent>
          </Card>
        </main>
      </div>
    );
  }

  // Show abandoned quiz screen for timed quizzes that were exited
  if (quizAbandoned) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-primary/5 via-background to-secondary/10">
        <nav className="border-b border-border bg-card/80 backdrop-blur-sm">
          <div className="container mx-auto px-6 py-4">
            <Button variant="ghost" onClick={onBack}>
              <ArrowLeft className="w-4 h-4 mr-2" />
              {t("nav.backToCourse")}
            </Button>
          </div>
        </nav>
        <main className="container mx-auto px-6 py-16">
          <Card className="max-w-md mx-auto text-center">
            <CardContent className="pt-8 pb-8">
              <div className="w-20 h-20 rounded-full bg-red-500/10 flex items-center justify-center mx-auto mb-4">
                <Clock className="w-10 h-10 text-red-500" />
              </div>
              <h2 className="text-2xl font-bold mb-2">{t("abandoned.title")}</h2>
              <p className="text-muted-foreground mb-4">{t("abandoned.body")}</p>
              <Button className="mt-2" onClick={onBack}>
                {t("nav.returnToCourse")}
              </Button>
            </CardContent>
          </Card>
        </main>
      </div>
    );
  }

  if (questions.length === 0) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-primary/5 via-background to-secondary/10">
        <nav className="border-b border-border bg-card/80 backdrop-blur-sm">
          <div className="container mx-auto px-6 py-4">
            <Button variant="ghost" onClick={onBack}>
              <ArrowLeft className="w-4 h-4 mr-2" />
              {t("nav.backToCourse")}
            </Button>
          </div>
        </nav>
        <main className="container mx-auto px-6 py-16">
          <Card className="max-w-md mx-auto text-center">
            <CardContent className="pt-8 pb-8 space-y-4">
              <Trophy className="w-16 h-16 mx-auto text-amber-500 mb-4" />
              <h2 className="text-2xl font-bold mb-2">{t("empty.title")}</h2>
              <p className="text-muted-foreground">
                {includeAnswered
                  ? t("empty.bodyIncludingAnswered")
                  : t("empty.bodyUnanswered")}
              </p>
              {studentQuestionsEnabled && onNavigateToGenerator ? (
                <>
                  <p className="text-sm text-muted-foreground">
                    {t("empty.generatePrompt")}
                  </p>
                  <Button className="w-full" onClick={onNavigateToGenerator}>
                    <Sparkles className="w-4 h-4 mr-2" />
                    {t("empty.generateAction")}
                  </Button>
                  <Button variant="outline" className="w-full" onClick={onBack}>
                    {t("nav.returnToCourse")}
                  </Button>
                </>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">
                    {t("empty.checkBackLater")}
                  </p>
                  <Button variant="outline" className="w-full" onClick={onBack}>
                    {t("nav.returnToCourse")}
                  </Button>
                </>
              )}
            </CardContent>
          </Card>
        </main>
      </div>
    );
  }

  if (quizComplete) {
    const accuracy = sessionStats.correct + sessionStats.wrong > 0
      ? Math.round((sessionStats.correct / (sessionStats.correct + sessionStats.wrong)) * 100)
      : 0;

    // If answers are not released, show a simpler completion screen
    if (!showAnswersEnabled && quizId) {
      return (
        <div className="min-h-screen bg-gradient-to-br from-primary/5 via-background to-secondary/10 flex items-center justify-center p-4">
          <Card className="max-w-lg w-full">
            <CardHeader className="text-center">
              <div className="w-20 h-20 rounded-full bg-gradient-to-br from-primary/20 to-secondary/20 flex items-center justify-center mx-auto mb-4">
                <CheckCircle className="w-10 h-10 text-primary" />
              </div>
              <CardTitle className="text-2xl">{t("submitted.title")}</CardTitle>
              <CardDescription>{t("submitted.subtitle")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="p-4 rounded-lg bg-muted/50 border text-center">
                <p className="text-sm text-muted-foreground">
                  <Trans
                    i18nKey="quiz:submitted.answeredCount"
                    values={{ count: sessionStats.correct + sessionStats.wrong }}
                    components={{ 1: <span className="font-semibold text-foreground" /> }}
                  />
                </p>
                <p className="text-sm text-muted-foreground mt-2">
                  {t("submitted.pendingRelease")}
                </p>
              </div>

              <div className="flex gap-3">
                <Button variant="outline" className="flex-1" onClick={onBack}>
                  {t("nav.backToCourse")}
                </Button>
                <Button className="flex-1" onClick={onComplete}>
                  {t("nav.continueLearning")}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      );
    }

    return (
      <div className="min-h-screen bg-gradient-to-br from-primary/5 via-background to-secondary/10 flex items-center justify-center p-4">
        <Card className="max-w-lg w-full">
          <CardHeader className="text-center">
            <div className="w-20 h-20 rounded-full bg-gradient-to-br from-amber-500/20 to-orange-500/20 flex items-center justify-center mx-auto mb-4">
              <Trophy className="w-10 h-10 text-amber-500" />
            </div>
            <CardTitle className="text-2xl">
              {quizId ? t("results.titleQuiz") : t("results.titleRound")}
            </CardTitle>
            <CardDescription>
              {quizId ? t("results.subtitleQuiz") : t("results.subtitleRound")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid grid-cols-3 gap-4 text-center">
              <div className="p-4 rounded-lg bg-muted/50">
                <p className="text-2xl font-bold text-primary">{sessionStats.correct + sessionStats.wrong}</p>
                <p className="text-xs text-muted-foreground">{t("results.questions")}</p>
              </div>
              <div className="p-4 rounded-lg bg-green-500/10">
                <p className="text-2xl font-bold text-green-600">{sessionStats.correct}</p>
                <p className="text-xs text-muted-foreground">{t("results.correct")}</p>
              </div>
              <div className="p-4 rounded-lg bg-red-500/10">
                <p className="text-2xl font-bold text-red-600">{sessionStats.wrong}</p>
                <p className="text-xs text-muted-foreground">{t("results.wrong")}</p>
              </div>
            </div>

            <div className="text-center">
              <p className="text-4xl font-bold text-primary mb-1">{accuracy}%</p>
              <p className="text-sm text-muted-foreground">{t("results.accuracy")}</p>
            </div>

            {accuracy >= 80 && (
              <div className="p-4 rounded-lg bg-gradient-to-r from-amber-500/10 to-orange-500/10 border border-amber-500/20 text-center">
                <p className="font-medium text-amber-600">{t("results.excellent")}</p>
              </div>
            )}

            <div className="flex gap-3">
              <Button variant="outline" className="flex-1" onClick={onBack}>
                {t("nav.backToCourse")}
              </Button>
              <Button className="flex-1" onClick={onComplete}>
                {t("nav.continueLearning")}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const currentQuestion = questions[currentIndex];
  const progress = ((currentIndex + 1) / questions.length) * 100;

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary/5 via-background to-secondary/10">
      {/* Exit Confirmation Dialog for Timed Quizzes */}
      <AlertDialog open={showExitDialog} onOpenChange={setShowExitDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <div className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 rounded-full bg-red-500/10 flex items-center justify-center">
                <AlertTriangle className="w-5 h-5 text-red-500" />
              </div>
              <AlertDialogTitle>{t("exitDialog.title")}</AlertDialogTitle>
            </div>
            <AlertDialogDescription className="text-left">
              <strong className="text-foreground">{t("exitDialog.warningLabel")}</strong>{" "}
              <Trans
                i18nKey="quiz:exitDialog.warningBody"
                components={{ 1: <strong className="text-red-600" /> }}
              />
              {timeRemaining !== null && timeRemaining > 0 && (
                <>
                  <br /><br />
                  {t("exitDialog.timeRemaining")}{" "}
                  <strong className="text-amber-600">{formatTime(timeRemaining)}</strong>
                </>
              )}
              {timeRemaining !== null && timeRemaining <= 0 && (
                <>
                  <br /><br />
                  <Trans
                    i18nKey="quiz:exitDialog.timeExpiredBody"
                    components={{ 1: <strong className="text-amber-600" /> }}
                  />
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("exitDialog.continue")}</AlertDialogCancel>
            <AlertDialogAction 
              onClick={handleExitQuiz}
              className="bg-red-600 hover:bg-red-700"
            >
              {t("exitDialog.exitAnyway")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Header */}
      <nav className="border-b border-border bg-card/80 backdrop-blur-sm">
        <div className="container mx-auto px-6 py-4 flex items-center justify-between">
          <Button 
            variant="ghost" 
            onClick={() => {
              if (timeLimitMinutes && timeLimitMinutes > 0) {
                setShowExitDialog(true);
              } else {
                onBack();
              }
            }}
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            {t("nav.exitQuiz")}
          </Button>
          <div className="text-sm font-medium">
            {quizTitle || courseTitle}
          </div>
          <div className="flex items-center gap-4 text-sm">
            {timeRemaining !== null && (
              <div className={`flex items-center gap-1 font-medium ${timeRemaining <= 0 ? 'text-red-600' : timeRemaining < 60 ? 'text-red-600 animate-pulse' : timeRemaining < 300 ? 'text-amber-600' : 'text-muted-foreground'}`}>
                <Clock className="w-4 h-4" />
                {timeRemaining <= 0 ? t("header.expired") : formatTime(timeRemaining)}
              </div>
            )}
            <span className="text-green-600 font-medium">{sessionStats.correct} ✓</span>
            <span className="text-red-600 font-medium">{sessionStats.wrong} ✗</span>
          </div>
        </div>
      </nav>

      {/* Progress */}
      <div className="container mx-auto px-6 pt-4">
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">
            {t("header.progress", {
              current: currentIndex + 1,
              total: questions.length,
            })}
          </span>
          <Progress value={progress} className="flex-1 h-2" />
        </div>
      </div>

      {/* Time Expired Banner */}
      {timeRemaining !== null && timeRemaining <= 0 && (
        <div className="container mx-auto px-6 pt-4">
          <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg p-3 flex items-center gap-3">
            <Clock className="w-5 h-5 text-amber-600 dark:text-amber-400 flex-shrink-0" />
            <div>
              <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
                {t("expiredBanner.title")}
              </p>
              <p className="text-xs text-amber-700 dark:text-amber-300">
                {t("expiredBanner.body")}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Question */}
      <main className="container mx-auto px-6 py-8 max-w-3xl">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2 flex-wrap">
                {showDifficulty && (
                  <Badge variant="outline" className={getDifficultyColor(currentQuestion.difficulty)}>
                    {currentQuestion.difficulty}
                  </Badge>
                )}
                {currentQuestion.isUserGenerated && (
                  <Badge variant="secondary" className="bg-emerald-500/10 text-emerald-600 border-emerald-500/20 text-xs">
                    {t("question.peer")}
                  </Badge>
                )}
                {answeredInSession.has(currentQuestion.id) && (
                  <Badge variant="secondary" className="bg-blue-500/10 text-blue-600 border-blue-500/20">
                    <RefreshCcw className="w-3 h-3 mr-1" />
                    {t("question.previouslyAnswered")}
                  </Badge>
                )}
                {!quizId && !answeredInSession.has(currentQuestion.id) && previousAnswers.has(currentQuestion.id) && (() => {
                  const prior = previousAnswers.get(currentQuestion.id)!;
                  return prior.isCorrect ? (
                    <Badge variant="secondary" className="bg-green-500/10 text-green-600 border-green-500/20">
                      <RefreshCcw className="w-3 h-3 mr-1" />
                      {t("question.previouslyCorrect")}
                    </Badge>
                  ) : (
                    <Badge variant="secondary" className="bg-amber-500/10 text-amber-600 border-amber-500/20">
                      <RefreshCcw className="w-3 h-3 mr-1" />
                      {t("question.previouslyIncorrect")}
                    </Badge>
                  );
                })()}
              </div>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Target className="w-4 h-4" />
                <span>{t("question.index", { index: currentIndex + 1 })}</span>
              </div>
            </div>
            {currentQuestion.diagram?.source && (
              <QuestionDiagram
                source={currentQuestion.diagram.source}
                alt={currentQuestion.diagram.alt ?? null}
              />
            )}
            {/* fill_gaps stores the cloze (with `{{1}}` placeholders) in the
                question column; its interactive stem is rendered inside
                FillGapsField, so we suppress the plain title here. */}
            {currentQuestion.type !== "fill_gaps" && (
              <CardTitle
                className="text-xl leading-relaxed"
                dangerouslySetInnerHTML={{
                  __html: processLatexContent(
                    renderQuestionStem(currentQuestion.question, currentQuestion.multiCorrect),
                  ),
                }}
              />
            )}
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Previously answered notice (practice mode only, before re-answering in this session) */}
            {!quizId && previousAnswers.has(currentQuestion.id) && !answeredInSession.has(currentQuestion.id) && !showResult && (() => {
              const prior = previousAnswers.get(currentQuestion.id)!;
              return prior.isCorrect ? (
                <Alert className="border-green-500/30 bg-green-500/5">
                  <CheckCircle className="h-4 w-4 text-green-600" />
                  <AlertDescription className="text-sm">
                    {t("question.priorCorrect")}
                  </AlertDescription>
                </Alert>
              ) : (
                <Alert className="border-amber-500/30 bg-amber-500/5">
                  <AlertTriangle className="h-4 w-4 text-amber-600" />
                  <AlertDescription className="text-sm">
                    {t("question.priorIncorrect")}
                  </AlertDescription>
                </Alert>
              );
            })()}

            {/* Non-MCQ answer surfaces (#820 classification, #829 ordering/
                fill_gaps/open). The live draft (`nonMcqDraft`) is a
                discriminated union that matches the current question's type. */}
            {isNonMcqType(currentQuestion.type) ? (
              nonMcqDraft && (
                <>
                  {nonMcqDraft.kind === "classification" && (
                    <ClassificationField
                      questionId={currentQuestion.id}
                      categories={currentQuestion.categories ?? []}
                      items={currentQuestion.items ?? []}
                      assignments={currentQuestion.classificationAssignments ?? {}}
                      userId={user?.id ?? ""}
                      value={nonMcqDraft.placements}
                      onSelect={handleClassificationSelect}
                      disabled={submitting || timeExpiredLocked}
                      reveal={showResult && (showAnswersEnabled || !quizId)}
                    />
                  )}
                  {nonMcqDraft.kind === "ordering" && (
                    <OrderingField
                      value={nonMcqDraft.order}
                      canonical={currentQuestion.orderingItems ?? []}
                      onChange={handleOrderingChange}
                      disabled={submitting || timeExpiredLocked}
                      reveal={showResult && (showAnswersEnabled || !quizId)}
                      needsConfirm={!nonMcqDraft.touched}
                    />
                  )}
                  {nonMcqDraft.kind === "fill_gaps" && (
                    <FillGapsField
                      stem={currentQuestion.fillGapsStem ?? ""}
                      gaps={currentQuestion.fillGapsGaps ?? []}
                      value={nonMcqDraft.inputs}
                      onChange={handleFillGapChange}
                      disabled={submitting || timeExpiredLocked}
                      reveal={showResult && (showAnswersEnabled || !quizId)}
                      perGap={serverPerGap[currentQuestion.id]}
                    />
                  )}
                  {nonMcqDraft.kind === "open" && (
                    <OpenField
                      value={nonMcqDraft.text}
                      onChange={handleOpenChange}
                      disabled={submitting || timeExpiredLocked}
                      reveal={showResult}
                    />
                  )}
                </>
              )
            ) : currentQuestion.options.length === 0 ? (
              /* #833 — an MCQ with no options is an unrenderable snapshot whose
                 live question could not be re-fetched (e.g. deleted). Show a
                 clear, recoverable message instead of a silent blank card. */
              <div className="rounded-xl border border-amber-500/50 bg-amber-500/10 p-4 text-sm text-amber-700 dark:text-amber-300">
                {t("question.unrenderable")}
              </div>
            ) : (
              <McqField
                options={currentQuestion.options}
                correctIndices={currentQuestion.correctIndices}
                value={selectedAnswers}
                onToggle={handleSelectAnswer}
                disabled={submitting || timeExpiredLocked}
                reveal={showResult}
                canShowCorrectness={showAnswersEnabled || !quizId}
              />
            )}

            {/* Explanation - only show when answers are released */}
            {showResult && (showAnswersEnabled || !quizId) && currentQuestion.explanation && (
              <div className="mt-6 p-4 rounded-xl bg-muted/50 border">
                <div className="flex items-center gap-2 mb-3">
                  <BookOpen className="w-4 h-4 text-primary" />
                  <span className="font-medium text-sm">{t("question.explanation")}</span>
                </div>
                <div 
                  className="text-sm text-muted-foreground leading-relaxed prose prose-sm max-w-none [&_p]:mb-3 [&_strong]:text-foreground [&_strong]:font-semibold"
                  dangerouslySetInnerHTML={{ __html: processLatexContent(formatExplanation(currentQuestion.explanation)) }}
                />
              </div>
            )}

            {/* Answer recorded message - when answers are hidden */}
            {showResult && !showAnswersEnabled && quizId && (
              <div className="mt-6 p-4 rounded-xl bg-muted/50 border text-center">
                <CheckCircle className="w-6 h-6 text-primary mx-auto mb-2" />
                <p className="text-sm text-muted-foreground">{t("question.answerRecorded")}</p>
              </div>
            )}

            {/* Voting - only show when answers are released */}
            {showResult && (showAnswersEnabled || !quizId) && (
              <div className="mt-4 flex items-center justify-between p-3 rounded-lg bg-muted/30 border">
                <span className="text-sm text-muted-foreground">{t("vote.prompt")}</span>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleVote(currentQuestion.id, 'up')}
                    disabled={votingQuestionId === currentQuestion.id}
                    className={`gap-1 ${userVotes[currentQuestion.id] === 'up' ? 'text-green-600 bg-green-500/10' : ''}`}
                  >
                    <ThumbsUp className="w-4 h-4" />
                    <span className="text-xs">{t("vote.helpful")}</span>
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleVote(currentQuestion.id, 'down')}
                    disabled={votingQuestionId === currentQuestion.id}
                    className={`gap-1 ${userVotes[currentQuestion.id] === 'down' ? 'text-red-600 bg-red-500/10' : ''}`}
                  >
                    <ThumbsDown className="w-4 h-4" />
                    <span className="text-xs">{t("vote.issue")}</span>
                  </Button>
                </div>
              </div>
            )}

            {/* Question Navigator (deferred mode only) */}
            {isDeferredMode && (
              <div className="pt-4 border-t">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm text-muted-foreground">
                    {t("navigator.answered", {
                      answered: answeredCount,
                      count: questions.length,
                    })}
                  </span>
                  {answeredCount === questions.length && (
                    <Badge variant="secondary" className="bg-green-500/20 text-green-600">
                      <CheckCircle className="w-3 h-3 mr-1" />
                      {t("navigator.allAnswered")}
                    </Badge>
                  )}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {questions.map((q, idx) => {
                    const isAnswered = isDeferredAnswered(q);
                    const isCurrent = idx === currentIndex;
                    return (
                      <button
                        key={q.id}
                        onClick={() => handleGoToQuestion(idx)}
                        className={`w-8 h-8 rounded text-sm font-medium transition-colors ${
                          isCurrent
                            ? 'bg-primary text-primary-foreground'
                            : isAnswered
                            ? 'bg-green-500/20 text-green-700 dark:text-green-400 hover:bg-green-500/30'
                            : 'bg-muted hover:bg-muted/80 text-muted-foreground'
                        }`}
                      >
                        {idx + 1}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Actions */}
            <div className="flex justify-between pt-4">
              <div>
                {/* Back button for deferred mode */}
                {isDeferredMode && currentIndex > 0 && (
                  <Button
                    variant="ghost"
                    onClick={handlePrevQuestion}
                    disabled={submitting || timeExpiredLocked}
                  >
                    <ArrowLeft className="w-4 h-4 mr-2" />
                    {t("actions.previous")}
                  </Button>
                )}
                {/* Skip button - only for practice mode (no quizId) and before answering */}
                {!quizId && !showResult && (
                  <Button
                    variant="ghost"
                    onClick={handleSkip}
                    disabled={submitting || timeExpiredLocked}
                    className="text-muted-foreground"
                  >
                    <SkipForward className="w-4 h-4 mr-2" />
                    {t("actions.skip")}
                  </Button>
                )}
              </div>
              <div className="flex gap-3">
                {isDeferredMode ? (
                  // Deferred mode: Save & Navigate or Submit Quiz
                  <>
                    {currentIndex < questions.length - 1 ? (
                      <Button
                        onClick={handleNextQuestion}
                        disabled={submitting || timeExpiredLocked}
                        variant={currentAnswerReady ? "default" : "outline"}
                        className="min-w-[140px]"
                      >
                        {currentAnswerReady
                          ? t("actions.saveAndNext")
                          : t("actions.next")}
                        <ArrowRight className="w-4 h-4 ml-2" />
                      </Button>
                    ) : (
                      <Button
                        onClick={() => setShowSubmitConfirm(true)}
                        disabled={submitting || timeExpiredLocked}
                        className="min-w-[140px] bg-green-600 hover:bg-green-700"
                      >
                        {submitting ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <>
                            <CheckCircle className="w-4 h-4 mr-2" />
                            {t("actions.submitQuiz")}
                          </>
                        )}
                      </Button>
                    )}
                  </>
                ) : (
                  // Immediate mode: Submit Answer then Next
                  <>
                    {!showResult ? (
                      <Button
                        onClick={handleSubmitAnswer}
                        disabled={!currentAnswerReady || submitting || timeExpiredLocked}
                        className="min-w-[140px]"
                      >
                        {submitting ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          t("actions.submitAnswer")
                        )}
                      </Button>
                    ) : (
                      <Button
                        onClick={handleNext}
                        disabled={timeExpiredLocked}
                        className="min-w-[140px]"
                      >
                        {currentIndex < questions.length - 1 ? (
                          <>
                            {t("actions.nextQuestion")}
                            <ArrowRight className="w-4 h-4 ml-2" />
                          </>
                        ) : (
                          quizId ? t("actions.finishQuiz") : t("actions.finishRound")
                        )}
                      </Button>
                    )}
                  </>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      </main>

      {/* Submit Quiz Confirmation Dialog */}
      <AlertDialog open={showSubmitConfirm} onOpenChange={setShowSubmitConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("submitDialog.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {(() => {
                // Count answered questions (per type), honoring the live draft.
                const answered = questions.filter(isDeferredAnswered).length;
                const unanswered = questions.length - answered;

                if (unanswered > 0) {
                  return t("submitDialog.unanswered", { count: unanswered });
                }
                return t("submitDialog.allAnswered");
              })()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("submitDialog.review")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleSubmitQuiz}
              disabled={submitting}
              className="bg-green-600 hover:bg-green-700"
            >
              {submitting ? (
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
              ) : (
                <CheckCircle className="w-4 h-4 mr-2" />
              )}
              {t("actions.submitQuiz")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Time-up grace period dialog — shown when the countdown hits zero. */}
      <AlertDialog open={graceRemaining !== null && !quizComplete}>
        <AlertDialogContent data-testid="time-up-grace-dialog">
          <AlertDialogHeader>
            <div className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 rounded-full bg-red-500/10 flex items-center justify-center">
                <Clock className="w-5 h-5 text-red-500" />
              </div>
              <AlertDialogTitle>{t("graceDialog.title")}</AlertDialogTitle>
            </div>
            <AlertDialogDescription className="text-left">
              <Trans
                i18nKey="quiz:graceDialog.body"
                count={graceRemaining ?? 0}
                values={{ count: graceRemaining ?? 0 }}
                components={{ 1: <strong className="text-red-600" /> }}
              />
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction
              onClick={autoSubmitOnTimeUp}
              disabled={autoSubmitting}
              className="bg-red-600 hover:bg-red-700"
            >
              {autoSubmitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  {t("graceDialog.submitting")}
                </>
              ) : (
                t("graceDialog.submitNow")
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};


export default StudentQuiz;
