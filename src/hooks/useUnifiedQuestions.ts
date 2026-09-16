/**
 * #621 — Unified Question Bank loader.
 *
 * Loads every `public.questions` row for a course regardless of `type` and
 * joins votes, competencies, chapters and author names in one pass. The
 * shape is keyed off `type` so the unified table can render all 5 question
 * types side-by-side.
 */
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { fetchAuthorNames } from "@/lib/author-names";
import { toast } from "sonner";
import type { QuestionType } from "@/types/question";
import {
  buildPreview,
  buildSearchText,
  openAnsweringModeFromPayload,
  type ChapterReference,
  type Competency,
  type GeneratedForGroup,
  type MaterialReference,
  type UnifiedQuestion,
} from "@/lib/unified-question";

interface DbQuestionRow {
  id: string;
  course_id: string;
  question: string | null;
  type: string;
  payload: unknown;
  answer_key: unknown;
  explanation: string | null;
  difficulty: string;
  upvotes: number;
  downvotes: number;
  hidden: boolean;
  created_at: string;
  created_by: string | null;
  generation_rationale: string | null;
  is_user_generated: boolean | null;
  generated_for_group_id: string | null;
}

export interface UseUnifiedQuestionsOptions {
  /**
   * #624 — when `true`, drop open questions whose `answering_mode` resolves
   * to `"interactive"`. Legacy/empty payloads default to `"interactive"`
   * (see `openAnsweringModeFromPayload`) so they are excluded too. Other
   * types (mcq / fill_gaps / ordering / classification) are unaffected.
   * Defaults to `false` so the hook stays unfiltered for callers that need
   * the full set (e.g. Practice & Review).
   */
  excludeInteractiveOpen?: boolean;
  /**
   * When `true`, drop rows with `is_user_generated === true`. Used by the
   * instructor assessment bank so that student-generated questions never
   * appear alongside instructor/AI-generated content.
   */
  excludeUserGenerated?: boolean;
  /**
   * #977 — when `true`, drop questions that belong to a study guide piece.
   * Study-guide questions live in the shared `questions` table (membership in
   * `study_guide_piece_questions` is their only provenance marker), so without
   * this a generated guide would flood the Question Bank with dozens of rows
   * the instructor never authored for it.
   */
  excludeStudyGuideQuestions?: boolean;
}

export interface UseUnifiedQuestionsResult {
  questions: UnifiedQuestion[];
  loading: boolean;
  refetch: () => Promise<void>;
  setQuestions: React.Dispatch<React.SetStateAction<UnifiedQuestion[]>>;
}

function resolveGeneratedForGroup(
  groupId: string | null,
  groupNameById: Map<string, string>,
): GeneratedForGroup | null {
  if (!groupId) return null;
  const name = groupNameById.get(groupId);
  // A group the caller cannot see (or one since deleted) yields no name;
  // surface nothing rather than a bare UUID.
  return name ? { id: groupId, name } : null;
}

const VALID_TYPES: ReadonlySet<string> = new Set([
  "mcq",
  "open",
  "fill_gaps",
  "ordering",
  "classification",
]);

