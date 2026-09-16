/**
 * #754 — Unified Practice Questions list (student).
 *
 * Renders every assigned practice question across all five types in a single
 * flat list with Type/Status filters. Consumes #753's
 * `useStudentPracticeQuestions` hook for both the data and the unified
 * completion status. The per-row action button selects a question and hands
 * that to the right answering UI via the embedded `PracticeAnsweringDispatcher`
 * (#756). Filter state and scroll position survive the round-trip into the
 * answering UI because the list DOM is kept mounted (display:none) while a
 * question is selected.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ArrowLeft,
  Loader2,
  Brain,
  CheckCircle,
  Clock,
  Play,
  Inbox,
  Shuffle,
} from "lucide-react";
import { formatQuestionText } from "@/lib/latex-utils";
import { getDifficultyClass } from "@/lib/difficulty-color";
import { useTranslation } from "react-i18next";
import type { QuestionType } from "@/types/question";
import {
  useStudentPracticeQuestions,
  type StudentPracticeQuestion,
  type StudentPracticeStatus,
} from "@/hooks/useStudentPracticeQuestions";
import { PracticeAnsweringDispatcher } from "./PracticeAnsweringDispatcher";
import { PracticeRandomRun } from "./PracticeRandomRun";
import { pickRandomRun } from "@/lib/practice-random-run";
import {
  DEFAULT_PAGE_SIZE,
  PaginationFooter,
} from "@/components/question-bank/filters/PaginationFooter";
import "katex/dist/katex.min.css";
import { useFormatters } from "@/i18n/formatters";

const RANDOM_RUN_SIZE = 10;

interface Props {
  courseId: string;
  courseTitle: string;
  /**
   * Side-channel notification when a row is selected. The list itself mounts
   * the answering dispatcher (#756); this callback stays around for parent
   * telemetry / future routing hooks and is optional.
   */
  onSelectQuestion?: (question: StudentPracticeQuestion) => void;
  onBack: () => void;
}

type TypeFilter = QuestionType | "all";
type StatusFilter = StudentPracticeStatus | "all";
type ChapterFilter = string; // chapter id, or "all"

// Values only. The labels are resolved inside the component: these used to
// be built at module scope, which would pin them to whatever language was
// active at import time.
const TYPE_FILTER_VALUES: TypeFilter[] = [
  "all",
  "mcq",
  "open",
  "fill_gaps",
  "ordering",
  "classification",
];

const STATUS_FILTER_VALUES: StatusFilter[] = [
  "all",
  "not_started",
  "in_progress",
  "completed",
];

// Pastel per-type badge classes — same palette as the per-type Practice
// cards on StudentCourse so the badges feel familiar.
const TYPE_BADGE_CLASS: Record<QuestionType, string> = {
  mcq: "bg-violet-500/15 text-violet-700 border-transparent hover:bg-violet-500/15",
  open: "bg-indigo-500/15 text-indigo-700 border-transparent hover:bg-indigo-500/15",
  fill_gaps: "bg-amber-500/15 text-amber-800 border-transparent hover:bg-amber-500/15",
  ordering: "bg-sky-500/15 text-sky-700 border-transparent hover:bg-sky-500/15",
  classification:
    "bg-fuchsia-500/15 text-fuchsia-700 border-transparent hover:bg-fuchsia-500/15",
};

function StatusBadge({ status }: { status: StudentPracticeStatus }) {
  const { t } = useTranslation("practice");

  if (status === "completed") {
    return (
      <Badge
        variant="secondary"
        className="bg-green-500/20 text-green-700 border-0 text-[10px] sm:text-xs px-1.5"
      >
        <CheckCircle className="h-2.5 w-2.5 sm:h-3 sm:w-3 mr-0.5 sm:mr-1" />
        {t("status.completed")}
      </Badge>
    );
  }
  if (status === "in_progress") {
    return (
      <Badge
        variant="secondary"
        className="bg-amber-500/20 text-amber-700 border-0 text-[10px] sm:text-xs px-1.5"
      >
        <Clock className="h-2.5 w-2.5 sm:h-3 sm:w-3 mr-0.5 sm:mr-1" />
        {t("status.inProgress")}
      </Badge>
    );
  }
  return (
    <Badge
      variant="secondary"
      className="bg-muted text-muted-foreground border-0 text-[10px] sm:text-xs px-1.5"
    >
      {t("status.notStarted")}
    </Badge>
  );
}

// Consistent across all types: answered (completed) shows "View", anything
// not yet answered shows "Start". Returns a catalog key -- callers must not
// branch on the rendered text, which is language-dependent.
function actionLabelKeyFor(status: StudentPracticeStatus): string {
  return status === "completed" ? "list.actionView" : "list.actionStart";
}

