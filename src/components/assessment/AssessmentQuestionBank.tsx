/**
 * AssessmentQuestionBank — type-generic bank used by both quiz and test
 * builders (#653).
 *
 * Mirrors the standalone `UnifiedQuestionBank` (#621): renders any
 * `UnifiedQuestion` regardless of `type`, with type-chip filters at the top.
 * Interactive-mode open questions are excluded by the caller via
 * `useUnifiedQuestions(..., { excludeInteractiveOpen: true })`.
 *
 * Per-type filtering keeps the existing difficulty / competency / chapter /
 * author / date filters from the previous mcq/open implementation. The
 * "Verified" gate (validation_status + confidence) applies only to mcq rows;
 * other types render without that filter.
 */
import { useEffect, useMemo, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { processLatexContent } from "@/lib/latex-utils";
import {
  FileText,
  Plus,
  Search,
  Filter,
  CheckCircle2,
  ShieldCheck,
  AlertTriangle,
  XCircle,
  User,
} from "lucide-react";
import {
  ALL_QUESTION_TYPES,
  QUESTION_TYPE_LABELS,
  type UnifiedQuestion,
} from "@/lib/unified-question";
import type { QuestionType } from "@/types/question";
import { TypeBadge } from "@/components/UnifiedQuestionsTable";
import { useFormatters } from "@/i18n/formatters";

export interface Competency {
  id: string;
  title: string;
}

interface AssessmentQuestionBankProps {
  /** All non-interactive questions for the course (already filtered by the loader). */
  questions: UnifiedQuestion[];
  /** Course-level competencies for the legacy competency filter. */
  competencies: Competency[];
  /** Per-question-id competency tag, used by the competency filter (mcq/open carry this). */
  competencyByQuestionId?: Record<string, string | null | undefined>;
  /**
   * Per-question-id validation status — used to apply the "Verified" gate to
   * mcq rows. Other types ignore validation entirely.
   */
  validationByQuestionId?: Record<
    string,
    {
      status:
        | "CORRECT"
        | "PARTIALLY_CORRECT"
        | "INCORRECT"
        | "INSUFFICIENT_INFORMATION"
        | null;
      confidence: number | null;
    } | undefined
  >;
  selectedQuestionIds: Set<string>;
  onAddQuestion: (question: UnifiedQuestion) => void;
  mode: "quiz" | "test";
}

const DIFFICULTY_BADGE: Record<string, string> = {
  easy: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
  medium: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400",
  hard: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
};

const DATE_THRESHOLDS: Record<string, number> = {
  "7days": 7 * 24 * 60 * 60 * 1000,
  "30days": 30 * 24 * 60 * 60 * 1000,
  "90days": 90 * 24 * 60 * 60 * 1000,
};

function getDifficultyColor(difficulty: string): string {
  return DIFFICULTY_BADGE[difficulty] ?? "bg-muted text-muted-foreground";
}

export function AssessmentQuestionBank({
  questions,
  competencies,
  competencyByQuestionId = {},
  validationByQuestionId = {},
  selectedQuestionIds,
  onAddQuestion,
  mode,
}: AssessmentQuestionBankProps) {
  const { compareText } = useFormatters();
  const [searchQuery, setSearchQuery] = useState("");
  const [difficultyFilter, setDifficultyFilter] = useState<string>("all");
  const [competencyFilter, setCompetencyFilter] = useState<string>("all");
  const [addedFilter, setAddedFilter] = useState<string>("all");
  const [dateFilter, setDateFilter] = useState<string>("all");
  const [authorFilter, setAuthorFilter] = useState<string>("all");
  const [chapterFilter, setChapterFilter] = useState<string>("all");
  // All 5 types selected by default. Empty selection renders the empty state
  // so users can see which types are visible at a glance.
  const [selectedTypes, setSelectedTypes] = useState<Set<QuestionType>>(
    () => new Set(ALL_QUESTION_TYPES),
  );
  const [expandedQuestions, setExpandedQuestions] = useState<Set<string>>(
    new Set(),
  );

  const toggleType = (t: QuestionType) => {
    setSelectedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  };

  const isMcqVerified = (id: string): boolean => {
    const v = validationByQuestionId[id];
    if (!v || !v.status) return false;
    return v.status === "CORRECT" && (v.confidence ?? 0) > 0.7;
  };

  // Authors derived from the visible/verified question set.
  const authors = useMemo(() => {
    const authorMap = new Map<string, string>();
    questions.forEach((q) => {
      if (q.hidden) return;
      if (q.type === "mcq" && !isMcqVerified(q.id)) return;
      if (q.createdBy && q.authorName) {
        authorMap.set(q.createdBy, q.authorName);
      }
    });
    return Array.from(authorMap.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => compareText(a.name, b.name));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isMcqVerified reads stable prop maps
  }, [questions, validationByQuestionId]);

  // Chapters derived from the same visible set.
  const chapters = useMemo(() => {
    const chapterMap = new Map<string, string>();
    questions.forEach((q) => {
      if (q.hidden) return;
      if (q.type === "mcq" && !isMcqVerified(q.id)) return;
      q.chapters.forEach((ref) => chapterMap.set(ref.id, ref.title));
    });
    return Array.from(chapterMap.entries())
      .map(([id, title]) => ({ id, title }))
      .sort((a, b) => compareText(a.title, b.title));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isMcqVerified reads stable prop maps
  }, [questions, validationByQuestionId]);

  useEffect(() => {
    if (authorFilter !== "all" && !authors.some((a) => a.id === authorFilter)) {
      setAuthorFilter("all");
    }
  }, [authors, authorFilter]);

  useEffect(() => {
    if (
      chapterFilter !== "all" &&
      !chapters.some((c) => c.id === chapterFilter)
    ) {
      setChapterFilter("all");
    }
  }, [chapters, chapterFilter]);

  const toggleQuestionExpanded = (id: string) => {
    setExpandedQuestions((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Counts per type — total visible in the bank regardless of other filters.
  // Drives the chip badges.
  const counts = useMemo(() => {
    const out: Record<QuestionType, number> = {
      mcq: 0,
      open: 0,
      fill_gaps: 0,
      ordering: 0,
      classification: 0,
    };
    questions.forEach((q) => {
      if (q.hidden) return;
      if (q.type === "mcq" && !isMcqVerified(q.id)) return;
      out[q.type] += 1;
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isMcqVerified reads stable prop maps
  }, [questions, validationByQuestionId]);

  const filteredQuestions = useMemo(() => {
    const term = searchQuery.trim().toLowerCase();
    const dateThresholdMs = DATE_THRESHOLDS[dateFilter];
    const dateThreshold = dateThresholdMs
      ? new Date(Date.now() - dateThresholdMs)
      : null;

    return questions.filter((q) => {
      if (q.hidden) return false;
      if (!selectedTypes.has(q.type)) return false;
      // The verification gate is mcq-only; other types skip it.
      if (q.type === "mcq" && !isMcqVerified(q.id)) return false;

      if (term.length > 0 && !q.searchText.toLowerCase().includes(term))
        return false;

      if (difficultyFilter !== "all" && q.difficulty !== difficultyFilter)
        return false;

      if (competencyFilter !== "all") {
        const cid = competencyByQuestionId[q.id] ?? null;
        if (cid !== competencyFilter) return false;
      }

      if (addedFilter === "added" && !selectedQuestionIds.has(q.id)) return false;
      if (addedFilter === "not_added" && selectedQuestionIds.has(q.id))
        return false;

      if (dateThreshold && new Date(q.createdAt) < dateThreshold) return false;

      if (authorFilter !== "all" && q.createdBy !== authorFilter) return false;

      if (
        chapterFilter !== "all" &&
        !q.chapters.some((ref) => ref.id === chapterFilter)
      )
        return false;

      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isMcqVerified reads stable prop maps
  }, [
    questions,
    selectedTypes,
    searchQuery,
    difficultyFilter,
    competencyFilter,
    competencyByQuestionId,
    addedFilter,
    selectedQuestionIds,
    dateFilter,
    authorFilter,
    chapterFilter,
    validationByQuestionId,
  ]);

  const hasActiveFilters =
    searchQuery !== "" ||
    difficultyFilter !== "all" ||
    competencyFilter !== "all" ||
    addedFilter !== "all" ||
    dateFilter !== "all" ||
    authorFilter !== "all" ||
    chapterFilter !== "all" ||
    selectedTypes.size !== ALL_QUESTION_TYPES.length;

  const clearFilters = () => {
    setSearchQuery("");
    setDifficultyFilter("all");
    setCompetencyFilter("all");
    setAddedFilter("all");
    setDateFilter("all");
    setAuthorFilter("all");
    setChapterFilter("all");
    setSelectedTypes(new Set(ALL_QUESTION_TYPES));
  };

  const getVerificationBadge = (q: UnifiedQuestion) => {
    const v = validationByQuestionId[q.id];
    if (!v || !v.status) return null;
    const conf = v.confidence ?? 0;
    const isVerified = v.status === "CORRECT" && conf > 0.7;
    const needsReview =
      v.status === "PARTIALLY_CORRECT" ||
      (v.status === "CORRECT" && conf <= 0.7);
    const isInvalid =
      v.status === "INCORRECT" || v.status === "INSUFFICIENT_INFORMATION";

    if (isVerified) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge
              variant="outline"
              className="bg-green-500/10 text-green-600 border-green-500/20 text-xs"
            >
              <ShieldCheck className="w-3 h-3 mr-1" />
              Verified
            </Badge>
          </TooltipTrigger>
          <TooltipContent>
            Verified ({Math.round(conf * 100)}% confidence)
          </TooltipContent>
        </Tooltip>
      );
    }
    if (needsReview) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge
              variant="outline"
              className="bg-amber-500/10 text-amber-600 border-amber-500/20 text-xs"
            >
              <AlertTriangle className="w-3 h-3 mr-1" />
              Review
            </Badge>
          </TooltipTrigger>
          <TooltipContent>
            Needs review ({Math.round(conf * 100)}% confidence)
          </TooltipContent>
        </Tooltip>
      );
    }
    if (isInvalid) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge
              variant="outline"
              className="bg-red-500/10 text-red-600 border-red-500/20 text-xs"
            >
              <XCircle className="w-3 h-3 mr-1" />
              Invalid
            </Badge>
          </TooltipTrigger>
          <TooltipContent>Invalid answer detected</TooltipContent>
        </Tooltip>
      );
    }
    return null;
  };

  const getCompetencyName = (questionId: string): string | null => {
    const cid = competencyByQuestionId[questionId];
    if (!cid) return null;
    return competencies.find((c) => c.id === cid)?.title ?? null;
  };

  const renderQuestionItem = (q: UnifiedQuestion) => {
    const isAdded = selectedQuestionIds.has(q.id);
    const isExpanded = expandedQuestions.has(q.id);
    const competencyName = getCompetencyName(q.id);

    return (
      <div
        key={q.id}
        className={`p-3 rounded-lg border transition-colors ${
          isAdded
            ? "bg-primary/5 border-primary/30"
            : "bg-secondary/50 hover:bg-secondary"
        }`}
      >
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <div
              className="cursor-pointer"
              onClick={() => toggleQuestionExpanded(q.id)}
            >
              <p
                className={`text-sm ${isExpanded ? "" : "line-clamp-2"}`}
                dangerouslySetInnerHTML={{
                  __html: processLatexContent(q.preview),
                }}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2 mt-2">
              <TypeBadge type={q.type} />
              <Badge
                variant="outline"
                className={`text-xs ${getDifficultyColor(q.difficulty)}`}
              >
                {q.difficulty}
              </Badge>
              {q.type === "mcq" && getVerificationBadge(q)}
              {competencyName && (
                <Badge variant="secondary" className="text-xs">
                  {competencyName}
                </Badge>
              )}
              {q.authorName && (
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <User className="w-3 h-3" />
                  {q.authorName}
                </span>
              )}
            </div>
          </div>
          {isAdded ? (
            <Badge className="bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400">
              <CheckCircle2 className="w-3 h-3 mr-1" />
              Added
            </Badge>
          ) : (
            <Button size="sm" variant="outline" onClick={() => onAddQuestion(q)}>
              <Plus className="w-4 h-4 mr-1" />
              Add
            </Button>
          )}
        </div>
      </div>
    );
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2">
          <FileText className="w-5 h-5" />
          Question Bank
        </CardTitle>
        <CardDescription>
          Select questions to add to your {mode}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Filters */}
        <div className="space-y-3">
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Search questions..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select value={difficultyFilter} onValueChange={setDifficultyFilter}>
              <SelectTrigger className="w-[140px]">
                <SelectValue placeholder="Difficulty" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Levels</SelectItem>
                <SelectItem value="easy">Easy</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="hard">Hard</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-wrap gap-3">
            {competencies.length > 0 && (
              <Select
                value={competencyFilter}
                onValueChange={setCompetencyFilter}
              >
                <SelectTrigger className="w-[200px]">
                  <SelectValue placeholder="Competency" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Competencies</SelectItem>
                  {competencies.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Select value={dateFilter} onValueChange={setDateFilter}>
              <SelectTrigger className="w-[140px]">
                <SelectValue placeholder="Created" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Time</SelectItem>
                <SelectItem value="7days">Last 7 Days</SelectItem>
                <SelectItem value="30days">Last 30 Days</SelectItem>
                <SelectItem value="90days">Last 90 Days</SelectItem>
              </SelectContent>
            </Select>
            <Select value={addedFilter} onValueChange={setAddedFilter}>
              <SelectTrigger className="w-[160px]">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Questions</SelectItem>
                <SelectItem value="added">Used Before</SelectItem>
                <SelectItem value="not_added">Unused</SelectItem>
              </SelectContent>
            </Select>
            {authors.length > 0 && (
              <Select value={authorFilter} onValueChange={setAuthorFilter}>
                <SelectTrigger className="w-[160px]">
                  <SelectValue placeholder="Author" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Authors</SelectItem>
                  {authors.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {chapters.length > 0 && (
              <Select value={chapterFilter} onValueChange={setChapterFilter}>
                <SelectTrigger className="w-[180px]">
                  <SelectValue placeholder="Chapter" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Chapters</SelectItem>
                  {chapters.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {hasActiveFilters && (
              <Button
                variant="ghost"
                size="sm"
                onClick={clearFilters}
                className="h-10"
              >
                <Filter className="w-4 h-4 mr-1" />
                Clear Filters
              </Button>
            )}
          </div>
          {/* Type chips — mirror UnifiedQuestionBank's selectable chip row. */}
          <div
            className="flex flex-wrap items-center gap-2"
            data-testid="assessment-bank-type-chips"
          >
            <span className="text-xs uppercase tracking-wide text-muted-foreground">
              Types
            </span>
            {ALL_QUESTION_TYPES.map((t) => {
              const active = selectedTypes.has(t);
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => toggleType(t)}
                  className={`group ${
                    active ? "opacity-100" : "opacity-40 grayscale"
                  }`}
                  data-testid={`assessment-bank-type-chip-${t}`}
                  aria-pressed={active}
                  title={QUESTION_TYPE_LABELS[t]}
                >
                  <span className="inline-flex items-center gap-1.5">
                    <TypeBadge type={t} />
                    <Badge variant="secondary" className="text-[10px]">
                      {counts[t]}
                    </Badge>
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Question list */}
        <ScrollArea className="h-[550px] pr-4">
          {filteredQuestions.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              No questions match your filters
            </div>
          ) : (
            <div className="space-y-2">
              {filteredQuestions.map((q) => renderQuestionItem(q))}
            </div>
          )}
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
