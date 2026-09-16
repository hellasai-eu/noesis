/**
 * UnifiedQuestionsTable (#621, trimmed in #623) — renders every question in
 * the bank in a single table regardless of type. Replaces the 5 per-type
 * sub-tabs.
 *
 * Layout: Checkbox? | Question (preview + type-aware) | Type | Difficulty |
 * Author | Classes? | Actions?
 *
 * Created date + vote counts moved into the expanded-row panel (#623) so
 * the Question column gets the freed width. The underlying data still
 * lives on the `UnifiedQuestion` shape — only the always-visible columns
 * collapsed.
 *
 * Expanded rows dispatch on `type` to the per-type panel in
 * `question-bank/expanded/`.
 *
 * Filters / search / URL-param sync live in the parent (UnifiedQuestionBank);
 * this component is the dumb table that receives an already-filtered list.
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ClipboardList,
  Eye,
  EyeOff,
  FilePlus2,
  ListChecks,
  MessageSquareText,
  PenLine,
  TextCursorInput,
  ArrowDownUp,
  LayoutGrid,
  MoreHorizontal,
  Pencil,
  ShieldCheck,
  Trash2,
  Users,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { formatQuestionText } from "@/lib/latex-utils";
import { getDifficultyClass } from "@/lib/difficulty-color";
import { AuthorCell } from "./QuestionMetaCells";
import { AssignedClassesBadges } from "./AssignedClassesBadges";
import { QuestionExpandedPanel } from "./question-bank/expanded";
import { QuestionEditorDialog, type SavedQuestion } from "./question-bank/editor";
import type {
  CourseClass,
  OfferingAssignment,
  OfferingGroup,
} from "@/types/content-assignments";
import type { QuestionType } from "@/types/question";
import type { UnifiedQuestion } from "@/lib/unified-question";
import {
  QUESTION_TYPE_LABELS,
  buildPreview,
  buildSearchText,
  openAnsweringModeFromPayload,
} from "@/lib/unified-question";
import { normalizeDifficulty } from "@/lib/question-editor";

interface UnifiedQuestionsTableProps {
  questions: UnifiedQuestion[];
  onQuestionsChange: (next: UnifiedQuestion[]) => void;
  isAdmin: boolean;
  classes?: CourseClass[];
  assignmentsByQuestionId?: Record<string, OfferingAssignment[]>;
  groupsByOffering?: Record<string, OfferingGroup[]>;
  onOpenAssignDialog?: (questionId: string) => void;
  onBulkAssign?: (questionIds: string[]) => void;
  /**
   * Create a quiz/test from the current selection, in place. Ids are passed
   * in table order so the new assessment matches what's on screen.
   */
  onCreateAssessment?: (kind: "quiz" | "test", questionIds: string[]) => void;
}

const TYPE_ICON: Record<QuestionType, typeof ListChecks> = {
  mcq: ListChecks,
  open: MessageSquareText,
  fill_gaps: TextCursorInput,
  ordering: ArrowDownUp,
  classification: LayoutGrid,
};

const TYPE_BADGE_CLASS: Record<QuestionType, string> = {
  mcq: "bg-blue-500/10 text-blue-600 border-blue-500/20",
  open: "bg-purple-500/10 text-purple-600 border-purple-500/20",
  fill_gaps: "bg-amber-500/10 text-amber-600 border-amber-500/20",
  ordering: "bg-emerald-500/10 text-emerald-600 border-emerald-500/20",
  classification: "bg-pink-500/10 text-pink-600 border-pink-500/20",
};

const difficultyClass = getDifficultyClass;

interface TypeBadgeProps {
  type: QuestionType;
}

export function TypeBadge({ type }: TypeBadgeProps) {
  const Icon = TYPE_ICON[type];
  return (
    <Badge
      variant="outline"
      className={`text-xs inline-flex items-center gap-1 ${TYPE_BADGE_CLASS[type]}`}
      data-testid={`type-badge-${type}`}
    >
      <Icon className="h-3 w-3" />
      {QUESTION_TYPE_LABELS[type]}
    </Badge>
  );
}

