import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  loadInstitutionSummary,
  loadInstructorContent,
  loadInstructorScope,
  type InstructorScope,
} from "@/lib/instructor-surface";

/**
 * The instructor home's two queries, shaped like `useStudentSurface`:
 * scope first (which courses), content gated on it (what exists in them).
 */
const STALE_MS = 60_000;

export function useInstructorScope(userId: string | undefined, institutionId: string | null) {
  return useQuery({
    queryKey: ["instructor-surface", "scope", userId, institutionId],
    enabled: !!userId && !!institutionId,
    staleTime: STALE_MS,
    queryFn: () =>
      loadInstructorScope(supabase, { userId: userId!, institutionId: institutionId! }),
  });
}

export function useInstitutionSummary(institutionId: string | null) {
  return useQuery({
    queryKey: ["instructor-surface", "institution", institutionId],
    enabled: !!institutionId,
    staleTime: STALE_MS,
    queryFn: () => loadInstitutionSummary(supabase, institutionId!),
  });
}

export function useInstructorContent(scope: InstructorScope | undefined) {
  return useQuery({
    // The offering→class maps are inputs too: a renamed class or moved
    // offering changes the scope, and the key must change with it or the
    // cache would keep serving summaries built with the old names.
    queryKey: [
      "instructor-surface",
      "content",
      scope?.courseIds,
      scope?.classNameByOffering,
      scope?.classIdByOffering,
    ],
    enabled: !!scope,
    staleTime: STALE_MS,
    queryFn: () =>
      loadInstructorContent(supabase, {
        courseIds: scope!.courseIds,
        classNameByOffering: scope!.classNameByOffering,
        classIdByOffering: scope!.classIdByOffering,
      }),
  });
}
