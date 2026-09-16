import { vi } from 'vitest';

export interface Membership {
  id: string;
  user_id: string;
  institution_id: string;
  role: string;
  created_at?: string;
}

/**
 * Minimal in-memory stand-in for `supabase.from('user_institutions')`.
 *
 * It mirrors the PostgREST semantics `useUserInstitution` depends on:
 *  - `.eq()` filters, `.order()` sorts, `.limit()` truncates
 *  - awaiting the builder resolves to `{ data: rows, error: null }`
 *  - `.maybeSingle()` yields the single row, `null` for zero rows, and a
 *    PGRST116 **error** for more than one — the failure mode that made the
 *    old implementation break for users in two institutions.
 *
 * Pass it as the implementation of a hoisted `supabase.from` mock.
 */
export function fakeUserInstitutionsFrom(rows: Membership[]) {
  return (table: string) => {
    if (table !== 'user_institutions') {
      throw new Error(`unexpected table in this test: ${table}`);
    }

    let filtered = [...rows];
    let take: number | null = null;

    const result = () => (take === null ? filtered : filtered.slice(0, take));

    const builder = {
      select: () => builder,
      eq: (column: keyof Membership, value: string) => {
        filtered = filtered.filter((row) => row[column] === value);
        return builder;
      },
      order: (column: keyof Membership, opts?: { ascending?: boolean }) => {
        const dir = opts?.ascending === false ? -1 : 1;
        filtered = [...filtered].sort((a, b) =>
          // eslint-disable-next-line no-restricted-syntax -- fixture ordering; nothing here is read by a user.
          String(a[column] ?? '').localeCompare(String(b[column] ?? '')) * dir
        );
        return builder;
      },
      limit: (n: number) => {
        take = n;
        return builder;
      },
      maybeSingle: async () => {
        const rowsOut = result();
        if (rowsOut.length > 1) {
          return {
            data: null,
            error: {
              code: 'PGRST116',
              message: 'JSON object requested, multiple (or no) rows returned',
              details: `Results contain ${rowsOut.length} rows`,
              hint: null,
            },
          };
        }
        return { data: rowsOut[0] ?? null, error: null };
      },
      // Awaiting the builder itself returns the full result set.
      then: (
        resolve: (value: { data: Membership[]; error: null }) => unknown,
        reject?: (reason: unknown) => unknown
      ) => Promise.resolve({ data: result(), error: null }).then(resolve, reject),
    };

    return builder;
  };
}

/** Point the shared sessionStorage mock at a specific selected institution. */
export function setSelectedInstitution(id: string | null) {
  (window.sessionStorage.getItem as ReturnType<typeof vi.fn>).mockImplementation(
    (key: string) => (key === 'selectedInstitutionId' ? id : null)
  );
}