export function UnifiedQuestionsTable({
  questions,
  onQuestionsChange,
  isAdmin,
  classes,
  assignmentsByQuestionId,
  groupsByOffering,
  onOpenAssignDialog,
  onBulkAssign,
  onCreateAssessment,
}: UnifiedQuestionsTableProps) {
  const hasAssignments = !!(classes && classes.length > 0 && assignmentsByQuestionId);
  const [expandedRowId, setExpandedRowId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<UnifiedQuestion | null>(null);
  const [singleDeleting, setSingleDeleting] = useState(false);
  const [revalidatingIds, setRevalidatingIds] = useState<Set<string>>(new Set());
  const [editTargetId, setEditTargetId] = useState<string | null>(null);

  // Drop stale selections when the visible question list changes (e.g. filter or
  // search update). Without this, bulk-delete could silently delete questions
  // that the user can no longer see in the table.
  useEffect(() => {
    const currentIds = new Set(questions.map((q) => q.id));
    setSelectedIds((prev) => {
      const next = new Set([...prev].filter((id) => currentIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [questions]);

  const allSelected = questions.length > 0 && selectedIds.size === questions.length;
  const someSelected = selectedIds.size > 0 && !allSelected;

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelectedIds((prev) => {
      if (prev.size === questions.length) return new Set();
      return new Set(questions.map((q) => q.id));
    });
  }, [questions]);

  const handleDeleteOne = useCallback(async () => {
    if (!deleteTarget) return;
    setSingleDeleting(true);
    try {
      const { error } = await supabase
        .from("questions")
        .delete()
        .eq("id", deleteTarget.id);
      if (error) throw error;
      onQuestionsChange(questions.filter((q) => q.id !== deleteTarget.id));
      toast.success("Question deleted");
      setDeleteTarget(null);
    } catch (err) {
      console.error("Delete failed", err);
      toast.error("Failed to delete question");
    } finally {
      setSingleDeleting(false);
    }
  }, [deleteTarget, onQuestionsChange, questions]);

  // Rebuild the edited row in place from the columns the editor persisted, so
  // the table reflects the save without a full refetch — mirroring the
  // optimistic hidden/delete handlers. `preview`/`searchText` are recomputed
  // from the new raw so the Question column and in-page search stay correct.
  const handleSaved = useCallback(
    (saved: SavedQuestion) => {
      onQuestionsChange(
        questions.map((q) => {
          if (q.id !== saved.id) return q;
          const raw: UnifiedQuestion["raw"] = {
            ...q.raw,
            question: saved.columns.question,
            payload: saved.columns.payload,
            answer_key: saved.columns.answer_key,
            explanation: saved.columns.explanation,
          };
          return {
            ...q,
            raw,
            difficulty: normalizeDifficulty(saved.columns.difficulty),
            preview: buildPreview(saved.type, raw),
            searchText: buildSearchText(saved.type, raw),
            answeringMode:
              saved.type === "open" ? openAnsweringModeFromPayload(raw.payload) : q.answeringMode,
          };
        }),
      );
    },
    [onQuestionsChange, questions],
  );

  const handleBulkDelete = useCallback(async () => {
    if (selectedIds.size === 0) return;
    setBulkDeleting(true);
    const ids = Array.from(selectedIds);
    try {
      const { error } = await supabase.from("questions").delete().in("id", ids);
      if (error) throw error;
      const idSet = new Set(ids);
      onQuestionsChange(questions.filter((q) => !idSet.has(q.id)));
      toast.success(`Deleted ${ids.length} question${ids.length === 1 ? "" : "s"}`);
      setSelectedIds(new Set());
      setBulkDeleteOpen(false);
    } catch (err) {
      console.error("Bulk delete failed", err);
      toast.error("Failed to delete selected questions");
    } finally {
      setBulkDeleting(false);
    }
  }, [onQuestionsChange, questions, selectedIds]);

  const handleSetHidden = useCallback(
    async (id: string, hidden: boolean) => {
      try {
        const { error } = await supabase
          .from("questions")
          .update({ hidden })
          .eq("id", id);
        if (error) throw error;
        onQuestionsChange(
          questions.map((q) => (q.id === id ? { ...q, hidden } : q)),
        );
        toast.success(hidden ? "Question set to draft" : "Question set to ready");
      } catch (err) {
        console.error("Update hidden failed", err);
        toast.error("Failed to update question");
      }
    },
    [onQuestionsChange, questions],
  );

  /**
   * Re-run answer validation for one question (#1069).
   *
   * Questions are validated once, at generation time — `generate-questions`
   * calls the shared `validateGeneratedAnswers` and stamps
   * `validation_status` / `_confidence` / `_message` / `validated_at` onto the
   * row. Nothing re-runs it afterwards, so an edited question keeps the verdict
   * its ORIGINAL content earned. The `validate-questions` function exists to
   * redo it and writes the fresh verdict back itself; until now it had no
   * caller in the live bank (its only one, the legacy QuestionsTable, is
   * mounted nowhere).
   *
   * That verdict is load-bearing rather than cosmetic: AssessmentQuestionBank's
   * `isMcqVerified` hides any MCQ that is not CORRECT with confidence > 0.7,
   * and the student practice query drops rows whose status is INCORRECT.
   *
   * The result is reported by toast because `UnifiedQuestion` carries no
   * validation fields, so there is no cell to refresh — the write happens
   * server-side and is picked up on the next load of a surface that reads it.
   */
  const handleRevalidate = useCallback(async (id: string) => {
    setRevalidatingIds((prev) => new Set(prev).add(id));
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");

      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/validate-questions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.access_token}`,
            apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
          },
          body: JSON.stringify({ questionIds: [id] }),
        },
      );

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Validation failed (${response.status})`);
      }

      const result = (await response.json())?.results?.[0];
      if (!result) throw new Error("Validation returned no verdict");

      // The verdict IS the outcome here, so surface it rather than a bare
      // "done" — a silent success would leave the instructor unable to tell
      // CORRECT from INCORRECT without leaving the page.
      const confidence = `${Math.round((result.confidence ?? 0) * 100)}% confident`;
      if (result.passed) {
        toast.success(`Revalidated: ${result.verdict} — ${confidence}`);
      } else {
        toast.warning(`Revalidated: ${result.verdict} — ${confidence}`, {
          description: result.message || undefined,
        });
      }
    } catch (err) {
      console.error("Revalidate failed", err);
      toast.error(err instanceof Error ? err.message : "Failed to revalidate question");
    } finally {
      setRevalidatingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, []);

  const handleBulkSetHidden = useCallback(
    async (hidden: boolean) => {
      if (selectedIds.size === 0) return;
      const ids = Array.from(selectedIds);
      try {
        const { error } = await supabase
          .from("questions")
          .update({ hidden })
          .in("id", ids);
        if (error) throw error;
        const idSet = new Set(ids);
        onQuestionsChange(
          questions.map((q) => (idSet.has(q.id) ? { ...q, hidden } : q)),
        );
        toast.success(
          `Set ${ids.length} question${ids.length === 1 ? "" : "s"} to ${
            hidden ? "draft" : "ready"
          }`,
        );
      } catch (err) {
        console.error("Bulk hidden failed", err);
        toast.error("Failed to update selected questions");
      }
    },
    [onQuestionsChange, questions, selectedIds],
  );

  const expandedColspan = useMemo(() => {
    let cols = 1 /* preview */ + 1 /* type */ + 1 /* difficulty */ + 1 /* author */;
    if (isAdmin) cols += 1 /* checkbox */ + 1 /* actions */;
    if (hasAssignments) cols += 1;
    return cols;
  }, [isAdmin, hasAssignments]);

  if (questions.length === 0) {
    return (
      <div className="py-12 text-center text-muted-foreground">
        No questions match the current filters.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {isAdmin && selectedIds.size > 0 && (
        <div
          className="flex items-center gap-3 px-3 py-2 rounded-md border bg-muted/30"
          data-testid="bulk-actions-bar"
        >
          <span className="text-sm font-medium">
            {selectedIds.size} selected
          </span>
          <div className="flex items-center gap-2 ml-auto">
            {onCreateAssessment && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid="bulk-create-assessment-trigger"
                  >
                    <FilePlus2 className="w-4 h-4 mr-2" />
                    Create…
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onClick={() =>
                      // Table order, not click order — the new assessment
                      // should read the way the screen does.
                      onCreateAssessment(
                        "quiz",
                        questions.filter((q) => selectedIds.has(q.id)).map((q) => q.id),
                      )
                    }
                    data-testid="bulk-create-quiz"
                  >
                    <ClipboardList className="w-4 h-4 mr-2" />
                    Quiz (online)
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() =>
                      onCreateAssessment(
                        "test",
                        questions.filter((q) => selectedIds.has(q.id)).map((q) => q.id),
                      )
                    }
                    data-testid="bulk-create-test"
                  >
                    <PenLine className="w-4 h-4 mr-2" />
                    Test (printed)
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {onBulkAssign && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => onBulkAssign(Array.from(selectedIds))}
              >
                <Users className="w-4 h-4 mr-2" />
                Assign
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => handleBulkSetHidden(true)}
            >
              <EyeOff className="w-4 h-4 mr-2" />
              Set Draft
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => handleBulkSetHidden(false)}
            >
              <Eye className="w-4 h-4 mr-2" />
              Set Ready
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => setBulkDeleteOpen(true)}
            >
              <Trash2 className="w-4 h-4 mr-2" />
              Delete
            </Button>
          </div>
        </div>
      )}

      <div className="rounded-md border overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              {isAdmin && (
                <TableHead className="w-10">
                  <Checkbox
                    checked={allSelected ? true : someSelected ? "indeterminate" : false}
                    onCheckedChange={toggleSelectAll}
                    aria-label="Select all questions"
                  />
                </TableHead>
              )}
              <TableHead className="w-[40%]">Question</TableHead>
              <TableHead className="hidden md:table-cell">Type</TableHead>
              <TableHead className="hidden md:table-cell">Difficulty</TableHead>
              <TableHead className="hidden lg:table-cell">Author</TableHead>
              {hasAssignments && (
                <TableHead className="hidden xl:table-cell">Classes</TableHead>
              )}
              {isAdmin && <TableHead className="text-right">Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {questions.map((q) => {
              const isExpanded = expandedRowId === q.id;
              const targets =
                hasAssignments && assignmentsByQuestionId
                  ? assignmentsByQuestionId[q.id] ?? []
                  : [];
              return (
                <Fragment key={q.id}>
                  <TableRow
                    data-testid={`question-row-${q.id}`}
                    className={`cursor-pointer ${q.hidden ? "opacity-50" : ""}`}
                    onClick={() =>
                      setExpandedRowId((curr) => (curr === q.id ? null : q.id))
                    }
                  >
                    {isAdmin && (
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          checked={selectedIds.has(q.id)}
                          onCheckedChange={() => toggleSelect(q.id)}
                          aria-label="Select question"
                        />
                      </TableCell>
                    )}
                    <TableCell className="w-[40%]">
                      <div className="flex flex-col gap-1">
                        <div
                          className="text-sm line-clamp-2"
                          dangerouslySetInnerHTML={{
                            __html: formatQuestionText(q.preview),
                          }}
                        />
                        <div className="md:hidden flex flex-wrap items-center gap-1">
                          <TypeBadge type={q.type} />
                          <Badge
                            variant="outline"
                            className={`text-xs capitalize ${difficultyClass(q.difficulty)}`}
                          >
                            {q.difficulty}
                          </Badge>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <TypeBadge type={q.type} />
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <Badge
                        variant="outline"
                        className={`text-xs capitalize ${difficultyClass(q.difficulty)}`}
                      >
                        {q.difficulty}
                      </Badge>
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      <AuthorCell
                        createdBy={q.createdBy}
                        authorName={q.authorName}
                      />
                    </TableCell>
                    {hasAssignments && (
                      <TableCell
                        className="hidden xl:table-cell"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <AssignedClassesBadges
                          classes={classes ?? []}
                          assignedTargets={targets.map((t) => ({
                            offering_id: t.offering_id,
                            group_id: t.group_id ?? null,
                          }))}
                          groupsByOffering={groupsByOffering}
                          onClickAssign={
                            onOpenAssignDialog
                              ? () => onOpenAssignDialog(q.id)
                              : undefined
                          }
                          compact
                        />
                      </TableCell>
                    )}
                    {isAdmin && (
                      <TableCell
                        className="text-right"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label="Question actions"
                            >
                              <MoreHorizontal className="w-4 h-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {onOpenAssignDialog && classes && classes.length > 0 && (
                              <DropdownMenuItem
                                onClick={() => onOpenAssignDialog(q.id)}
                              >
                                <Users className="w-4 h-4 mr-2" />
                                Assign
                              </DropdownMenuItem>
                            )}
                            {/*
                              MCQ only. The validator judges a marked answer
                              against the stem, which needs an option list and a
                              correct index; `validate-questions` accordingly
                              serves mcq alone and answers 422 for anything
                              else. Offering the action on the other four types
                              would guarantee an error toast.
                            */}
                            {q.type === "mcq" && (
                              <DropdownMenuItem
                                disabled={revalidatingIds.has(q.id)}
                                // The menu closes on select by default, which
                                // would unmount the item mid-request and lose
                                // the pending state the user is looking at.
                                onSelect={(e) => {
                                  e.preventDefault();
                                  handleRevalidate(q.id);
                                }}
                                data-testid={`revalidate-${q.id}`}
                              >
                                <ShieldCheck className="w-4 h-4 mr-2" />
                                {revalidatingIds.has(q.id) ? "Revalidating…" : "Revalidate"}
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem
                              onClick={() => setEditTargetId(q.id)}
                              data-testid={`edit-question-${q.id}`}
                            >
                              <Pencil className="w-4 h-4 mr-2" />
                              Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => handleSetHidden(q.id, !q.hidden)}
                            >
                              {q.hidden ? (
                                <>
                                  <Eye className="w-4 h-4 mr-2" />
                                  Set Ready
                                </>
                              ) : (
                                <>
                                  <EyeOff className="w-4 h-4 mr-2" />
                                  Set Draft
                                </>
                              )}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="text-destructive focus:text-destructive"
                              onClick={() => setDeleteTarget(q)}
                            >
                              <Trash2 className="w-4 h-4 mr-2" />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    )}
                  </TableRow>
                  {isExpanded && (
                    <TableRow>
                      <TableCell
                        colSpan={expandedColspan}
                        className="bg-muted/20 p-4"
                        data-testid={`question-expanded-${q.id}`}
                      >
                        <QuestionExpandedPanel
                          question={q}
                          onClose={() => setExpandedRowId(null)}
                          isAdmin={isAdmin}
                        />
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <AlertDialog
        open={bulkDeleteOpen}
        onOpenChange={(open) => !bulkDeleting && setBulkDeleteOpen(open)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {selectedIds.size} question{selectedIds.size === 1 ? "" : "s"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the selected questions across all
              question types. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={bulkDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={bulkDeleting}
              onClick={(e) => {
                e.preventDefault();
                void handleBulkDelete();
              }}
            >
              {bulkDeleting ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !singleDeleting && !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this question?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the question. This action cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={singleDeleting}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={singleDeleting}
              onClick={(e) => {
                e.preventDefault();
                void handleDeleteOne();
              }}
            >
              {singleDeleting ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <QuestionEditorDialog
        questionId={editTargetId}
        open={editTargetId !== null}
        onOpenChange={(open) => {
          if (!open) setEditTargetId(null);
        }}
        onSaved={handleSaved}
      />
    </div>
  );
}
