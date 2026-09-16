import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { InstitutionType, SchoolLevel } from "@/lib/greek-school";

interface InstitutionConfig {
  institutionType: InstitutionType;
  schoolLevels: SchoolLevel[];
  defaultLanguage: string;
  academicPeriod: string | null;
  loading: boolean;
}

export function useInstitutionConfig(institutionId: string | null): InstitutionConfig {
  const [institutionType, setInstitutionType] = useState<InstitutionType>("generic");
  const [schoolLevels, setSchoolLevels] = useState<SchoolLevel[]>([]);
  const [defaultLanguage, setDefaultLanguage] = useState("en");
  const [academicPeriod, setAcademicPeriod] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!institutionId) {
      setLoading(false);
      return;
    }

    setInstitutionType("generic");
    setSchoolLevels([]);
    setDefaultLanguage("en");
    setAcademicPeriod(null);
    setLoading(true);

    // Guards against an out-of-order response: switching A → B fires two
    // requests, and if A's lands last it would overwrite B's config while
    // `institutionId` already reads B. That was latent while the id only
    // changed on remount; `LocaleProvider` now changes it in place on every
    // in-app institution switch, which makes it reachable — and a stale
    // `default_language` puts the whole UI back into the previous
    // institution's language.
    let cancelled = false;

    const fetchConfig = async () => {
      const { data } = await supabase
        .from("institutions")
        .select("institution_type, school_levels, default_language, academic_period")
        .eq("id", institutionId)
        .single();

      // A newer institutionId owns the state (and `loading`) from here on.
      if (cancelled) return;

      if (data) {
        setInstitutionType((data.institution_type as InstitutionType) || "generic");
        setSchoolLevels((data.school_levels as SchoolLevel[]) || []);
        setDefaultLanguage(data.default_language || "en");
        setAcademicPeriod(data.academic_period || null);
      }
      setLoading(false);
    };

    fetchConfig();

    return () => {
      cancelled = true;
    };
  }, [institutionId]);

  return { institutionType, schoolLevels, defaultLanguage, academicPeriod, loading };
}
