import { useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { MultiSelectFilter } from "@/components/question-bank/filters/MultiSelectFilter";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  BarChart2,
  CheckCircle2,
  ClipboardList,
  Plus,
  Loader2,
  Trash2,
  Edit,
  Eye,
  EyeOff,
  FileDown,
  Pencil,
  User,
  PenLine,
  RotateCcw,
  Search,
  Settings2,
  Sparkles,
  Lock,
  LockOpen,
  Users,
  X,
} from "lucide-react";
import { useFormatters } from "@/i18n/formatters";

/**
 * One offering_quizzes row, as the quiz table's Classes/Due columns need it.
 * Only meaningful in quiz mode.
 */
export interface QuizAssignmentInfo {
  id: string;
  offeringId: string;
  classLabel: string;
  /** Group (offering_group) id/name; null = whole class. */
  groupId: string | null;
  groupName: string | null;
  publishedAt: string | null;
  closedAt: string | null;
  dueDate: string | null;
}

export interface AssessmentItem {
  id: string;
  title: string;
  description: string | null;
  is_published: boolean;
  time_limit_minutes?: number | null;
  custom_header?: string | null;
  created_at: string;
  created_by: string | null;
  author_name?: string | null;
  question_count?: number;
  assignment_count?: number;
  // Per-assignment states (quiz mode). Same semantics as AssignedQuizzesBoard:
  // open = published and not closed, closed = closed_at set, draft = neither.
  open_assignment_count?: number;
  closed_assignment_count?: number;
  draft_assignment_count?: number;
  // Per-assignment detail for the quiz table's Classes and Due columns.
  assignments?: QuizAssignmentInfo[];
}

type QuizStatus = 'open' | 'closed' | 'draft' | 'unassigned';

// Every status a quiz currently has — one per badge its row displays. A quiz
// open in one class and closed in another carries both, and the chips count
// and match it under both.
const quizStatusesOf = (item: AssessmentItem): QuizStatus[] => {
  const statuses: QuizStatus[] = [];
  if ((item.open_assignment_count ?? 0) > 0) statuses.push('open');
  if ((item.closed_assignment_count ?? 0) > 0) statuses.push('closed');
  if ((item.draft_assignment_count ?? 0) > 0) statuses.push('draft');
  if ((item.assignment_count ?? 0) === 0) statuses.push('unassigned');
  return statuses;
};

// Dominant status, used only for ordering: an open assignment anywhere
// outranks a closed one, etc.
const quizStatusOf = (item: AssessmentItem): QuizStatus => quizStatusesOf(item)[0];

const QUIZ_STATUS_RANK: Record<QuizStatus, number> = {
  open: 0,
  closed: 1,
  draft: 2,
  unassigned: 3,
};

const QUIZ_STATUSES: QuizStatus[] = ['open', 'closed', 'draft', 'unassigned'];
// Test mode has only the is_published flag, so its "statuses" are that flag.
const TEST_STATUSES = ['published', 'hidden'] as const;

// One badge per status, reused by the row badges and the filter chips so the
// chips look exactly like what they filter (the question-bank TypeBadge trick).
function StatusBadge({ status, label }: { status: QuizStatus; label?: string }) {
  switch (status) {
    case 'open':
      return (
        <Badge
          variant="outline"
          className="border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
        >
          <LockOpen className="w-3 h-3 mr-1" />
          {label ?? 'Published · Open'}
        </Badge>
      );
    case 'closed':
      return (
        <Badge
          variant="outline"
          className="border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
        >
          <Lock className="w-3 h-3 mr-1" />
          {label ?? 'Published · Closed'}
        </Badge>
      );
    case 'draft':
      return <Badge variant="secondary">{label ?? 'Draft assignment'}</Badge>;
    case 'unassigned':
      return (
        <Badge variant="outline" className="text-muted-foreground">
          {label ?? 'Unassigned'}
        </Badge>
      );
  }
}

