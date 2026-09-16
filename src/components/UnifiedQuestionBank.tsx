/**
 * UnifiedQuestionBank (#621, extended in #623) — the bank's single tab.
 * Wraps `UnifiedQuestionsTable` with header counts, search, type-chip
 * filters, author/date/book/chapter filters, client-side pagination, the
 * single Generate button, and the cross-type similarity entry point.
 *
 * URL params (all client-side, all preserved across refresh):
 *   ?type=mcq,open               selected types (default: all 5)
 *   ?q=foo                       search term against the normalized searchText
 *   ?difficulty=hard             difficulty filter (or `all`)
 *   ?author=user-1,user-2,ai     selected authors (multi-select)
 *   ?created_from=YYYY-MM-DD     inclusive lower bound on created_at
 *   ?created_to=YYYY-MM-DD       inclusive upper bound on created_at
 *   ?book=mat-1,mat-2            selected book/material ids (chaptered books
 *                                AND whole "Other" documents, #1019)
 *   ?chapter=ch-1,ch-2           selected chapter ids
 *   ?competency=comp-1,comp-2    selected competency ids (match ANY)
 *   ?generated_for=g-1,g-2       groups the questions were generated for
 *   ?assigned=any,unassigned,o-1 assignment filter: `any` = assigned to at
 *                                least one class, `unassigned` = assigned to
 *                                none, anything else = an offering id (match
 *                                ANY selected)
 *   ?exclude_quiz=any            drop questions that are part of any quiz
 *   ?exclude_quiz=quiz-1,quiz-2  drop questions in any of the listed quizzes
 *   ?page=2                      1-based page index
 *   ?page_size=50                10 / 25 / 50 / 100; default 25
 *
 * Backward-compat: `?subtab=<mcq|open|fill-gaps|ordering|classification>`
 * arriving on mount is normalized to `?type=<…>` with a single replace().
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useContentAssignments } from "@/hooks/useContentAssignments";
import { useQuizQuestionUsage } from "@/hooks/useQuizQuestionUsage";
import { useUnifiedQuestions } from "@/hooks/useUnifiedQuestions";
import { BulkGenerateDialog } from "./BulkGenerateDialog";
import { ContentAssignDialog } from "./ContentAssignDialog";
import { SimilarityCheckDialog } from "./SimilarityCheckDialog";
import { UnifiedQuestionsTable } from "./UnifiedQuestionsTable";
import { UnifiedGenerateDialog } from "./UnifiedGenerateDialog";
import { GenerateMcqDialog, type GenerateMcqSeed } from "./GenerateMcqDialog";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ChevronDown,
  GitCompare,
  HelpCircle,
  Layers,
  Loader2,
  MoreHorizontal,
  Search,
  SlidersHorizontal,
  Sparkles,
  Users,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { buildClassDisplayName } from "@/lib/greek-school";
import {
  ALL_QUESTION_TYPES,
  QUESTION_TYPE_LABELS,
} from "@/lib/unified-question";
import type {
  CourseClass,
  OfferingGroup,
} from "@/types/content-assignments";
import type { AudienceSelection } from "./TargetAudienceSelector";
import type { QuestionType } from "@/types/question";
import { TypeBadge } from "./UnifiedQuestionsTable";
import {
  CreateAssessmentDialog,
  type AssessmentKind,
} from "./question-bank/CreateAssessmentDialog";
import {
  MultiSelectFilter,
  type MultiSelectOption,
} from "./question-bank/filters/MultiSelectFilter";
import {
  DateRangeFilter,
  isWithinRange,
} from "./question-bank/filters/DateRangeFilter";
import {
  ExcludeQuizFilter,
  type ExcludeQuizSelection,
} from "./question-bank/filters/ExcludeQuizFilter";
import {
  DEFAULT_PAGE_SIZE,
  PAGE_SIZE_OPTIONS,
  PaginationFooter,
} from "./question-bank/filters/PaginationFooter";
import { useFormatters } from "@/i18n/formatters";

interface CourseMaterial {
  id: string;
  file_name: string;
  title: string | null;
}

/**
 * Shape of the `derive-group-weaknesses` edge-function response (#852). Only
 * the fields the Question Bank cluster seeding reads are declared here.
 */
interface DeriveWeaknessesResult {
  insufficient_data: boolean;
  reason?: string;
  suggested_difficulty: "easy" | "medium" | "hard" | null;
  weak_competencies: Array<{
    competency_id: string;
    title: string;
    chapters: Array<{ id: string; title: string }>;
  }>;
}

interface UnifiedQuestionBankProps {
  courseId: string;
  materials: CourseMaterial[];
  isAdmin: boolean;
  classes?: CourseClass[];
}

const SUBTAB_TO_TYPE: Record<string, QuestionType> = {
  mcq: "mcq",
  open: "open",
  "fill-gaps": "fill_gaps",
  fill_gaps: "fill_gaps",
  ordering: "ordering",
  classification: "classification",
};

/** Sentinel author id for AI-generated rows (`createdBy === null`). */
const AI_AUTHOR_ID = "ai";

