import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { loadIsSuperAdmin } from "@/lib/super-admin";

/**
 * Thin TanStack Query wrapper over `loadIsSuperAdmin`, shaped like the
 * surface hooks: the loader stays pure, the hook only wires client + cache.
 * `enabled` lets callers skip the RPC when a membership role already
 * answers the question.
 */
export function useIsSuperAdmin(
  userId: string | undefined,
  opts?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: ["is-super-admin", userId],
    enabled: !!userId && (opts?.enabled ?? true),
    staleTime: 60_000,
    queryFn: () => loadIsSuperAdmin(supabase, userId!),
  });
}