interface AssessmentListProps {
  mode: 'quiz' | 'test';
  items: AssessmentItem[];
  loading: boolean;
  onCreateNew?: () => void;
  onEdit?: (item: AssessmentItem) => void;
  onDelete?: (id: string) => void;
  onTogglePublish?: (item: AssessmentItem) => void;
  onPreview?: (item: AssessmentItem) => void;
  onExport?: (item: AssessmentItem) => void;
  onAssign?: (item: AssessmentItem) => void;
  /** Open the results dialog on its Students tab (quiz mode only). */
  onResults?: (item: AssessmentItem) => void;
  /** Open the results dialog on its AI Assessment tab (quiz mode only). */
  onAssessment?: (item: AssessmentItem) => void;
  /** Open per-class tracking & management for a quiz (quiz mode only). */
  onManage?: (item: AssessmentItem) => void;
  /** Close every open published assignment of a quiz (quiz mode only). */
  onMarkDone?: (item: AssessmentItem) => void;
  /** Reopen every closed assignment of a quiz (quiz mode only). */
  onReopen?: (item: AssessmentItem) => void;
  /** Quiz id whose mark-done/reopen write is in flight (quiz mode only). */
  doneBusyId?: string | null;
}

export function AssessmentList({
  mode,
  items,
  loading,
  onCreateNew,
  onEdit,
  onDelete,
  onTogglePublish,
  onPreview,
  onExport,
  onAssign,
  onResults,
  onAssessment,
  onManage,
  onMarkDone,
  onReopen,
  doneBusyId = null,
}: AssessmentListProps) {
  const { formatDate, formatTime, compareText } = useFormatters();
  const modeLabel = mode === 'quiz' ? 'Quiz' : 'Test';
  const modeLabelPlural = mode === 'quiz' ? 'Quizzes' : 'Tests';

  // Question-bank-style filters: search input, toggleable status chips
  // (all selected by default, like the bank's type chips), author multi-select.
  const allStatuses: readonly string[] = mode === 'quiz' ? QUIZ_STATUSES : TEST_STATUSES;
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedStatuses, setSelectedStatuses] = useState<Set<string>>(
    () => new Set(allStatuses)
  );
  const [selectedAuthors, setSelectedAuthors] = useState<Set<string>>(new Set());

  const statusesOf = (item: AssessmentItem): string[] =>
    mode === 'quiz' ? quizStatusesOf(item) : [item.is_published ? 'published' : 'hidden'];

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    allStatuses.forEach((s) => (counts[s] = 0));
    items.forEach((item) => statusesOf(item).forEach((s) => (counts[s] += 1)));
    return counts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, mode]);

  // Options keyed by creator id, not display name — two creators can share a
  // name (or both resolve to "Unknown") and must stay filterable apart.
  const authorOptions = useMemo(() => {
    const byId = new Map<string, { label: string; count: number }>();
    items.forEach((i) => {
      if (!i.created_by) return;
      const entry = byId.get(i.created_by);
      if (entry) entry.count += 1;
      else byId.set(i.created_by, { label: i.author_name ?? 'Unknown', count: 1 });
    });
    return [...byId.entries()]
      .map(([value, { label, count }]) => ({ value, label, count }))
      .sort((a, b) => compareText(a.label, b.label));
  }, [items, compareText]);

  const toggleStatus = (status: string) => {
    setSelectedStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  };

  const hasActiveFilters =
    searchQuery.trim() !== "" ||
    selectedStatuses.size < allStatuses.length ||
    selectedAuthors.size > 0;

  const clearFilters = () => {
    setSearchQuery("");
    setSelectedStatuses(new Set(allStatuses));
    setSelectedAuthors(new Set());
  };

  const visibleItems = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const filtered = items.filter((item) => {
      if (q && !`${item.title} ${item.description ?? ""}`.toLowerCase().includes(q)) return false;
      if (selectedAuthors.size > 0 && (!item.created_by || !selectedAuthors.has(item.created_by)))
        return false;
      if (!statusesOf(item).some((s) => selectedStatuses.has(s))) return false;
      return true;
    });
    if (mode !== 'quiz') return filtered;
    // Assigned-and-open first, then closed, drafts, unassigned. Stable sort
    // keeps the incoming created_at-desc order within each group.
    return [...filtered].sort(
      (a, b) => QUIZ_STATUS_RANK[quizStatusOf(a)] - QUIZ_STATUS_RANK[quizStatusOf(b)]
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, searchQuery, selectedStatuses, selectedAuthors, mode]);

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
          <CardTitle className="flex items-center gap-2">
            {mode === 'quiz' ? (
              <ClipboardList className="w-5 h-5" />
            ) : (
              <PenLine className="w-5 h-5" />
            )}
            {modeLabelPlural}
            {items.length > 0 && (
              <span className="text-sm font-normal text-muted-foreground">
                {hasActiveFilters
                  ? `(${visibleItems.length} of ${items.length})`
                  : `(${items.length} total)`}
              </span>
            )}
          </CardTitle>
          {onCreateNew && (
            <Button onClick={onCreateNew}>
              <Plus className="w-4 h-4 mr-2" />
              Create {modeLabel}
            </Button>
          )}
        </div>
        <CardDescription>
          {mode === 'quiz' 
            ? 'Online quizzes with multiple choice questions'
            : 'Tests for printing, in-class, or take-home use — supports MCQ and open questions'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <div className="py-12 text-center">
            {mode === 'quiz' ? (
              <ClipboardList className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
            ) : (
              <PenLine className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
            )}
            <p className="text-muted-foreground mb-2">No {modeLabelPlural.toLowerCase()} created yet</p>
            <p className="text-sm text-muted-foreground">
              Create a {modeLabel.toLowerCase()} to give students a structured set of questions
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder={`Search ${modeLabelPlural.toLowerCase()}...`}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
                data-testid="assessment-search-input"
              />
            </div>
            <div
              className="flex flex-wrap items-center gap-2"
              data-testid="assessment-status-chips"
            >
              <span className="text-xs uppercase tracking-wide text-muted-foreground">
                Status
              </span>
              {allStatuses.map((status) => {
                const active = selectedStatuses.has(status);
                return (
                  <button
                    key={status}
                    type="button"
                    onClick={() => toggleStatus(status)}
                    className={active ? "opacity-100" : "opacity-40 grayscale"}
                    data-testid={`status-chip-${status}`}
                    aria-pressed={active}
                  >
                    <span className="inline-flex items-center gap-1.5">
                      {mode === 'quiz' ? (
                        <StatusBadge
                          status={status as QuizStatus}
                          label={
                            { open: 'Open', closed: 'Closed', draft: 'Draft', unassigned: 'Unassigned' }[
                              status as QuizStatus
                            ]
                          }
                        />
                      ) : (
                        <Badge variant={status === 'published' ? 'default' : 'secondary'}>
                          {status === 'published' ? 'Available' : 'Hidden'}
                        </Badge>
                      )}
                      <Badge variant="secondary" className="text-[10px]">
                        {statusCounts[status]}
                      </Badge>
                    </span>
                  </button>
                );
              })}
            </div>
            {(authorOptions.length > 0 || hasActiveFilters) && (
              <div className="flex flex-wrap items-center gap-2">
                {authorOptions.length > 0 && (
                  <MultiSelectFilter
                    label="Author"
                    options={authorOptions}
                    selected={selectedAuthors}
                    onChange={setSelectedAuthors}
                    testId="assessment-author-filter"
                  />
                )}
                {hasActiveFilters && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={clearFilters}
                    className="ml-auto text-xs"
                    data-testid="assessment-clear-filters"
                  >
                    <X className="w-3 h-3 mr-1" />
                    Clear filters
                  </Button>
                )}
              </div>
            )}
            {visibleItems.length === 0 && (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No {modeLabelPlural.toLowerCase()} match the current filters
              </p>
            )}
            {visibleItems.length > 0 && mode === 'quiz' && (
              <Table data-testid="quiz-table">
                <TableHeader>
                  <TableRow>
                    <TableHead>Title</TableHead>
                    <TableHead className="whitespace-nowrap">Questions</TableHead>
                    <TableHead>Classes</TableHead>
                    <TableHead className="whitespace-nowrap">Due</TableHead>
                    <TableHead className="w-[208px] text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleItems.map((item) => {
                    const assignments = item.assignments ?? [];
                    // Earliest deadline across PUBLISHED assignments (the
                    // study-guide rule): a draft's deadline is not live for
                    // anyone yet, while a done quiz keeps showing the date it
                    // was due, next to its Done badge.
                    const due = assignments
                      .filter((a) => a.publishedAt !== null && a.dueDate)
                      .map((a) => a.dueDate as string)
                      .sort()[0] ?? null;
                    const openCount = assignments.filter(
                      (a) => a.publishedAt !== null && a.closedAt === null,
                    ).length;
                    const closedCount = assignments.filter(
                      (a) => a.closedAt !== null,
                    ).length;
                    // Done = at least one class got the quiz and every one of
                    // them is closed — the study-guide definition.
                    const isDone = closedCount > 0 && openCount === 0;
                    return (
                      <TableRow key={item.id} data-testid={`quiz-row-${item.id}`}>
                        <TableCell className="font-medium">
                          {item.title}
                          {item.description && (
                            <span
                              className="block max-w-[280px] truncate text-xs font-normal text-muted-foreground"
                              title={item.description}
                            >
                              {item.description}
                            </span>
                          )}
                          {item.author_name && (
                            <span className="block text-xs font-normal text-muted-foreground">
                              {item.author_name}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          {item.question_count || 0}
                          {item.time_limit_minutes ? (
                            <span className="ml-1 text-xs text-muted-foreground">
                              · {item.time_limit_minutes} min
                            </span>
                          ) : null}
                        </TableCell>
                        <TableCell>
                          {assignments.length === 0 ? (
                            onAssign ? (
                              /* Same quiet ghost Assign affordance the study
                                 guide table uses for an unassigned row. */
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-auto px-2 py-1 text-xs text-muted-foreground"
                                onClick={() => onAssign(item)}
                                title="No class has this quiz yet — click to assign it"
                                aria-label={`Assign ${item.title}`}
                                data-testid={`quiz-needs-assign-${item.id}`}
                              >
                                <Users className="w-3 h-3 mr-1" />
                                Assign
                              </Button>
                            ) : (
                              <span className="text-sm text-muted-foreground">—</span>
                            )
                          ) : (
                            <div className="flex flex-wrap items-center gap-1">
                              {assignments.map((a) => {
                                const isDraft =
                                  a.publishedAt === null && a.closedAt === null;
                                const badge = (
                                  <Badge
                                    variant="outline"
                                    className={
                                      isDraft
                                        ? "font-normal text-muted-foreground"
                                        : "font-normal"
                                    }
                                  >
                                    {a.classLabel}
                                    {a.groupName ? ` · ${a.groupName}` : ""}
                                    {isDraft ? " · Draft" : ""}
                                  </Badge>
                                );
                                // A draft is only publishable from the manage
                                // dialog, and the dialog's row action is
                                // withheld until something is closed — so the
                                // draft badge itself is the way in.
                                return isDraft && onManage ? (
                                  <button
                                    key={a.id}
                                    type="button"
                                    onClick={() => onManage(item)}
                                    title="Draft — not visible to students yet. Click to review and publish it."
                                    data-testid={`quiz-draft-badge-${a.id}`}
                                  >
                                    {badge}
                                  </button>
                                ) : (
                                  <span key={a.id}>{badge}</span>
                                );
                              })}
                              {onAssign && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-6 w-6 shrink-0"
                                  onClick={() => onAssign(item)}
                                  title="Assign to more classes"
                                  aria-label={`Assign ${item.title} to more classes`}
                                  data-testid={`quiz-assign-more-${item.id}`}
                                >
                                  <Plus className="w-3.5 h-3.5" />
                                </Button>
                              )}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          {isDone && (
                            <Badge
                              variant="outline"
                              className="mr-1.5 border-border bg-muted text-muted-foreground"
                              data-testid={`quiz-done-badge-${item.id}`}
                            >
                              Done
                            </Badge>
                          )}
                          {due ? (
                            <span
                              className="text-sm text-muted-foreground"
                              data-testid={`quiz-due-${item.id}`}
                            >
                              {formatDate(due)}{" "}
                              {formatTime(due, { hour: "2-digit", minute: "2-digit" })}
                            </span>
                          ) : isDone ? null : (
                            <span className="text-sm text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="w-[208px]">
                          <div className="flex flex-nowrap items-center justify-end gap-0.5">
                            {/* Results are live (like study guides): the
                                Students tab shows per-student status as they
                                submit, so it's offered as soon as any class
                                has the quiz published. */}
                            {onResults && openCount + closedCount > 0 && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                onClick={() => onResults(item)}
                                title="See how the class is doing"
                                aria-label={`Results for ${item.title}`}
                                data-testid={`quiz-results-${item.id}`}
                              >
                                <BarChart2 className="w-4 h-4" />
                              </Button>
                            )}
                            {/* Mark as done / reopen — only meaningful once
                                the quiz is out with a class. Done quizzes stay
                                readable; only new attempts are closed. */}
                            {onMarkDone &&
                              onReopen &&
                              (openCount > 0 || closedCount > 0) &&
                              (isDone ? (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8"
                                  onClick={() => onReopen(item)}
                                  disabled={doneBusyId === item.id}
                                  title="Reopen — let students submit again"
                                  aria-label={`Reopen ${item.title}`}
                                  data-testid={`quiz-reopen-${item.id}`}
                                >
                                  {doneBusyId === item.id ? (
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                  ) : (
                                    <RotateCcw className="w-4 h-4" />
                                  )}
                                </Button>
                              ) : (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8"
                                  onClick={() => onMarkDone(item)}
                                  disabled={doneBusyId === item.id}
                                  title="Mark as done — students can no longer submit"
                                  aria-label={`Mark ${item.title} as done`}
                                  data-testid={`quiz-mark-done-${item.id}`}
                                >
                                  {doneBusyId === item.id ? (
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                  ) : (
                                    <CheckCircle2 className="w-4 h-4" />
                                  )}
                                </Button>
                              ))}
                            {/* The AI assessment lives in the results dialog
                                (Report | Follow up sub-tabs), mirroring the
                                study-guide table's Sparkles action. */}
                            {onAssessment && openCount + closedCount > 0 && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                onClick={() => onAssessment(item)}
                                title="AI assessment of class understanding"
                                aria-label={`AI assessment for ${item.title}`}
                                data-testid={`quiz-assessment-${item.id}`}
                              >
                                <Sparkles className="w-4 h-4" />
                              </Button>
                            )}
                            {/* Track & manage — publish drafts, per-class due
                                dates, time limits, closure, answer release.
                                Available whenever anything is assigned; a
                                draft can only be published from here. */}
                            {onManage && assignments.length > 0 && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                onClick={() => onManage(item)}
                                title="Manage class assignments — publish drafts, due dates, time limits"
                                aria-label={`Manage ${item.title}`}
                                data-testid={`quiz-manage-${item.id}`}
                              >
                                <Settings2 className="w-4 h-4" />
                              </Button>
                            )}
                            {onEdit && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                onClick={() => onEdit(item)}
                                title="Edit"
                                aria-label={`Edit ${item.title}`}
                              >
                                <Pencil className="w-4 h-4" />
                              </Button>
                            )}
                            {onDelete && (
                              <AlertDialog>
                                <AlertDialogTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8 text-destructive hover:text-destructive"
                                    title="Delete"
                                    aria-label={`Delete ${item.title}`}
                                  >
                                    <Trash2 className="w-4 h-4" />
                                  </Button>
                                </AlertDialogTrigger>
                                <AlertDialogContent>
                                  <AlertDialogHeader>
                                    <AlertDialogTitle>Delete {modeLabel}</AlertDialogTitle>
                                    <AlertDialogDescription>
                                      Are you sure you want to delete "{item.title}"? This action cannot be undone.
                                    </AlertDialogDescription>
                                  </AlertDialogHeader>
                                  <AlertDialogFooter>
                                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                                    <AlertDialogAction
                                      onClick={() => onDelete(item.id)}
                                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                    >
                                      Delete
                                    </AlertDialogAction>
                                  </AlertDialogFooter>
                                </AlertDialogContent>
                              </AlertDialog>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
            {mode === 'test' && visibleItems.map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between p-4 border rounded-lg hover:bg-muted/50 transition-colors"
              >
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <h4 className="font-medium">{item.title}</h4>
                    <Badge variant={item.is_published ? "default" : "secondary"}>
                      {item.is_published ? "Available" : "Hidden"}
                    </Badge>
                  </div>
                  {item.description && (
                    <p className="text-sm text-muted-foreground line-clamp-1">
                      {item.description}
                    </p>
                  )}
                  <div className="flex items-center gap-2 text-xs text-muted-foreground mt-1 flex-wrap">
                    {item.author_name && (
                      <span className="flex items-center gap-1">
                        <User className="w-3 h-3" />
                        {item.author_name}
                      </span>
                    )}
                    <span>• {item.question_count || 0} questions</span>
                    <span>• Created {formatDate(item.created_at)}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {onTogglePublish && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => onTogglePublish(item)}
                      title={item.is_published ? "Hide" : "Publish"}
                    >
                      {item.is_published ? (
                        <EyeOff className="w-4 h-4" />
                      ) : (
                        <Eye className="w-4 h-4" />
                      )}
                    </Button>
                  )}
                  {onPreview && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => onPreview(item)}
                      title="Preview"
                    >
                      <Eye className="w-4 h-4" />
                    </Button>
                  )}
                  {onExport && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => onExport(item)}
                      title="Export PDF"
                    >
                      <FileDown className="w-4 h-4" />
                    </Button>
                  )}
                  {onEdit && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => onEdit(item)}
                      title="Edit"
                    >
                      <Edit className="w-4 h-4" />
                    </Button>
                  )}
                  {onDelete && (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-destructive hover:text-destructive"
                          title="Delete"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete {modeLabel}</AlertDialogTitle>
                          <AlertDialogDescription>
                            Are you sure you want to delete "{item.title}"? This action cannot be undone.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => onDelete(item.id)}
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                          >
                            Delete
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