/**
 * Sentinel values for the `?assigned` filter. Real values are offering ids
 * (uuids), so these short words can't collide.
 */
const ASSIGNED_ANY = "any";
const ASSIGNED_NONE = "unassigned";

function parseTypesParam(raw: string | null): Set<QuestionType> {
  if (!raw) return new Set(ALL_QUESTION_TYPES);
  if (raw === "none") return new Set();
  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .map((p) => (p === "fill-gaps" ? "fill_gaps" : p));
  const valid = parts.filter((p): p is QuestionType =>
    (ALL_QUESTION_TYPES as string[]).includes(p),
  );
  return valid.length > 0 ? new Set(valid) : new Set(ALL_QUESTION_TYPES);
}

function typesParamString(types: Set<QuestionType>): string | null {
  if (types.size === ALL_QUESTION_TYPES.length) return null;
  if (types.size === 0) return "none";
  return ALL_QUESTION_TYPES.filter((t) => types.has(t)).join(",");
}

function parseCsvSet(raw: string | null): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function csvSetString(set: Set<string>): string | null {
  if (set.size === 0) return null;
  return Array.from(set).join(",");
}

function parsePageSize(raw: string | null): number {
  const n = raw ? parseInt(raw, 10) : DEFAULT_PAGE_SIZE;
  return (PAGE_SIZE_OPTIONS as readonly number[]).includes(n)
    ? n
    : DEFAULT_PAGE_SIZE;
}

function parsePage(raw: string | null): number {
  const n = raw ? parseInt(raw, 10) : 1;
  return Number.isFinite(n) && n > 0 ? n : 1;
}

