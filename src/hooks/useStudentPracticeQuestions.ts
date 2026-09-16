/**
 * #753 — Unified student practice-questions loader.
 *
 * Mirrors the instructor-side `useUnifiedQuestions` but scoped to a single
 * student and to questions that have been ASSIGNED to their enrolled
 * offerings (via `offering_questions`, `published_at IS NOT NULL`). Returns
 * a normalized, type-agnostic row per question with a unified completion
 * status reconciled across the five practice types.
 *
 * Status sources (read-only — no migration):
 *   - mcq          → `quiz_answers` (rows are written per attempt, even in
 *                    practice mode where `quiz_id IS NULL`). `is_correct`
 *                    on any row promotes the question to "completed".
 *   - open / fill_gaps / ordering / classification
 *                  → `chat_sessions.status` + `open_question_grades`
 *
 * Out of scope: interactive-mode open questions (Socratic chat surface),
 * and any question that is also a member of a timed quiz — those flow
 * through `StudentQuiz` and stay separate per the parent epic (#752).
 */
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type { Json } from "@/integrations/supabase/types";
import type { QuestionType } from "@/types/question";
import {
  buildPreview,
  openAnsweringModeFromPayload,
  type ChapterReference,
  type OpenAnsweringMode,
  type UnifiedQuestionRaw,
} from "@/lib/unified-question";
import { resolveStudentEnrolledOfferingsForCourse } from "@/lib/student-offerings";

export type StudentPracticeStatus = "not_started" | "in_progress" | "completed";

export interface StudentPracticeQuestion {
  id: string;
  type: QuestionType;
  stemPreview: string;
  difficulty: "easy" | "medium" | "hard";
  status: StudentPracticeStatus;
  /** 0–100 score when known; omitted when the question is `not_started`. */
  grade?: number;
  /** The offering this assignment was sourced from — needed by #756's dispatcher. */
  offeringId: string;
  /** Populated for `type === "open"`. Always `"single"` here (interactive is filtered out). */
  answeringMode?: OpenAnsweringMode;
  /** #774 — chapter tags joined via `question_chapters` so the list can offer a chapter filter. */
  chapters: ChapterReference[];
}

export interface UseStudentPracticeQuestionsResult {
  questions: StudentPracticeQuestion[];
  loading: boolean;
  refetch: () => Promise<void>;
}

interface QuestionRow {
  id: string;
  type: string;
  question: string | null;
  payload: Json | null;
  difficulty: string;
  hidden: boolean;
}

const VALID_TYPES: ReadonlySet<string> = new Set([
  "mcq",
  "open",
  "fill_gaps",
  "ordering",
  "classification",
]);

// Reuse the same chunk size the per-type Student components use — keeps the
// PostgREST URL under its ~8 KB limit.
const ID_CHUNK_SIZE = 100;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function normalizeDifficulty(raw: string): "easy" | "medium" | "hard" {
  return raw === "easy" || raw === "hard" ? raw : "medium";
}

