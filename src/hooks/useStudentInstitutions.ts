import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { setSelectedInstitutionId } from "@/lib/selected-institution";

/**
 * The institutions a student belongs to, plus which one they are looking at.
 *
 * Lifted out of `StudentDashboard` when the course route started rendering the
 * same `SurfaceShell`: the shell's institution switcher is part of the chrome,
 * so every page that wears it needs the same list, resolved the same way — the
 * session's stored choice first, the first membership otherwise.
 *
 * The poll is the reason this is a hook and not a query: a student who has
 * just accepted an invitation can arrive before their membership row exists,
 * and the surface must keep looking rather than showing them a dead end.
 */
export interface StudentInstitution {
  id: string;
  name: string;
  slug: string;
  logo_url: string | null;
  is_public?: boolean;
  /**
   * Whether this membership has been suspended.
   *
   * A suspended institution stays in the list — hiding it would silently
   * change what the switcher has always offered, and RLS, not this array, is
   * what actually gates the data. It is carried so that a caller making an
   * automatic choice can decline to make it into a suspended membership.
   */
  is_suspended: boolean;
}

const POLL_MS = 5000;

export function useStudentInstitutions(userId: string | undefined) {
  const [institutions, setInstitutions] = useState<StudentInstitution[]>([]);
  const [currentInstitution, setCurrentInstitution] = useState<StudentInstitution | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refetch = useCallback(async () => {
    if (!userId) return;

    const { data: memberships } = await supabase
      .from("user_institutions")
      .select("institution_id, is_suspended")
      .eq("user_id", userId);

    const suspendedById = new Map(
      (memberships ?? []).map((m) => [m.institution_id, !!m.is_suspended]),
    );
    const memberInstIds = [...suspendedById.keys()];

    let memberInstitutions: StudentInstitution[] = [];
    if (memberInstIds.length > 0) {
      const { data } = await supabase
        .from("institutions")
        .select("id, name, slug, logo_url, is_public")
        .in("id", memberInstIds);
      memberInstitutions = (data ?? []).map((i) => ({
        ...i,
        is_suspended: suspendedById.get(i.id) ?? false,
      }));
    }

    if (memberInstitutions.length > 0) {
      setInstitutions(memberInstitutions);
      const selectedId = sessionStorage.getItem("selectedInstitutionId");
      const current = memberInstitutions.find((i) => i.id === selectedId) ?? memberInstitutions[0];
      setCurrentInstitution(current);
      if (current && !selectedId) setSelectedInstitutionId(current.id);
    } else {
      setInstitutions([]);
      setCurrentInstitution(null);
    }
    setLoaded(true);
  }, [userId]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  useEffect(() => {
    if (!userId || institutions.length > 0) return;
    const interval = setInterval(() => {
      refetch();
    }, POLL_MS);
    return () => clearInterval(interval);
  }, [userId, institutions.length, refetch]);

  /** Switch the viewed institution, and remember it for the next page. */
  const select = useCallback(
    (institutionId: string) => {
      const full = institutions.find((i) => i.id === institutionId);
      if (!full) return;
      setSelectedInstitutionId(full.id);
      setCurrentInstitution(full);
    },
    [institutions],
  );

  return { institutions, currentInstitution, loaded, refetch, select };
}
