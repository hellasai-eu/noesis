/**
 * EvaluatorReviewSession (#668) — the per-question evaluation surface.
 *
 * On mount we create a `question_evaluation_sessions` row scoped to the
 * evaluator + course. The user picks questions from the left rail and
 * fills the rubric form on the right; `question_evaluations` is upserted
 * one row per (evaluator, question). Ending the session opens the summary
 * dialog which writes `ended_at` and the three summary fields, then
 * navigates back to `/evaluator/course/:courseId`.
 *
 * Per #668: the cognitive-level sampling block is decided lazily on first
 * view of each question, stable for the duration of this session, at ~20%.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import { useUserInstitution } from "@/hooks/useUserInstitution";
import { useUnifiedQuestions } from "@/hooks/useUnifiedQuestions";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  ArrowLeft,
  CheckCircle2,
  ClipboardCheck,
  List,
  Loader2,
} from "lucide-react";
import {
  QuestionEvaluationForm,
  type QuestionEvaluationFormHandle,
  type QuestionEvaluationRow,
} from "@/components/evaluator/QuestionEvaluationForm";
import type { ProblemCategoryCode } from "@/components/evaluator/rubric";
import { EvaluatorNavBar } from "@/components/evaluator/EvaluatorNavBar";
import { EvaluatorMobileActionBar } from "@/components/evaluator/EvaluatorMobileActionBar";
import {
  EvaluationSessionSummaryDialog,
  type FlaggedQuestion,
} from "@/components/evaluator/EvaluationSessionSummaryDialog";
import { SAMPLING_PROBABILITY } from "@/components/evaluator/rubric";
import { listDraftQuestionIds } from "@/components/evaluator/draftStorage";
import {
  clearSamplingDecisions,
  loadSamplingDecisions,
  saveSamplingDecisions,
} from "@/components/evaluator/samplingStorage";
import { TypeBadge } from "@/components/UnifiedQuestionsTable";
import {
  EvaluatorListFilters,
  type DifficultyFilter,
} from "@/components/evaluator/EvaluatorListFilters";
import type { QuestionType } from "@/types/question";

const AUTO_ADVANCE_STORAGE_KEY = "evaluator:autoAdvance";
const lastQuestionKey = (sessionId: string) => `evaluator:lastQuestion:${sessionId}`;

const EvaluatorReviewSession = () => {
  const { courseId } = useParams();
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const {
    isAdmin,
    isInstructor,
    isEvaluator,
    loading: institutionLoading,
  } = useUserInstitution(user?.id);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState(false);
  const [evaluationsLoaded, setEvaluationsLoaded] = useState(false);
  const [courseTitle, setCourseTitle] = useState<string | null>(null);
  const [selectedQuestionId, setSelectedQuestionId] = useState<string | null>(null);
  const [evaluationsByQuestionId, setEvaluationsByQuestionId] = useState<
    Record<string, QuestionEvaluationRow>
  >({});
  // Questions saved during *this* session (resumed sessions populate this from
  // existing rows whose session_id matches). Drives the progress counter and
  // the green checkmarks so they reflect work done in this sitting, not the
  // evaluator's lifetime history — the upsert moves a row's session_id on
  // re-save anyway, so cross-session checkmarks would otherwise mislead.
  const [savedThisSession, setSavedThisSession] = useState<Set<string>>(new Set());
  const [summaryOpen, setSummaryOpen] = useState(false);
  // Drawer for the mobile question list (#681). Desktop renders the list as a
  // persistent left rail and ignores this. We close the drawer as soon as the
  // evaluator picks a question so the form is in view immediately.
  const [listDrawerOpen, setListDrawerOpen] = useState(false);
  // Mirrors the form's transient `saving` flag so the mobile sticky action bar
  // can render its own spinner. We don't lift the rest of the form state.
  const [formSaving, setFormSaving] = useState(false);
  // Default ON: most evaluators want to rip through the bank, advancing as
  // they save. Persisted in localStorage so the preference survives across
  // sessions; the toggle lives in the nav bar.
  const [autoAdvance, setAutoAdvance] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem(AUTO_ADVANCE_STORAGE_KEY) !== "off";
  });

  // Triage filter state (#683). Page-local so it survives sheet open/close
  // and component re-mounts within the page, but resets on full reload —
  // triage is a workspace view, not a saved preference.
  const [searchTerm, setSearchTerm] = useState("");
  const [unevaluatedOnly, setUnevaluatedOnly] = useState(false);
  const [typeFilter, setTypeFilter] = useState<Set<QuestionType>>(new Set());
  const [difficultyFilter, setDifficultyFilter] = useState<DifficultyFilter>("all");

  // Sampling decisions are persisted to localStorage (#682) so a refresh
  // or accidental navigation finds the same sampled/unsampled pattern on
  // resume — without persistence, the dice re-roll on reload and a
  // sampled question could quietly stop asking for specialist ratings
  // mid-session. Keyed by session id (a single key per session keeps
  // writes cheap); the page's session lookup ensures we re-hydrate the
  // same row's decisions even after a Cmd+R. Lazy ref + lazy init is
  // intentional: the ref must keep its identity across renders and the
  // initial value depends on `sessionId` which arrives asynchronously,
  // so the load is gated behind `sessionId` below.
  const samplingDecisions = useRef<Record<string, boolean>>({});
  const samplingHydratedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!sessionId) return;
    if (samplingHydratedFor.current === sessionId) return;
    samplingDecisions.current = loadSamplingDecisions(sessionId);
    samplingHydratedFor.current = sessionId;
  }, [sessionId]);

  // Questions with active local drafts (#682). Maintained alongside
  // `savedThisSession` so the question list can render a small dot next to
  // questions the evaluator has touched but not yet committed. Seeded by
  // scanning localStorage on mount so the dot is correct on a fresh
  // page load (not just after the form notifies us live).
  const [draftQuestionIds, setDraftQuestionIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!user) return;
    setDraftQuestionIds(new Set(listDraftQuestionIds(user.id)));
  }, [user]);

  // Ref to the active form's imperative handle, so the page-level keyboard
  // listener can call submit() and setVerdict() without lifting the form's
  // internal state into this component.
  const formRef = useRef<QuestionEvaluationFormHandle>(null);

  // Auth + role gates (match EvaluatorCourse for consistent UX).
  useEffect(() => {
    if (!authLoading && !user) {
      navigate("/auth");
      return;
    }
    if (!authLoading && !institutionLoading && user) {
      if (isAdmin || isInstructor) {
        navigate("/dashboard");
        return;
      }
      if (!isEvaluator) {
        navigate("/student");
      }
    }
  }, [user, isAdmin, isInstructor, isEvaluator, authLoading, institutionLoading, navigate]);

  // Resume an open session for this (evaluator, course) if one exists,
  // otherwise create one. The lookup-first pattern keeps refresh and Strict
  // Mode from leaving orphan rows behind, and makes the page safely
  // re-mountable.
  // RLS enforces that the user must be `is_course_evaluator(course_id, auth.uid())`.
  useEffect(() => {
    let cancelled = false;
    const startSession = async () => {
      if (!user || !courseId) return;
      try {
        const { data: open, error: lookupError } = await supabase
          .from("question_evaluation_sessions")
          .select("id")
          .eq("evaluator_id", user.id)
          .eq("course_id", courseId)
          .is("ended_at", null)
          .order("started_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (lookupError) throw lookupError;
        if (open) {
          if (!cancelled) setSessionId(open.id);
          return;
        }
        const { data, error } = await supabase
          .from("question_evaluation_sessions")
          .insert({ evaluator_id: user.id, course_id: courseId })
          .select("id")
          .single();
        if (error) throw error;
        if (!cancelled) setSessionId(data.id);
      } catch (err) {
        console.error("Failed to start evaluation session", err);
        if (!cancelled) setSessionError(true);
        toast.error("Δεν ήταν δυνατή η έναρξη της συνεδρίας");
      }
    };
    void startSession();
    return () => {
      cancelled = true;
    };
  }, [user, courseId]);

  // Course title for the header.
  useEffect(() => {
    const fetchCourse = async () => {
      if (!courseId) return;
      const { data } = await supabase
        .from("courses")
        .select("title")
        .eq("id", courseId)
        .maybeSingle();
      setCourseTitle(data?.title ?? null);
    };
    void fetchCourse();
  }, [courseId]);

  const { questions, loading: questionsLoading } = useUnifiedQuestions(courseId ?? "");

  // Load this evaluator's prior evaluations so re-opening a question
  // restores their last answers (acceptance criterion: "re-opening a
  // previously evaluated question loads the evaluator's prior answers").
  // Rows whose `session_id` matches the current session also seed
  // `savedThisSession`, so a resumed session shows its in-progress checkmarks.
  //
  // evaluationsLoaded gates the form so showSamplingFor is never called with
  // an empty evaluationsByQuestionId — without it, the first auto-selected
  // question rolls sampling dice before prior was_sampled=true rows arrive,
  // then the cached false decision survives the fetch and can null specialist
  // ratings on re-save (#678).
  useEffect(() => {
    const fetchExisting = async () => {
      if (!user || !sessionId) return;
      if (questions.length === 0) return;
      const ids = questions.map((q) => q.id);
      const { data, error } = await supabase
        .from("question_evaluations")
        .select("*")
        .eq("evaluator_id", user.id)
        .in("question_id", ids);
      if (error) {
        console.error("Failed to load existing evaluations", error);
        setEvaluationsLoaded(true);
        return;
      }
      const map: Record<string, QuestionEvaluationRow> = {};
      const sessionRows = new Set<string>();
      for (const row of (data ?? []) as QuestionEvaluationRow[]) {
        map[row.question_id] = row;
        if (row.session_id === sessionId) sessionRows.add(row.question_id);
      }
      setEvaluationsByQuestionId(map);
      setSavedThisSession(sessionRows);
      setEvaluationsLoaded(true);
    };
    void fetchExisting();
  }, [user, sessionId, questions]);

  // Pick the initial selection once questions + evaluations are loaded.
  // Preference order: the question the evaluator last viewed in this session
  // (resume), then the first unevaluated, then questions[0]. The resume path
  // matters most when the page is refreshed — without it, the evaluator
  // would lose their place and land back at the top of the list.
  useEffect(() => {
    if (selectedQuestionId || questions.length === 0 || !evaluationsLoaded || !sessionId) {
      return;
    }
    let resumed: string | null = null;
    if (typeof window !== "undefined") {
      const stored = window.localStorage.getItem(lastQuestionKey(sessionId));
      if (stored && questions.some((q) => q.id === stored)) {
        resumed = stored;
      }
    }
    if (resumed) {
      setSelectedQuestionId(resumed);
      return;
    }
    const firstUnevaluated = questions.find((q) => !savedThisSession.has(q.id));
    setSelectedQuestionId((firstUnevaluated ?? questions[0]).id);
  }, [questions, selectedQuestionId, evaluationsLoaded, sessionId, savedThisSession]);

  // Persist the current selection so a refresh restores it (#680). Scoped by
  // session id since the same evaluator may have multiple sessions across
  // courses; the key is cleared on session end.
  useEffect(() => {
    if (typeof window === "undefined" || !sessionId || !selectedQuestionId) return;
    window.localStorage.setItem(lastQuestionKey(sessionId), selectedQuestionId);
  }, [sessionId, selectedQuestionId]);

  // Persist auto-advance preference whenever the user toggles it.
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      AUTO_ADVANCE_STORAGE_KEY,
      autoAdvance ? "on" : "off",
    );
  }, [autoAdvance]);

  const selectedQuestion = useMemo(
    () => questions.find((q) => q.id === selectedQuestionId) ?? null,
    [questions, selectedQuestionId],
  );

  const currentIndex = useMemo(
    () => questions.findIndex((q) => q.id === selectedQuestionId),
    [questions, selectedQuestionId],
  );

  const goToIndex = useCallback(
    (next: number) => {
      if (next < 0 || next >= questions.length) return;
      setSelectedQuestionId(questions[next].id);
    },
    [questions],
  );

  // Wrap-once search for the next unevaluated. Wrapping is intentional: an
  // evaluator who reached the end and goes back to fix a couple of skipped
  // items still wants `u` to find them without manually clicking back to the
  // top of the list. Toast when nothing remains so the lack of motion is
  // explained.
  const findNextUnevaluatedFrom = useCallback(
    (fromIndex: number): number => {
      if (questions.length === 0) return -1;
      const start = Math.max(0, fromIndex);
      for (let i = start + 1; i < questions.length; i++) {
        if (!savedThisSession.has(questions[i].id)) return i;
      }
      for (let i = 0; i <= start && i < questions.length; i++) {
        if (!savedThisSession.has(questions[i].id)) return i;
      }
      return -1;
    },
    [questions, savedThisSession],
  );

  const handlePrev = useCallback(() => {
    if (currentIndex > 0) goToIndex(currentIndex - 1);
  }, [currentIndex, goToIndex]);

  const handleNext = useCallback(() => {
    if (currentIndex >= 0 && currentIndex < questions.length - 1) {
      goToIndex(currentIndex + 1);
    }
  }, [currentIndex, goToIndex, questions.length]);

  const handleJumpUnevaluated = useCallback(() => {
    const idx = findNextUnevaluatedFrom(currentIndex);
    if (idx === -1) {
      toast.info("Όλες οι ερωτήσεις αξιολογήθηκαν σε αυτή τη συνεδρία");
      return;
    }
    goToIndex(idx);
  }, [currentIndex, findNextUnevaluatedFrom, goToIndex]);

  const hasUnevaluated = useMemo(
    () => questions.some((q) => !savedThisSession.has(q.id)),
    [questions, savedThisSession],
  );

  // Flagged questions for the end-of-session summary (#683). Built from the
  // in-memory `evaluationsByQuestionId` map filtered to this session's rows
  // with a verdict of `needs_fixing`/`reject`, joined to `questions` for the
  // preview text — no extra fetch. The dialog uses this to surface "the
  // problems you found this session" instead of asking for a blank rewrite.
  const flaggedQuestions = useMemo<FlaggedQuestion[]>(() => {
    const out: FlaggedQuestion[] = [];
    for (const q of questions) {
      const row = evaluationsByQuestionId[q.id];
      if (!row || row.session_id !== sessionId) continue;
      if (row.verdict !== "needs_fixing" && row.verdict !== "reject") continue;
      out.push({
        questionId: q.id,
        preview: q.preview,
        verdict: row.verdict as "needs_fixing" | "reject",
        problemCategories: (row.problem_categories ?? []) as ProblemCategoryCode[],
      });
    }
    return out;
  }, [questions, evaluationsByQuestionId, sessionId]);

  // Triage filter pipeline (#683). Returns the subset of `questions` shown in
  // the list. Note: the keyboard nav (`j`/`k`/`u`) intentionally still walks
  // the FULL list — filters are a discovery view, not a hard slice of the
  // workspace, so an evaluator can narrow to a category and still hop to the
  // selected question's neighbours without the list rearranging under them.
  const filteredQuestions = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    return questions.filter((q) => {
      if (unevaluatedOnly && savedThisSession.has(q.id)) return false;
      if (typeFilter.size > 0 && !typeFilter.has(q.type)) return false;
      if (difficultyFilter !== "all" && q.difficulty !== difficultyFilter) return false;
      if (term.length > 0 && !q.searchText.toLowerCase().includes(term)) return false;
      return true;
    });
  }, [questions, searchTerm, unevaluatedOnly, typeFilter, difficultyFilter, savedThisSession]);

  const showSamplingFor = useCallback(
    (questionId: string) => {
      const prior = samplingDecisions.current[questionId];
      if (prior !== undefined) return prior;
      // If the evaluator has already saved a sampled row for this question
      // (possibly in an earlier session), honor that: re-rolling the dice
      // to `false` would hide the sampled block, and a re-save would null
      // the specialist ratings + cognitive_level (#678 made those nullable
      // gated by was_sampled). Keep the existing sampled judgments intact.
      const existing = evaluationsByQuestionId[questionId];
      const decision = existing?.was_sampled
        ? true
        : Math.random() < SAMPLING_PROBABILITY;
      samplingDecisions.current = {
        ...samplingDecisions.current,
        [questionId]: decision,
      };
      // Guard: only persist after hydration is complete. Writing before hydration
      // finishes would save a single-entry map and overwrite all stored decisions.
      if (sessionId && samplingHydratedFor.current === sessionId) {
        saveSamplingDecisions(sessionId, samplingDecisions.current);
      }
      return decision;
    },
    [evaluationsByQuestionId, sessionId],
  );

  const handleSaved = useCallback(
    (row: QuestionEvaluationRow) => {
      setEvaluationsByQuestionId((prev) => ({ ...prev, [row.question_id]: row }));
      let nextSaved: Set<string> | null = null;
      setSavedThisSession((prev) => {
        if (prev.has(row.question_id)) return prev;
        const next = new Set(prev);
        next.add(row.question_id);
        nextSaved = next;
        return next;
      });
      // Saving clears the local draft — drop it from the dot set too.
      setDraftQuestionIds((prev) => {
        if (!prev.has(row.question_id)) return prev;
        const next = new Set(prev);
        next.delete(row.question_id);
        return next;
      });
      // Auto-advance computed against the post-save savedThisSession so the
      // just-saved question doesn't count as "still unevaluated" and trap us
      // here on a single-item bank.
      if (autoAdvance) {
        const projected = nextSaved ?? savedThisSession;
        const fromIndex = questions.findIndex((q) => q.id === row.question_id);
        if (fromIndex === -1 || questions.length <= 1) return;
        for (let i = fromIndex + 1; i < questions.length; i++) {
          if (!projected.has(questions[i].id)) {
            setSelectedQuestionId(questions[i].id);
            return;
          }
        }
        for (let i = 0; i < fromIndex; i++) {
          if (!projected.has(questions[i].id)) {
            setSelectedQuestionId(questions[i].id);
            return;
          }
        }
      }
    },
    [autoAdvance, questions, savedThisSession],
  );

  // Server confirmed the optimistic save — overwrite the predicted row with
  // the authoritative server one so future re-renders carry the real id
  // and updated_at. Doesn't touch savedThisSession or auto-advance (those
  // already moved on the optimistic call).
  const handleSaveConfirmed = useCallback((row: QuestionEvaluationRow) => {
    setEvaluationsByQuestionId((prev) => ({ ...prev, [row.question_id]: row }));
  }, []);

  // Server rejected the optimistic save — roll back the question to the
  // pre-optimistic row (or remove it entirely if this was a first save).
  // The form is responsible for restoring its own local draft so the
  // user's input survives the failure.
  const handleSaveFailed = useCallback(
    (questionId: string, previous: QuestionEvaluationRow | null) => {
      setEvaluationsByQuestionId((prev) => {
        const next = { ...prev };
        if (previous) {
          next[questionId] = previous;
        } else {
          delete next[questionId];
        }
        return next;
      });
      setSavedThisSession((prev) => {
        // Only drop from the saved set if there's no prior committed row.
        // A re-save that fails should still leave the question marked saved
        // (the prior commit is what the server has).
        if (previous) return prev;
        if (!prev.has(questionId)) return prev;
        const next = new Set(prev);
        next.delete(questionId);
        return next;
      });
      // Form will rewrite its draft → the dirty dot should reappear.
      setDraftQuestionIds((prev) => {
        if (prev.has(questionId)) return prev;
        const next = new Set(prev);
        next.add(questionId);
        return next;
      });
    },
    [],
  );

  // Track per-question dirty status (#682). The form fires on transitions;
  // we maintain a Set so the question list can dot the touched questions
  // and the beforeunload handler knows whether to warn.
  const handleDirtyChange = useCallback(
    (questionId: string, dirty: boolean) => {
      setDraftQuestionIds((prev) => {
        const has = prev.has(questionId);
        if (dirty === has) return prev;
        const next = new Set(prev);
        if (dirty) next.add(questionId);
        else next.delete(questionId);
        return next;
      });
    },
    [],
  );

  // Stable per-selection callbacks so the form's `useEffect([isDirty, onDirtyChange])`
  // fires only on actual isDirty transitions, not on every parent re-render.
  const handleSaveFailedForSelected = useCallback(
    (prev: QuestionEvaluationRow | null) => {
      if (selectedQuestionId) handleSaveFailed(selectedQuestionId, prev);
    },
    [selectedQuestionId, handleSaveFailed],
  );

  const handleDirtyChangeForSelected = useCallback(
    (dirty: boolean) => {
      if (selectedQuestionId) handleDirtyChange(selectedQuestionId, dirty);
    },
    [selectedQuestionId, handleDirtyChange],
  );

  // Warn before unloading the tab when at least one question carries an
  // unsaved draft — guards against an accidental Cmd+W / page refresh from
  // discarding in-progress work (#682). Modern browsers ignore the custom
  // message and show their generic prompt; the `preventDefault` + setting
  // returnValue is the cross-browser dance that triggers it.
  useEffect(() => {
    if (draftQuestionIds.size === 0) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [draftQuestionIds]);

  const handleFinished = () => {
    setSummaryOpen(false);
    if (typeof window !== "undefined" && sessionId) {
      window.localStorage.removeItem(lastQuestionKey(sessionId));
      // Drop the per-session sampling cache when the session ends — a new
      // session for the same course rerolls from scratch (#682).
      clearSamplingDecisions(sessionId);
    }
    if (courseId) navigate(`/evaluator/course/${courseId}`);
  };

  // Global keyboard shortcuts (#680). Registered once and suppressed when
  // typing in a text field — matches SpacedRepetitionReview's pattern. The
  // submit / quick-verdict shortcuts dispatch through formRef so the form
  // owns its own state.
  useEffect(() => {
    const isTextInput = (el: EventTarget | null): boolean => {
      if (!(el instanceof HTMLElement)) return false;
      if (el.isContentEditable) return true;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      // ⌘/Ctrl+Enter saves regardless of focus — letting the evaluator press
      // it from inside the comment box is the whole point of a save shortcut.
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        formRef.current?.submit();
        return;
      }
      if (isTextInput(e.target)) return;
      // Skip when other modifier keys are held so OS shortcuts pass through.
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      switch (e.key) {
        case "j":
        case "ArrowRight":
          e.preventDefault();
          handleNext();
          return;
        case "k":
        case "ArrowLeft":
          e.preventDefault();
          handlePrev();
          return;
        case "u":
          e.preventDefault();
          handleJumpUnevaluated();
          return;
        case "1":
          e.preventDefault();
          formRef.current?.setVerdict("good");
          return;
        case "2":
          e.preventDefault();
          formRef.current?.setVerdict("needs_fixing");
          return;
        case "3":
          e.preventDefault();
          formRef.current?.setVerdict("reject");
          return;
        default:
          return;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleNext, handlePrev, handleJumpUnevaluated]);

  if (authLoading || institutionLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary/5 via-background to-secondary/10">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (sessionError) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-primary/5 via-background to-secondary/10">
        <div className="container mx-auto px-4 sm:px-6 py-8">
          <Button
            variant="ghost"
            size="sm"
            className="mb-6"
            onClick={() => courseId && navigate(`/evaluator/course/${courseId}`)}
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            Πίσω στο μάθημα
          </Button>
          <Card className="py-12">
            <CardContent className="text-center text-muted-foreground">
              Δεν ήταν δυνατή η έναρξη της συνεδρίας. Επικοινωνήστε με τον διαχειριστή σας.
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  if (!sessionId || questionsLoading || (questions.length > 0 && !evaluationsLoaded)) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary/5 via-background to-secondary/10">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  const evaluatedCount = savedThisSession.size;
  const progressValue =
    questions.length > 0 ? Math.round((evaluatedCount / questions.length) * 100) : 0;

  const handleSelectFromList = (id: string) => {
    setSelectedQuestionId(id);
    setListDrawerOpen(false);
  };

  const handleMobileSave = () => {
    formRef.current?.submit();
  };

  // Filtered list rendered inside both the desktop rail and the mobile sheet.
  // We accept a `variant` so the filter strip's test ids are addressable
  // independently for each instance — the underlying filter state is shared
  // (page-owned), so both strips stay in sync.
  const renderQuestionList = (variant: "mobile" | "desktop") => (
    <>
      <EvaluatorListFilters
        searchTerm={searchTerm}
        onSearchTermChange={setSearchTerm}
        unevaluatedOnly={unevaluatedOnly}
        onUnevaluatedOnlyChange={setUnevaluatedOnly}
        typeFilter={typeFilter}
        onTypeFilterChange={setTypeFilter}
        difficultyFilter={difficultyFilter}
        onDifficultyFilterChange={setDifficultyFilter}
        visibleCount={filteredQuestions.length}
        totalCount={questions.length}
        variant={variant}
      />
      <ul className="space-y-1 px-2 pt-2" data-testid={`question-list-${variant}`}>
        {filteredQuestions.map((q, idx) => {
          const done = savedThisSession.has(q.id);
          // Dirty dot only when the question has a draft AND it isn't already
          // committed in this session — saving moves the question into "done"
          // and clears the draft simultaneously, so showing both at once
          // would be redundant. Drafts attached to already-saved questions
          // (re-edits) still light up the dot via the `done && hasDraft` arm.
          const hasDraft = draftQuestionIds.has(q.id);
          const active = q.id === selectedQuestionId;
          return (
            <li key={q.id}>
              <button
                type="button"
                className={`w-full text-left px-2 py-2.5 rounded-md text-sm flex items-start gap-2 transition-colors ${
                  active
                    ? "bg-primary/10 border border-primary/30"
                    : "hover:bg-muted/60 border border-transparent"
                }`}
                onClick={() => handleSelectFromList(q.id)}
                data-testid={`question-list-item-${q.id}`}
              >
                <span className="text-xs text-muted-foreground w-5 shrink-0 mt-0.5">
                  {idx + 1}.
                </span>
                <span className="flex-1 line-clamp-3 break-words">
                  {q.preview}
                </span>
                {hasDraft ? (
                  <span
                    className="w-2 h-2 rounded-full bg-amber-500 shrink-0 mt-1.5"
                    aria-label="Μη αποθηκευμένες αλλαγές"
                    title="Μη αποθηκευμένες αλλαγές"
                    data-testid={`question-dirty-${q.id}`}
                  />
                ) : null}
                {done ? (
                  <CheckCircle2
                    className="w-4 h-4 text-green-600 shrink-0"
                    data-testid={`question-done-${q.id}`}
                  />
                ) : (
                  <Badge variant="outline" className="text-[10px] shrink-0">
                    <TypeBadge type={q.type} />
                  </Badge>
                )}
              </button>
            </li>
          );
        })}
        {questions.length === 0 ? (
          <li className="px-2 py-4 text-sm text-muted-foreground">
            Δεν υπάρχουν ερωτήσεις σε αυτό το μάθημα.
          </li>
        ) : filteredQuestions.length === 0 ? (
          <li
            className="px-2 py-4 text-sm text-muted-foreground"
            data-testid={`question-list-empty-${variant}`}
          >
            Καμία ερώτηση δεν ταιριάζει με τα φίλτρα.
          </li>
        ) : null}
      </ul>
    </>
  );

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary/5 via-background to-secondary/10">
      <nav className="border-b border-border bg-card/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-3 sm:px-6 py-2 sm:py-4 flex items-center gap-2 sm:gap-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => courseId && navigate(`/evaluator/course/${courseId}`)}
            aria-label="Πίσω στο μάθημα"
          >
            <ArrowLeft className="w-4 h-4 sm:mr-2" />
            <span className="hidden sm:inline">Πίσω στο μάθημα</span>
          </Button>
          <Sheet open={listDrawerOpen} onOpenChange={setListDrawerOpen}>
            <SheetTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="lg:hidden"
                aria-label="Άνοιγμα λίστας ερωτήσεων"
                data-testid="open-list-drawer"
              >
                <List className="w-4 h-4 sm:mr-2" />
                <span className="hidden sm:inline">Λίστα</span>
              </Button>
            </SheetTrigger>
            <SheetContent
              side="left"
              className="w-[88vw] sm:w-[420px] flex flex-col p-0"
              data-testid="question-list-drawer"
            >
              <SheetHeader className="px-4 pt-6 pb-3 border-b">
                <SheetTitle>Ερωτήσεις</SheetTitle>
              </SheetHeader>
              <ScrollArea className="flex-1">
                {renderQuestionList("mobile")}
              </ScrollArea>
            </SheetContent>
          </Sheet>
          <div className="flex flex-1 items-center gap-2 sm:gap-3 ml-auto sm:ml-4 min-w-0">
            <div className="hidden sm:flex items-center gap-2 flex-1 min-w-0 max-w-md">
              <ClipboardCheck className="w-4 h-4 text-muted-foreground shrink-0" />
              <Progress
                value={progressValue}
                className="h-2 flex-1"
                aria-label={`Πρόοδος αξιολόγησης: ${evaluatedCount} από ${questions.length}`}
                data-testid="session-progress"
              />
              <span
                className="text-xs text-muted-foreground tabular-nums whitespace-nowrap"
                data-testid="session-progress-label"
              >
                {evaluatedCount} / {questions.length}
              </span>
            </div>
            <span
              className="sm:hidden text-xs text-muted-foreground tabular-nums shrink-0"
              data-testid="session-progress-label-mobile"
            >
              {evaluatedCount}/{questions.length}
            </span>
            <Button
              size="sm"
              variant="default"
              onClick={() => setSummaryOpen(true)}
              data-testid="end-session-button"
              className="ml-auto"
            >
              <span className="hidden sm:inline">Ολοκλήρωση συνεδρίας</span>
              <span className="sm:hidden">Τέλος</span>
            </Button>
          </div>
        </div>
      </nav>

      <main className="container mx-auto px-4 sm:px-6 py-4 sm:py-6 lg:py-8">
        {courseTitle && (
          <h1 className="text-xl sm:text-2xl font-display font-bold text-foreground mb-4">
            {courseTitle}
          </h1>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-4 pb-24 lg:pb-0">
          <Card className="hidden lg:block lg:sticky lg:top-20 h-fit">
            <CardContent className="p-0">
              <ScrollArea className="h-[calc(100vh-200px)]">
                {renderQuestionList("desktop")}
              </ScrollArea>
            </CardContent>
          </Card>

          <div className="space-y-3">
            {questions.length > 0 && (
              <EvaluatorNavBar
                currentIndex={currentIndex}
                total={questions.length}
                hasUnevaluated={hasUnevaluated}
                autoAdvance={autoAdvance}
                onPrev={handlePrev}
                onNext={handleNext}
                onJumpUnevaluated={handleJumpUnevaluated}
                onToggleAutoAdvance={setAutoAdvance}
              />
            )}
            {selectedQuestion && user ? (
              <QuestionEvaluationForm
                ref={formRef}
                key={selectedQuestion.id}
                question={selectedQuestion}
                sessionId={sessionId}
                evaluatorId={user.id}
                showSampling={showSamplingFor(selectedQuestion.id)}
                existing={evaluationsByQuestionId[selectedQuestion.id] ?? null}
                onSaved={handleSaved}
                onSaveConfirmed={handleSaveConfirmed}
                onSaveFailed={handleSaveFailedForSelected}
                onSavingChange={setFormSaving}
                onDirtyChange={handleDirtyChangeForSelected}
              />
            ) : (
              <Card className="py-12">
                <CardContent className="text-center text-muted-foreground">
                  Επιλέξτε ερώτηση από τη λίστα για να ξεκινήσετε.
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </main>

      <EvaluatorMobileActionBar
        currentIndex={currentIndex}
        total={questions.length}
        saving={formSaving}
        onPrev={handlePrev}
        onNext={handleNext}
        onSave={handleMobileSave}
      />

      <EvaluationSessionSummaryDialog
        open={summaryOpen}
        onOpenChange={setSummaryOpen}
        sessionId={sessionId}
        flaggedQuestions={flaggedQuestions}
        onFinished={handleFinished}
      />
    </div>
  );
};

export default EvaluatorReviewSession;
