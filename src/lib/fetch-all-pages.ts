/**
 * Read every row matching a PostgREST query, not just the first page.
 *
 * PostgREST caps an unbounded `select()` at its `max-rows` setting — 1000 on
 * Supabase by default — and returns that first page with **no error and no
 * indication that anything was withheld**. A caller that then aggregates the
 * result gets a plausible-looking answer computed over an arbitrary slice of
 * the data it asked for. That is worse than an outright failure, because
 * nothing about the output says it is wrong.
 *
 * ## Keyset, not offset
 *
 * Pages are identified by the **last row seen**, never by a numeric offset.
 * That is not a stylistic preference: `.range(from, to)` re-runs the query per
 * page, so any row inserted while the read is in progress shifts every
 * subsequent offset by one. Against a live log table ordered newest-first, a
 * new row lands at offset 0 and pushes the row at the end of page N onto the
 * start of page N+1 — returning it twice — while a row at the far end falls off
 * the cap unread. The totals are then wrong in both directions at once, and the
 * report still looks complete.
 *
 * `ai_usage_logs` is written by every edge function on every attempt, so this
 * is the normal case rather than a corner one. A cursor is immune: "give me
 * rows after this one" means the same thing however many rows arrive in front
 * of it.
 *
 * The caller therefore owns the cursor filter, since only it knows the sort.
 * Two obligations come with that:
 *
 *   - **The ordering must be total.** A cursor on a non-unique key cannot
 *     express "after this row" unambiguously — rows tied with the cursor are
 *     either all included (duplicates) or all excluded (omissions). End the
 *     sort with a unique column, and include it in the cursor comparison.
 *   - **The filter must be strict.** `<` on the cursor, never `<=`, or the
 *     cursor row itself comes back at the head of every page and the read never
 *     advances.
 *
 * ## A cap is disclosed, never silent
 *
 * `truncated` distinguishes "there is more data past the ceiling" from "the
 * data happened to end exactly on the ceiling", at the cost of one extra
 * request in that case. Reporting a complete dataset as partial costs as much
 * trust as the reverse.
 */

export interface PageResult<T> {
  data: T[] | null;
  error: { message: string } | null;
}

export interface FetchAllPagesOptions {
  /** Rows per request. Above PostgREST's `max-rows` this achieves nothing. */
  pageSize?: number;
  /**
   * Hard ceiling on rows returned. Guards against a query that matches far more
   * than the caller can hold; reaching it sets `truncated`.
   */
  maxRows?: number;
  /**
   * Checked between pages. Return false to stop early — for a read whose result
   * is no longer wanted, such as one superseded by a newer filter selection.
   * Paging can mean dozens of sequential round trips, so abandoning one that
   * nobody will read is worth the hook.
   */
  shouldContinue?: () => boolean;
}

export interface FetchAllPagesResult<T> {
  rows: T[];
  /** True only when rows exist beyond `maxRows` — see the note above. */
  truncated: boolean;
  /**
   * True when `shouldContinue` stopped the read. `rows` is then an arbitrary
   * prefix and must not be aggregated or displayed — the caller asked to stop,
   * so it already knows it does not want this.
   */
  aborted: boolean;
}

/**
 * @param fetchPage Runs the query for rows strictly after `cursor` (the last
 *   row of the previous page), or from the beginning when it is null. Must
 *   apply the same filters and the same total ordering on every call, and must
 *   limit to `pageSize`.
 */
export async function fetchAllPages<T>(
  fetchPage: (cursor: T | null) => Promise<PageResult<T>>,
  { pageSize = 1000, maxRows = 50_000, shouldContinue }: FetchAllPagesOptions = {},
): Promise<FetchAllPagesResult<T>> {
  if (pageSize <= 0) throw new Error("fetchAllPages: pageSize must be positive");
  if (maxRows <= 0) throw new Error("fetchAllPages: maxRows must be positive");

  const rows: T[] = [];
  let cursor: T | null = null;
  let hitCap = false;

  for (;;) {
    if (shouldContinue && !shouldContinue()) {
      return { rows, truncated: false, aborted: true };
    }

    const { data, error } = await fetchPage(cursor);
    // Propagate rather than returning a short read — a partial result that
    // looks whole is the exact failure this helper exists to prevent.
    if (error) throw new Error(error.message);
    if (!data?.length) break;

    rows.push(...data);
    cursor = data[data.length - 1];

    // A short page is the last page.
    if (data.length < pageSize) break;

    if (rows.length >= maxRows) {
      hitCap = true;
      break;
    }
  }

  let truncated = false;
  if (hitCap) {
    if (shouldContinue && !shouldContinue()) {
      return { rows, truncated: false, aborted: true };
    }
    // Asking for the next page and taking whether it has anything, rather than
    // trusting that a full final page implies more.
    const { data, error } = await fetchPage(cursor);
    if (error) throw new Error(error.message);
    truncated = Boolean(data?.length);
  }

  return { rows, truncated, aborted: false };
}
