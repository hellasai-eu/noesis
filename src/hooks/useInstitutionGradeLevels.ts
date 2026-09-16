import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  deriveGradeOptions,
  findGradeCodeById,
  findGradeLevelIdByCode,
  getGradeLabelFromRows,
  type GradeLevelOption,
  type GradeLevelRow,
} from "@/lib/grade-levels";

export interface InstitutionGradeLevels {
  rows: GradeLevelRow[];
  options: GradeLevelOption[];
  loading: boolean;
  findIdByCode: (code: string | null | undefined) => string | null;
  findCodeById: (id: string | null | undefined) => string | null;
  getLabel: (code: string | null | undefined, lang: string) => string;
  getLabelById: (id: string | null | undefined, lang: string) => string;
}

/**
 * Fetch the institution's `grade_levels` rows and expose them as the
 * canonical dropdown source + FK lookup. Cached by institution.
 */
export function useInstitutionGradeLevels(
  institutionId: string | null | undefined,
): InstitutionGradeLevels {
  const { data, isLoading } = useQuery<GradeLevelRow[]>({
    queryKey: ["grade_levels", institutionId],
    enabled: !!institutionId,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("grade_levels")
        .select(
          "id, institution_id, code, label_el, label_en, ordinal, school_level, is_generic",
        )
        .eq("institution_id", institutionId!)
        .order("ordinal", { ascending: true });
      if (error) throw error;
      return (data ?? []) as GradeLevelRow[];
    },
  });

  const rows = useMemo(() => data ?? [], [data]);
  const options = useMemo(() => deriveGradeOptions(rows), [rows]);
  const findIdByCode = useMemo(
    () => (code: string | null | undefined) => findGradeLevelIdByCode(rows, code),
    [rows],
  );
  const findCodeById = useMemo(
    () => (id: string | null | undefined) => findGradeCodeById(rows, id),
    [rows],
  );
  const getLabel = useMemo(
    () => (code: string | null | undefined, lang: string) =>
      getGradeLabelFromRows(rows, code, lang),
    [rows],
  );
  const getLabelById = useMemo(
    () => (id: string | null | undefined, lang: string) => {
      if (!id) return "";
      const row = rows.find((r) => r.id === id);
      if (!row) return "";
      return lang === "el" ? row.label_el : row.label_en;
    },
    [rows],
  );

  return {
    rows,
    options,
    loading: isLoading,
    findIdByCode,
    findCodeById,
    getLabel,
    getLabelById,
  };
}
