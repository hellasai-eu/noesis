import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import {
  getSelectedInstitutionId,
  setSelectedInstitutionId,
} from '@/lib/selected-institution';

interface UserInstitution {
  id: string;
  user_id: string;
  institution_id: string;
  role: string;
}

/**
 * Resolves the caller's membership for the institution they are currently
 * working in (`sessionStorage.selectedInstitutionId`).
 *
 * A user can belong to several institutions with a DIFFERENT role in each, so
 * every read here fetches the full membership list and picks from it in JS.
 * The previous implementation filtered in SQL and called `.maybeSingle()`,
 * which errors with PGRST116 the moment the query matches more than one row —
 * i.e. for every multi-institution user with nothing selected yet.
 */
export function useUserInstitution(userId: string | undefined) {
  const [membership, setMembership] = useState<UserInstitution | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchMembership = useCallback(async () => {
    if (!userId) {
      setMembership(null);
      setLoading(false);
      return;
    }

    const { data, error } = await supabase
      .from('user_institutions')
      .select('*')
      // Stable fallback order, so a user with no selection lands on the same
      // institution on every reload rather than whatever Postgres returns first.
      .order('created_at', { ascending: true })
      .eq('user_id', userId);

    if (error || !data || data.length === 0) {
      setMembership(null);
      setLoading(false);
      return;
    }

    const selectedInstitutionId = getSelectedInstitutionId();
    const selected = selectedInstitutionId
      ? data.find((m) => m.institution_id === selectedInstitutionId)
      : undefined;
    const resolved = selected ?? data[0];

    // If a selection is stored but is not one of the user's memberships (e.g.
    // they were removed from that institution, or it is a leftover from another
    // account), reconcile it. Pages such as Dashboard and
    // BugReportDialog read `selectedInstitutionId` straight out of
    // sessionStorage, and they must not disagree with the role reported here.
    //
    // Deliberately NOT written when nothing is selected: an empty
    // `selectedInstitutionId` is what sends a user to /select-institution, and
    // silently filling it in would drop multi-institution users into an
    // arbitrary institution without ever showing them the picker.
    if (selectedInstitutionId && resolved.institution_id !== selectedInstitutionId) {
      setSelectedInstitutionId(resolved.institution_id);
    }

    setMembership(resolved);
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    setLoading(true);
    fetchMembership();
  }, [fetchMembership]);

  const refetch = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    await fetchMembership();
  }, [fetchMembership, userId]);

  return {
    membership,
    loading,
    institutionId: membership?.institution_id || null,
    role: membership?.role || null,
    isAdmin: membership?.role === 'admin',
    isInstructor: membership?.role === 'instructor',
    isStudent: membership?.role === 'student',
    isEvaluator: membership?.role === 'evaluator',
    refetch,
  };
}