export function UnifiedQuestionBank({
  courseId,
  materials,
  isAdmin,
  classes = [],
}: UnifiedQuestionBankProps) {
  const { compareText } = useFormatters();
  const [searchParams, setSearchParams] = useSearchParams();
  // #624 — interactive-mode opens have their own "AI Interactive Questions"
  // tab; exclude them here so the bank shows only single-answer opens plus
  // mcq / fill_gaps / ordering / classification.
  // #977 — study-guide questions live in the same `questions` table but belong
  // to a guide's pieces; keep them out of the bank.
  const { questions, loading, refetch, setQuestions } = useUnifiedQuestions(courseId, {
    excludeInteractiveOpen: true,
    excludeStudyGuideQuestions: true,
  });

  // One-shot backward-compat: legacy ?subtab=… arriving on mount.
  useEffect(() => {
    const subtab = searchParams.get("subtab");
    if (!subtab) return;
    const next = new URLSearchParams(searchParams);
    next.delete("subtab");
    const mapped = SUBTAB_TO_TYPE[subtab];
    if (mapped && !next.has("type")) {
      next.set("type", mapped);
    }
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only redirect
  }, []);

  const selectedTypes = useMemo(
    () => parseTypesParam(searchParams.get("type")),
    [searchParams],
  );
  const search = searchParams.get("q") ?? "";
  const difficulty = searchParams.get("difficulty") ?? "all";

  const selectedAuthors = useMemo(
    () => parseCsvSet(searchParams.get("author")),
    [searchParams],
  );
  const createdFrom = searchParams.get("created_from");
  const createdTo = searchParams.get("created_to");
  const selectedBooks = useMemo(
    () => parseCsvSet(searchParams.get("book")),
    [searchParams],
  );
  const selectedChapters = useMemo(
    () => parseCsvSet(searchParams.get("chapter")),
    [searchParams],
  );
  const selectedCompetencies = useMemo(
    () => parseCsvSet(searchParams.get("competency")),
    [searchParams],
  );
  const selectedGeneratedFor = useMemo(
    () => parseCsvSet(searchParams.get("generated_for")),
    [searchParams],
  );
  const selectedAssigned = useMemo(
    () => parseCsvSet(searchParams.get("assigned")),
    [searchParams],
  );
  const excludeQuiz = useMemo<ExcludeQuizSelection>(() => {
    const raw = searchParams.get("exclude_quiz");
    return raw === "any" ? "any" : parseCsvSet(raw);
  }, [searchParams]);

  const page = parsePage(searchParams.get("page"));
  const pageSize = parsePageSize(searchParams.get("page_size"));

  // Single param-patcher used by every control. Touching any filter resets the
  // page to 1 — callers opt out by passing { resetPage: false }.
  const updateParams = useCallback(
    (
      patch: Record<string, string | null>,
      opts: { resetPage?: boolean } = {},
    ) => {
      const next = new URLSearchParams(searchParams);
      const resetPage = opts.resetPage !== false;
      if (resetPage) next.delete("page");
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === "") next.delete(k);
        else next.set(k, v);
      }
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const toggleType = useCallback(
    (type: QuestionType) => {
      const next = new Set(selectedTypes);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      // Empty set = no types selected; we still record that explicitly so the
      // user can see "0 questions" rather than the chip silently resetting.
      const param = typesParamString(next);
      updateParams({ type: param });
    },
    [selectedTypes, updateParams],
  );

  // Content assignments — `useContentAssignments` is keyed by content type,
  // but the underlying junction (`offering_questions`) is the same for all
  // 5 types. Treat the bank as `mcq_question` for the assignment lookup;
  // ids are unique across types and the table filters server-side by id.
  const questionIds = useMemo(() => questions.map((q) => q.id), [questions]);
  const contentAssignments = useContentAssignments("mcq_question", questionIds, classes);
  // Quiz membership for the Exclude quiz filter — which questions already
  // sit in which of the course's quizzes.
  const quizUsage = useQuizQuestionUsage(courseId);
  const [assignDialogOpen, setAssignDialogOpen] = useState(false);
  const [assignTargetIds, setAssignTargetIds] = useState<string[]>([]);
  const [assignIsBulk, setAssignIsBulk] = useState(false);

  const handleOpenAssignDialog = useCallback((questionId: string) => {
    setAssignTargetIds([questionId]);
    setAssignIsBulk(false);
    setAssignDialogOpen(true);
  }, []);

  const handleBulkAssign = useCallback((ids: string[]) => {
    setAssignTargetIds(ids);
    setAssignIsBulk(true);
    setAssignDialogOpen(true);
  }, []);

  const handleSaveAssign = useCallback(
    async (
      selection: Set<string> | import("@/types/content-assignments").AssignSelection,
    ) => {
      await contentAssignments.saveAssignments(assignTargetIds, selection, assignIsBulk);
      setAssignDialogOpen(false);
    },
    [contentAssignments, assignTargetIds, assignIsBulk],
  );

  // Create a quiz/test straight from a bank selection, without leaving the
  // bank. `null` kind = dialog closed; ids arrive in table order.
  const [createAssessment, setCreateAssessment] = useState<{
    kind: AssessmentKind;
    questionIds: string[];
  } | null>(null);

  const handleCreateAssessment = useCallback(
    (kind: AssessmentKind, questionIds: string[]) => {
      setCreateAssessment({ kind, questionIds });
    },
    [],
  );

  const [generateOpen, setGenerateOpen] = useState(false);
  const [bulkGenerateOpen, setBulkGenerateOpen] = useState(false);
  // #853 — "Find Similar" now lives in the overflow menu, so its dialog is
  // controlled from here rather than self-triggering.
  const [similarityOpen, setSimilarityOpen] = useState(false);
  // Pre-filled MCQ dialog: seeded from a cluster's weak areas (#853) or from
  // the home page's "Create More Questions" on a done study guide.
  const [mcqSeed, setMcqSeed] = useState<GenerateMcqSeed | undefined>(
    undefined,
  );
  const [seededMcqOpen, setSeededMcqOpen] = useState(false);

  // One-shot deep link (?followupGuide=<id>): the instructor home's "Create
  // follow-up" on a Done study guide lands here with the generator pre-set to
  // that guide. Strip the param immediately (replace, same contract as the
  // analytics deep links) so a tab switch doesn't reopen the dialog.
  useEffect(() => {
    const followupGuideId = searchParams.get("followupGuide");
    if (!followupGuideId) return;
    const next = new URLSearchParams(searchParams);
    next.delete("followupGuide");
    setSearchParams(next, { replace: true });
    setMcqSeed({
      selectionMode: "guides",
      selectedStudyGuideIds: [followupGuideId],
      note: "Follow-up to a completed study guide — questions are grounded in its stored theory and won't repeat the guide's own questions.",
    });
    setSeededMcqOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only deep link
  }, []);
  const [clusterLoadingGroupId, setClusterLoadingGroupId] = useState<
    string | null
  >(null);

  // Saved (non-individual) Student Groups per section, for the "From student
  // cluster" menu. Individual singleton groups are excluded — clusters are
  // multi-student by nature.
  const groupsByOffering = contentAssignments.groupsByOffering;
  const clusterSections = useMemo(() => {
    const classByOffering = new Map<string, (typeof classes)[number]>();
    for (const cls of classes) {
      if (!classByOffering.has(cls.offering_id)) {
        classByOffering.set(cls.offering_id, cls);
      }
    }
    return Array.from(classByOffering.values())
      .map((cls) => ({
        offeringId: cls.offering_id,
        label: buildClassDisplayName(cls),
        groups: (groupsByOffering[cls.offering_id] ?? []).filter(
          (g) => !g.is_individual,
        ),
      }))
      .filter((section) => section.groups.length > 0)
      .sort((a, b) => compareText(a.label, b.label));
  }, [classes, groupsByOffering, compareText]);
  const hasClusterGroups = clusterSections.length > 0;

  const handleGenerateFromCluster = useCallback(
    async (offeringId: string, group: OfferingGroup) => {
      if (clusterLoadingGroupId) return;
      setClusterLoadingGroupId(group.id);
      try {
        const { data, error } = await supabase.functions.invoke(
          "derive-group-weaknesses",
          { body: { offering_id: offeringId, group_id: group.id } },
        );
        if (error) throw error;
        if (data?.error) throw new Error(data.error);
        const result = data as DeriveWeaknessesResult;

        const audience: AudienceSelection = {
          kind: "group",
          groupId: group.id,
          offeringId,
          label: group.name,
          description: group.description ?? null,
        };

        const weak = result?.weak_competencies ?? [];
        if (result?.insufficient_data || weak.length === 0) {
          // Nothing to pre-fill, but still target the group so the instructor
          // can generate a general batch for them.
          setMcqSeed({
            audience,
            note: `Not enough data to target "${group.name}" — nothing was pre-filled.${
              result?.reason ? ` (${result.reason})` : ""
            }`,
          });
        } else {
          const top = weak.slice(0, 3);
          const competencyIds = top.map((w) => w.competency_id);
          const chapterIds = Array.from(
            new Set(
              weak.flatMap((w) => (w.chapters ?? []).map((c) => c.id)),
            ),
          );
          const titles = top.map((w) => w.title).join(", ");
          setMcqSeed({
            selectionMode: "competencies",
            selectedCompetencyIds: competencyIds,
            selectedChapterIds: chapterIds,
            difficulty: result.suggested_difficulty ?? undefined,
            audience,
            note: `Seeded from "${group.name}" — weak in: ${titles}`,
          });
        }
        setSeededMcqOpen(true);
      } catch (err) {
        console.error("Failed to derive group weaknesses", err);
        toast.error(
          err instanceof Error
            ? err.message
            : "Failed to derive group weaknesses",
        );
      } finally {
        setClusterLoadingGroupId(null);
      }
    },
    [clusterLoadingGroupId],
  );

  const counts = useMemo(() => {
    const out: Record<QuestionType, number> = {
      mcq: 0,
      open: 0,
      fill_gaps: 0,
      ordering: 0,
      classification: 0,
    };
    for (const q of questions) out[q.type] += 1;
    return out;
  }, [questions]);

  // ── Filter option derivations ──────────────────────────────────────────
  // Authors derived from the loaded rows. AI-generated rows (createdBy=null)
  // share a single synthetic option so users can target/exclude them.
  const authorOptions = useMemo<MultiSelectOption[]>(() => {
    const map = new Map<string, { label: string; count: number }>();
    for (const q of questions) {
      const id = q.createdBy ?? AI_AUTHOR_ID;
      const label = q.createdBy ? q.authorName || "Unknown" : "AI Generated";
      const slot = map.get(id) ?? { label, count: 0 };
      slot.count += 1;
      map.set(id, slot);
    }
    return Array.from(map.entries())
      .map(([value, { label, count }]) => ({ value, label, count }))
      .sort((a, b) => compareText(a.label, b.label));
  }, [questions, compareText]);

  // Books are the union of `chapters[*].materialId` across all rows, plus the
  // whole "Other" documents in `materials` (#1019) — those have no chapters,
  // so without them a question generated from an "Other" document could never
  // be filtered by source. Counts are # of distinct questions that touch the
  // book/document.
  const bookOptions = useMemo<MultiSelectOption[]>(() => {
    const map = new Map<string, { label: string; count: number }>();
    for (const q of questions) {
      const touched = new Set<string>();
      for (const ch of q.chapters) {
        if (touched.has(ch.materialId)) continue;
        touched.add(ch.materialId);
        const slot =
          map.get(ch.materialId) ?? { label: ch.materialTitle, count: 0 };
        slot.count += 1;
        slot.label = ch.materialTitle;
        map.set(ch.materialId, slot);
      }
      for (const m of q.materials ?? []) {
        if (touched.has(m.id)) continue;
        touched.add(m.id);
        const slot = map.get(m.id) ?? { label: m.title, count: 0 };
        slot.count += 1;
        slot.label = m.title;
        map.set(m.id, slot);
      }
    }
    return Array.from(map.entries())
      .map(([value, { label, count }]) => ({ value, label, count }))
      .sort((a, b) => compareText(a.label, b.label));
  }, [questions, compareText]);

  // Groups questions were generated for — provenance recorded at generation
  // time, distinct from where they are currently assigned.
  const generatedForOptions = useMemo<MultiSelectOption[]>(() => {
    const map = new Map<string, { label: string; count: number }>();
    for (const q of questions) {
      const g = q.generatedForGroup;
      if (!g) continue;
      const slot = map.get(g.id) ?? { label: g.name, count: 0 };
      slot.count += 1;
      slot.label = g.name;
      map.set(g.id, slot);
    }
    return Array.from(map.entries())
      .map(([value, { label, count }]) => ({ value, label, count }))
      .sort((a, b) => compareText(a.label, b.label));
  }, [questions, compareText]);

  // Competencies are the union of `q.competencies` across all rows. Counts are
  // # of distinct questions tagged with the competency (#858).
  const competencyOptions = useMemo<MultiSelectOption[]>(() => {
    const map = new Map<string, { label: string; count: number }>();
    for (const q of questions) {
      const touched = new Set<string>();
      for (const c of q.competencies) {
        if (touched.has(c.id)) continue;
        touched.add(c.id);
        const slot = map.get(c.id) ?? { label: c.title, count: 0 };
        slot.count += 1;
        slot.label = c.title;
        map.set(c.id, slot);
      }
    }
    return Array.from(map.entries())
      .map(([value, { label, count }]) => ({ value, label, count }))
      .sort((a, b) => compareText(a.label, b.label));
  }, [questions, compareText]);

  // Assignment filter options — "assigned to any class", "unassigned", plus
  // one entry per section. Section entries match questions assigned to that
  // offering (whole-class or any group within it). Only meaningful when the
  // bank has classes, i.e. when assignments are fetched at all.
  // Rows with `published_at: null` (legacy unpublished assignments preserved
  // by the unification migration) don't count as assigned — matching the
  // hook's own helpers, which all filter on `published_at !== null`.
  const assignmentsByQuestionId = contentAssignments.assignments;
  const publishedTargetsFor = useCallback(
    (questionId: string) =>
      (assignmentsByQuestionId[questionId] ?? []).filter(
        (t) => t.published_at !== null,
      ),
    [assignmentsByQuestionId],
  );
  const assignedOptions = useMemo<MultiSelectOption[]>(() => {
    if (classes.length === 0) return [];
    const classByOffering = new Map<string, (typeof classes)[number]>();
    for (const cls of classes) {
      if (!classByOffering.has(cls.offering_id)) {
        classByOffering.set(cls.offering_id, cls);
      }
    }
    let anyCount = 0;
    let unassignedCount = 0;
    const perOffering = new Map<string, number>();
    for (const q of questions) {
      const targets = publishedTargetsFor(q.id);
      if (targets.length === 0) {
        unassignedCount += 1;
        continue;
      }
      anyCount += 1;
      const touched = new Set<string>();
      for (const t of targets) {
        if (touched.has(t.offering_id)) continue;
        touched.add(t.offering_id);
        perOffering.set(t.offering_id, (perOffering.get(t.offering_id) ?? 0) + 1);
      }
    }
    const sections = Array.from(classByOffering.values())
      .map((cls) => ({
        value: cls.offering_id,
        label: buildClassDisplayName(cls),
        count: perOffering.get(cls.offering_id) ?? 0,
      }))
      .sort((a, b) => compareText(a.label, b.label));
    return [
      { value: ASSIGNED_ANY, label: "Any class (assigned)", count: anyCount },
      { value: ASSIGNED_NONE, label: "Unassigned", count: unassignedCount },
      ...sections,
    ];
  }, [classes, questions, publishedTargetsFor, compareText]);

  // Chapters — when at least one book is selected, restrict to that book's
  // chapters; otherwise list all chapters. Counts are # of distinct questions
  // tagged with that chapter.
  const chapterOptions = useMemo<MultiSelectOption[]>(() => {
    const map = new Map<string, { label: string; count: number }>();
    for (const q of questions) {
      const touched = new Set<string>();
      for (const ch of q.chapters) {
        if (selectedBooks.size > 0 && !selectedBooks.has(ch.materialId)) continue;
        if (touched.has(ch.id)) continue;
        touched.add(ch.id);
        const label =
          selectedBooks.size === 1
            ? ch.title
            : `${ch.materialTitle} — ${ch.title}`;
        const slot = map.get(ch.id) ?? { label, count: 0 };
        slot.count += 1;
        slot.label = label;
        map.set(ch.id, slot);
      }
    }
    return Array.from(map.entries())
      .map(([value, { label, count }]) => ({ value, label, count }))
      .sort((a, b) => compareText(a.label, b.label));
  }, [questions, selectedBooks, compareText]);

  // Drop stale chapter selections when the book filter narrows them away —
  // otherwise the URL chip would show a chapter that isn't visible in the
  // dropdown, which is confusing.
  useEffect(() => {
    if (selectedChapters.size === 0) return;
    const allowed = new Set(chapterOptions.map((c) => c.value));
    const filtered = new Set(
      Array.from(selectedChapters).filter((c) => allowed.has(c)),
    );
    if (filtered.size !== selectedChapters.size) {
      updateParams({ chapter: csvSetString(filtered) });
    }
  }, [chapterOptions, selectedChapters, updateParams]);

  const quizOptions = useMemo(
    () =>
      quizUsage.quizzes.map((quiz) => ({
        value: quiz.id,
        label: quiz.title,
        count: quiz.questionCount,
      })),
    [quizUsage.quizzes],
  );

  // ── Main filter pipeline ───────────────────────────────────────────────
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return questions.filter((q) => {
      if (!selectedTypes.has(q.type)) return false;
      if (difficulty !== "all" && q.difficulty !== difficulty) return false;
      if (term.length > 0 && !q.searchText.toLowerCase().includes(term))
        return false;

      if (selectedAuthors.size > 0) {
        const id = q.createdBy ?? AI_AUTHOR_ID;
        if (!selectedAuthors.has(id)) return false;
      }

      if ((createdFrom || createdTo) && !isWithinRange(q.createdAt, createdFrom, createdTo))
        return false;

      if (selectedBooks.size > 0) {
        const hit =
          q.chapters.some((ch) => selectedBooks.has(ch.materialId)) ||
          (q.materials ?? []).some((m) => selectedBooks.has(m.id));
        if (!hit) return false;
      }

      if (selectedChapters.size > 0) {
        const hit = q.chapters.some((ch) => selectedChapters.has(ch.id));
        if (!hit) return false;
      }

      if (selectedCompetencies.size > 0) {
        const hit = q.competencies.some((c) => selectedCompetencies.has(c.id));
        if (!hit) return false;
      }

      if (selectedGeneratedFor.size > 0) {
        if (!q.generatedForGroup || !selectedGeneratedFor.has(q.generatedForGroup.id))
          return false;
      }

      if (selectedAssigned.size > 0) {
        const targets = publishedTargetsFor(q.id);
        const hit =
          (selectedAssigned.has(ASSIGNED_ANY) && targets.length > 0) ||
          (selectedAssigned.has(ASSIGNED_NONE) && targets.length === 0) ||
          targets.some((t) => selectedAssigned.has(t.offering_id));
        if (!hit) return false;
      }

      // Skipped entirely while quiz usage is unavailable (fetch error):
      // the control is disabled then, and applying a possibly-stale
      // membership map would exclude rows the user can't inspect or undo.
      if (quizUsage.error === null) {
        const quizIds = quizUsage.quizIdsByQuestion[q.id];
        if (excludeQuiz === "any") {
          if (quizIds && quizIds.length > 0) return false;
        } else if (excludeQuiz.size > 0) {
          if (quizIds?.some((id) => excludeQuiz.has(id))) return false;
        }
      }

      return true;
    });
  }, [
    questions,
    selectedTypes,
    search,
    difficulty,
    selectedAuthors,
    createdFrom,
    createdTo,
    selectedBooks,
    selectedChapters,
    selectedCompetencies,
    selectedGeneratedFor,
    selectedAssigned,
    publishedTargetsFor,
    excludeQuiz,
    quizUsage.quizIdsByQuestion,
    quizUsage.error,
  ]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  // `page` from the URL might point past the end after a filter narrowing;
  // we clamp client-side so the table never silently shows an empty page.
  const clampedPage = Math.min(Math.max(1, page), totalPages);
  const pagedQuestions = useMemo(() => {
    const start = (clampedPage - 1) * pageSize;
    return filtered.slice(start, start + pageSize);
  }, [filtered, clampedPage, pageSize]);

  const countsLine = ALL_QUESTION_TYPES.map(
    (t) => `${counts[t]} ${QUESTION_TYPE_LABELS[t]}`,
  ).join(" • ");

  const hasActiveFilters =
    search.length > 0 ||
    difficulty !== "all" ||
    selectedTypes.size !== ALL_QUESTION_TYPES.length ||
    selectedAuthors.size > 0 ||
    createdFrom !== null ||
    createdTo !== null ||
    selectedBooks.size > 0 ||
    selectedChapters.size > 0 ||
    selectedCompetencies.size > 0 ||
    selectedGeneratedFor.size > 0 ||
    selectedAssigned.size > 0 ||
    excludeQuiz === "any" ||
    excludeQuiz.size > 0;

  const clearAllFilters = useCallback(() => {
    setSearchParams(new URLSearchParams(), { replace: true });
  }, [setSearchParams]);

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

  // Inline JSX fragment for the four new filter controls — reused inline on
  // md+ screens and inside a "More filters" popover on mobile.
  const advancedFilters = (
    <>
      <Select
        value={difficulty}
        onValueChange={(v) =>
          updateParams({ difficulty: v === "all" ? null : v })
        }
      >
        <SelectTrigger
          className="w-auto min-w-[140px] gap-2"
          data-testid="difficulty-filter"
        >
          <span className="flex items-center gap-2">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">
              Difficulty
            </span>
            <SelectValue placeholder="All difficulties" />
          </span>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All difficulties</SelectItem>
          <SelectItem value="easy">Easy</SelectItem>
          <SelectItem value="medium">Medium</SelectItem>
          <SelectItem value="hard">Hard</SelectItem>
        </SelectContent>
      </Select>
      <MultiSelectFilter
        label="Author"
        options={authorOptions}
        selected={selectedAuthors}
        onChange={(next) =>
          updateParams({ author: csvSetString(next) })
        }
        testId="author-filter"
        emptyHint="No authors yet"
      />
      <DateRangeFilter
        from={createdFrom}
        to={createdTo}
        onChange={(next) =>
          updateParams({
            created_from: next.from,
            created_to: next.to,
          })
        }
        testId="date-filter"
      />
      <MultiSelectFilter
        label="Book"
        options={bookOptions}
        selected={selectedBooks}
        onChange={(next) =>
          updateParams({ book: csvSetString(next) })
        }
        testId="book-filter"
        emptyHint="No books linked yet"
      />
      <MultiSelectFilter
        label="Chapter"
        options={chapterOptions}
        selected={selectedChapters}
        onChange={(next) =>
          updateParams({ chapter: csvSetString(next) })
        }
        testId="chapter-filter"
        disabled={selectedBooks.size === 0}
        disabledHint="Select a book first"
        emptyHint="No chapters for the selected book(s)"
      />
      <MultiSelectFilter
        label="Competency"
        options={competencyOptions}
        selected={selectedCompetencies}
        onChange={(next) =>
          updateParams({ competency: csvSetString(next) })
        }
        testId="competency-filter"
        emptyHint="No competencies tagged yet"
      />
      <MultiSelectFilter
        label="Generated for"
        options={generatedForOptions}
        selected={selectedGeneratedFor}
        onChange={(next) =>
          updateParams({ generated_for: csvSetString(next) })
        }
        testId="generated-for-filter"
        emptyHint="No group-targeted questions yet"
      />
      {classes.length > 0 && (
        <MultiSelectFilter
          label="Classes"
          options={assignedOptions}
          selected={selectedAssigned}
          onChange={(next) =>
            updateParams({ assigned: csvSetString(next) })
          }
          testId="assigned-filter"
          emptyHint="No classes yet"
        />
      )}
      <ExcludeQuizFilter
        quizzes={quizOptions}
        selection={excludeQuiz}
        onChange={(next) =>
          updateParams({
            exclude_quiz: next === "any" ? "any" : csvSetString(next),
          })
        }
        testId="exclude-quiz-filter"
        disabled={quizUsage.error !== null}
        disabledHint="Quiz data unavailable"
      />
    </>
  );

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <HelpCircle className="w-5 h-5" />
                Question Bank
              </CardTitle>
              <CardDescription className="mt-1" data-testid="bank-counts">
                Showing {filtered.length} of {questions.length} question
                {questions.length === 1 ? "" : "s"} ({countsLine})
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              {isAdmin && (
                <Button
                  variant="outline"
                  onClick={() => setBulkGenerateOpen(true)}
                  data-testid="bulk-generate-button"
                >
                  <Layers className="w-4 h-4 mr-2" />
                  Bulk Generate
                </Button>
              )}
              {isAdmin && (
                // Split button: main click = generate; caret = seed from a
                // student cluster (#853).
                <div className="flex">
                  <Button
                    className="rounded-r-none"
                    onClick={() => setGenerateOpen(true)}
                    data-testid="generate-questions-button"
                  >
                    <Sparkles className="w-4 h-4 mr-2" />
                    Generate Questions
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        className="rounded-l-none border-l border-primary-foreground/20 px-2"
                        aria-label="Generate from student cluster"
                        data-testid="generate-cluster-trigger"
                      >
                        <ChevronDown className="w-4 h-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-72">
                      <DropdownMenuLabel>From student cluster</DropdownMenuLabel>
                      {!hasClusterGroups ? (
                        <DropdownMenuItem
                          disabled
                          data-testid="cluster-empty-hint"
                          className="whitespace-normal text-xs text-muted-foreground"
                        >
                          Create groups under My Class → Student Groups
                        </DropdownMenuItem>
                      ) : (
                        clusterSections.map((section, idx) => (
                          <div key={section.offeringId}>
                            {idx > 0 && <DropdownMenuSeparator />}
                            {clusterSections.length > 1 && (
                              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                                {section.label}
                              </DropdownMenuLabel>
                            )}
                            {section.groups.map((g) => (
                              <DropdownMenuItem
                                key={g.id}
                                disabled={clusterLoadingGroupId !== null}
                                onSelect={(e) => {
                                  e.preventDefault();
                                  handleGenerateFromCluster(section.offeringId, g);
                                }}
                                data-testid={`cluster-group-${g.id}`}
                              >
                                {clusterLoadingGroupId === g.id ? (
                                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                ) : (
                                  <Users className="w-4 h-4 mr-2" />
                                )}
                                {g.name}
                              </DropdownMenuItem>
                            ))}
                          </div>
                        ))
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              )}
              {isAdmin && questions.length >= 2 && (
                // Overflow menu — de-emphasised "Find Similar Questions" (#853).
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="outline"
                      size="icon"
                      aria-label="More actions"
                      data-testid="bank-overflow-trigger"
                    >
                      <MoreHorizontal className="w-4 h-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onSelect={(e) => {
                        e.preventDefault();
                        setSimilarityOpen(true);
                      }}
                      data-testid="find-similar-menu-item"
                    >
                      <GitCompare className="w-4 h-4 mr-2" />
                      Find Similar Questions
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => updateParams({ q: e.target.value || null })}
              placeholder="Search across all questions…"
              className="pl-9"
              data-testid="bank-search-input"
            />
          </div>

          <div
            className="flex flex-wrap items-center gap-2"
            data-testid="type-filter-chips"
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
                  data-testid={`type-chip-${t}`}
                  aria-pressed={active}
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

          {/* md+ : four advanced filters inline. */}
          <div
            className="hidden md:flex flex-wrap items-center gap-2"
            data-testid="advanced-filter-row"
          >
            {advancedFilters}
            {hasActiveFilters && (
              <Button
                variant="ghost"
                size="sm"
                onClick={clearAllFilters}
                data-testid="clear-filters"
                className="ml-auto text-xs"
              >
                <X className="w-3 h-3 mr-1" />
                Clear filters
              </Button>
            )}
          </div>

          {/* Small screens: same filters folded into a single popover. */}
          <div className="md:hidden flex items-center gap-2">
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="more-filters-trigger"
                >
                  <SlidersHorizontal className="w-3 h-3 mr-2" />
                  More filters
                </Button>
              </PopoverTrigger>
              <PopoverContent
                className="w-80 p-3"
                align="start"
                data-testid="more-filters-popover"
              >
                <div className="flex flex-col gap-2">{advancedFilters}</div>
              </PopoverContent>
            </Popover>
            {hasActiveFilters && (
              <Button
                variant="ghost"
                size="sm"
                onClick={clearAllFilters}
                data-testid="clear-filters-mobile"
                className="text-xs"
              >
                <X className="w-3 h-3 mr-1" />
                Clear
              </Button>
            )}
          </div>

          <UnifiedQuestionsTable
            questions={pagedQuestions}
            onQuestionsChange={(next) => {
              // The paged list is a subset; reconcile with the full list by id.
              const byId = new Map(next.map((q) => [q.id, q]));
              setQuestions((prev) =>
                prev
                  .map((q) => byId.get(q.id) ?? q)
                  // If the new list omits ids that existed in the paged set,
                  // treat that as a delete in the table layer.
                  .filter((q) => {
                    const inPaged = pagedQuestions.some((f) => f.id === q.id);
                    if (!inPaged) return true;
                    return byId.has(q.id);
                  }),
              );
            }}
            isAdmin={isAdmin}
            classes={classes.length > 0 ? classes : undefined}
            assignmentsByQuestionId={
              classes.length > 0 ? contentAssignments.assignments : undefined
            }
            groupsByOffering={
              classes.length > 0 ? contentAssignments.groupsByOffering : undefined
            }
            onOpenAssignDialog={classes.length > 0 ? handleOpenAssignDialog : undefined}
            onBulkAssign={classes.length > 0 ? handleBulkAssign : undefined}
            onCreateAssessment={isAdmin ? handleCreateAssessment : undefined}
          />

          {filtered.length > 0 && (
            <PaginationFooter
              page={clampedPage}
              pageSize={pageSize}
              totalItems={filtered.length}
              onPageChange={(p) =>
                updateParams(
                  { page: p === 1 ? null : String(p) },
                  { resetPage: false },
                )
              }
              onPageSizeChange={(size) =>
                updateParams({
                  page_size:
                    size === DEFAULT_PAGE_SIZE ? null : String(size),
                })
              }
            />
          )}
        </CardContent>
      </Card>

      {isAdmin && (
        <UnifiedGenerateDialog
          open={generateOpen}
          onOpenChange={setGenerateOpen}
          courseId={courseId}
          classes={classes}
          materials={materials}
          groupsByOffering={contentAssignments.groupsByOffering}
          onGenerated={refetch}
        />
      )}

      {isAdmin && (
        <BulkGenerateDialog
          open={bulkGenerateOpen}
          onOpenChange={setBulkGenerateOpen}
          courseId={courseId}
        />
      )}

      {isAdmin && questions.length >= 2 && (
        <SimilarityCheckDialog
          courseId={courseId}
          open={similarityOpen}
          onOpenChange={setSimilarityOpen}
          hideTrigger
          onQuestionAction={(id, action) => {
            if (action === "delete") {
              setQuestions((prev) => prev.filter((q) => q.id !== id));
            } else if (action === "hide") {
              setQuestions((prev) =>
                prev.map((q) => (q.id === id ? { ...q, hidden: true } : q)),
              );
            }
          }}
        />
      )}

      {isAdmin && (
        <GenerateMcqDialog
          open={seededMcqOpen}
          onOpenChange={setSeededMcqOpen}
          courseId={courseId}
          classes={classes}
          groupsByOffering={contentAssignments.groupsByOffering}
          onGenerated={refetch}
          seed={mcqSeed}
        />
      )}

      {isAdmin && createAssessment && (
        <CreateAssessmentDialog
          open
          onCreated={(kind) => {
            // Keep the Exclude quiz filter's list current when a quiz is
            // created straight from the bank.
            if (kind === "quiz") quizUsage.refetch();
          }}
          onOpenChange={(open) => {
            if (!open) setCreateAssessment(null);
          }}
          kind={createAssessment.kind}
          courseId={courseId}
          questions={createAssessment.questionIds
            .map((id) => questions.find((q) => q.id === id))
            .filter((q): q is NonNullable<typeof q> => !!q)}
        />
      )}

      {classes.length > 0 && (
        <ContentAssignDialog
          open={assignDialogOpen}
          onOpenChange={setAssignDialogOpen}
          classes={classes}
          currentAssignedTargets={
            !assignIsBulk && assignTargetIds.length === 1
              ? contentAssignments.getAssignedTargets(assignTargetIds[0])
              : []
          }
          groupsByOffering={contentAssignments.groupsByOffering}
          onSave={handleSaveAssign}
          saving={contentAssignments.saving}
          title={
            assignIsBulk
              ? `Assign ${assignTargetIds.length} Questions to Classes`
              : "Assign to Classes"
          }
        />
      )}
    </>
  );
}

export default UnifiedQuestionBank;
