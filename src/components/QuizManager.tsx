import { useState, useEffect, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AssessmentQuestionBank,
  AssessmentBuilderPanel,
  AssessmentList,
  QuestionTypePreview,
  type Competency,
  type AssessmentQuestion,
  type AssessmentItem,
} from "@/components/assessment";
import { buildClassDisplayName } from "@/lib/greek-school";
import { useUnifiedQuestions } from "@/hooks/useUnifiedQuestions";
import { type UnifiedQuestion } from "@/lib/unified-question";
import { toast } from "sonner";
import {
  ArrowLeft,
  Eye,
  EyeOff,
  PlayCircle,
  School,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { fetchAuthorNames } from "@/lib/author-names";
import { AssignedQuizzesBoard } from "@/components/quiz/AssignedQuizzesBoard";
import { QuizResultsDialog, type QuizResultsTab } from "@/components/quiz/QuizResultsDialog";
import { ContentAssignDialog } from "@/components/ContentAssignDialog";
import { useContentAssignments } from "@/hooks/useContentAssignments";
import type { AssignSelection, CourseClass } from "@/types/content-assignments";
import { isoToLocalInputs, localInputsToIso } from "@/lib/assign-due-dates";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Quiz {
  id: string;
  title: string;
  description: string | null;
  is_published: boolean;
  time_limit_minutes: number | null;
  created_at: string;
  created_by: string | null;
  author_name?: string | null;
  question_count?: number;
  assignment_count?: number;
}

/**
 * The offerings a dialog selection touches — whichever of the three selection
 * shapes the ContentAssignDialog handed back (see useContentAssignments'
 * normalizeSelection).
 */
function selectionToOfferingIds(selection: Set<string> | AssignSelection): string[] {
  if (selection instanceof Set) return [...selection];
  if (selection.kind === "offerings") return [...selection.offeringIds];
  return [...selection.perOffering.keys()];
}

interface QuizManagerProps {
  courseId: string;
  isAdmin: boolean;
  hideCreate?: boolean;
  /**
   * Classes linked to this course, for the shared assign dialog. Without them
   * the assign actions are withheld (same contract as StudyGuideManager).
   */
  classes?: CourseClass[];
  /**
   * Open this quiz's results dialog once the list loads — the instructor
   * home's "See results" deep link (?quiz=<id>). Consumed once, so closing
   * the dialog doesn't reopen it.
   */
  initialReportQuizId?: string | null;
  /**
   * Fired the moment the deep link above is consumed. The parent uses it to
   * strip `?quiz=` from the URL — without that, leaving this tab and coming
   * back remounts the manager against the same param and the dialog pops
   * again on every return.
   */
  onInitialReportConsumed?: () => void;
}

export const QuizManager = ({
  courseId,
  isAdmin,
  hideCreate = false,
  classes = [],
  initialReportQuizId = null,
  onInitialReportConsumed,
}: QuizManagerProps) => {
  // List view state
  const [quizzes, setQuizzes] = useState<AssessmentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'list' | 'builder'>('list');
  const [editingQuiz, setEditingQuiz] = useState<Quiz | null>(null);

  // Builder state — bank is the unified question loader (#653 widened it to
  // include all 5 non-interactive types). The legacy mcqQuestions array is gone;
  // type-specific reads happen via question-payload helpers against `q.raw`.
  const { questions: bankQuestions } = useUnifiedQuestions(courseId, {
    excludeInteractiveOpen: true,
    excludeUserGenerated: true,
  });
  const [competencies, setCompetencies] = useState<Competency[]>([]);
  const [competencyByQuestionId, setCompetencyByQuestionId] = useState<
    Record<string, string | null>
  >({});
  const [validationByQuestionId, setValidationByQuestionId] = useState<
    Record<
      string,
      {
        status:
          | "CORRECT"
          | "PARTIALLY_CORRECT"
          | "INCORRECT"
          | "INSUFFICIENT_INFORMATION"
          | null;
        confidence: number | null;
      }
    >
  >({});
  const [quizQuestions, setQuizQuestions] = useState<AssessmentQuestion[]>([]);
  const [quizTitle, setQuizTitle] = useState("");
  const [quizDescription, setQuizDescription] = useState("");
  const [saving, setSaving] = useState(false);

  // Preview state
  const [showPreview, setShowPreview] = useState(false);
  const [previewCurrentIndex, setPreviewCurrentIndex] = useState(0);
  const [previewShowAnswer, setPreviewShowAnswer] = useState(false);

  /**
   * The results dialog, plus which of its panels to open on. The AI class
   * assessment gets its own row action (like the study-guide table), so that
   * button lands directly on the Assessment tab.
   */
  const [results, setResults] = useState<{
    quiz: AssessmentItem;
    tab: QuizResultsTab;
  } | null>(null);
  const [initialReportConsumed, setInitialReportConsumed] = useState(false);

  // Per-quiz tracking & management dialog (submissions, publish/close, due
  // dates) — the embedded AssignedQuizzesBoard scoped to one quiz.
  const [manageQuiz, setManageQuiz] = useState<AssessmentItem | null>(null);

  // Quiz whose row-level mark-done/reopen write is in flight.
  const [doneBusyId, setDoneBusyId] = useState<string | null>(null);

  // A new deep-link id re-arms the preselect; an id the list doesn't (yet)
  // contain stays un-consumed, so a later successful load can still open it,
  // while a stale id simply never fires.
  useEffect(() => {
    setInitialReportConsumed(false);
  }, [initialReportQuizId]);

  useEffect(() => {
    if (initialReportConsumed || !initialReportQuizId || loading) return;
    const item = quizzes.find((q) => q.id === initialReportQuizId);
    if (!item) return;
    setInitialReportConsumed(true);
    setResults({ quiz: item, tab: "students" });
    // Tell the parent so it can drop `?quiz=` from the URL — this manager
    // unmounts on every tab switch, and a param left in place would reopen
    // the results dialog on each return to the tab.
    onInitialReportConsumed?.();
  }, [initialReportConsumed, initialReportQuizId, loading, quizzes, onInitialReportConsumed]);

  // Shared assign dialog state — same shape as StudyGuideManager: the shared
  // hook owns the (offering, group) junction rows; the per-section due dates
  // live here and are written onto those rows after they exist.
  const [assignDialogOpen, setAssignDialogOpen] = useState(false);
  const [assignTargetId, setAssignTargetId] = useState<string | null>(null);
  // Due dates edited in the assign dialog, one per offering: two sections can
  // carry the same quiz with different deadlines.
  const [dueByOffering, setDueByOffering] = useState<
    Record<string, { date: string; time: string }>
  >({});

  const quizIds = useMemo(() => quizzes.map((q) => q.id), [quizzes]);
  const contentAssignments = useContentAssignments("quiz", quizIds, classes);

  useEffect(() => {
    fetchQuizzes();
    fetchCourseTagsForBank();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch on courseId change
  }, [courseId]);

  const fetchQuizzes = async () => {
    try {
      const { data, error } = await supabase
        .from("quizzes")
        .select(`
          *,
          quiz_questions(count),
          offering_quizzes(
            id, offering_id, group_id, published_at, closed_at, due_date,
            offerings(classes(name, grade_level_id, section_name, category, academic_period)),
            offering_groups(name)
          )
        `)
        .eq("course_id", courseId)
        .order("created_at", { ascending: false });

      if (error) throw error;

      const creatorIds = [...new Set((data || []).filter(q => q.created_by).map(q => q.created_by))];
      let authorMap: Record<string, string> = {};
      
      if (creatorIds.length > 0) {
        authorMap = await fetchAuthorNames(creatorIds);
      }

      const quizzesWithCount = (data || []).map((q: any) => {
        // Same state semantics as AssignedQuizzesBoard: draft = neither
        // timestamp, open = published and not closed, closed = closed_at set.
        const assignments: any[] = q.offering_quizzes || [];
        return {
          ...q,
          question_count: q.quiz_questions?.[0]?.count || 0,
          assignment_count: assignments.length,
          open_assignment_count: assignments.filter(a => a.published_at && !a.closed_at).length,
          closed_assignment_count: assignments.filter(a => a.closed_at).length,
          draft_assignment_count: assignments.filter(a => !a.published_at && !a.closed_at).length,
          assignments: assignments.map((a) => ({
            id: a.id,
            offeringId: a.offering_id,
            classLabel: a.offerings?.classes
              ? buildClassDisplayName(a.offerings.classes)
              : "Unknown class",
            groupId: a.group_id ?? null,
            groupName: a.offering_groups?.name ?? null,
            publishedAt: a.published_at ?? null,
            closedAt: a.closed_at ?? null,
            dueDate: a.due_date ?? null,
          })),
          author_name: q.created_by ? (authorMap[q.created_by] || "Unknown") : null,
        };
      });

      setQuizzes(quizzesWithCount);
    } catch (error: any) {
      console.error("Error fetching quizzes:", error);
      toast.error("Failed to load quizzes");
    } finally {
      setLoading(false);
    }
  };

  // useUnifiedQuestions (#621) handles the bank fetch end-to-end. We still
  // need course competencies (for the bank's competency filter) and a small
  // sidecar of competency / mcq-validation tags keyed by question id so the
  // bank can apply the per-mcq verification gate and competency filter
  // without rebuilding the unified loader.
  const fetchCourseTagsForBank = async () => {
    try {
      const { data: tagRows, error: tagsError } = await supabase
        .from("questions")
        .select("id, type, competency_id, validation_status, validation_confidence")
        .eq("course_id", courseId);

      if (tagsError) throw tagsError;

      const compMap: Record<string, string | null> = {};
      const valMap: Record<
        string,
        {
          status:
            | "CORRECT"
            | "PARTIALLY_CORRECT"
            | "INCORRECT"
            | "INSUFFICIENT_INFORMATION"
            | null;
          confidence: number | null;
        }
      > = {};
      (tagRows ?? []).forEach((row: any) => {
        compMap[row.id] = row.competency_id ?? null;
        if (row.type === "mcq") {
          valMap[row.id] = {
            status: row.validation_status ?? null,
            confidence: row.validation_confidence ?? null,
          };
        }
      });
      setCompetencyByQuestionId(compMap);
      setValidationByQuestionId(valMap);

      const { data: compData, error: compError } = await supabase
        .from("course_competencies")
        .select("id, title")
        .eq("course_id", courseId)
        .order("order_num", { ascending: true });

      if (compError) throw compError;
      setCompetencies(compData || []);
    } catch (error: any) {
      console.error("Error fetching course tags:", error);
    }
  };

  const fetchQuizQuestions = async (quizId: string) => {
    try {
      // Read the joined `questions.type` so existing rows hydrate with their
      // true type — quiz_questions has only an FK; the discriminator lives on
      // the unified questions row (#582).
      const { data, error } = await supabase
        .from("quiz_questions")
        .select("question_id, order_num, question:question_id(type)")
        .eq("quiz_id", quizId)
        .order("order_num", { ascending: true });

      if (error) throw error;

      let droppedCount = 0;
      const questions: AssessmentQuestion[] = (data || []).flatMap((qq: any) => {
        if (!qq.question_id) return [];
        const joinedType = qq.question?.type as
          | 'mcq'
          | 'open'
          | 'fill_gaps'
          | 'ordering'
          | 'classification'
          | undefined;
        if (!joinedType) {
          droppedCount++;
          return [];
        }
        const fullQuestion = bankQuestions.find((q) => q.id === qq.question_id);
        return [{
          id: qq.question_id,
          type: joinedType,
          question: fullQuestion?.preview || '',
          difficulty: fullQuestion?.difficulty || 'medium',
          points: 1,
          competency_id: competencyByQuestionId[qq.question_id] ?? null,
        }];
      });

      if (droppedCount > 0) {
        toast.warning(`${droppedCount} question(s) could not be loaded and were skipped.`);
      }
      setQuizQuestions(questions);
    } catch (error: any) {
      console.error("Error fetching quiz questions:", error);
    }
  };

  const handleCreateNew = () => {
    setEditingQuiz(null);
    setQuizTitle("");
    setQuizDescription("");
    setQuizQuestions([]);
    setView('builder');
  };

  const handleEdit = async (item: AssessmentItem) => {
    const quiz = quizzes.find(q => q.id === item.id);
    if (!quiz) return;
    
    setEditingQuiz(quiz as unknown as Quiz);
    setQuizTitle(quiz.title);
    setQuizDescription(quiz.description || "");
    
    await fetchQuizQuestions(quiz.id);
    setView('builder');
  };

  const handleDelete = async (id: string) => {
    try {
      const { error } = await supabase
        .from("quizzes")
        .delete()
        .eq("id", id);

      if (error) throw error;

      toast.success("Quiz deleted");
      fetchQuizzes();
    } catch (error: any) {
      console.error("Error deleting quiz:", error);
      toast.error("Failed to delete quiz");
    }
  };

  const openResults = (item: AssessmentItem, tab: QuizResultsTab) => {
    setResults({ quiz: item, tab });
  };

  /**
   * Mark every open published assignment of the quiz as done — the row-level
   * counterpart of the manage dialog's per-class "Mark as done". Goes through
   * the same RPC, which force-finalizes in-progress sessions; a bare
   * closed_at update would leave them dangling.
   *
   * The RPC is per-assignment, so a multi-class quiz cannot close
   * atomically: each result is inspected and a partial outcome is reported
   * as exactly that, naming the split. The refetch in `finally` then shows
   * the true mixed state — the row keeps its mark-done action while any
   * class is still open, so retrying is one click, and the Track & manage
   * dialog can always fix an individual class.
   */
  const handleMarkQuizDone = async (item: AssessmentItem) => {
    const openAssignments = (item.assignments ?? []).filter(
      (a) => a.publishedAt !== null && a.closedAt === null,
    );
    if (openAssignments.length === 0) return;
    setDoneBusyId(item.id);
    try {
      const results = await Promise.all(
        openAssignments.map(async (a) => ({
          classLabel: a.classLabel,
          error: (
            await supabase.rpc("mark_offering_quiz_done", { p_offering_quiz_id: a.id })
          ).error,
        })),
      );
      const failed = results.filter((r) => r.error);
      for (const f of failed) {
        console.error(`Error marking assignment done (${f.classLabel}):`, f.error);
      }
      if (failed.length === 0) {
        toast.success("Quiz marked as done — students can no longer start new attempts.");
      } else if (failed.length < results.length) {
        toast.error(
          `Marked ${results.length - failed.length} of ${results.length} class assignments as done — ${failed.length} failed (${failed
            .map((f) => f.classLabel)
            .join(", ")}). Click mark as done again to retry the rest.`,
        );
      } else {
        toast.error("Could not mark this quiz as done");
      }
    } catch (error: any) {
      console.error("Error marking quiz as done:", error);
      toast.error("Could not mark this quiz as done");
    } finally {
      setDoneBusyId(null);
      // Refetch even after a partial failure so the row shows the true state.
      await fetchQuizzes();
    }
  };

  /**
   * Reopen every closed assignment of the quiz. reopen_offering_quiz also
   * clears answers_released in the same statement — students can attempt the
   * quiz again, so they must not keep the answer key.
   *
   * Same per-assignment RPC and the same partial-outcome contract as
   * `handleMarkQuizDone`, with one difference in the recovery path: a
   * partially reopened quiz is no longer Done, so the row swaps to the
   * mark-done action — the classes that stayed closed are reopened from the
   * Track & manage dialog, and the failure toast says so.
   */
  const handleReopenQuiz = async (item: AssessmentItem) => {
    const closedAssignments = (item.assignments ?? []).filter(
      (a) => a.closedAt !== null,
    );
    if (closedAssignments.length === 0) return;
    setDoneBusyId(item.id);
    try {
      const results = await Promise.all(
        closedAssignments.map(async (a) => ({
          classLabel: a.classLabel,
          error: (
            await supabase.rpc("reopen_offering_quiz", { p_offering_quiz_id: a.id })
          ).error,
        })),
      );
      const failed = results.filter((r) => r.error);
      for (const f of failed) {
        console.error(`Error reopening assignment (${f.classLabel}):`, f.error);
      }
      if (failed.length === 0) {
        toast.success("Quiz reopened — students can start new attempts again.");
      } else if (failed.length < results.length) {
        toast.error(
          `Reopened ${results.length - failed.length} of ${results.length} class assignments — ${failed.length} failed (${failed
            .map((f) => f.classLabel)
            .join(", ")}). Reopen the remaining classes from the Track & manage dialog.`,
        );
      } else {
        toast.error("Could not reopen this quiz");
      }
    } catch (error: any) {
      console.error("Error reopening quiz:", error);
      toast.error("Could not reopen this quiz");
    } finally {
      setDoneBusyId(null);
      await fetchQuizzes();
    }
  };

  const handleOpenAssignDialog = (item: AssessmentItem) => {
    setAssignTargetId(item.id);
    // Prefill each class's due inputs from what is already saved for that
    // class (earliest across its rows, should whole-class and group rows ever
    // disagree), so reopening the dialog edits the current deadlines instead
    // of silently clearing them.
    const earliestByOffering = new Map<string, string>();
    for (const a of item.assignments ?? []) {
      if (!a.dueDate) continue;
      const current = earliestByOffering.get(a.offeringId);
      if (!current || a.dueDate < current) {
        earliestByOffering.set(a.offeringId, a.dueDate);
      }
    }
    const next: Record<string, { date: string; time: string }> = {};
    for (const [offeringId, iso] of earliestByOffering) {
      next[offeringId] = isoToLocalInputs(iso);
    }
    setDueByOffering(next);
    setAssignDialogOpen(true);
  };

  /**
   * Save the target selection through the shared hook, then write each
   * selected section's due date onto its assignment rows — the same two-step
   * StudyGuideManager performs, because due dates ride on the junction rows
   * and can only be written after those exist. One value per SECTION: each
   * selected offering's rows (whole-class and group alike) get that
   * offering's input, and an empty input clears that section's deadline.
   */
  const handleSaveAssign = async (selection: Set<string> | AssignSelection) => {
    if (!assignTargetId) return;
    const targetId = assignTargetId;

    await contentAssignments.saveAssignments([targetId], selection, false);

    const selectedOfferingIds = [...new Set(selectionToOfferingIds(selection))];
    let dueWriteFailed = false;
    for (const offeringId of selectedOfferingIds) {
      const inputs = dueByOffering[offeringId];
      const dueIso = localInputsToIso(inputs?.date ?? "", inputs?.time ?? "");
      const { error: dueError } = await supabase
        .from("offering_quizzes")
        .update({ due_date: dueIso })
        .eq("quiz_id", targetId)
        .eq("offering_id", offeringId);
      if (dueError) {
        console.error("Failed to save the due date", dueError);
        dueWriteFailed = true;
      }
    }
    if (dueWriteFailed) {
      toast.error("Assignments saved, but a due date could not be saved");
    }
    await fetchQuizzes();
    setAssignDialogOpen(false);
  };

  const handleAddQuestion = (question: UnifiedQuestion) => {
    if (quizQuestions.some(q => q.id === question.id)) {
      toast.error("Question already added");
      return;
    }

    setQuizQuestions(prev => [...prev, {
      id: question.id,
      type: question.type,
      question: question.preview,
      difficulty: question.difficulty,
      points: 1,
      competency_id: competencyByQuestionId[question.id] ?? null,
    }]);
    toast.success("Question added");
  };

  const handleRemoveQuestion = (id: string) => {
    setQuizQuestions(prev => prev.filter(q => q.id !== id));
  };

  const handleUpdatePoints = (id: string, points: number) => {
    setQuizQuestions(prev => prev.map(q => 
      q.id === id ? { ...q, points: Math.max(0, points) } : q
    ));
  };

  const handleMoveQuestion = (index: number, direction: 'up' | 'down') => {
    const newIndex = direction === 'up' ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= quizQuestions.length) return;
    
    const newQuestions = [...quizQuestions];
    [newQuestions[index], newQuestions[newIndex]] = [newQuestions[newIndex], newQuestions[index]];
    setQuizQuestions(newQuestions);
  };

  const handleSave = async () => {
    if (!quizTitle.trim()) {
      toast.error("Please enter a quiz title");
      return;
    }
    if (quizQuestions.length === 0) {
      toast.error("Please add at least one question");
      return;
    }

    setSaving(true);
    try {
      const { data: user } = await supabase.auth.getUser();

      if (editingQuiz) {
        const { error: quizError } = await supabase
          .from("quizzes")
          .update({
            title: quizTitle.trim(),
            description: quizDescription.trim() || null,
          })
          .eq("id", editingQuiz.id);

        if (quizError) throw quizError;

        const { error: deleteError } = await supabase
          .from("quiz_questions")
          .delete()
          .eq("quiz_id", editingQuiz.id);

        if (deleteError) throw deleteError;

        const quizQuestionsData = quizQuestions.map((q, index) => ({
          quiz_id: editingQuiz.id,
          question_id: q.id,
          order_num: index,
        }));

        const { error: insertError } = await supabase
          .from("quiz_questions")
          .insert(quizQuestionsData);

        if (insertError) throw insertError;

        toast.success("Quiz updated");
      } else {
        const { data: newQuiz, error: quizError } = await supabase
          .from("quizzes")
          .insert({
            course_id: courseId,
            title: quizTitle.trim(),
            description: quizDescription.trim() || null,
            is_published: true,
            created_by: user.user?.id,
          })
          .select()
          .single();

        if (quizError) throw quizError;

        const quizQuestionsData = quizQuestions.map((q, index) => ({
          quiz_id: newQuiz.id,
          question_id: q.id,
          order_num: index,
        }));

        const { error: insertError } = await supabase
          .from("quiz_questions")
          .insert(quizQuestionsData);

        if (insertError) throw insertError;

        toast.success("Quiz created");
      }

      fetchQuizzes();
      setView('list');
    } catch (error: any) {
      console.error("Error saving quiz:", error);
      toast.error(error.message || "Failed to save quiz");
    } finally {
      setSaving(false);
    }
  };

  const selectedQuestionIds = new Set(quizQuestions.map(q => q.id));

  if (!isAdmin) return null;

  if (view === 'list') {
    return (
      <>
        <AssessmentList
          mode="quiz"
          items={quizzes}
          loading={loading}
          onCreateNew={hideCreate ? undefined : handleCreateNew}
          onEdit={hideCreate ? undefined : handleEdit}
          onDelete={hideCreate ? undefined : handleDelete}
          onTogglePublish={undefined}
          onAssign={classes.length > 0 ? handleOpenAssignDialog : undefined}
          onResults={(item) => openResults(item, "students")}
          onAssessment={(item) => openResults(item, "assessment")}
          onManage={(item) => setManageQuiz(item)}
          onMarkDone={handleMarkQuizDone}
          onReopen={handleReopenQuiz}
          doneBusyId={doneBusyId}
        />

        {/* Track & manage dialog — the per-class assignment cards (publish,
            due dates, closure, submissions, analysis) scoped to one quiz. */}
        <Dialog
          open={!!manageQuiz}
          onOpenChange={(open) => {
            if (!open) setManageQuiz(null);
          }}
        >
          <DialogContent className="max-w-3xl max-h-[90vh] flex flex-col">
            <DialogHeader className="flex-shrink-0">
              <DialogTitle className="flex items-center gap-2">
                <School className="w-5 h-5" />
                {manageQuiz?.title}
              </DialogTitle>
              <DialogDescription>
                Track submissions per class, publish drafts, set due dates, and
                close or reopen this quiz.
              </DialogDescription>
            </DialogHeader>
            <div className="flex-1 overflow-y-auto -mx-6 px-6 pb-2">
              {manageQuiz && (
                <AssignedQuizzesBoard
                  courseId={courseId}
                  quizId={manageQuiz.id}
                  embedded
                  // Refresh the table row after each completed write (not on
                  // dialog close, which could race an in-flight mutation).
                  onAssignmentsMutated={() => fetchQuizzes()}
                />
              )}
            </div>
          </DialogContent>
        </Dialog>

        {/* Results dialog — Students + Assessment (Report | Follow up), the
            study-guide-style single surface for analytics and the AI eval. */}
        <QuizResultsDialog
          open={!!results}
          onOpenChange={(next) => !next && setResults(null)}
          quizId={results?.quiz.id ?? null}
          courseId={courseId}
          quizTitle={results?.quiz.title ?? "Quiz"}
          initialTab={results?.tab ?? "students"}
          onAssignmentsChanged={() => fetchQuizzes()}
        />

        {/* Shared assign dialog — multi-class, per-group and per-student
            targets with a due date per section, exactly like study guides.
            Per-class time limits are edited in the Track & manage dialog. */}
        {classes.length > 0 && assignTargetId && (
          <ContentAssignDialog
            open={assignDialogOpen}
            onOpenChange={setAssignDialogOpen}
            classes={classes}
            currentAssignedTargets={contentAssignments.getAssignedTargets(assignTargetId)}
            groupsByOffering={contentAssignments.groupsByOffering}
            onSave={handleSaveAssign}
            saving={contentAssignments.saving}
            title="Assign quiz"
            description="Choose which classes, groups or students get this quiz. Assigning publishes it to them right away."
            perOfferingControls={(cls, selected) =>
              selected ? (
                <div className="mt-3 ml-7 flex items-center gap-2">
                  <Label
                    htmlFor={`quiz-assign-due-date-${cls.offering_id}`}
                    className="whitespace-nowrap text-xs text-muted-foreground"
                  >
                    Due
                  </Label>
                  <Input
                    id={`quiz-assign-due-date-${cls.offering_id}`}
                    type="date"
                    className="h-8"
                    value={dueByOffering[cls.offering_id]?.date ?? ""}
                    onChange={(e) =>
                      setDueByOffering((prev) => ({
                        ...prev,
                        [cls.offering_id]: {
                          date: e.target.value,
                          time: prev[cls.offering_id]?.time ?? "",
                        },
                      }))
                    }
                    data-testid={`quiz-assign-due-date-${cls.offering_id}`}
                  />
                  <Input
                    type="time"
                    className="h-8"
                    value={dueByOffering[cls.offering_id]?.time ?? ""}
                    onChange={(e) =>
                      setDueByOffering((prev) => ({
                        ...prev,
                        [cls.offering_id]: {
                          date: prev[cls.offering_id]?.date ?? "",
                          time: e.target.value,
                        },
                      }))
                    }
                    aria-label={`Due time for ${cls.name}`}
                    data-testid={`quiz-assign-due-time-${cls.offering_id}`}
                  />
                </div>
              ) : null
            }
            extraControls={
              <p className="pt-2 text-xs text-muted-foreground">
                Due dates are optional and per class, so two sections can have
                different deadlines. Unselecting a class removes its
                assignment.
              </p>
            }
          />
        )}
      </>
    );
  }

  return (
    <div className="space-y-4">
      <Button
        variant="ghost"
        onClick={() => setView('list')}
        className="mb-2"
      >
        <ArrowLeft className="w-4 h-4 mr-2" />
        Back to Quizzes
      </Button>

      <div className="grid lg:grid-cols-3 gap-6">
        {/* Question Bank */}
        <div className="lg:col-span-2">
          <AssessmentQuestionBank
            questions={bankQuestions}
            competencies={competencies}
            competencyByQuestionId={competencyByQuestionId}
            validationByQuestionId={validationByQuestionId}
            selectedQuestionIds={selectedQuestionIds}
            onAddQuestion={handleAddQuestion}
            mode="quiz"
          />
        </div>

        {/* Builder Panel */}
        <div>
          <AssessmentBuilderPanel
            mode="quiz"
            title={quizTitle}
            onTitleChange={setQuizTitle}
            description={quizDescription}
            onDescriptionChange={setQuizDescription}
            questions={quizQuestions}
            onRemoveQuestion={handleRemoveQuestion}
            onUpdatePoints={handleUpdatePoints}
            onMoveQuestion={handleMoveQuestion}
            onPreview={() => {
              setPreviewCurrentIndex(0);
              setPreviewShowAnswer(false);
              setShowPreview(true);
            }}
            onSave={handleSave}
            saving={saving}
            isEditing={!!editingQuiz}
          />
        </div>
      </div>

      {/* Preview Dialog in Builder mode */}
      <Dialog open={showPreview} onOpenChange={setShowPreview}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <PlayCircle className="w-5 h-5" />
              Preview: {quizTitle || "Untitled Quiz"}
            </DialogTitle>
            <DialogDescription className="flex items-center gap-4">
              <span>{quizQuestions.length} questions</span>
            </DialogDescription>
          </DialogHeader>

          {quizQuestions.length > 0 ? (
            <div className="space-y-4 py-4">
              <div className="flex items-center justify-between text-sm text-muted-foreground">
                <span>Question {previewCurrentIndex + 1} of {quizQuestions.length}</span>
                {bankQuestions.find(bq => bq.id === quizQuestions[previewCurrentIndex]?.id) && (
                  <Badge
                    variant="outline"
                    className={
                      bankQuestions.find(bq => bq.id === quizQuestions[previewCurrentIndex]?.id)?.difficulty === "easy"
                        ? "text-green-600 border-green-600"
                        : bankQuestions.find(bq => bq.id === quizQuestions[previewCurrentIndex]?.id)?.difficulty === "hard"
                        ? "text-red-600 border-red-600"
                        : "text-amber-600 border-amber-600"
                    }
                  >
                    {bankQuestions.find(bq => bq.id === quizQuestions[previewCurrentIndex]?.id)?.difficulty}
                  </Badge>
                )}
              </div>

              {(() => {
                const currentQ = bankQuestions.find(bq => bq.id === quizQuestions[previewCurrentIndex]?.id);
                if (!currentQ) return null;
                return (
                  <QuestionTypePreview
                    question={currentQ}
                    showAnswer={previewShowAnswer}
                  />
                );
              })()}

              <Button
                variant="outline"
                onClick={() => setPreviewShowAnswer(!previewShowAnswer)}
                className="w-full"
              >
                {previewShowAnswer ? (
                  <>
                    <EyeOff className="w-4 h-4 mr-2" />
                    Hide Answer
                  </>
                ) : (
                  <>
                    <Eye className="w-4 h-4 mr-2" />
                    Show Answer
                  </>
                )}
              </Button>

              <div className="flex items-center justify-between pt-4 border-t">
                <Button
                  variant="outline"
                  onClick={() => {
                    setPreviewShowAnswer(false);
                    setPreviewCurrentIndex(prev => Math.max(0, prev - 1));
                  }}
                  disabled={previewCurrentIndex === 0}
                >
                  Previous
                </Button>
                <div className="flex gap-1">
                  {quizQuestions.map((_, idx) => (
                    <button
                      key={idx}
                      onClick={() => {
                        setPreviewCurrentIndex(idx);
                        setPreviewShowAnswer(false);
                      }}
                      className={`w-2 h-2 rounded-full transition-colors ${
                        idx === previewCurrentIndex
                          ? "bg-primary"
                          : "bg-muted-foreground/30 hover:bg-muted-foreground/50"
                      }`}
                    />
                  ))}
                </div>
                <Button
                  variant="outline"
                  onClick={() => {
                    setPreviewShowAnswer(false);
                    setPreviewCurrentIndex(prev => Math.min(quizQuestions.length - 1, prev + 1));
                  }}
                  disabled={previewCurrentIndex === quizQuestions.length - 1}
                >
                  Next
                </Button>
              </div>
            </div>
          ) : (
            <div className="py-8 text-center text-muted-foreground">
              <p>No questions added yet</p>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
};
