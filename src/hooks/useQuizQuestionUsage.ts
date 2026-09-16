/**
 * Question Bank quiz-usage loader.
 *
 * Loads every quiz of a course together with its `quiz_questions` membership
 * so the bank's Exclude filter can drop questions that are already part of
 * any (or a specific) quiz. One query — quizzes with the junction embedded.
 */
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface QuizUsageQuiz {
  id: string;
  title: string;
  /** # of bank questions the quiz contains (distinct question ids). */
  questionCount: number;
}

export interface UseQuizQuestionUsageResult {
  quizzes: QuizUsageQuiz[];
  /** question id → ids of the quizzes it appears in. Absent key = in none. */
  quizIdsByQuestion: Record<string, string[]>;
  loading: boolean;
  /**
   * Non-null when the fetch failed. Callers must distinguish this from an
   * empty result — with an empty-but-failed membership map an exclude filter
   * would look active while excluding nothing.
   */
  error: string | null;
  refetch: () => Promise<void>;
}

export function useQuizQuestionUsage(
  courseId: string,
): UseQuizQuestionUsageResult {
  const [quizzes, setQuizzes] = useState<QuizUsageQuiz[]>([]);
  const [quizIdsByQuestion, setQuizIdsByQuestion] = useState<
    Record<string, string[]>
  >({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchUsage = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("quizzes")
        .select("id, title, quiz_questions(question_id)")
        .eq("course_id", courseId)
        .order("created_at", { ascending: false });
      if (error) throw error;

      const rows = (data ?? []) as Array<{
        id: string;
        title: string;
        quiz_questions: Array<{ question_id: string }> | null;
      }>;

      const byQuestion: Record<string, string[]> = {};
      const list: QuizUsageQuiz[] = rows.map((quiz) => {
        const questionIds = new Set(
          (quiz.quiz_questions ?? []).map((qq) => qq.question_id),
        );
        for (const qid of questionIds) {
          (byQuestion[qid] ??= []).push(quiz.id);
        }
        return { id: quiz.id, title: quiz.title, questionCount: questionIds.size };
      });

      setQuizzes(list);
      setQuizIdsByQuestion(byQuestion);
      setError(null);
    } catch (err) {
      // Non-fatal: the bank still works, the quiz exclude filter disables
      // itself off `error`. Surfacing a toast here would fire on every
      // course page load for users without quiz access.
      console.error("Error fetching quiz question usage:", err);
      // Supabase rejects with a PostgrestError (a plain object, not an
      // Error), so read `.message` structurally.
      const message = (err as { message?: unknown } | null)?.message;
      setError(
        typeof message === "string" && message
          ? message
          : "Failed to load quiz usage",
      );
    } finally {
      setLoading(false);
    }
  }, [courseId]);

  useEffect(() => {
    fetchUsage();
  }, [fetchUsage]);

  return { quizzes, quizIdsByQuestion, loading, error, refetch: fetchUsage };
}