export function UnifiedPracticeQuestionsList({
  courseId,
  courseTitle,
  onSelectQuestion,
  onBack,
}: Props) {
  const { t } = useTranslation("practice");
  const { compareText } = useFormatters();
  // Built inline rather than memoised: four and six items, and a memo here
  // would raise the question of whether `t` changes identity on a language
  // switch. Rebuilding every render makes them unconditionally current.
  const typeFilterOptions = TYPE_FILTER_VALUES.map((value) => ({
    value,
    label: value === "all" ? t("list.allTypes") : t(`types.${value}`),
  }));
  const statusFilterOptions = STATUS_FILTER_VALUES.map((value) => ({
    value,
    label:
      value === "all"
        ? t("list.allStatuses")
        : value === "not_started"
          ? t("status.notStarted")
          : value === "in_progress"
            ? t("status.inProgress")
            : t("status.completed"),
  }));
  const { questions, loading, refetch } = useStudentPracticeQuestions(courseId);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [chapterFilter, setChapterFilter] = useState<ChapterFilter>("all");
  // #775 — client-side pagination over the filtered list. Page state is local
  // (not URL) since the list lives behind a dispatcher and isn't deep-linked.
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [selectedQuestion, setSelectedQuestion] =
    useState<StudentPracticeQuestion | null>(null);
  // #776 — when set, a randomized serial run is in progress; the list is
  // hidden the same way it is for the dispatcher.
  const [randomRun, setRandomRun] = useState<StudentPracticeQuestion[] | null>(
    null,
  );
  // Optimistic per-row status overrides — feed back from the panel's
  // `onStatusChange` so the list reflects progress immediately, without
  // waiting on a refetch round-trip.
  const [statusOverrides, setStatusOverrides] = useState<
    Record<string, StudentPracticeStatus>
  >({});
  // Document scrollY at the moment the dispatcher takes over. Hidden lists
  // shrink the document, so the browser clamps scroll to 0 on its own —
  // we restore the saved value when the list comes back.
  const savedScrollRef = useRef<number>(0);

  // #774 — Chapters surfaced by the data hook; collapse to one entry per chapter
  // id with a "Material — Chapter" label, sorted alphabetically (matches the
  // instructor bank's chapter filter ordering).
  const chapterOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const q of questions) {
      for (const ch of q.chapters) {
        if (map.has(ch.id)) continue;
        map.set(ch.id, `${ch.materialTitle} — ${ch.title}`);
      }
    }
    return Array.from(map.entries())
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => compareText(a.label, b.label));
  }, [questions, compareText]);

  // When the loaded set changes (e.g. refetch) the previously-selected chapter
  // may no longer exist — fall back to "all" so the empty-state isn't sticky.
  useEffect(() => {
    if (chapterFilter === "all") return;
    if (chapterOptions.length === 0) {
      // All chapter-tagged questions disappeared (e.g. after a refetch) — reset
      // so the now-hidden dropdown doesn't silently keep the list empty.
      setChapterFilter("all");
      return;
    }
    if (!chapterOptions.some((o) => o.value === chapterFilter)) {
      setChapterFilter("all");
    }
  }, [chapterOptions, chapterFilter]);

  // Questions with any optimistic status overrides applied. Both the displayed
  // list and the random-run pool derive from this so their statuses agree.
  const withOverrides = useMemo(() => {
    return questions.map((q) =>
      statusOverrides[q.id] ? { ...q, status: statusOverrides[q.id] } : q,
    );
  }, [questions, statusOverrides]);

  const filtered = useMemo(() => {
    return withOverrides.filter((q) => {
      if (typeFilter !== "all" && q.type !== typeFilter) return false;
      if (statusFilter !== "all" && q.status !== statusFilter) return false;
      if (chapterFilter !== "all" && !q.chapters.some((c) => c.id === chapterFilter))
        return false;
      return true;
    });
  }, [withOverrides, typeFilter, statusFilter, chapterFilter]);

  // #821 — "Practice N random" must always draw across ALL question types, so
  // the run pool deliberately skips the type predicate. Status/chapter filters
  // are still honored so the draw respects the student's other narrowing.
  const randomRunPool = useMemo(() => {
    return withOverrides.filter((q) => {
      if (statusFilter !== "all" && q.status !== statusFilter) return false;
      if (chapterFilter !== "all" && !q.chapters.some((c) => c.id === chapterFilter))
        return false;
      return true;
    });
  }, [withOverrides, statusFilter, chapterFilter]);

  const hasAnyAssigned = questions.length > 0;

  // Any filter change resets to page 1 so the student doesn't land on a stale
  // page that no longer has rows for the new selection.
  useEffect(() => {
    setPage(1);
  }, [typeFilter, statusFilter, chapterFilter, pageSize]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const clampedPage = Math.min(Math.max(1, page), totalPages);
  const pagedFiltered = useMemo(() => {
    const start = (clampedPage - 1) * pageSize;
    return filtered.slice(start, start + pageSize);
  }, [filtered, clampedPage, pageSize]);

  const handleSelectQuestion = useCallback(
    (q: StudentPracticeQuestion) => {
      savedScrollRef.current = typeof window !== "undefined" ? window.scrollY : 0;
      // Apply override eagerly so the list status already shows "In progress"
      // when the student returns; the panel will confirm via onStatusChange.
      setStatusOverrides((prev) =>
        prev[q.id] === "completed"
          ? prev
          : { ...prev, [q.id]: q.status === "not_started" ? "in_progress" : q.status },
      );
      onSelectQuestion?.(q);
      setSelectedQuestion(q);
    },
    [onSelectQuestion],
  );

  const handleDispatcherBack = useCallback(() => {
    setSelectedQuestion(null);
    // Restore scroll on the next frame, after the hidden list re-expands the
    // document. requestAnimationFrame keeps it after layout but before paint.
    if (typeof window !== "undefined") {
      const y = savedScrollRef.current;
      requestAnimationFrame(() => window.scrollTo(0, y));
    }
  }, []);

  const handleDispatcherStatusChange = useCallback(
    (status: StudentPracticeStatus) => {
      if (!selectedQuestion) return;
      setStatusOverrides((prev) => ({ ...prev, [selectedQuestion.id]: status }));
    },
    [selectedQuestion],
  );

  const handleDispatcherCompleted = useCallback(() => {
    void refetch();
  }, [refetch]);

  const nextUnansweredAfterCurrent = useMemo(() => {
    if (!selectedQuestion) return null;
    const currentIdx = filtered.findIndex((q) => q.id === selectedQuestion.id);
    // Scan forward from current, wrapping to the start, looking for an item
    // that hasn't been completed yet. The current question's own row is
    // skipped even if it remains incomplete.
    if (filtered.length === 0) return null;
    const start = currentIdx >= 0 ? currentIdx : -1;
    for (let i = 1; i <= filtered.length; i++) {
      const cand = filtered[(start + i) % filtered.length];
      if (!cand || cand.id === selectedQuestion.id) continue;
      if (cand.status !== "completed") return cand;
    }
    return null;
  }, [filtered, selectedQuestion]);

  const handleDispatcherNext = useCallback(() => {
    if (!nextUnansweredAfterCurrent) return;
    setSelectedQuestion(nextUnansweredAfterCurrent);
    setStatusOverrides((prev) =>
      prev[nextUnansweredAfterCurrent.id] === "completed"
        ? prev
        : {
            ...prev,
            [nextUnansweredAfterCurrent.id]:
              nextUnansweredAfterCurrent.status === "not_started"
                ? "in_progress"
                : nextUnansweredAfterCurrent.status,
          },
    );
    if (typeof window !== "undefined") {
      requestAnimationFrame(() => window.scrollTo(0, 0));
    }
  }, [nextUnansweredAfterCurrent]);

  // #776 — start a randomized run. #821 — draw from `randomRunPool` (which
  // ignores the type filter) so a "random" run always spans all question
  // types. Disabled upstream when the pool is empty, but guard here too.
  const handleStartRandomRun = useCallback(() => {
    if (randomRunPool.length === 0) return;
    savedScrollRef.current = typeof window !== "undefined" ? window.scrollY : 0;
    const run = pickRandomRun(randomRunPool, RANDOM_RUN_SIZE);
    if (run.length === 0) return;
    setRandomRun(run);
  }, [randomRunPool]);

  const handleRunQuestionStatusChange = useCallback(
    (q: StudentPracticeQuestion, status: StudentPracticeStatus) => {
      setStatusOverrides((prev) => ({ ...prev, [q.id]: status }));
    },
    [],
  );

  const handleRunExit = useCallback(() => {
    setRandomRun(null);
    void refetch();
    if (typeof window !== "undefined") {
      const y = savedScrollRef.current;
      requestAnimationFrame(() => window.scrollTo(0, y));
    }
  }, [refetch]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary/5 via-background to-secondary/10">
      {/* List view — kept mounted (display:none when dispatching) so its
          filter inputs and document scroll position survive the trip into
          the answering UI. The random run (#776) also hides the list, but
          we unmount it on exit so a fresh refetch is reflected. */}
      <div
        className={selectedQuestion || randomRun ? "hidden" : ""}
        aria-hidden={!!selectedQuestion || !!randomRun}
      >
      <nav className="border-b border-border bg-card/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 sm:px-6 py-3 sm:py-4 flex items-center gap-2 sm:gap-3">
          <Button
            variant="ghost"
            size="icon"
            className="flex-shrink-0 h-8 w-8 sm:h-10 sm:w-10"
            onClick={onBack}
            aria-label={t("list.backToCourse")}
          >
            <ArrowLeft className="w-4 h-4 sm:w-5 sm:h-5" />
          </Button>
          <div className="min-w-0 flex-1">
            <h1 className="text-base sm:text-xl font-display font-bold text-foreground truncate">
              {t("list.title")}
            </h1>
            <p className="text-xs sm:text-sm text-muted-foreground truncate">
              {courseTitle}
            </p>
          </div>
        </div>
      </nav>

      <main className="container mx-auto px-4 sm:px-6 py-4 sm:py-6 max-w-4xl">
        <div className="flex flex-col sm:flex-row gap-2 sm:gap-3 mb-4 sm:mb-6">
          <div className="flex-1 min-w-0">
            <Select
              value={typeFilter}
              onValueChange={(value) => setTypeFilter(value as TypeFilter)}
            >
              <SelectTrigger aria-label={t("list.filterByType")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {typeFilterOptions.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex-1 min-w-0">
            <Select
              value={statusFilter}
              onValueChange={(value) => setStatusFilter(value as StatusFilter)}
            >
              <SelectTrigger aria-label={t("list.filterByStatus")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {statusFilterOptions.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {chapterOptions.length > 0 && (
            <div className="flex-1 min-w-0">
              <Select
                value={chapterFilter}
                onValueChange={(value) => setChapterFilter(value)}
              >
                <SelectTrigger aria-label={t("list.filterByChapter")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("list.allChapters")}</SelectItem>
                  {chapterOptions.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        {hasAnyAssigned && !loading && (
          <div className="mb-4 sm:mb-6 flex justify-end">
            <Button
              variant="secondary"
              size="sm"
              onClick={handleStartRandomRun}
              disabled={randomRunPool.length === 0}
              data-testid="practice-random-run-cta"
            >
              <Shuffle className="h-3.5 w-3.5 mr-1.5" />
              {t("list.practiceRandom", {
                count:
                  Math.min(RANDOM_RUN_SIZE, randomRunPool.length) || RANDOM_RUN_SIZE,
              })}
            </Button>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
          </div>
        ) : !hasAnyAssigned ? (
          <Card className="border-dashed">
            <CardContent className="p-8 text-center">
              <Brain className="h-12 w-12 text-muted-foreground/50 mx-auto mb-4" />
              <h4 className="font-medium mb-2">{t("list.emptyTitle")}</h4>
              <p className="text-sm text-muted-foreground">
                {t("list.emptyBody")}
              </p>
            </CardContent>
          </Card>
        ) : filtered.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="p-8 text-center">
              <Inbox className="h-12 w-12 text-muted-foreground/50 mx-auto mb-4" />
              <h4 className="font-medium mb-2">{t("list.noMatchTitle")}</h4>
              <p className="text-sm text-muted-foreground mb-4">
                {t("list.noMatchBody")}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setTypeFilter("all");
                  setStatusFilter("all");
                  setChapterFilter("all");
                }}
              >
                {t("list.clearFilters")}
              </Button>
            </CardContent>
          </Card>
        ) : (
          <>
            <ul className="space-y-2 sm:space-y-3" data-testid="practice-list">
              {pagedFiltered.map((q) => (
                <li key={q.id}>
                  <PracticeRow question={q} onSelect={handleSelectQuestion} />
                </li>
              ))}
            </ul>
            <div className="mt-4 sm:mt-6">
              <PaginationFooter
                page={clampedPage}
                pageSize={pageSize}
                totalItems={filtered.length}
                onPageChange={setPage}
                onPageSizeChange={setPageSize}
              />
            </div>
          </>
        )}
      </main>
      </div>

      {selectedQuestion && !randomRun && (
        <div className="min-h-screen">
          <nav className="border-b border-border bg-card/80 backdrop-blur-sm sticky top-0 z-50">
            <div className="container mx-auto px-4 sm:px-6 py-3 sm:py-4 flex items-center gap-2 sm:gap-3">
              <Button
                variant="ghost"
                size="icon"
                className="flex-shrink-0 h-8 w-8 sm:h-10 sm:w-10"
                onClick={handleDispatcherBack}
                aria-label={t("list.backToPracticeList")}
              >
                <ArrowLeft className="w-4 h-4 sm:w-5 sm:h-5" />
              </Button>
              <div className="min-w-0 flex-1">
                <h1 className="text-base sm:text-xl font-display font-bold text-foreground truncate">
                  {t("list.title")}
                </h1>
                <p className="text-xs sm:text-sm text-muted-foreground truncate">
                  {courseTitle}
                </p>
              </div>
            </div>
          </nav>
          <main className="container mx-auto px-4 sm:px-6 py-4 sm:py-6 max-w-4xl">
            <PracticeAnsweringDispatcher
              question={selectedQuestion}
              courseId={courseId}
              hasNext={!!nextUnansweredAfterCurrent}
              onBack={handleDispatcherBack}
              onNext={handleDispatcherNext}
              onCompleted={handleDispatcherCompleted}
              onStatusChange={handleDispatcherStatusChange}
            />
          </main>
        </div>
      )}

      {randomRun && (
        <div className="min-h-screen" data-testid="random-run-host">
          <nav className="border-b border-border bg-card/80 backdrop-blur-sm sticky top-0 z-50">
            <div className="container mx-auto px-4 sm:px-6 py-3 sm:py-4 flex items-center gap-2 sm:gap-3">
              <Button
                variant="ghost"
                size="icon"
                className="flex-shrink-0 h-8 w-8 sm:h-10 sm:w-10"
                onClick={handleRunExit}
                aria-label={t("list.backToPracticeList")}
              >
                <ArrowLeft className="w-4 h-4 sm:w-5 sm:h-5" />
              </Button>
              <div className="min-w-0 flex-1">
                <h1 className="text-base sm:text-xl font-display font-bold text-foreground truncate">
                  {t("list.runTitle")}
                </h1>
                <p className="text-xs sm:text-sm text-muted-foreground truncate">
                  {courseTitle}
                </p>
              </div>
            </div>
          </nav>
          <main className="container mx-auto px-4 sm:px-6 py-4 sm:py-6 max-w-4xl">
            <PracticeRandomRun
              courseId={courseId}
              questionsInRun={randomRun}
              onExit={handleRunExit}
              onQuestionStatusChange={handleRunQuestionStatusChange}
            />
          </main>
        </div>
      )}
    </div>
  );
}

function PracticeRow({
  question,
  onSelect,
}: {
  question: StudentPracticeQuestion;
  onSelect: (q: StudentPracticeQuestion) => void;
}) {
  const { t } = useTranslation("practice");
  const previewHtml = useMemo(
    () => formatQuestionText(question.stemPreview || ""),
    [question.stemPreview],
  );
  const actionLabelKey = actionLabelKeyFor(question.status);
  // Keyed off the status, not the rendered label: the label is translated
  // and comparing it to "Start" would drop the icon in every other language.
  const showPlayIcon = question.status !== "completed";
  const actionVariant: "default" | "secondary" | "outline" =
    question.status === "completed"
      ? "outline"
      : question.status === "in_progress"
        ? "secondary"
        : "default";

  return (
    <Card className="hover:border-primary/30 transition-colors active:scale-[0.99]">
      <CardContent className="p-3 sm:p-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 sm:gap-2 mb-1.5 flex-wrap">
              <Badge
                variant="secondary"
                className={`text-[10px] sm:text-xs px-1.5 ${TYPE_BADGE_CLASS[question.type]}`}
              >
                {t(`types.${question.type}`)}
              </Badge>
              <Badge
                variant="secondary"
                className={`text-[10px] sm:text-xs px-1.5 ${getDifficultyClass(question.difficulty)}`}
              >
                {t(`common:difficulty.${question.difficulty}`, {
                  defaultValue: question.difficulty,
                })}
              </Badge>
              <StatusBadge status={question.status} />
            </div>
            {question.stemPreview ? (
              <div
                className="text-sm sm:text-base text-foreground line-clamp-2 break-words"
                // formatQuestionText returns sanitized HTML (DOMPurify) — safe to inject.
                dangerouslySetInnerHTML={{ __html: previewHtml }}
              />
            ) : (
              <p className="text-sm text-muted-foreground italic">
                {t("list.contentUnavailable")}
              </p>
            )}
          </div>
          <Button
            variant={actionVariant}
            size="sm"
            className="w-full sm:w-auto h-9 text-sm flex-shrink-0"
            onClick={() => onSelect(question)}
          >
            {showPlayIcon && <Play className="h-3.5 w-3.5 mr-1" />}
            {t(actionLabelKey)}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