export function useStudentPracticeQuestions(
  courseId: string,
): UseStudentPracticeQuestionsResult {
  const [questions, setQuestions] = useState<StudentPracticeQuestion[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchQuestions = useCallback(async () => {
    setLoading(true);
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        setQuestions([]);
        return;
      }

      // 1. Resolve the offerings the student is enrolled in for this course
      //    via the shared helper. We cannot embed `class_enrollments` under
      //    `offerings` (no FK between them — see #743, #750, #770).
      const offeringRows = await resolveStudentEnrolledOfferingsForCourse(
        supabase,
        { userId: user.id, courseId },
      );
      const offeringIds = offeringRows.map((o) => o.id);
      if (offeringIds.length === 0) {
        setQuestions([]);
        return;
      }

      // 2. Pull the assignment rows. Keep the (question_id → offering_id)
      //    map so the answer dispatcher (#756) knows which offering owns a
      //    given question — when the same question is assigned via two
      //    offerings we keep the first occurrence.
      const { data: assignments, error: assignErr } = await supabase
        .from("offering_questions")
        .select("question_id, offering_id")
        .in("offering_id", offeringIds)
        .not("published_at", "is", null);
      if (assignErr) throw assignErr;
      const questionToOffering = new Map<string, string>();
      for (const row of assignments ?? []) {
        const r = row as { question_id: string; offering_id: string };
        if (!questionToOffering.has(r.question_id)) {
          questionToOffering.set(r.question_id, r.offering_id);
        }
      }
      const questionIds = Array.from(questionToOffering.keys());
      if (questionIds.length === 0) {
        setQuestions([]);
        return;
      }

      // 3. Identify questions that are part of a timed quiz so we can
      //    exclude them — those flow through StudentQuiz (the assess path)
      //    and are out of scope per the parent epic.
      const quizMemberIds = new Set<string>();
      for (const ids of chunk(questionIds, ID_CHUNK_SIZE)) {
        const { data: quizMembers, error: qmErr } = await supabase
          .from("quiz_questions")
          .select("question_id")
          .in("question_id", ids);
        if (qmErr) throw qmErr;
        for (const m of quizMembers ?? []) {
          quizMemberIds.add((m as { question_id: string }).question_id);
        }
      }
      const eligibleQuestionIds = questionIds.filter((id) => !quizMemberIds.has(id));
      if (eligibleQuestionIds.length === 0) {
        setQuestions([]);
        return;
      }

      // 4. Fetch the unified question rows, chunked to stay under PostgREST's URL limit.
      const rows: QuestionRow[] = [];
      for (const ids of chunk(eligibleQuestionIds, ID_CHUNK_SIZE)) {
        const { data, error } = await supabase
          .from("questions")
          // Student-facing columns only (#1011). This is a whole course's
          // assigned questions across all five types, so asking for
          // `answer_key` here handed the browser every answer the student had
          // been set — and nothing on this surface ever read it: the hook
          // returns a preview, a status and a grade, and `buildPreview` works
          // from `payload` alone.
          .select("id, type, question, payload, difficulty, hidden")
          .in("id", ids);
        if (error) throw error;
        for (const r of (data ?? []) as QuestionRow[]) {
          if (r.hidden) continue;
          if (!VALID_TYPES.has(r.type)) continue;
          rows.push(r);
        }
      }
      if (rows.length === 0) {
        setQuestions([]);
        return;
      }

      // 5. Status reconciliation — fan out the status reads in parallel.
      const mcqIds = rows.filter((r) => r.type === "mcq").map((r) => r.id);
      const otherIds = rows.filter((r) => r.type !== "mcq").map((r) => r.id);

      // Chunked fetcher for user-scoped .in() queries — keeps PostgREST URL under ~8 KB.
      //
      // `table` is narrowed to the two tables this actually reads. Typed as a
      // bare `string` it made `.from()` resolve against every table in the
      // schema at once, which TypeScript gives up on ("Type instantiation is
      // excessively deep") — and giving up meant no checking here at all.
      async function fetchChunked<T>(
        table: "chat_sessions" | "open_question_grades",
        idField: string,
        selectCols: string,
        ids: string[],
      ): Promise<T[]> {
        const out: T[] = [];
        for (const batch of chunk(ids, ID_CHUNK_SIZE)) {
          // The builder is given an explicit shape rather than an inferred one.
          // PostgREST derives the row type from the *literal* select string, and
          // `selectCols` is a parameter — asked to infer from an arbitrary
          // string it recurses until TypeScript bails out ("excessively deep"),
          // and bailing out silently disables checking for the whole call. The
          // assertion has to sit on `.from()`, before the chain is evaluated.
          // `T` comes from the two call sites, which do know their columns.
          const builder = supabase.from(table) as unknown as {
            select(cols: string): {
              eq(column: string, value: string): {
                in(
                  column: string,
                  values: string[],
                ): PromiseLike<{
                  data: T[] | null;
                  error: { message: string } | null;
                }>;
              };
            };
          };

          const { data, error } = await builder
            .select(selectCols)
            .eq("user_id", user.id)
            .in(idField, batch);
          if (error) throw error;
          for (const row of data ?? []) out.push(row);
        }
        return out;
      }

      // quiz_answers: restrict to practice-mode attempts (quiz_id IS NULL) so
      // that prior timed-quiz attempts don't bleed into practice-surface status.
      async function fetchMcqAnswers(): Promise<{ question_id: string; is_correct: boolean }[]> {
        const out: { question_id: string; is_correct: boolean }[] = [];
        for (const batch of chunk(mcqIds, ID_CHUNK_SIZE)) {
          const { data, error } = await supabase
            .from("quiz_answers")
            .select("question_id, is_correct")
            .eq("user_id", user.id)
            .is("quiz_id", null)
            .in("question_id", batch);
          if (error) throw error;
          for (const row of (data ?? []) as { question_id: string; is_correct: boolean }[]) out.push(row);
        }
        return out;
      }

      // #774 — chapter joins. Mirrors the instructor bank's `useUnifiedQuestions`
      // query (question_chapters → material_chapters → course_materials),
      // chunked to stay under PostgREST's URL limit.
      interface RawChapterJoinRow {
        question_id: string;
        material_chapters: {
          id: string;
          title: string;
          material_id: string;
          course_materials: {
            id: string;
            title: string | null;
            file_name: string | null;
          } | null;
        } | null;
      }
      async function fetchChapterJoins(): Promise<RawChapterJoinRow[]> {
        const out: RawChapterJoinRow[] = [];
        const allIds = rows.map((r) => r.id);
        for (const batch of chunk(allIds, ID_CHUNK_SIZE)) {
          const { data, error } = await supabase
            .from("question_chapters")
            .select(
              `question_id, chapter_id, material_chapters!inner(
                id, title, material_id,
                course_materials!inner(id, title, file_name)
              )`,
            )
            .in("question_id", batch);
          if (error) throw error;
          for (const row of (data ?? []) as unknown as RawChapterJoinRow[]) out.push(row);
        }
        return out;
      }

      const [quizAnswerRows, progressRows, gradeRows, chapterJoinRows] = await Promise.all([
        mcqIds.length > 0
          ? fetchMcqAnswers()
          : Promise.resolve([] as { question_id: string; is_correct: boolean }[]),
        otherIds.length > 0
          ? fetchChunked<{ open_question_id: string; status: string }>(
              "chat_sessions", "open_question_id", "open_question_id, status", otherIds,
            )
          : Promise.resolve([] as { open_question_id: string; status: string }[]),
        otherIds.length > 0
          ? fetchChunked<{ open_question_id: string; grade: number | null }>(
              "open_question_grades", "open_question_id", "open_question_id, grade", otherIds,
            )
          : Promise.resolve([] as { open_question_id: string; grade: number | null }[]),
        fetchChapterJoins(),
      ]);

      // Build the per-question chapter map. Skip joins whose embedded material
      // came back null (RLS can theoretically hide the parent material).
      const chapterMap = new Map<string, ChapterReference[]>();
      for (const row of chapterJoinRows) {
        const ch = row.material_chapters;
        const mat = ch?.course_materials;
        if (!ch || !mat) continue;
        const list = chapterMap.get(row.question_id) ?? [];
        list.push({
          id: ch.id,
          title: ch.title,
          materialId: mat.id,
          materialTitle: mat.title || mat.file_name || "Unknown",
        });
        chapterMap.set(row.question_id, list);
      }

      // MCQ: completed when ANY attempt was correct, in_progress when there is
      // at least one row but none correct, otherwise not_started.
      const mcqAnyAttempt = new Set<string>();
      const mcqCorrect = new Set<string>();
      for (const row of quizAnswerRows) {
        mcqAnyAttempt.add(row.question_id);
        if (row.is_correct) mcqCorrect.add(row.question_id);
      }

      // Other types: status comes from the chat session; grade (when
      // present) comes from open_question_grades. `paused` collapses into
      // `in_progress` for the unified surface — paused is a moderator-flagged
      // state that's invisible at the list level.
      const progressByQuestion = new Map<string, string>();
      for (const row of progressRows) {
        progressByQuestion.set(row.open_question_id, row.status);
      }
      const gradeByQuestion = new Map<string, number>();
      // The deterministic types (fill the gaps, ordering, classification) and
      // single-answer open questions never open a chat session at all:
      // `grade-deterministic-answer` writes the result straight to
      // `open_question_grades`, and the answering panels read that row back to
      // decide they are done. Reading only `chat_sessions` for status showed
      // that submitted work as not-started again the moment a student
      // reloaded the list.
      //
      // Only where there is NO chat session, though. When a question has one,
      // it is the conversational surface and its own status stays the
      // authority — a grade can be recorded against a conversation that is
      // still going.
      const submittedQuestions = new Set<string>();
      for (const row of gradeRows) {
        submittedQuestions.add(row.open_question_id);
        if (typeof row.grade === "number") {
          gradeByQuestion.set(row.open_question_id, row.grade);
        }
      }

      // 6. Map rows to the normalized shape, dropping interactive-mode open
      //    questions (parent epic out-of-scope).
      const mapped: StudentPracticeQuestion[] = [];
      for (const r of rows) {
        const type = r.type as QuestionType;
        const raw: UnifiedQuestionRaw = {
          question: r.question,
          payload: r.payload,
          // `UnifiedQuestionRaw` is shared with the instructor surfaces,
          // which legitimately read these. The student list does not fetch
          // them, and `buildPreview` never touches them — only
          // `buildSearchText` does, and this hook does not call it.
          answer_key: null,
          explanation: null,
          generation_rationale: null,
        };
        const answeringMode =
          type === "open" ? openAnsweringModeFromPayload(r.payload) : undefined;
        if (type === "open" && answeringMode === "interactive") continue;

        let status: StudentPracticeStatus = "not_started";
        let grade: number | undefined;

        if (type === "mcq") {
          if (mcqCorrect.has(r.id)) {
            status = "completed";
            grade = 100;
          } else if (mcqAnyAttempt.has(r.id)) {
            status = "in_progress";
            grade = 0;
          }
        } else {
          const progressStatus = progressByQuestion.get(r.id);
          if (progressStatus === "completed") {
            status = "completed";
          } else if (progressStatus === "in_progress" || progressStatus === "paused") {
            status = "in_progress";
          } else if (submittedQuestions.has(r.id)) {
            status = "completed";
          }
          const g = gradeByQuestion.get(r.id);
          if (typeof g === "number") grade = g;
        }

        // Defensive: buildPreview reads malformed payloads via the
        // question-payload helpers, which already return safe sentinels
        // ("", []). Wrap in a try/catch anyway so one corrupt row never
        // takes down the whole list.
        let stemPreview = "";
        try {
          stemPreview = buildPreview(type, raw);
        } catch (err) {
          console.error("buildPreview threw on row", r.id, err);
          stemPreview = "";
        }

        const offeringId = questionToOffering.get(r.id) ?? "";

        mapped.push({
          id: r.id,
          type,
          stemPreview,
          difficulty: normalizeDifficulty(r.difficulty),
          status,
          ...(grade !== undefined ? { grade } : {}),
          offeringId,
          ...(answeringMode !== undefined ? { answeringMode } : {}),
          chapters: chapterMap.get(r.id) ?? [],
        });
      }

      setQuestions(mapped);
    } catch (err) {
      console.error("Failed to load student practice questions", err);
      toast.error("Failed to load practice questions");
      setQuestions([]);
    } finally {
      setLoading(false);
    }
  }, [courseId]);

  useEffect(() => {
    void fetchQuestions();
  }, [fetchQuestions]);

  return { questions, loading, refetch: fetchQuestions };
}
