import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  loadDueItems,
  loadStudentScope,
  type StudentScope,
} from "@/lib/student-surface";

/**
 * The dashboard's two queries: who the student is, and what they owe.
 *
 * Everything hangs off `scope`, which resolves the student's classes,
 * offerings and courses once. The due query stays disabled until it lands,
 * so it never re-runs as enrolment resolves. The self-paced activities
 * (practice, flashcards, tutoring) are the course page's business now and
 * load from its own fetch — the dashboard no longer pays for them.
 */
const STALE_MS = 60_000;

export function useStudentScope(userId: string | undefined, institutionId: string | null) {
  return useQuery({
    queryKey: ["student-surface", "scope", userId, institutionId],
    enabled: !!userId && !!institutionId,
    staleTime: STALE_MS,
    queryFn: () =>
      loadStudentScope(supabase, { userId: userId!, institutionId: institutionId! }),
  });
}

export function useDueItems(userId: string | undefined, scope: StudentScope | undefined) {
  return useQuery({
    queryKey: ["student-surface", "due", userId, scope?.offeringIds],
    enabled: !!userId && !!scope,
    staleTime: STALE_MS,
    queryFn: () => loadDueItems(supabase, { userId: userId!, scope: scope! }),
  });
}
