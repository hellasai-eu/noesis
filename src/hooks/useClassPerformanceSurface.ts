import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  loadQuizPerformance,
  loadStudyGuidePerformance,
} from "@/lib/class-performance-surface";

/**
 * Class Performance rosters, shaped like `useInstructorSurface`: pure
 * loaders behind thin React Query hooks, so the components get caching,
 * loading and error states without owning any fetch code.
 */
const STALE_MS = 60_000;

export function useQuizPerformance(courseId: string) {
  return useQuery({
    queryKey: ["class-performance", "quizzes", courseId],
    staleTime: STALE_MS,
    queryFn: () => loadQuizPerformance(supabase, courseId),
  });
}

export function useStudyGuidePerformance(
  courseId: string,
  classLabelByOffering: Record<string, string>,
) {
  return useQuery({
    // The labels are inputs: a renamed class must change the key or the
    // cache would keep serving rows built with the old names.
    queryKey: ["class-performance", "guides", courseId, classLabelByOffering],
    staleTime: STALE_MS,
    queryFn: () => loadStudyGuidePerformance(supabase, courseId, classLabelByOffering),
  });
}