export function useUnifiedQuestions(
  courseId: string,
  options: UseUnifiedQuestionsOptions = {},
): UseUnifiedQuestionsResult {
  const {
    excludeInteractiveOpen = false,
    excludeUserGenerated = false,
    excludeStudyGuideQuestions = false,
  } = options;
  const [questions, setQuestions] = useState<UnifiedQuestion[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchQuestions = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("questions")
        .select("*")
        .eq("course_id", courseId)
        .order("created_at", { ascending: false });

      if (error) throw error;

      const rows = (data ?? []) as unknown as DbQuestionRow[];
      const ids = rows.map((r) => r.id);

      const voteCounts: Record<string, { up: number; down: number }> = {};
      const competencyMap: Record<string, Competency[]> = {};
      const chapterMap: Record<string, ChapterReference[]> = {};
      const materialMap: Record<string, MaterialReference[]> = {};
      const groupNameById = new Map<string, string>();

      if (ids.length > 0) {
        // `question_materials` isn't in the generated supabase types yet;
        // the cast matches the writers.
        const [
          { data: votes },
          { data: questionCompetencies },
          { data: questionChapters },
          { data: questionMaterials },
        ] = await Promise.all([
          supabase
            .from("question_votes")
            .select("question_id, vote_type")
            .in("question_id", ids),
          supabase
            .from("question_competencies")
            .select(
              "question_id, competency_id, course_competencies!inner(id, title)",
            )
            .in("question_id", ids),
          supabase
            .from("question_chapters")
            .select(
              `question_id, chapter_id, material_chapters!inner(
                id, title, material_id,
                course_materials!inner(id, title, file_name)
              )`,
            )
            .in("question_id", ids),
          supabase
            .from("question_materials" as never)
            .select(
              "question_id, material_id, course_materials!inner(id, title, file_name)",
            )
            .in("question_id", ids) as unknown as Promise<{
              data:
                | {
                    question_id: string;
                    material_id: string;
                    course_materials: {
                      id: string;
                      title: string | null;
                      file_name: string | null;
                    } | null;
                  }[]
                | null;
            }>,
        ]);

        for (const v of votes ?? []) {
          const row = v as { question_id: string; vote_type: string };
          const slot = voteCounts[row.question_id] ?? { up: 0, down: 0 };
          if (row.vote_type === "up") slot.up += 1;
          else slot.down += 1;
          voteCounts[row.question_id] = slot;
        }

        for (const qc of questionCompetencies ?? []) {
          // Supabase's typed JSON for inner joins is awkward; cast at the boundary.
          const row = qc as {
            question_id: string;
            course_competencies: { id: string; title: string } | null;
          };
          if (!row.course_competencies) continue;
          const list = competencyMap[row.question_id] ?? [];
          list.push({ id: row.course_competencies.id, title: row.course_competencies.title });
          competencyMap[row.question_id] = list;
        }

        for (const qc of questionChapters ?? []) {
          const row = qc as {
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
          };
          const ch = row.material_chapters;
          const mat = ch?.course_materials;
          if (!ch || !mat) continue;
          const list = chapterMap[row.question_id] ?? [];
          list.push({
            id: ch.id,
            title: ch.title,
            materialId: mat.id,
            materialTitle: mat.title || mat.file_name || "Unknown",
          });
          chapterMap[row.question_id] = list;
        }

        for (const qm of questionMaterials ?? []) {
          const mat = qm.course_materials;
          if (!mat) continue;
          const list = materialMap[qm.question_id] ?? [];
          list.push({
            id: mat.id,
            title: mat.title || mat.file_name || "Unknown",
          });
          materialMap[qm.question_id] = list;
        }

        // Resolve `generated_for_group_id` → group name in one roundtrip.
        // A group the caller cannot read (RLS) simply resolves to nothing.
        const groupIds = Array.from(
          new Set(
            rows
              .map((r) => r.generated_for_group_id)
              .filter((id): id is string => !!id),
          ),
        );
        if (groupIds.length > 0) {
          const { data: groups } = await supabase
            .from("offering_groups")
            .select("id, name")
            .in("id", groupIds);
          for (const g of groups ?? []) {
            groupNameById.set(g.id as string, g.name as string);
          }
        }
      }

      // #977 — questions owned by a study guide piece. Membership in
      // `study_guide_piece_questions` is the only thing distinguishing them
      // from Question Bank rows; `questions` carries no origin column.
      const studyGuideQuestionIds = new Set<string>();
      if (excludeStudyGuideQuestions && ids.length > 0) {
        const { data: pieceQuestions, error: pqError } = await supabase
          .from("study_guide_piece_questions")
          .select("question_id")
          .in("question_id", ids);
        if (pqError) throw pqError;
        for (const pq of pieceQuestions ?? []) {
          studyGuideQuestionIds.add((pq as { question_id: string }).question_id);
        }
      }

      // Resolve author names from created_by UUIDs in a single roundtrip.
      const creatorIds = Array.from(
        new Set(rows.filter((r) => r.created_by).map((r) => r.created_by as string)),
      );
      const authorMap = await fetchAuthorNames(creatorIds);

      const unified: UnifiedQuestion[] = rows
        .filter(
          (r) =>
            VALID_TYPES.has(r.type) &&
            (!excludeUserGenerated || !r.is_user_generated) &&
            !studyGuideQuestionIds.has(r.id),
        )
        .map((r) => {
          const type = r.type as QuestionType;
          const raw = {
            question: r.question,
            payload: r.payload as never,
            answer_key: r.answer_key as never,
            explanation: r.explanation,
            generation_rationale: r.generation_rationale,
          };
          const answeringMode =
            type === "open" ? openAnsweringModeFromPayload(r.payload as never) : undefined;
          return {
            id: r.id,
            type,
            preview: buildPreview(type, raw),
            searchText: buildSearchText(type, raw),
            difficulty: (r.difficulty as "easy" | "medium" | "hard") || "medium",
            authorName: r.created_by ? authorMap[r.created_by] || "Unknown" : null,
            createdBy: r.created_by,
            createdAt: r.created_at,
            hidden: r.hidden,
            upvotes: voteCounts[r.id]?.up ?? r.upvotes ?? 0,
            downvotes: voteCounts[r.id]?.down ?? r.downvotes ?? 0,
            competencies: competencyMap[r.id] ?? [],
            chapters: chapterMap[r.id] ?? [],
            materials: materialMap[r.id] ?? [],
            generatedForGroup: resolveGeneratedForGroup(
              r.generated_for_group_id,
              groupNameById,
            ),
            answeringMode,
            raw,
          };
        })
        // #624 — opt-in filter: drop interactive-mode opens so they live only
        // in the dedicated "AI Interactive Questions" tab and don't appear
        // twice in the Question Bank.
        .filter(
          (q) =>
            !excludeInteractiveOpen ||
            q.type !== "open" ||
            q.answeringMode !== "interactive",
        );

      setQuestions(unified);
    } catch (err) {
      console.error("Failed to load unified questions", err);
      toast.error("Failed to load questions");
    } finally {
      setLoading(false);
    }
  }, [courseId, excludeInteractiveOpen, excludeUserGenerated, excludeStudyGuideQuestions]);

  useEffect(() => {
    void fetchQuestions();
  }, [fetchQuestions]);

  return { questions, loading, refetch: fetchQuestions, setQuestions };
}
